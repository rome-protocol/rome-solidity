// Pure transform from rome-solidity's per-chain deployment receipt to the
// registry's per-chain oracle.json + contracts.json. Designed to be
// invoked from the contract-deploys oracle-deploy.yml workflow after the
// rome-solidity PR-back step, so registry updates land automatically.
//
// Single source of truth invariants this enforces:
//   - registry/chains/<slug>/oracle.json   ← workflow-managed; no hand-edits
//   - registry/chains/<slug>/contracts.json ← workflow-managed; no hand-edits
//
// Pure-functional core (`emitRegistryUpdate`) takes file contents in,
// returns file contents out. The CLI wrapper (sibling file) handles I/O.

// ─── Input types ────────────────────────────────────────────────────────────

export interface DeploymentsFeed {
  pair: string; // "SOL/USD"
  adapter: `0x${string}`;
  pubkey: string; // Solana base58
  pubkeyBytes32: `0x${string}`;
}

export interface PriceBookFeed {
  pair: string; // "SOL/USD"
  adapter: `0x${string}`; // BookFeedAdapter clone for this feed
  pubkey: string; // Solana base58
  pubkeyBytes32: `0x${string}`;
  maxStaleness: number; // per-feed, set at registerFeed(...) time
}

export interface DeploymentsFile {
  OracleGatewayV2: {
    deployedAt: string;
    defaultMaxStaleness: number;
    pythReceiverProgramId: string;
    switchboardProgramId: string;
    PythPullAdapterImpl: `0x${string}`;
    SwitchboardV3AdapterImpl: `0x${string}`;
    CachedPythAdapterImpl?: `0x${string}`;
    CachedFeedAdapterImpl?: `0x${string}`;
    OracleAdapterFactory: `0x${string}`;
    BatchReader: `0x${string}`;
    feeds: {
      pyth: DeploymentsFeed[];
      switchboard: DeploymentsFeed[];
      cachedPyth?: DeploymentsFeed[];
      cachedFeed?: DeploymentsFeed[];
    };
  };
  // Optional — PriceBook is a standalone contract (one aggregated write,
  // N per-feed BookFeedAdapter clones) deployed independently of the
  // OracleGatewayV2 stack. Absent on deployments files that predate it.
  PriceBook?: {
    address: `0x${string}`;
    implementation: `0x${string}`; // BookFeedAdapter implementation
    deployedAt: string;
    owner: `0x${string}`;
    feeds: PriceBookFeed[];
  };
}

export interface RegistryOracleFile {
  factory: string;
  // Present only when the source deployments file has a PriceBook block.
  priceBook?: {
    address: string;
    implementation: string;
  };
  feeds: Record<
    string,
    {
      address: string;
      source: "pyth" | "switchboard" | "cached-pyth" | "cached-feed" | "book";
      underlyingAccount?: string;
    }
  >;
}

export interface RegistryContractVersion {
  address: string;
  version: string;
  status: "live" | "retired";
  deployedAt: string;
  sourceGitSha?: string;
  compilerVersion?: string;
  deprecatedAt?: string;
  replacedBy?: string;
}

export interface RegistryContractEntry {
  name: string;
  versions: RegistryContractVersion[];
}

export type RegistryContractsFile = RegistryContractEntry[];

export interface EmitOptions {
  sourceGitSha: string;
  compilerVersion: string;
  deployedAt: string;
}

export interface EmitInput {
  deployments: DeploymentsFile;
  oracle: RegistryOracleFile;
  contracts: RegistryContractsFile;
  options: EmitOptions;
}

export interface EmitOutput {
  oracle: RegistryOracleFile;
  contracts: RegistryContractsFile;
}

// The 4 contract names this script manages. Order is the stable sort order
// emitted on greenfield deploys (matches alphabetical for predictability).
const MANAGED_CONTRACTS: ReadonlyArray<{
  name: string;
  field: keyof DeploymentsFile["OracleGatewayV2"];
}> = [
  { name: "BatchReader", field: "BatchReader" },
  { name: "OracleAdapterFactory", field: "OracleAdapterFactory" },
  { name: "PythPullAdapterImpl", field: "PythPullAdapterImpl" },
  { name: "SwitchboardV3AdapterImpl", field: "SwitchboardV3AdapterImpl" },
  // Optional — only tracked on deployments that include the cached impls.
  { name: "CachedPythAdapterImpl", field: "CachedPythAdapterImpl" },
  { name: "CachedFeedAdapterImpl", field: "CachedFeedAdapterImpl" },
];

export function emitRegistryUpdate(input: EmitInput): EmitOutput {
  return {
    oracle: buildOracle(input),
    contracts: buildContracts(input),
  };
}

