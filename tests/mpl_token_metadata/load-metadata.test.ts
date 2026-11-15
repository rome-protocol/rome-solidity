import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { concatHex, numberToHex, stringToHex, type Hex } from "viem";
import { SYSTEM_PROGRAM_ADDRESS } from "../precompile-addresses";
import { METAPLEX_PROGRAM, mockMetadataPda, vectors } from "../erc20spl/naming-helpers";

/// `load_metadata` reports a mint's Metaplex metadata only for an account that the Metaplex program
/// owns, that is MetadataV1 for that mint, and whose name and symbol fit the program's limits. Lamports
/// alone, or well-formed bytes under another owner, are not metadata.
describe("MplTokenMetadataLib.load_metadata", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const MINT = vectors.constants.mint;
    const OTHER_PROGRAM = vectors.constants.otherProgram;
    const PDA = mockMetadataPda(MINT);
    const OTHER_MINT = vectors.constants.otherMint;

    let store: any;
    let harness: any;

    const u32 = (n: number) => numberToHex(n, { size: 4 }).replace(/^0x(..)(..)(..)(..)$/, "0x$4$3$2$1") as Hex;
    const field = (text: string, padTo: number) => {
        const raw = stringToHex(text, { size: padTo });
        return concatHex([u32(padTo), raw]);
    };
    // key, update authority, mint, name, symbol, uri "", seller fee 0, no creators, then the zero padding
    // Metaplex leaves after the last field (every remaining option reads as None).
    const metadata = (opts: { key?: number; mint?: Hex; nameLen?: number; symbolLen?: number } = {}): Hex =>
        concatHex([
            numberToHex(opts.key ?? 4, { size: 1 }),
            `0x${"33".repeat(32)}`,
            opts.mint ?? MINT,
            field("Wrapped SOL", opts.nameLen ?? 32),
            field("SOL", opts.symbolLen ?? 10),
            u32(0),
            "0x0000",
            "0x000100",
            `0x${"00".repeat(40)}`,
        ]);

    before(async () => {
        const mock = await viem.deployContract("MintInfoMock");
        const code = await (await viem.getPublicClient()).getCode({ address: mock.address });
        await conn.provider.request({ method: "hardhat_setCode", params: [SYSTEM_PROGRAM_ADDRESS, code] });
        store = await viem.deployContract("AccountStoreMock");
        harness = await viem.deployContract("MplMetadataHarness", []);
    });

    const load = async () => harness.read.load([MINT, METAPLEX_PROGRAM, store.address]);

    it("reads a real metadata account", async () => {
        await store.write.set([PDA, METAPLEX_PROGRAM, metadata()]);
        const [found, mint, name, symbol] = await load();
        assert.equal(found, true);
        assert.equal(mint, MINT);
        assert.ok(name.startsWith("Wrapped SOL"));
        assert.ok(symbol.startsWith("SOL"));
    });

    it("an absent account is not metadata", async () => {
        await store.write.clear([PDA]);
        assert.equal((await load())[0], false);
    });

    it("a funded account with no data, under the system program, is not metadata", async () => {
        await store.write.set([PDA, `0x${"00".repeat(32)}`, "0x"]);
        assert.equal((await load())[0], false);
    });

    it("well-formed metadata under another owner is not metadata", async () => {
        await store.write.set([PDA, OTHER_PROGRAM, metadata()]);
        assert.equal((await load())[0], false);
    });

    it("an account of another kind is not metadata", async () => {
        await store.write.set([PDA, METAPLEX_PROGRAM, metadata({ key: 6 })]);
        assert.equal((await load())[0], false);
    });

    it("metadata that names another mint is not this mint's", async () => {
        await store.write.set([PDA, METAPLEX_PROGRAM, metadata({ mint: OTHER_MINT })]);
        assert.equal((await load())[0], false);
    });

    it("a name over 32 bytes or a symbol over 10 is not metadata", async () => {
        await store.write.set([PDA, METAPLEX_PROGRAM, metadata({ nameLen: 33 })]);
        assert.equal((await load())[0], false);
        await store.write.set([PDA, METAPLEX_PROGRAM, metadata({ symbolLen: 11 })]);
        assert.equal((await load())[0], false);
    });
});
