import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
    CPI_PROGRAM_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
    HELPER_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
} from "../precompile-addresses";

// A Token-2022 mint can carry its own identity, in the mint account itself, under
// the mint's metadata authority. That identity is what a wrapper must present:
// the factory is permissionless and its name/symbol are immutable once set, so a
// deployer-supplied label lets whoever registers first name somebody else's token
// permanently, and every EVM wallet then shows that label.
//
// Bytes below are the real ai16z mint, dumped from mainnet and committed as a CI
// fixture — MetadataPointer self-referential, TokenMetadata in the mint, name and
// symbol both "ai16z". Parsed here as a pure function against real data rather
// than a construction of our own, following tests/oracle/PythPullParser.test.ts.
const AI16Z_MINT =
    "0x010000008e266e49fd037319a0710185b369e0be018bbb2b1baa2b240e6b84f1837b01efb6c4322896b0430f0901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001120040000000000000000000000000000000000000000000000000000000000000000000f74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f871300aa008e266e49fd037319a0710185b369e0be018bbb2b1baa2b240e6b84f1837b01eff74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f8705000000616931367a05000000616931367a5000000068747470733a2f2f697066732e696f2f697066732f6261666b726569676166346d6d69626b6d6a6d7a346d6e346f7073767a62637037346b3265646c6475693268787465636f666c616c746f6737783400000000";

describe("mint identity is read from the mint", async () => {
    const { viem } = await network.connect();
    const lib = await viem.deployContract("SplTokenLibHarness");

    /// ai16z's own pubkey. The pointer is self-referential, which is the common
    /// shape: the metadata lives in the mint account rather than beside it.
    const AI16Z_PUBKEY =
        "0xf74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f87";

    it("finds the metadata pointer, and it points at the mint itself", async () => {
        const [found, addr] = await lib.read.metadataPointer([AI16Z_MINT]);
        assert.equal(found, true, "ai16z carries MetadataPointer");
        assert.equal(
            (addr as string).toLowerCase(),
            AI16Z_PUBKEY,
            "self-referential: the metadata is in the mint, not beside it",
        );
    });

    it("reads the name and symbol the mint asserts", async () => {
        const [found, name, symbol] = await lib.read.tokenMetadata([AI16Z_MINT]);
        assert.equal(found, true, "ai16z carries TokenMetadata in the mint");
        assert.equal(name, "ai16z");
        assert.equal(symbol, "ai16z");
    });

    it("a mint with no metadata reports none, rather than reverting", async () => {
        // 82 bytes of base layout and nothing else: the extension-free case.
        const bare = "0x" + "00".repeat(82);
        const [found] = await lib.read.tokenMetadata([bare]);
        assert.equal(found, false, "absence is a value, not an error");
    });

    it("truncated TLV is refused, not read past the end", async () => {
        const truncated = AI16Z_MINT.slice(0, 2 + 2 * 300);
        const [found] = await lib.read.tokenMetadata([truncated]);
        assert.equal(found, false);
    });
});

