import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitRegistryUpdate,
  type DeploymentsFile,
  type RegistryOracleFile,
  type RegistryContractsFile,
  type EmitOptions,
} from "./emit-registry-update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8"));
}

const HADRIAN_DEPLOYMENTS = readFixture("deployments-hadrian-sample.json") as DeploymentsFile;

const META: EmitOptions = {
  sourceGitSha: "4d67b384642063ab27fc20a890c12de78661568e",
  compilerVersion: "0.8.28+commit.7893614a",
  deployedAt: "2026-05-21T02:57:14.616Z",
};

// Empty stub state — what registry looks like for a never-deployed chain.
const EMPTY_ORACLE: RegistryOracleFile = {
  factory: "0x0000000000000000000000000000000000000000",
  feeds: {},
};
const EMPTY_CONTRACTS: RegistryContractsFile = [];

describe("emitRegistryUpdate — oracle.json output", () => {
  it("populates factory from deployments OracleAdapterFactory", () => {
    const { oracle } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    expect(oracle.factory).toBe("0x9be249718c5c066d98fead6bfbb214ca0787f870");
  });

  it("emits one feed per pyth entry, keyed by pair", () => {
    const { oracle } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    expect(oracle.feeds["SOL/USD"]).toEqual({
      address: "0x63C28E0adE03B38e32b9cD85f2dD9B9fbB89185F",
      source: "pyth",
      underlyingAccount: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
    });
    expect(oracle.feeds["BTC/USD"]).toEqual({
      address: "0x7e35f232C8f1cB0eDE5BEddb8Ebe7110C29a6E81",
      source: "pyth",
      underlyingAccount: "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
    });
  });

  it("suffixes switchboard feeds with -SB to disambiguate from pyth", () => {
    const { oracle } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    expect(oracle.feeds["SOL/USD-SB"]).toEqual({
      address: "0xffD0586Ff206C95e6ff365da9EDf0524eA1F61db",
      source: "switchboard",
      underlyingAccount: "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR",
    });
  });

  it("is deterministic — same inputs produce same output", () => {
    const a = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    const b = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    expect(a.oracle).toEqual(b.oracle);
    expect(a.contracts).toEqual(b.contracts);
  });
});

describe("emitRegistryUpdate — contracts.json output (greenfield)", () => {
  it("creates 4 entries (factory + 2 impls + batch reader) at v1.0.0", () => {
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    const names = contracts.map((c) => c.name).sort();
    expect(names).toEqual([
      "BatchReader",
      "OracleAdapterFactory",
      "PythPullAdapterImpl",
      "SwitchboardV3AdapterImpl",
    ]);
    for (const entry of contracts) {
      expect(entry.versions).toHaveLength(1);
      expect(entry.versions[0].status).toBe("live");
      expect(entry.versions[0].version).toBe("1.0.0");
      expect(entry.versions[0].sourceGitSha).toBe(META.sourceGitSha);
      expect(entry.versions[0].compilerVersion).toBe(META.compilerVersion);
      expect(entry.versions[0].deployedAt).toBe(META.deployedAt);
    }
  });

  it("addresses match deployments file exactly", () => {
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    const byName = Object.fromEntries(
      contracts.map((c) => [c.name, c.versions[0].address]),
    );
    expect(byName["OracleAdapterFactory"]).toBe("0x9be249718c5c066d98fead6bfbb214ca0787f870");
    expect(byName["PythPullAdapterImpl"]).toBe("0xea0bc9643c462fafc470873f85ee57d1ac2bbcaf");
    expect(byName["SwitchboardV3AdapterImpl"]).toBe("0x43cbe9c67e35c7f401fa76d8ce06595e004d2a63");
    expect(byName["BatchReader"]).toBe("0xc1224fe8d9eaeef34376ff4b24db360d5e10163e");
  });
});