function buildOracle({ deployments }: EmitInput): RegistryOracleFile {
  const og = deployments.OracleGatewayV2;
  const feeds: RegistryOracleFile["feeds"] = {};

  for (const f of og.feeds.pyth) {
    feeds[f.pair] = {
      address: f.adapter,
      source: "pyth",
      underlyingAccount: f.pubkey,
    };
  }
  for (const f of og.feeds.switchboard) {
    // Suffix switchboard entries with "-SB" so a pyth + switchboard pair
    // for the same symbol (e.g. SOL/USD) don't collide. Matches Marcus's
    // existing curated registry shape.
    feeds[`${f.pair}-SB`] = {
      address: f.adapter,
      source: "switchboard",
      underlyingAccount: f.pubkey,
    };
  }
  // Cached adapters. Pyth-specific (CachedPythAdapter) keyed "-CACHEDPYTH";
  // generic (CachedFeedAdapter, wraps any AggregatorV3) keyed "-CACHED".
  // Distinct suffixes so cached + raw entries for the same symbol don't collide.
  for (const f of og.feeds.cachedPyth ?? []) {
    feeds[`${f.pair}-CACHEDPYTH`] = {
      address: f.adapter,
      source: "cached-pyth",
      underlyingAccount: f.pubkey,
    };
  }
  for (const f of og.feeds.cachedFeed ?? []) {
    feeds[`${f.pair}-CACHED`] = {
      address: f.adapter,
      source: "cached-feed",
      underlyingAccount: f.pubkey,
    };
  }
  // PriceBook — one aggregated write, N per-feed BookFeedAdapter clones.
  // Keyed "-BOOK" so it never collides with the raw/cached entries above.
  // Additive: a deployments file without a PriceBook block emits nothing new.
  for (const f of deployments.PriceBook?.feeds ?? []) {
    feeds[`${f.pair}-BOOK`] = {
      address: f.adapter,
      source: "book",
      underlyingAccount: f.pubkey,
    };
  }

  return {
    factory: og.OracleAdapterFactory,
    ...(deployments.PriceBook && {
      priceBook: {
        address: deployments.PriceBook.address,
        implementation: deployments.PriceBook.implementation,
      },
    }),
    feeds,
  };
}

function buildContracts({
  deployments,
  contracts: prior,
  options,
}: EmitInput): RegistryContractsFile {
  const updateForName = (name: string): RegistryContractEntry => {
    const cfg = MANAGED_CONTRACTS.find((c) => c.name === name);
    if (!cfg) {
      // Unknown contract — shouldn't happen for the 4 managed ones, but
      // if a chain's contracts.json has other entries (e.g. legacy stuff)
      // we pass them through untouched.
      return prior.find((e) => e.name === name)!;
    }
    const newAddress = deployments.OracleGatewayV2[cfg.field] as string;
    const priorEntry = prior.find((e) => e.name === name);

    if (newAddress === undefined) {
      // Managed contract absent from this deployment (e.g. cached impls on a
      // chain that doesn't deploy them) — pass the prior entry through untouched.
      return priorEntry!;
    }

    if (!priorEntry) {
      return {
        name,
        versions: [
          {
            address: newAddress,
            version: "1.0.0",
            status: "live",
            deployedAt: options.deployedAt,
            sourceGitSha: options.sourceGitSha,
            compilerVersion: options.compilerVersion,
          },
        ],
      };
    }

    const liveVersion = priorEntry.versions.find((v) => v.status === "live");
    if (liveVersion && liveVersion.address.toLowerCase() === newAddress.toLowerCase()) {
      // Idempotent — current live version already matches deployment.
      return priorEntry;
    }

    // Address differs (or no live entry). Compute next version: max major + 1.
    const maxMajor = priorEntry.versions
      .map((v) => parseInt(v.version.split(".")[0], 10))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
    const nextVersion = `${maxMajor + 1}.0.0`;

    const updatedVersions: RegistryContractVersion[] = priorEntry.versions.map((v) =>
      v.status === "live"
        ? {
            ...v,
            status: "retired" as const,
            deprecatedAt: options.deployedAt,
            replacedBy: newAddress,
          }
        : v,
    );
    updatedVersions.unshift({
      address: newAddress,
      version: nextVersion,
      status: "live",
      deployedAt: options.deployedAt,
      sourceGitSha: options.sourceGitSha,
      compilerVersion: options.compilerVersion,
    });

    return { name, versions: updatedVersions };
  };

  // Preserve input order for entries already in the prior array.
  // Append new (managed) entries that didn't exist before, in alphabetical
  // order. This gives byte-equal output on idempotent runs.
  const out: RegistryContractsFile = [];
  const seenNames = new Set<string>();

  for (const entry of prior) {
    out.push(updateForName(entry.name));
    seenNames.add(entry.name);
  }
  for (const { name, field } of MANAGED_CONTRACTS) {
    if (!seenNames.has(name) && deployments.OracleGatewayV2[field] !== undefined) {
      out.push(updateForName(name));
    }
  }

  return out;
}
