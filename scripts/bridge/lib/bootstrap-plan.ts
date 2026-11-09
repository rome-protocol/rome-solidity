// scripts/bridge/lib/bootstrap-plan.ts
//
// What the bootstrap does with each canonical mint on a chain with a live named factory (E1). Nothing here
// chooses a name: the wrapper's name and symbol are the ones E1's `preview` gives, which are D1's rule applied
// to what the mint itself carries. A mint E1 refuses (grandfathered, no name of its own, a pointer it does not
// accept, a name or symbol its checks refuse) is skipped with the reason, never registered under another name.

import { BaseError, ContractFunctionRevertedError, type Address } from "viem";

export type PreviewOutcome =
    | { kind: "ok"; name: string; symbol: string }
    | { kind: "refused"; error: string };

export type EntryAction =
    | { kind: "existing"; wrapper: Address }
    | { kind: "register"; name: string; symbol: string }
    | { kind: "skip"; reason: string };

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Runs E1's `preview` and turns a revert into the error's name. Anything that is not a revert of a named custom
 * error (an RPC failure, an unknown revert) is thrown, never read as a refusal.
 */
export async function previewOutcome(call: () => Promise<unknown>): Promise<PreviewOutcome> {
    try {
        const [name, symbol] = (await call()) as [string, string];
        return { kind: "ok", name, symbol };
    } catch (e) {
        if (e instanceof BaseError) {
            const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
            if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
                return { kind: "refused", error: reverted.data.errorName };
            }
        }
        throw e;
    }
}

/** What to do with one mint, given its existing wrapper (zero when none) and E1's preview. */
export function planEntry(existingWrapper: string, preview: PreviewOutcome): EntryAction {
    if (existingWrapper.toLowerCase() !== ZERO) return { kind: "existing", wrapper: existingWrapper as Address };
    if (preview.kind === "ok") return { kind: "register", name: preview.name, symbol: preview.symbol };
    if (preview.error === "AlreadyRegistered") {
        // registered between the read and the preview: the caller re-reads token_by_mint
        return { kind: "skip", reason: "AlreadyRegistered (re-run to record it)" };
    }
    return { kind: "skip", reason: `E1 refuses this mint: ${preview.error}` };
}
