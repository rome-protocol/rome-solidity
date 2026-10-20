// scripts/bridge/lib/build-provenance.ts
//
// Is the bytecode the deploy script is about to send really the bytecode of the sources on disk?
//
// `git status` says the sources are clean; it does not say the artifact was compiled from them
// (compile an experimental constructor, switch the sources back, and the stale artifact still
// loads). A Hardhat 3 artifact names its build-info (`buildInfoId`), and the build-info holds the
// exact compiler input: every source file's text, the settings, the solc version. So this
// compares that input with the files on disk (project sources under the repo root, npm sources
// under node_modules), with the build profile's settings and solc version, and the artifact's
// creation bytecode with the compiler output. Any difference is a problem the deploy refuses on.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface BuildProvenanceInput {
  /** The repo root: `project/<p>` sources live at `<root>/<p>`, `npm/<pkg>@<v>/<p>` at `<root>/node_modules/<pkg>/<p>`. */
  root: string;
  /** The artifacts directory (holds `build-info/`). */
  artifactsDir: string;
  /** From the artifact. */
  buildInfoId: string;
  inputSourceName: string;
  contractName: string;
  /** The creation bytecode the script will send (0x-prefixed). */
  artifactBytecode: string;
  /** The build profile's compiler version and settings (outputSelection and remappings are not compared). */
  expectedSolcVersion: string;
  expectedSettings: Record<string, unknown>;
}

export interface BuildProvenance {
  ok: boolean;
  /** Everything found wrong; empty when ok. */
  problems: string[];
  buildInfoId: string;
  solcVersion?: string;
}

const NPM_SOURCE = /^npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/;

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Deep equality for JSON values (key order does not matter). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameJson((a as any)[k], (b as any)[k]));
}

export function checkBuildProvenance(i: BuildProvenanceInput): BuildProvenance {
  const problems: string[] = [];
  const result = (solcVersion?: string): BuildProvenance => ({ ok: problems.length === 0, problems, buildInfoId: i.buildInfoId, solcVersion });
  if (!/^[A-Za-z0-9_.-]+$/.test(i.buildInfoId)) {
    problems.push(`the artifact names a build-info "${i.buildInfoId}" that is not a plain file name`);
    return result();
  }
  const info = readJson(path.join(i.artifactsDir, "build-info", `${i.buildInfoId}.json`));
  if (!info?.input?.sources) {
    problems.push(`the build-info ${i.buildInfoId} the artifact names cannot be read: compile again (npx hardhat compile)`);
    return result();
  }
  if (info.solcVersion !== i.expectedSolcVersion) problems.push(`the artifact was built with solc ${info.solcVersion}, the build profile says ${i.expectedSolcVersion}`);
  for (const [key, want] of Object.entries(i.expectedSettings)) {
    if (key === "outputSelection" || key === "remappings") continue;
    if (!sameJson(info.input.settings?.[key], want)) problems.push(`the artifact was built with settings.${key} = ${JSON.stringify(info.input.settings?.[key])}, the build profile says ${JSON.stringify(want)}`);
  }
  // Every source the compiler saw must read the same on disk now.
  const sources = info.input.sources as Record<string, { content?: string }>;
  const root = path.resolve(i.root);
  for (const [name, src] of Object.entries(sources)) {
    let file: string | undefined;
    if (name.startsWith("project/")) {
      file = path.resolve(root, name.slice("project/".length));
    } else {
      const m = NPM_SOURCE.exec(name);
      if (m) {
        const pkgDir = path.resolve(root, "node_modules", m[1]);
        const pkg = readJson(path.join(pkgDir, "package.json"));
        if (pkg?.version !== m[2]) {
          problems.push(`${name}: the artifact was built with ${m[1]}@${m[2]}, node_modules has ${m[1]}@${pkg?.version ?? "(not installed)"}`);
          continue;
        }
        file = path.resolve(pkgDir, m[3]);
      }
    }
    if (!file || !(file.startsWith(root + path.sep))) {
      problems.push(`${name}: not a source the check knows how to find on disk`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${name}: the artifact was built from it, it is not on disk any more`);
      continue;
    }
    if (readFileSync(file, "utf8") !== src.content) problems.push(`${name}: differs from what the artifact was compiled from (stale artifact: compile again)`);
  }
  if (!(i.inputSourceName in sources)) problems.push(`the build-info does not contain ${i.inputSourceName}`);
  // The artifact's creation bytecode is the compiler's output for that contract, not a stray file.
  const out = readJson(path.join(i.artifactsDir, "build-info", `${i.buildInfoId}.output.json`));
  const compiled = out?.output?.contracts?.[i.inputSourceName]?.[i.contractName]?.evm?.bytecode?.object;
  if (typeof compiled !== "string") problems.push(`the compiler output of ${i.buildInfoId} has no bytecode for ${i.contractName}`);
  else if (`0x${compiled}`.toLowerCase() !== i.artifactBytecode.toLowerCase()) problems.push(`the artifact's creation bytecode is not the compiler output of ${i.buildInfoId}`);
  return result(info.solcVersion);
}
