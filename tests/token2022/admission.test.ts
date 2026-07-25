import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { network } from "hardhat";

// Admission is keyed on the ARMED hook, at every path that can bring a wrapper
// into existence. Three such paths exist: the factory, and each wrapper's own
// constructor — the second reachable directly by the deploy scripts, which the
// factory gate never sees.
//
// The first block asserts the wiring, which is what can silently regress: that
// each path declares the error and reads mint_info on its own track. The second
// executes the constructors against a mocked mint_info, so the refusal is
// observed rather than inferred from source.
//
// An earlier version of this comment said behaviour was "the funded matrix's job;
// no armed-hook 2022 mint exists on devnet to point a local run at yet." Both
// halves are now wrong: an armed-hook mint is a committed fixture
// (rome-evm-private ci/dump, built by ci/gen-t22-fixtures.sh) that the CI
// validator loads at genesis, and the refusal against it is asserted on a live
// stack in the tests repo. Nothing here waits on a funded chain.

function src(p: string): string {
    return readFileSync(`contracts/${p}`, "utf8");
}
function abi(iface: string) {
    return JSON.parse(
        readFileSync(`artifacts/contracts/interface.sol/${iface}.json`, "utf8"),
    ).abi as any[];
}

const PATHS: Array<[string, string, string]> = [
    ["factory", "erc20spl/erc20spl_factory.sol", "HelperProgram"],
    ["legacy wrapper ctor", "erc20spl/erc20spl.sol", "HelperProgram"],
    ["cached wrapper ctor", "erc20spl/erc20spl_cached.sol", "SplCached"],
];

