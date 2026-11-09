// scripts/erc20spl/lib/register-named.ts
//
// Registers a mint on the named wrapper factory for a script that made the mint itself: through the metadata
// path when the mint carries a name of its own, otherwise through the authority path with the strings given.
// The factory's own ABI (its error items included) must be passed, so a refusal in `preview` decodes to the
// error's name; with an ABI that has no error items every refusal would be thrown instead of read.

import { previewOutcome } from "../../bridge/lib/bootstrap-plan.js";

export type RegisterNamedResult = { path: "metadata" | "authority"; hash: `0x${string}` };

export async function registerOnNamedFactory(opts: {
    publicClient: { readContract: (a: any) => Promise<unknown> };
    wallet: { writeContract: (a: any) => Promise<`0x${string}`> };
    factory: `0x${string}`;
    abi: readonly unknown[];
    mint: `0x${string}`;
    /** used only when the mint carries no name of its own */
    authorityName: string;
    authoritySymbol: string;
}): Promise<RegisterNamedResult> {
    const { publicClient, wallet, factory, abi, mint } = opts;
    const named = await previewOutcome(() =>
        publicClient.readContract({ address: factory, abi, functionName: "preview", args: [mint] }),
    );
    if (named.kind === "ok") {
        const hash = await wallet.writeContract({ address: factory, abi, functionName: "add_spl_token_with_metadata", args: [mint] });
        return { path: "metadata", hash };
    }
    if (named.error !== "NoName") {
        // any other refusal is final: the authority path would hit the same check or a stricter one
        throw new Error(`the named factory refuses mint ${mint}: ${named.error}`);
    }
    const hash = await wallet.writeContract({
        address: factory,
        abi,
        functionName: "add_spl_token_by_authority",
        args: [mint, opts.authorityName, opts.authoritySymbol],
    });
    return { path: "authority", hash };
}
