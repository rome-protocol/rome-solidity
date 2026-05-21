#!/usr/bin/env -S npx tsx
// CLI wrapper for emit-registry-update. Designed to be invoked from the
// contract-deploys oracle-deploy.yml workflow.
//
// Usage:
//   npx tsx scripts/oracle/emit-registry-update-cli.ts \
//     --network <slug> \
//     --registry-path <path-to-registry-checkout> \
//     --source-git-sha <sha> \
//     [--compiler-version <semver>] \
//     [--deployments-path <path>]
//
// Reads:
//   - <deployments-path> | default: deployments/<network>.json
//   - <registry-path>/chains/<slug>/oracle.json
//   - <registry-path>/chains/<slug>/contracts.json
//
// Writes updated versions IN PLACE back to the registry path. The workflow
// then uses peter-evans/create-pull-request to PR them.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  emitRegistryUpdate,
  type DeploymentsFile,
  type RegistryOracleFile,
  type RegistryContractsFile,
} from "./lib/emit-registry-update.js";

interface Args {
  network: string;
  registryPath: string;
  sourceGitSha: string;
  compilerVersion: string;
  deploymentsPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--network") args.network = v, i++;
    else if (k === "--registry-path") args.registryPath = v, i++;
    else if (k === "--source-git-sha") args.sourceGitSha = v, i++;
    else if (k === "--compiler-version") args.compilerVersion = v, i++;
    else if (k === "--deployments-path") args.deploymentsPath = v, i++;
  }
  if (!args.network || !args.registryPath || !args.sourceGitSha) {
    throw new Error(
      "missing required arg(s); need --network, --registry-path, --source-git-sha",
    );
  }
  return {
    network: args.network,
    registryPath: args.registryPath,
    sourceGitSha: args.sourceGitSha,
    compilerVersion: args.compilerVersion ?? "0.8.28+commit.7893614a",
    deploymentsPath: args.deploymentsPath ?? `deployments/${args.network}.json`,
  };
}

/** Locate the chain directory in registry/chains by slug suffix (handles `<chainId>-<slug>` convention). */
function resolveChainDir(registryPath: string, network: string): string {
  const chainsDir = join(registryPath, "chains");
  const candidates = readdirSync(chainsDir).filter(
    (d) => d.endsWith(`-${network}`) || d === network,
  );
  if (candidates.length === 0) {
    throw new Error(
      `no registry chain dir found for network="${network}" under ${chainsDir}; ` +
        `expected a dir ending in "-${network}" (e.g. "200010-hadrian")`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `multiple registry chain dirs match network="${network}": ${candidates.join(", ")}`,
    );
  }
  return join(chainsDir, candidates[0]);
}

function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const deployments = JSON.parse(
    readFileSync(args.deploymentsPath, "utf8"),
  ) as DeploymentsFile;

  if (!deployments.OracleGatewayV2) {
    console.error(
      `deployments file ${args.deploymentsPath} has no OracleGatewayV2 block; nothing to emit`,
    );
    process.exit(0); // Soft-exit — non-oracle deploy isn't a failure for this CLI.
  }

  const chainDir = resolveChainDir(args.registryPath, args.network);
  const oraclePath = join(chainDir, "oracle.json");
  const contractsPath = join(chainDir, "contracts.json");

  const oracle = readJsonOrDefault<RegistryOracleFile>(oraclePath, {
    factory: "0x0000000000000000000000000000000000000000",
    feeds: {},
  });
  const contracts = readJsonOrDefault<RegistryContractsFile>(contractsPath, []);

  const { oracle: newOracle, contracts: newContracts } = emitRegistryUpdate({
    deployments,
    oracle,
    contracts,
    options: {
      sourceGitSha: args.sourceGitSha,
      compilerVersion: args.compilerVersion,
      deployedAt: deployments.OracleGatewayV2.deployedAt,
    },
  });

  // Pretty-printed 2-space indent to match the existing registry house style.
  writeFileSync(oraclePath, JSON.stringify(newOracle, null, 2) + "\n");
  writeFileSync(contractsPath, JSON.stringify(newContracts, null, 2) + "\n");

  // Emit summary lines the workflow can grep for / display in the run log.
  console.log(`[emit-registry-update] wrote ${oraclePath}`);
  console.log(`[emit-registry-update] wrote ${contractsPath}`);
}

main();