describe("emitRegistryUpdate — contracts.json output (redeploy onto existing)", () => {
  const PRIOR: RegistryContractsFile = [
    {
      name: "OracleAdapterFactory",
      versions: [
        {
          address: "0xdc4de76da5508a0f53a302451ebcc6fc156c19b9",
          version: "1.0.0",
          status: "live",
          deployedAt: "2026-05-20T13:19:00Z",
          sourceGitSha: "abc1234",
          compilerVersion: "0.8.28+commit.7893614a",
        },
      ],
    },
    {
      name: "PythPullAdapterImpl",
      versions: [
        {
          address: "0x731d22d69e686ea3f407600984d794e4046fa4d8",
          version: "1.0.0",
          status: "live",
          deployedAt: "2026-05-20T13:19:00Z",
          sourceGitSha: "abc1234",
          compilerVersion: "0.8.28+commit.7893614a",
        },
      ],
    },
    {
      name: "SwitchboardV3AdapterImpl",
      versions: [
        {
          address: "0x39946f23e4931d5d14dfdf415c2d10345b528ef3",
          version: "1.0.0",
          status: "live",
          deployedAt: "2026-05-20T13:19:00Z",
          sourceGitSha: "abc1234",
          compilerVersion: "0.8.28+commit.7893614a",
        },
      ],
    },
    {
      name: "BatchReader",
      versions: [
        {
          address: "0xfe4275443771932f766bf959b4d0244c8f4652be",
          version: "1.0.0",
          status: "live",
          deployedAt: "2026-05-20T13:19:00Z",
          sourceGitSha: "abc1234",
          compilerVersion: "0.8.28+commit.7893614a",
        },
      ],
    },
  ];

  it("retires previous live version when address differs", () => {
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: { factory: "0xdc4de76da5508a0f53a302451ebcc6fc156c19b9", feeds: {} },
      contracts: PRIOR,
      options: META,
    });
    const factory = contracts.find((c) => c.name === "OracleAdapterFactory")!;
    expect(factory.versions).toHaveLength(2);
    const v1 = factory.versions.find((v) => v.version === "1.0.0")!;
    expect(v1.status).toBe("retired");
    expect(v1.deprecatedAt).toBe(META.deployedAt);
    expect(v1.replacedBy).toBe("0x9be249718c5c066d98fead6bfbb214ca0787f870");
    const v2 = factory.versions.find((v) => v.version === "2.0.0")!;
    expect(v2.status).toBe("live");
    expect(v2.address).toBe("0x9be249718c5c066d98fead6bfbb214ca0787f870");
  });

  it("is idempotent — no change when address already matches", () => {
    // Build prior state with TODAY's addresses (i.e. registry already up to date).
    const upToDate: RegistryContractsFile = [
      {
        name: "OracleAdapterFactory",
        versions: [
          {
            address: HADRIAN_DEPLOYMENTS.OracleGatewayV2.OracleAdapterFactory,
            version: "1.0.0",
            status: "live",
            deployedAt: META.deployedAt,
            sourceGitSha: META.sourceGitSha,
            compilerVersion: META.compilerVersion,
          },
        ],
      },
      {
        name: "PythPullAdapterImpl",
        versions: [
          {
            address: HADRIAN_DEPLOYMENTS.OracleGatewayV2.PythPullAdapterImpl,
            version: "1.0.0",
            status: "live",
            deployedAt: META.deployedAt,
            sourceGitSha: META.sourceGitSha,
            compilerVersion: META.compilerVersion,
          },
        ],
      },
      {
        name: "SwitchboardV3AdapterImpl",
        versions: [
          {
            address: HADRIAN_DEPLOYMENTS.OracleGatewayV2.SwitchboardV3AdapterImpl,
            version: "1.0.0",
            status: "live",
            deployedAt: META.deployedAt,
            sourceGitSha: META.sourceGitSha,
            compilerVersion: META.compilerVersion,
          },
        ],
      },
      {
        name: "BatchReader",
        versions: [
          {
            address: HADRIAN_DEPLOYMENTS.OracleGatewayV2.BatchReader,
            version: "1.0.0",
            status: "live",
            deployedAt: META.deployedAt,
            sourceGitSha: META.sourceGitSha,
            compilerVersion: META.compilerVersion,
          },
        ],
      },
    ];
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: {
        factory: HADRIAN_DEPLOYMENTS.OracleGatewayV2.OracleAdapterFactory,
        feeds: {},
      },
      contracts: upToDate,
      options: META,
    });
    // Should equal the input — no new version added.
    expect(contracts).toEqual(upToDate);
  });

  it("preserves prior retired versions across multiple redeploys", () => {
    const twoVersions: RegistryContractsFile = [
      {
        name: "OracleAdapterFactory",
        versions: [
          {
            address: "0xnewly_live_aaaa00000000000000000000000000000001",
            version: "2.0.0",
            status: "live",
            deployedAt: "2026-05-18T05:30:00Z",
            sourceGitSha: "def5678",
            compilerVersion: "0.8.28+commit.7893614a",
          },
          {
            address: "0xprior_retired_b00000000000000000000000000000001",
            version: "1.0.0",
            status: "retired",
            deployedAt: "2026-05-14T09:55:00Z",
            deprecatedAt: "2026-05-18T05:30:00Z",
            replacedBy: "0xnewly_live_aaaa00000000000000000000000000000001",
            sourceGitSha: "abc1234",
            compilerVersion: "0.8.28+commit.7893614a",
          },
        ],
      },
    ];
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: twoVersions,
      options: META,
    });
    const factory = contracts.find((c) => c.name === "OracleAdapterFactory")!;
    expect(factory.versions).toHaveLength(3); // 2 old + 1 new
    const v3 = factory.versions.find((v) => v.version === "3.0.0")!;
    expect(v3.status).toBe("live");
    expect(v3.address).toBe(HADRIAN_DEPLOYMENTS.OracleGatewayV2.OracleAdapterFactory);
    // Prior retired entry is untouched
    const v1 = factory.versions.find((v) => v.version === "1.0.0")!;
    expect(v1.status).toBe("retired");
    expect(v1.deprecatedAt).toBe("2026-05-18T05:30:00Z");
  });
});

