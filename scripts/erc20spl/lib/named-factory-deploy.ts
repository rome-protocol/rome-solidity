// scripts/erc20spl/lib/named-factory-deploy.ts
//
// The pure parts of the E1 deploy command: the grandfather list, its hash, the plan the command prints, and the
// gate on --send.

import { encodeAbiParameters, isAddress, keccak256, type Hex } from "viem";
import { base58ToBytes32 } from "../../lib/pubkey.js";

export type GrandfatherEntry = { network: number; mint: Hex; wrapper: `0x${string}` };

const ZERO32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Reads a grandfather list from JSON: [{ "network": 74, "mint": "<base58 or 0x bytes32>", "wrapper": "0x..." }].
 * The same array goes to the asset book and to E1, so the two hashes can be compared. Refuses a malformed entry, a
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

/** keccak256(abi.encode(list)): the preimage E1 and the asset book share. */
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
    const lines = [
        `ERC20SPLNamedFactory constructor(`,
        `  _cpi_program = ${opts.cpiProgram}`,
        `  list = ${opts.list.length} grandfathered mint(s)`,
        ...opts.list.map((e) => `    network ${e.network}  mint ${e.mint}  wrapper ${e.wrapper}`),
        `)`,
        `grandfatherHash = ${grandfatherHash(opts.list)}  (compare with the asset book's, and with the deploy config's)`,
    ];
    return { args, lines };
}

/**
 * The gate on --send: a dry run (no --send) never sends; --send needs the deployer's current transaction count,
 * stated by the operator, and refuses when the chain's count differs; a mainnet send also needs its own flag.
 */
export function gateSend(opts: {
    send: boolean;
    expectNonce: number | undefined;
    nonce: number;
    mainnet?: boolean;
    acknowledgeMainnet?: boolean;
}): "dry-run" | "send" {
    if (!opts.send) return "dry-run";
    if (opts.expectNonce === undefined) {
        throw new Error("--send needs --expect-nonce <n>, the deployer's current transaction count");
    }
    if (opts.expectNonce !== opts.nonce) {
        throw new Error(`nonce gate: --expect-nonce ${opts.expectNonce}, the deployer's nonce on this chain is ${opts.nonce}`);
    }
    if (opts.mainnet && !opts.acknowledgeMainnet) {
        throw new Error("this is a mainnet chain: --send also needs --i-understand-mainnet");
    }
    return "send";
}
