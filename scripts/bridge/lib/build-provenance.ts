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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ── Dependency contents against the lockfile ───────────────────────────────
//
// checkBuildProvenance ties the compiler input to the files on disk, and stops at node_modules: a
// locally patched dependency (same version, same lockfile) passes it. This closes that gap without
// trusting node_modules at all. For every npm package the compiler read, the check takes the
// lockfile's entry (version, registry URL, sha512 integrity), downloads that tarball, requires its
// sha512 to equal the lockfile's integrity, and compares every compiler-input file of that package
// byte for byte with the file in the tarball. Whatever sits in node_modules, the bytes the compiler
// saw are the bytes of the locked package. (Why not just verify node_modules/.package-lock.json: it only
// repeats versions and tarball hashes; it says nothing about the files on disk.) Only the registry
// host is accepted, and a package the lockfile cannot vouch for (a git dependency, a missing or non-sha512
// integrity, another version) is a problem, never skipped.

export interface DependencySourcesInput {
  root: string;
  artifactsDir: string;
  buildInfoId: string;
  /** Downloads a tarball. Only URLs this check has already restricted to the npm registry are passed. */
  fetchTarball(url: string): Promise<Buffer>;
}

const REGISTRY_PREFIX = "https://registry.npmjs.org/";

/** Contact sent with the tarball download, the project's own (never a person's). */
export const DOWNLOAD_USER_AGENT = "rome-solidity deploy check (rome@romeprotocol.com)";

/** The real download: Node's fetch, with a timeout. The sha512 of the answer is checked against the lockfile, so the transport is not trusted. */
export async function fetchTarballFromRegistry(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": DOWNLOAD_USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function checkDependencySources(i: DependencySourcesInput): Promise<string[]> {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_.-]+$/.test(i.buildInfoId)) return [`the artifact names a build-info "${i.buildInfoId}" that is not a plain file name`];
  const info = readJson(path.join(i.artifactsDir, "build-info", `${i.buildInfoId}.json`));
  if (!info?.input?.sources) return [`the build-info ${i.buildInfoId} cannot be read: compile again (npx hardhat compile)`];
  const lock = readJson(path.join(i.root, "package-lock.json"));
  if (!lock?.packages) return ["package-lock.json cannot be read, so the dependencies cannot be checked against it"];

  // package@version -> the files the compiler read from it (path inside the package, and the text it saw)
  const wanted = new Map<string, { name: string; version: string; files: Array<{ rel: string; content: string; source: string }> }>();
  for (const [source, src] of Object.entries(info.input.sources as Record<string, { content?: string }>)) {
    const m = NPM_SOURCE.exec(source);
    if (!m) continue;
    const rel = m[3];
    if (rel.split("/").some((p) => p === ".." || p === "" || p === ".")) { problems.push(`${source}: not a plain path inside the package`); continue; }
    const key = `${m[1]}@${m[2]}`;
    if (!wanted.has(key)) wanted.set(key, { name: m[1], version: m[2], files: [] });
    wanted.get(key)!.files.push({ rel, content: src.content ?? "", source });
  }

  for (const { name, version, files } of wanted.values()) {
    const entry = lock.packages[`node_modules/${name}`];
    const id = `${name}@${version}`;
    if (!entry) { problems.push(`${id}: package-lock.json has no entry for it`); continue; }
    if (entry.version !== version) { problems.push(`${id}: package-lock.json locks ${name}@${entry.version}`); continue; }
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY_PREFIX)) { problems.push(`${id}: package-lock.json does not resolve it to the npm registry (${String(entry.resolved)}), so it cannot be checked`); continue; }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) { problems.push(`${id}: package-lock.json has no sha512 integrity for it`); continue; }
    let tgz: Buffer;
    try {
      tgz = await i.fetchTarball(entry.resolved);
    } catch (e) {
      problems.push(`${id}: the locked tarball could not be downloaded for the check (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    if (`sha512-${createHash("sha512").update(tgz).digest("base64")}` !== entry.integrity) {
      problems.push(`${id}: the downloaded tarball does not match the lockfile's integrity`);
      continue;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "dep-sources-"));
    try {
      writeFileSync(path.join(dir, "package.tgz"), tgz);
      execFileSync("tar", ["-xzf", "package.tgz", "-C", dir, "--no-same-owner"], { cwd: dir, stdio: "pipe" });
      for (const f of files) {
        const file = path.join(dir, "package", f.rel);
        let ok = false;
        try { ok = lstatSync(file).isFile() && readFileSync(file).equals(Buffer.from(f.content, "utf8")); } catch { /* absent */ }
        if (!ok) problems.push(`${f.source}: the compiler read text that is not in the locked ${id} package (a patched or replaced dependency)`);
      }
    } catch (e) {
      problems.push(`${id}: the locked tarball could not be unpacked (${(e as Error).message.split("\n")[0]})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return problems;
}