// The factory path. `add_spl_token_with_metadata` exists to take the name and
// symbol from the mint rather than from whoever registers it, but it looks only in
// the Metaplex account — so for a Token-2022 mint carrying native TokenMetadata it
// reverts "Metadata does not exist" about a mint that plainly has metadata.
//
// `add_spl_token_no_metadata` is deliberately untouched by this: choosing your own
// label stays allowed. Anyone can deploy their own factory and their own wrapper,
// on any chain; curation is what answers that, not a gate here.
describe("the factory reads identity from the mint", async () => {
    const CPI = CPI_PROGRAM_ADDRESS;
    const SYSTEM = SYSTEM_PROGRAM_ADDRESS;
    const HELPER = HELPER_PROGRAM_ADDRESS;
    // The wrapper the factory deploys reads mint_info on its own track, so the
    // cached home has to answer too — otherwise its constructor decodes five words
    // from an empty return and reverts with no reason at all.
    const SPL_CACHED = SPL_CACHED_ADDRESS;

    const conn = await network.connect();
    const { viem } = conn;
    const mock = await viem.deployContract("MintInfoMock");
    const code = await (await viem.getPublicClient()).getCode({ address: mock.address });
    for (const a of [CPI, SYSTEM, HELPER, SPL_CACHED]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
    }

    const AI16Z = "0xf74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f87";

    it("registers a Token-2022 mint whose metadata is native, and takes its name", async () => {
        const factory = await viem.deployContract("ERC20SPLFactory", [CPI]);
        await factory.write.add_spl_token_with_metadata([AI16Z]);

        const wrapper = await factory.read.token_by_mint([AI16Z]);
        assert.notEqual(wrapper, "0x0000000000000000000000000000000000000000");

        const w = await viem.getContractAt("SPL_ERC20_cached", wrapper as `0x${string}`);
        assert.equal(await w.read.name(), "ai16z", "the name comes from the mint");
        assert.equal(await w.read.symbol(), "ai16z");
        assert.equal(await w.read.decimals(), 9, "and decimals from mint_info");
    });

    it("a mint that asserts no identity still reverts, and says so", async () => {
        const factory = await viem.deployContract("ERC20SPLFactory", [CPI]);
        const bare = `0x06${"11".repeat(31)}` as `0x${string}`;
        await assert.rejects(factory.write.add_spl_token_with_metadata([bare]));
    });
});

// Red team the TLV walk. Its input is a mint account — data someone else controls
// — and every length in it is attacker-chosen, so the parser has to survive a
// hostile one rather than trust it.
describe("the TLV walk survives hostile mint data", async () => {
    const { viem } = await network.connect();
    const lib = await viem.deployContract("SplTokenLibHarness");

    const mutate = (at: number, bytes: string) => {
        const b = Buffer.from(AI16Z_MINT.slice(2), "hex");
        Buffer.from(bytes, "hex").copy(b, at);
        return `0x${b.toString("hex")}` as `0x${string}`;
    };

    it("an entry claiming more bytes than the account has is refused", async () => {
        // First TLV entry sits at 166: type u16 then len u16, little-endian.
        const [found] = await lib.read.tokenMetadata([mutate(168, "ffff")]);
        assert.equal(found, false, "must not read past the account");
    });

    it("a zero-length entry of the right type is refused, not parsed as empty", async () => {
        // type 19 (TokenMetadata) with len 0 — shorter than the fixed prefix.
        const [found] = await lib.read.tokenMetadata([mutate(166, "13000000")]);
        assert.equal(found, false);
    });

    it("a name length larger than the entry is refused", async () => {
        // TokenMetadata payload: 32 authority + 32 mint, then u32 name length.
        const [, off] = [0, 166 + 4 + 64];
        const [found] = await lib.read.tokenMetadata([mutate(off, "ffffffff")]);
        assert.equal(found, false, "the string must stay inside its own entry");
    });

    it("entries with no terminator terminate anyway", async () => {
        // Every entry advances the cursor by at least the 4-byte header, so a
        // buffer of zero-length non-zero-type entries cannot loop forever. If this
        // ever times out rather than returning, the walk can be stalled.
        const b = Buffer.alloc(400);
        for (let o = 166; o + 4 <= 400; o += 4) {
            b[o] = 0x63; // type 99, absent
            b[o + 1] = 0x00;
            b[o + 2] = 0x00; // len 0
            b[o + 3] = 0x00;
        }
        const [found] = await lib.read.tokenMetadata([`0x${b.toString("hex")}`]);
        assert.equal(found, false);
    });

    it("a truncated account, and an empty one, are refused", async () => {
        for (const d of ["0x", "0x00", `0x${"00".repeat(165)}`]) {
            const [found] = await lib.read.tokenMetadata([d as `0x${string}`]);
            assert.equal(found, false, `len ${(d.length - 2) / 2} must be refused`);
        }
    });
});
