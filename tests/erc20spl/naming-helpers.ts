// Shared by the wrapper-naming tests: the vector file, hex helpers, and a way to read which custom error a
// reverted call raised.
import { readFileSync } from "node:fs";
import { concatHex, keccak256, toFunctionSelector, toHex, hexToString, type Hex } from "viem";

export type TextExpect = { ok: true; output: Hex } | { ok: false; error: "BadName" | "BadSymbol" };
export type TextVector = { id: string; kind: "name" | "symbol"; input: Hex; expect: TextExpect };
export type MintAccount = {
    at: "mint" | "metaplex" | "other";
    owner: "classic" | "p2022" | "metaplex" | "other";
    data: Hex;
    patch?: { offset: number; address: "metaplex" }[];
};
export type MintVector = {
    id: string;
    mint: Hex;
    accounts: MintAccount[];
    expect: { ok: true; name: Hex; symbol: Hex } | { ok: false; error: string };
    read: { source: string; name?: Hex; symbol?: Hex };
};
export type AuthorityVector = {
    id: string;
    originName: Hex;
    originSymbol: Hex;
    expect: { ok: true; name: Hex; symbol: Hex } | { ok: false; error: string };
};
export type Vectors = {
    unicodeVersion: string;
    constants: Record<string, Hex>;
    table: [number, number][];
    text: TextVector[];
    mints: MintVector[];
    authority: AuthorityVector[];
};

export const vectors: Vectors = JSON.parse(
    readFileSync(new URL("./../fixtures/asset-naming/vectors.json", import.meta.url), "utf8"),
);

/** The Token Metadata program's id, as the fixtures name it. */
export const METAPLEX_PROGRAM = vectors.constants.metaplexProgram;

/** The mock `find_program_address` answers keccak(program ‖ seeds): what `MintInfoMock` does. */
export function mockMetadataPda(mint: Hex): Hex {
    return keccak256(concatHex([METAPLEX_PROGRAM, toHex("metadata"), METAPLEX_PROGRAM, mint]));
}

/** The mock `pda(address)` answers keccak("mock-pda" ‖ address): what `MintInfoMock` does. */
export function mockPda(user: Hex): Hex {
    return keccak256(concatHex([toHex("mock-pda"), user]));
}

const ERROR_NAMES = [
    "AlreadyRegistered()",
    "Grandfathered()",
    "NoName()",
    "BadName()",
    "BadSymbol()",
    "ExternalPointer()",
    "NotMintAuthority()",
    "MintAssertsName()",
    "BadGrandfatherList()",
    "MintAccountAlreadyExists(bytes32)",
];
const bySelector = new Map(ERROR_NAMES.map((s) => [toFunctionSelector(s), s.split("(")[0]]));

/** The custom error a reverted call raised, by name; null when the call did not revert. */
export async function revertName(p: Promise<unknown>): Promise<string | null> {
    try {
        await p;
        return null;
    } catch (e: any) {
        let data: string | undefined;
        const seen = new Set<any>();
        const visit = (x: any) => {
            if (!x || typeof x !== "object" || seen.has(x)) return;
            seen.add(x);
            if (typeof x.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(x.data) && !data) data = x.data;
            if (x.data && typeof x.data === "object" && typeof x.data.errorName === "string") {
                data = data ?? undefined;
                found = x.data.errorName;
            }
            visit(x.cause);
            visit(x.error);
        };
        let found: string | undefined;
        visit(e);
        if (found) return found;
        if (data) return bySelector.get(data.slice(0, 10) as Hex) ?? `unknown revert ${data.slice(0, 10)}`;
        return `reverted: ${e?.shortMessage ?? e?.message ?? e}`;
    }
}

export const utf8 = (h: Hex): string => hexToString(h);