describe("emitRegistryUpdate — preserves non-managed contracts.json entries", () => {
  it("passes through ERC20SPLFactory, Multicall3, and any other unmanaged entries untouched", () => {
    // Mimic a real Hadrian contracts.json that has many non-OG entries.
    const realisticPrior: RegistryContractsFile = [
      {
        name: "ERC20SPLFactory",
        versions: [
          {
            address: "0x3c971ea1c7cf7a1b0a8af46f8a9e0648a82f9869",
            version: "3.0.0",
            status: "live",
            deployedAt: "2026-05-18T05:30:00Z",
            sourceGitSha: "506961ed1fe4f368a4c6a8793960a754b777b9fd",
            compilerVersion: "0.8.28+commit.7893614a",
          },
        ],
      },
      {
        name: "Multicall3",
        versions: [
          {
            address: "0x000000000000000000000000000000000000ca11",
            version: "3.0.0",
            status: "live",
            deployedAt: "2026-05-21T04:49:00Z",
            sourceGitSha: "deadbeef",
            compilerVersion: "0.8.28+commit.7893614a",
          },
        ],
      },
      {
        name: "RomeBridgePaymaster",
        versions: [
          {
            address: "0xe5b515d69590044a994d88c8bb8a87b36cd7b6d2",
            version: "3.0.0",
            status: "live",
            deployedAt: "2026-05-18T05:30:00Z",
            sourceGitSha: "506961ed1fe4f368a4c6a8793960a754b777b9fd",
            compilerVersion: "0.8.28+commit.7893614a",
          },
        ],
      },
    ];
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: realisticPrior,
      options: META,
    });
    // The 3 non-managed entries should pass through unchanged
    const erc20 = contracts.find((c) => c.name === "ERC20SPLFactory")!;
    const multicall = contracts.find((c) => c.name === "Multicall3")!;
    const paymaster = contracts.find((c) => c.name === "RomeBridgePaymaster")!;
    expect(erc20).toEqual(realisticPrior[0]);
    expect(multicall).toEqual(realisticPrior[1]);
    expect(paymaster).toEqual(realisticPrior[2]);
    // The 4 managed entries should be appended (since they weren't in prior)
    const managedNames = contracts
      .filter((c) =>
        ["BatchReader", "OracleAdapterFactory", "PythPullAdapterImpl", "SwitchboardV3AdapterImpl"].includes(c.name),
      )
      .map((c) => c.name);
    expect(managedNames.sort()).toEqual([
      "BatchReader",
      "OracleAdapterFactory",
      "PythPullAdapterImpl",
      "SwitchboardV3AdapterImpl",
    ]);
    // Total entries: 3 preserved + 4 new = 7
    expect(contracts).toHaveLength(7);
    // Non-managed entries appear FIRST (in input order); managed entries appended.
    expect(contracts[0].name).toBe("ERC20SPLFactory");
    expect(contracts[1].name).toBe("Multicall3");
    expect(contracts[2].name).toBe("RomeBridgePaymaster");
  });

  it("preserves non-managed entries even on a redeploy that retires managed ones", () => {
    const mixedPrior: RegistryContractsFile = [
      {
        name: "Multicall3",
        versions: [
          {
            address: "0x000000000000000000000000000000000000ca11",
            version: "3.0.0",
            status: "live",
            deployedAt: "2026-05-21T04:49:00Z",
            sourceGitSha: "deadbeef",
            compilerVersion: "0.8.28+commit.7893614a",
          },
        ],
      },
      {
        name: "OracleAdapterFactory",
        versions: [
          {
            address: "0xold_factory_address0000000000000000000000",
            version: "1.0.0",
            status: "live",
            deployedAt: "2026-05-20T00:00:00Z",
            sourceGitSha: "old",
            compilerVersion: "0.8.28+commit.7893614a",
          },
        ],
      },
    ];
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: mixedPrior,
      options: META,
    });
    const multicall = contracts.find((c) => c.name === "Multicall3")!;
    expect(multicall).toEqual(mixedPrior[0]); // unchanged
    const factory = contracts.find((c) => c.name === "OracleAdapterFactory")!;
    expect(factory.versions).toHaveLength(2); // 1 retired + 1 new live
    expect(factory.versions.find((v) => v.version === "2.0.0")!.status).toBe("live");
    expect(factory.versions.find((v) => v.version === "1.0.0")!.status).toBe("retired");
  });
});

