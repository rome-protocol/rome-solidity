// scripts/lib/wrapper-factory.ts
//
// Which wrapper factory a script may use. One factory makes new wrappers on a chain: the named factory (E1,
// `ERC20SPLNamedFactory`), which names every wrapper by rule. The legacy `ERC20SPLFactory` versions stay
// deployed and callable, but no script here makes a wrapper through one, and no script deploys a wrapper
// directly (a wrapper deployed outside a factory emits no `TokenCreated`, so the indexers never see it) or a
// second legacy factory, on a chain where E1 is live.
//
// "Live" is the chain's record in deployments/<network>.json: `ERC20SPLNamedFactory.live === true`. A deploy
// writes the record with `live: false`; the lead sets it when the registry's record marks E1 the chain's live
// `ERC20SPLFactory` and the legacy version deprecated, never a deploy script. A chain without a live E1 keeps
// its legacy factory, not deprecated, and no wrapper-making script runs there until E1 is.

import { getAddress, isAddress } from "viem";
import { readDeployments, type DeploymentsFile } from "./deployments.js";

export class NoLiveNamedFactoryError extends Error {
    constructor(networkName: string) {
        super(
            `[${networkName}] no live named wrapper factory (ERC20SPLNamedFactory with live: true) in ` +
            `deployments/${networkName}.json. New wrappers are made only through it; deploy it with ` +
            `scripts/erc20spl/deploy-named-factory.ts and mark it live once the registry's record does.`,
        );
        this.name = "NoLiveNamedFactoryError";
    }
}

export class NotLiveNamedFactoryError extends Error {
    constructor(networkName: string, requested: string, live: string, deprecated: boolean) {
        super(
            `[${networkName}] ${requested} is not this chain's live named wrapper factory (${live})` +
            (deprecated ? "; it is a legacy factory marked deprecated" : "") +
            `. No wrapper is made through any other factory.`,
        );
        this.name = "NotLiveNamedFactoryError";
    }
}

export class DirectWrapperDeployRetiredError extends Error {
    constructor(networkName: string, what: string, e1: string) {
        super(
            `[${networkName}] refusing to ${what}: the named wrapper factory ${e1} is live on this chain, and new ` +
            `wrappers are made only through it (add_spl_token_with_metadata, or add_spl_token_by_authority for ` +
            `a mint you made). Nothing was sent.`,
        );
        this.name = "DirectWrapperDeployRetiredError";
    }
}

/** The live E1 recorded for a chain, or null. */
export function liveNamedFactoryAddress(dep: DeploymentsFile): `0x${string}` | null {
    const rec = dep.ERC20SPLNamedFactory;
    if (!rec || rec.live !== true || !rec.address || !isAddress(rec.address)) return null;
    return getAddress(rec.address);
}

/**
 * The chain's live named factory. Throws when there is none. `requested`, when a script was given an address
 * (an environment override, say), must be that same factory: a legacy one, deprecated or not, is refused.
 */
export function resolveLiveNamedFactory(
    networkName: string,
    dep: DeploymentsFile = readDeployments(networkName),
    requested?: string,
): `0x${string}` {
    const live = liveNamedFactoryAddress(dep);
    if (!live) throw new NoLiveNamedFactoryError(networkName);
    if (requested !== undefined && (!isAddress(requested) || getAddress(requested) !== live)) {
        const legacy = dep.ERC20SPLFactory;
        const isLegacy = !!legacy?.address && isAddress(requested) && getAddress(legacy.address) === getAddress(requested);
        throw new NotLiveNamedFactoryError(networkName, requested, live, isLegacy && legacy?.deprecated === true);
    }
    return live;
}

/**
 * Call first in a script that deploys a wrapper directly, or a legacy factory: it throws, before anything is
 * sent, on a chain where E1 is live.
 */
export function assertDirectWrapperDeployAllowed(
    networkName: string,
    what: string,
    dep: DeploymentsFile = readDeployments(networkName),
): void {
    const live = liveNamedFactoryAddress(dep);
    if (live) throw new DirectWrapperDeployRetiredError(networkName, what, live);
}