describe("armed-hook admission", () => {
    for (const [name, file, track] of PATHS) {
        it(`${name} refuses an armed hook`, () => {
            const s = src(file);
            assert.match(
                s,
                /hook_program != bytes32\(0\)/,
                "must key on the ARMED hook — a zero program_id is inert and must pass",
            );
            assert.match(s, /revert ArmedTransferHookUnsupported\(/);
        });

        it(`${name} reads mint_info on its own track (${track})`, () => {
            // verify_call refuses a legacy cross-state read once a cached invoke
            // has fired, so a cached contract reading the legacy home would fail
            // mid-transaction.
            assert.match(src(file), new RegExp(`${track}\\.mint_info\\(`));
        });
    }

    it("neither wrapper parses mint bytes in Solidity any more", () => {
        for (const f of ["erc20spl/erc20spl.sol", "erc20spl/erc20spl_cached.sol"]) {
            assert.doesNotMatch(
                src(f),
                /load_mint\(/,
                `${f} must take decimals from mint_info, not by parsing the mint (I2)`,
            );
        }
    });

    it("the error names the mint and the hook, so a failure is diagnosable", () => {
        assert.match(
            src("erc20spl/erc20spl.sol"),
            /error ArmedTransferHookUnsupported\(bytes32 mint, bytes32 hookProgram\)/,
        );
    });

    it("mint_info is declared on both tracks with the same selector", () => {
        for (const iface of ["IHelperProgram", "ISplCached"]) {
            assert.ok(
                abi(iface).some((e) => e.type === "function" && e.name === "mint_info"),
                `${iface} must declare mint_info`,
            );
        }
    });
});

// The block above reads source. That catches a deleted check, but it would pass
// just as happily if the check were unreachable, or if the wrapper refused an
// *unarmed* hook too — the failure that would reject most real Token-2022 mints.
//
// So run the constructors. `mint_info` is the only precompile either one calls,
// so putting MintInfoMock at the two precompile addresses is enough to execute
// them for real. The mock derives its answer from the mint id (byte 0 decimals,
// byte 1 arms the hook, bytes 2-3 fee bps), so no per-case setup is needed.
describe("armed-hook admission, executed", async () => {
    const HELPER = "0xff00000000000000000000000000000000000009";
    const SPL_CACHED = "0xff00000000000000000000000000000000000005";

    const conn = await network.connect();
    const { viem } = conn;

    const mock = await viem.deployContract("MintInfoMock");
    const client = await viem.getPublicClient();
    const code = await client.getCode({ address: mock.address });
    assert.ok(code && code !== "0x", "mock must have deployed code to install");
    // Also the System precompile: the factory's constructor converts a program
    // name through it before any mint is involved.
    const SYSTEM = "0xff00000000000000000000000000000000000007";
    for (const addr of [HELPER, SPL_CACHED, SYSTEM]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
    }

    /// byte 0 decimals · byte 1 arms the hook · bytes 2-3 fee bps ·
    /// byte 5 marks the hook present in the bitmap without arming it · rest distinct.
    /// `hookPresent` defaults to whatever `hookArmed` is, since arming implies
    /// presence; pass it explicitly to build the present-but-inert case.
    function mintId(
        decimals: number,
        hookArmed: boolean,
        feeBps: number,
        tag: number,
        hookPresent = hookArmed,
    ): `0x${string}` {
        const b = new Uint8Array(32);
        b[0] = decimals;
        b[1] = hookArmed ? 1 : 0;
        b[2] = (feeBps >> 8) & 0xff;
        b[3] = feeBps & 0xff;
        b[5] = hookPresent ? 1 : 0;
        b[31] = tag;
        return `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
    }

    const WRAPPERS = ["SPL_ERC20", "SPL_ERC20_cached"] as const;

    async function deployWrapper(name: string, mint: `0x${string}`) {
        const users = await viem.deployContract("ERC20Users");
        return viem.deployContract(name, [
            mint,
            "0xff00000000000000000000000000000000000008",
            "Wrapped",
            "WRAP",
            users.address,
        ]);
    }

    for (const name of WRAPPERS) {
        it(`${name} refuses an armed hook, and says which`, async () => {
            await assert.rejects(
                deployWrapper(name, mintId(6, true, 0, 1)),
                (e: Error) => {
                    assert.match(e.message, /ArmedTransferHookUnsupported/);
                    return true;
                },
                "an armed hook must be refused at construction, not at first transfer",
            );
        });

        it(`${name} accepts a present-but-unarmed hook`, async () => {
            // The mint carries the extension — bit 14 is set in the bitmap —
            // and its program_id is zero, so the processor's get_program_id()
            // returns None and no CPI ever fires. Refusing this would refuse
            // most real Token-2022 mints, so a wrapper keying on presence must
            // fail this test.
            const w = await deployWrapper(name, mintId(6, false, 0, 2, true));
            assert.equal(await w.read.decimals(), 6);
        });

        it(`${name} accepts an armed fee, which it handles by measuring`, async () => {
            const w = await deployWrapper(name, mintId(9, false, 50, 3));
            assert.equal(await w.read.decimals(), 9, "decimals come from mint_info");
        });

        it(`${name} takes decimals from mint_info rather than a constructor argument`, async () => {
            const w = await deployWrapper(name, mintId(2, false, 0, 4));
            assert.equal(await w.read.decimals(), 2);
        });
    }

    it("a fee and an armed hook together are still refused for the hook", async () => {
        await assert.rejects(
            deployWrapper("SPL_ERC20_cached", mintId(6, true, 50, 5)),
            /ArmedTransferHookUnsupported/,
        );
    });

    // The third admission path. It refuses before deploying rather than letting
    // the wrapper's own constructor fail, so the caller does not pay for a CREATE
    // that was always going to revert. The gate is the first thing the register
    // path does after the symbol check, which is why it is reachable here without
    // mocking the mint-creation machinery behind it.
    it("the factory refuses an armed hook before it deploys anything", async () => {
        const factory = await viem.deployContract("ERC20SPLFactory", [
            "0xff00000000000000000000000000000000000008",
        ]);
        await assert.rejects(
            factory.write.add_spl_token_no_metadata([mintId(6, true, 0, 6), "Wrapped", "WRAP"]),
            /ArmedTransferHookUnsupported/,
        );
    });

    // This path registers a wrapper over a mint that already exists, so it needs
    // no mint-creation machinery: mocking mint_info is enough for it to run to
    // completion. A present-but-unarmed hook therefore has to produce a wrapper,
    // not a revert — and the wrapper it deploys reads the same mint_info on the
    // cached track, so this covers both gates in one call.
    it("the factory registers a wrapper for a present-but-unarmed hook", async () => {
        const factory = await viem.deployContract("ERC20SPLFactory", [
            "0xff00000000000000000000000000000000000008",
        ]);
        const mint = mintId(6, false, 0, 7, true);
        await factory.write.add_spl_token_no_metadata([mint, "Wrapped2", "WRP2"]);

        const wrapper = await factory.read.token_by_mint([mint]);
        assert.notEqual(
            wrapper,
            "0x0000000000000000000000000000000000000000",
            "an inert hook must not stop the factory from registering",
        );
    });
});

// The block above installs the mock at both homes, so it cannot tell whether each
// wrapper reads its OWN track — only that each reads something. The distinction
// matters: verify_call refuses a legacy cross-state read once a cached invoke has
// fired, so a cached wrapper reading the legacy home would fail mid-transaction,
// on a path no local test would exercise.
//
// Install one home at a time. The wrapper whose track is absent must fail to
// deploy, which is the source assertion above turned into behaviour.
describe("each wrapper reads its own track, executed", async () => {
    const HELPER = "0xff00000000000000000000000000000000000009";
    const SPL_CACHED = "0xff00000000000000000000000000000000000005";

    const conn = await network.connect();
    const { viem } = conn;
    const mock = await viem.deployContract("MintInfoMock");
    const code = await (await viem.getPublicClient()).getCode({ address: mock.address });

    async function installOnly(present: string, absent: string) {
        await conn.provider.request({ method: "hardhat_setCode", params: [present, code] });
        await conn.provider.request({ method: "hardhat_setCode", params: [absent, "0x"] });
    }

    async function deploy(name: string) {
        const users = await viem.deployContract("ERC20Users");
        const mint = `0x06${"00".repeat(31)}` as `0x${string}`; // 6 decimals, nothing armed
        return viem.deployContract(name, [
            mint,
            "0xff00000000000000000000000000000000000008",
            "Wrapped",
            "WRAP",
            users.address,
        ]);
    }

    it("the cached wrapper needs SplCached, not HelperProgram", async () => {
        await installOnly(SPL_CACHED, HELPER);
        await deploy("SPL_ERC20_cached"); // resolves
        await assert.rejects(
            deploy("SPL_ERC20"),
            "the legacy wrapper must be reading HelperProgram, which is absent here",
        );
    });

    it("the legacy wrapper needs HelperProgram, not SplCached", async () => {
        await installOnly(HELPER, SPL_CACHED);
        await deploy("SPL_ERC20"); // resolves
        await assert.rejects(
            deploy("SPL_ERC20_cached"),
            "the cached wrapper must be reading SplCached, which is absent here",
        );
    });
});
