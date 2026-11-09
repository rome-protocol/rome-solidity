// Helpers for the script tests: a live named factory on the simulated chain with a store of Solana accounts, and a Metaplex
// account to put in it.
import { concatHex, toHex, type Hex } from "viem";
import {
    CPI_PROGRAM_ADDRESS,
    HELPER_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
} from "../precompile-addresses";
import { METAPLEX_PROGRAM, mockMetadataPda, vectors } from "./naming-helpers";

const K = vectors.constants;

export async function MINT_FOR_SCRIPTS(conn: any) {
    const { viem } = conn;
    const publicClient = await viem.getPublicClient();
    const mock = await viem.deployContract("MintInfoMock");
    const code = await publicClient.getCode({ address: mock.address });
    for (const a of [CPI_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, HELPER_PROGRAM_ADDRESS, SPL_CACHED_ADDRESS]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
    }
    const store = await viem.deployContract("AccountStoreMock");
    const f = await viem.deployContract("ERC20SPLNamedFactory", [store.address, []]);
    // the mint itself, a classic mint with no extensions
    const base = `0x01000000${"22".repeat(32)}${"00".repeat(8)}0901${"00000000"}${"00".repeat(32)}` as Hex;
    await store.write.set([K.mint, K.classicProgram, base]);
    return { f, store };
}
MINT_FOR_SCRIPTS.mint = K.mint as Hex;

const u32 = (n: number) => `${(n & 255).toString(16).padStart(2, "0")}${((n >> 8) & 255).toString(16).padStart(2, "0")}0000`;

/** A Metaplex metadata account for the vector mint: key 4, update authority, mint, padded name and symbol. */
export async function plantMetaplex(store: any, name: string, symbol: string) {
    const pad = (s: string, n: number) => (toHex(s).slice(2) + "00".repeat(n)).slice(0, n * 2);
    const data = concatHex([
        "0x04",
        `0x${"33".repeat(32)}`,
        K.mint as Hex,
        `0x${u32(32)}`,
        `0x${pad(name, 32)}`,
        `0x${u32(10)}`,
        `0x${pad(symbol, 10)}`,
        `0x${u32(0)}`,
        "0x0000",
        "0x000100",
    ]);
    await store.write.set([mockMetadataPda(K.mint as Hex), METAPLEX_PROGRAM, data]);
}