describe("emitRegistryUpdate — cached feeds", () => {
  const ETH_PYTH =
    "0x2cfad277afcaa867c7d7fe26e0d51dc899101335879ab63c2aa84876317135bb" as `0x${string}`;
  const withCached: DeploymentsFile = {
    OracleGatewayV2: {
      ...HADRIAN_DEPLOYMENTS.OracleGatewayV2,
      CachedPythAdapterImpl: "0xaaaa000000000000000000000000000000000001",
      CachedFeedAdapterImpl: "0xbbbb000000000000000000000000000000000002",
      feeds: {
        ...HADRIAN_DEPLOYMENTS.OracleGatewayV2.feeds,
        cachedPyth: [
          {
            pair: "ETH/USD",
            adapter: "0xccc0000000000000000000000000000000000003",
            pubkey: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC",
            pubkeyBytes32: ETH_PYTH,
          },
        ],
        cachedFeed: [
          {
            pair: "ETH/USD",
            adapter: "0xddd0000000000000000000000000000000000004",
            pubkey: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC",
            pubkeyBytes32: ETH_PYTH,
          },
        ],
      },
    },
  };

  it("emits Pyth-specific cached feeds keyed <PAIR>-CACHEDPYTH", () => {
    const { oracle } = emitRegistryUpdate({
      deployments: withCached,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    expect(oracle.feeds["ETH/USD-CACHEDPYTH"]).toEqual({
      address: "0xccc0000000000000000000000000000000000003",
      source: "cached-pyth",
      underlyingAccount: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC",
    });
  });

  it("emits generic cached feeds keyed <PAIR>-CACHED", () => {
    const { oracle } = emitRegistryUpdate({
      deployments: withCached,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    expect(oracle.feeds["ETH/USD-CACHED"]).toEqual({
      address: "0xddd0000000000000000000000000000000000004",
      source: "cached-feed",
      underlyingAccount: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC",
    });
  });

  it("tracks CachedPythAdapterImpl + CachedFeedAdapterImpl in contracts.json when present", () => {
    const { contracts } = emitRegistryUpdate({
      deployments: withCached,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    const names = contracts.map((c) => c.name);
    expect(names).toContain("CachedPythAdapterImpl");
    expect(names).toContain("CachedFeedAdapterImpl");
  });

  it("does NOT add cached impls for a deployment that lacks them (backward-compat)", () => {
    const { contracts } = emitRegistryUpdate({
      deployments: HADRIAN_DEPLOYMENTS,
      oracle: EMPTY_ORACLE,
      contracts: EMPTY_CONTRACTS,
      options: META,
    });
    const names = contracts.map((c) => c.name);
    expect(names).not.toContain("CachedPythAdapterImpl");
    expect(names).not.toContain("CachedFeedAdapterImpl");
  });
});
