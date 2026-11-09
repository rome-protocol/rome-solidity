// scripts/erc20spl/lib/named-factory-deploy.ts
//
// The pure parts of the named-factory deploy command: the grandfather list, its hash, the plan the command prints, and the
// gate on --send.

import { decodeDeployData, encodeAbiParameters, encodeDeployData, isAddress, keccak256, type Abi, type Hex } from "viem";
import { base58ToBytes32 } from "../../lib/pubkey.js";

export type GrandfatherEntry = { network: number; mint: Hex; wrapper: `0x${string}` };

const ZERO32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Reads a grandfather list from JSON: [{ "network": 74, "mint": "<base58 or 0x bytes32>", "wrapper": "0x..." }].
 * The same array can go to other tools that take it, so the hashes can be compared. Refuses a malformed entry, a
 * zero mint or wrapper, and a repeated mint, as the contract does.
 */
export function parseGrandfatherList(raw: unknown): GrandfatherEntry[] {
    if (!Array.isArray(raw)) throw new Error("the grandfather list must be a JSON array");
    const seen = new Set<string>();
    return raw.map((e, i) => {
        if (!e || typeof e !== "object") throw new Error(`grandfather entry ${i}: not an object`);
        const { network, mint, wrapper } = e as Record<string, unknown>;
        if (!Number.isInteger(network) || (network as number) < 0 || (network as number) > 0xffffffff) {
            throw new Error(`grandfather entry ${i}: network must be a uint32`);
        }
        if (typeof mint !== "string") throw new Error(`grandfather entry ${i}: mint must be a string`);
        const m = /^0x[0-9a-fA-F]{64}$/.test(mint) ? (mint.toLowerCase() as Hex) : base58ToBytes32(mint);
        if (m === ZERO32) throw new Error(`grandfather entry ${i}: zero mint`);
        if (typeof wrapper !== "string" || !isAddress(wrapper) || wrapper.toLowerCase() === ZERO_ADDRESS) {
            throw new Error(`grandfather entry ${i}: wrapper must be a non-zero 20-byte address`);
        }
        if (seen.has(m)) throw new Error(`grandfather entry ${i}: mint repeated`);
        seen.add(m);
        return { network: network as number, mint: m, wrapper: wrapper as `0x${string}` };
    });
}

/** keccak256(abi.encode(list)): the preimage the factory stores. */
export function grandfatherHash(list: GrandfatherEntry[]): Hex {
    return keccak256(
        encodeAbiParameters(
            [{ type: "tuple[]", components: [{ type: "uint32" }, { type: "bytes32" }, { type: "address" }] }],
            [list.map((e) => [e.network, e.mint, e.wrapper] as const)],
        ),
    );
}

export function planDeploy(opts: { cpiProgram: `0x${string}`; list: GrandfatherEntry[] }) {
    const args = [opts.cpiProgram, opts.list] as const;
    const hash = grandfatherHash(opts.list);
    return { args, hash, lines: [`grandfatherHash = ${hash}  (compare with the same list's hash in the other tools that take it)`] };
}

/**
 * The deploy transaction's data, built once: what is simulated, hashed, printed and sent. The constructor call is
 * decoded back from the encoded data, so the lines printed are what the chain would receive, not the inputs.
 */
export function buildDeploy(opts: { abi: Abi; bytecode: Hex; args: readonly unknown[] }) {
    const data = encodeDeployData({ abi: opts.abi, bytecode: opts.bytecode, args: opts.args as any });
    const decoded = decodeDeployData({ abi: opts.abi, bytecode: opts.bytecode, data });
    const [cpiProgram, list] = (decoded.args ?? []) as unknown as [`0x${string}`, readonly { network: number; mint: Hex; wrapper: `0x${string}` }[]];
    const lines = [
        `deploy data: ${(data.length - 2) / 2} bytes, keccak256 ${keccak256(data)}`,
        `decoded constructor call (from the encoded data):`,
        `  _cpi_program = ${cpiProgram}`,
        `  list = ${list.length} grandfathered mint(s), grandfatherHash ${grandfatherHash(list.map((e) => ({ network: Number(e.network), mint: e.mint, wrapper: e.wrapper })))}`,
        ...list.map((e) => `    network ${e.network}  mint ${e.mint}  wrapper ${e.wrapper}`),
    ];
    return { data, digest: keccak256(data), cpiProgram, list, lines };
}

/** Refuses an empty grandfather list on a mainnet chain: it would let the factory make a second token of a listed mint. */
export function assertListAllowed(opts: { noGrandfather: boolean; mainnet: boolean }): void {
    if (opts.noGrandfather && opts.mainnet) {
        throw new Error("--no-grandfather is refused on a mainnet chain: give the grandfather list with --grandfather");
    }
}

/**
 * The gate on --send: a dry run (no --send) never sends; --send needs the deployer's current transaction count
 * (pending included), stated by the caller, and refuses when the chain's count differs; it also needs the
 * grandfather hash the caller expects, which must equal the list's; a mainnet send also needs its own flag.
 */
export function gateSend(opts: {
    send: boolean;
    expectNonce: number | undefined;
    nonce: number;
    mainnet?: boolean;
    acknowledgeMainnet?: boolean;
    grandfatherHash?: Hex;
    expectGrandfatherHash?: string;
}): "dry-run" | "send" {
    if (!opts.send) return "dry-run";
    if (opts.expectNonce === undefined) {
        throw new Error("--send needs --expect-nonce <n>, the deployer's current transaction count");
    }
    if (opts.expectNonce !== opts.nonce) {
        throw new Error(`nonce gate: --expect-nonce ${opts.expectNonce}, the deployer's nonce on this chain is ${opts.nonce}`);
    }
    if (opts.grandfatherHash !== undefined) {
        if (!opts.expectGrandfatherHash) {
            throw new Error("--send needs --expect-grandfather-hash <hash>, the hash of the grandfather list you mean to deploy");
        }
        if (opts.expectGrandfatherHash.toLowerCase() !== opts.grandfatherHash.toLowerCase()) {
            throw new Error(
                `grandfather gate: --expect-grandfather-hash ${opts.expectGrandfatherHash}, the list's hash is ${opts.grandfatherHash}`,
            );
        }
    }
    if (opts.mainnet && !opts.acknowledgeMainnet) {
        throw new Error("this is a mainnet chain: --send also needs --i-understand-mainnet");
    }
    return "send";
}
