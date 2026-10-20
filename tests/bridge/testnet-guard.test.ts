import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  EXTRA_ENV, MAINNET_FLAG, RUBICON_V13_DEPLOY_SCRIPT, assertRubiconV13DeploySend, assertSolanaTestnetRpc, entryScript, assertTestnetChainId, assertTestnetRpc, assertTestnetSend, judgeChain, judgeRubiconV13Deploy, judgeSolanaGenesis,
  parseExtraChainIds,
} from "../../scripts/bridge/lib/testnet-guard.js";
import { resolveBurnAmount, resolveBurnRecipient } from "../../scripts/bridge/lib/burn-recipient.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../..");

describe("judgeChain (fail closed on the chain id the RPC reports)", () => {
  it("allows the known testnets", () => {
    for (const id of [200010, 121214, 121213, 121302, 210000, 31337]) assert.equal(judgeChain(id).allowed, true, String(id));
  });
  it("refuses Rubicon (7531) and says it is mainnet", () => {
    const v = judgeChain(7531);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /mainnet/);
  });
  it("refuses a chain id nobody listed", () => {
    assert.equal(judgeChain(1).allowed, false);
    assert.equal(judgeChain(7532).allowed, false);
    assert.match(judgeChain(424242).reason, /not on the testnet allowlist/);
  });
  it("refuses an unreadable or unusable chain id", () => {
    for (const bad of [undefined, NaN, 0, -1, 1.5, Infinity]) assert.equal(judgeChain(bad as number | undefined).allowed, false, String(bad));
  });
  it("lets a local stack in only when its id is listed on purpose", () => {
    assert.equal(judgeChain(9090).allowed, false);
    assert.equal(judgeChain(9090, "9090").allowed, true);
    assert.equal(judgeChain(9090, " 1 , 9090 ").allowed, true);
    assert.equal(judgeChain(9091, "9090").allowed, false);
  });
  it("never lets the extra list unlock mainnet", () => {
    assert.equal(judgeChain(7531, "7531").allowed, false);
    assert.equal(judgeChain(7531, "1,7531,200010").allowed, false);
  });
  it("ignores garbage in the extra list (fails closed)", () => {
    assert.deepEqual([...parseExtraChainIds("abc, -5, 1.5, 0, 0x10, ,12")], [12]);
    assert.equal(judgeChain(16, "0x10").allowed, false);
  });
});

describe("assertTestnetSend / assertTestnetRpc read the live chain id, whatever the network is called", () => {
  const client = (id: number | Error) => ({ getChainId: async () => { if (id instanceof Error) throw id; return id; } });
  const rpc = (result: unknown, ok = true) => (async () => ({ ok, json: async () => ({ jsonrpc: "2.0", id: 1, result }) })) as unknown as typeof fetch;

  it("passes a testnet and returns its id", async () => {
    assert.equal(await assertTestnetSend(client(200010), "t"), 200010);
  });
  it("refuses Rubicon even when the script thinks it is on 'hadrian'", async () => {
    await assert.rejects(assertTestnetSend(client(7531), "hadrian deploy"), /hadrian deploy.*mainnet/);
  });
  it("refuses when the RPC does not answer", async () => {
    await assert.rejects(assertTestnetSend(client(new Error("ECONNREFUSED")), "t"), /cannot read the chain id.*refusing to send/);
  });
  it("assertTestnetChainId throws with the script name", () => {
    assert.throws(() => assertTestnetChainId(7531, "set-wormhole-allowlist", undefined), /set-wormhole-allowlist/);
    assert.doesNotThrow(() => assertTestnetChainId(200010, "x", undefined));
  });
  it("assertTestnetRpc: 0x30d4a (200010) passes, 0x1d6b (7531) and unknown ids are refused", async () => {
    assert.equal(await assertTestnetRpc("http://x", "t", rpc("0x30d4a"), undefined), 200010);
    await assert.rejects(assertTestnetRpc("http://x", "t", rpc("0x1d6b"), undefined), /mainnet/);
    await assert.rejects(assertTestnetRpc("http://x", "t", rpc("0x1"), undefined), /not on the testnet allowlist/);
  });
  it("assertTestnetRpc: a non-hex answer, an error body or a thrown fetch is refused", async () => {
    await assert.rejects(assertTestnetRpc("http://x", "t", rpc("200010"), undefined), /usable chain id/);
    await assert.rejects(assertTestnetRpc("http://x", "t", rpc(undefined), undefined), /usable chain id/);
    await assert.rejects(assertTestnetRpc("http://x", "t", (async () => { throw new Error("boom"); }) as unknown as typeof fetch, undefined), /refusing to send/);
  });
  it("the env var name is the documented one", () => {
    assert.equal(EXTRA_ENV, "ROME_EXTRA_TESTNET_CHAIN_IDS");
  });
});

describe("Solana side: devnet or testnet genesis only", () => {
  const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const rpc = (result: unknown) => (async () => ({ ok: true, json: async () => ({ result }) })) as unknown as typeof fetch;
  it("judges the genesis hash", () => {
    assert.equal(judgeSolanaGenesis(DEVNET).allowed, true);
    assert.equal(judgeSolanaGenesis(MAINNET).allowed, false);
    assert.equal(judgeSolanaGenesis("nope").allowed, false);
    assert.equal(judgeSolanaGenesis(undefined).allowed, false);
  });
  it("asserts it over RPC", async () => {
    assert.equal(await assertSolanaTestnetRpc("http://x", "t", rpc(DEVNET)), DEVNET);
    await assert.rejects(assertSolanaTestnetRpc("http://x", "t", rpc(MAINNET)), /not devnet or testnet/);
    await assert.rejects(assertSolanaTestnetRpc("http://x", "t", (async () => { throw new Error("x"); }) as unknown as typeof fetch), /refusing to send/);
  });
});

describe("every script that sends is behind the guard", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|mjs)$/.test(name)) out.push(full);
    }
    return out;
  }
  // Viem / web3.js / hardhat send calls, plus the ethers ones: a contract-method send in
  // ethers is `const tx = await tm.depositForBurn(...); await tx.wait()`, which has no
  // "send" in its name, so it is recognised by what every ethers send ends in (a `.wait(`
  // on the returned response, also `await (await usdc.approve(...)).wait()`) and by a
  // Contract built with a signer (`new Contract(addr, abi, signer)`) or `getSigner(`.
  // A bare `new Wallet(` is not a marker: smoke-emulate-all.ts signs but only emulates.
  const SEND_CALLS = /sendTransaction\(|deployContract\(|writeContract\(|\.write\.|sendRawTransaction|sendAndConfirmTransaction/;
  const ETHERS_SEND = /\.wait\(\s*\d*\s*\)|\.getSigner\(|new\s+(?:ethers\.)?Contract\([^)]*,\s*(?:signer|wallet)\s*\)/;
  const SEND = new RegExp(`${SEND_CALLS.source}|${ETHERS_SEND.source}`);
  // assertRubiconV13DeploySend is the one mainnet exception; its own describe block below
  // proves that no file but deploy-rubicon-v13.ts may use it.
  const GUARD = /assertTestnet(Send|Rpc|ChainId)\(|assertSolanaTestnetRpc\(|canSend\(|assertRubiconV13DeploySend\(/;
  /** Scripts that send only on a hard-coded Sepolia RPC (an Ethereum testnet), never on a Rome chain or Solana. */
  const SEPOLIA_ONLY = new Set(["inbound/01-submit-deposit.mjs", "inbound/01b-submit-whETH.mjs"]);

  /** The files with a send site that are neither guarded in order nor on the Sepolia-only list. */
  function unguarded(entries: ReadonlyArray<readonly [string, string]>, sepoliaOnly: ReadonlySet<string>): string[] {
    const open: string[] = [];
    for (const [rel, src] of entries) {
      if (!SEND.test(src) || sepoliaOnly.has(rel.split(path.sep).join("/"))) continue;
      const g = src.search(GUARD);
      if (g < 0) { open.push(rel); continue; }
      // A top-level script has no function boundary: the guard must come first.
      if (!/function main\(|const main\s*=/.test(src) && g > src.search(SEND)) open.push(rel);
    }
    return open;
  }

  const files = walk(path.join(repo, "scripts/bridge"))
    .filter((f) => !f.includes(`${path.sep}lib${path.sep}`)) // helpers, no entry points
    .map((f) => [path.relative(path.join(repo, "scripts/bridge"), f), readFileSync(f, "utf8")] as const);

  it("finds the send sites at all (the scan is not vacuous)", () => {
    assert.ok(files.filter(([, src]) => SEND.test(src)).length >= 15);
  });
  it("each file with a send site calls the guard, and a script without a main() calls it before its first send", () => {
    assert.deepEqual(unguarded(files, SEPOLIA_ONLY), [], "scripts that can send without the testnet guard");
  });
  it("the scan sees ethers-only senders: both Sepolia-only scripts are send sites, so their exception is really used", () => {
    for (const rel of SEPOLIA_ONLY) {
      const src = files.find(([r]) => r.split(path.sep).join("/") === rel)?.[1];
      assert.ok(src, `${rel} exists`);
      assert.equal(SEND_CALLS.test(src), false, `${rel} has no viem/web3 send call: only the ethers markers can catch it`);
      assert.equal(SEND.test(src), true, `${rel} must be recognised as a send site`);
      // Without the exception they would be reported as unguarded.
      assert.deepEqual(unguarded([[rel, src]], new Set()), [rel]);
      assert.deepEqual(unguarded([[rel, src]], SEPOLIA_ONLY), []);
    }
  });
  it("a future ethers-only sender with no guard is caught, and one that guards first is not", () => {
    const ethersOnly = [
      'import { Wallet, JsonRpcProvider, Contract } from "ethers";',
      "const signer = new Wallet(key, new JsonRpcProvider(process.env.RPC));",
      'const tm = new Contract(TM, ABI, signer);',
      "const tx = await tm.depositForBurn(amount, 0, mintRecipient, usdc);",
      "await tx.wait();",
    ].join("\n");
    assert.deepEqual(unguarded([["new-sender.ts", ethersOnly]], SEPOLIA_ONLY), ["new-sender.ts"]);
    // Only a contract-method send and a .wait(): no Wallet or Contract constructor in this file.
    const waitOnly = 'const tx = await tm.depositForBurn(a, 0, r, u);\nawait tx.wait();\n';
    assert.deepEqual(unguarded([["wait-only.mjs", waitOnly]], SEPOLIA_ONLY), ["wait-only.mjs"]);
    // A Contract built with a signer is a marker on its own (a send that is never awaited).
    const noWait = 'const tm = new Contract(TM, ABI, signer);\ntm.depositForBurn(a, 0, r, u);\n';
    assert.deepEqual(unguarded([["no-wait.mjs", noWait]], SEPOLIA_ONLY), ["no-wait.mjs"]);
    // Signing and emulating only (smoke-emulate-all.ts) is not a send.
    assert.deepEqual(unguarded([["emulate.ts", "const wallet = new Wallet(pk, provider);\nconst signed = await wallet.signTransaction(tx);"]], SEPOLIA_ONLY), []);
    // Guard after the send in a top-level script is still open.
    assert.deepEqual(unguarded([["late.mjs", `${waitOnly}await assertTestnetRpc(url, "late");`]], SEPOLIA_ONLY), ["late.mjs"]);
    // Guard first, then the send.
    assert.deepEqual(unguarded([["ok.mjs", `await assertTestnetRpc(url, "ok");\n${waitOnly}`]], SEPOLIA_ONLY), []);
    // The exception is by path only: the same code under another name is not exempt.
    assert.deepEqual(unguarded([["inbound/other.mjs", ethersOnly]], SEPOLIA_ONLY), ["inbound/other.mjs"]);
  });
  it("e2e-all-four and outbound-wh-e2e check the Rome RPC before they load a key", () => {
    for (const f of ["e2e-all-four.ts", "outbound-wh-e2e.ts"]) {
      const src = readFileSync(path.join(repo, "scripts/bridge", f), "utf8");
      const main = src.slice(src.search(/async function main\(/));
      assert.ok(main.indexOf("assertTestnetRpc(") >= 0 && main.indexOf("assertTestnetRpc(") < main.indexOf("accounts[0].get()"), f);
    }
  });
  it("the Sepolia-only exceptions really use a hard-coded Sepolia RPC and no Rome network", () => {
    for (const rel of SEPOLIA_ONLY) {
      const src = readFileSync(path.join(repo, "scripts/bridge", rel), "utf8");
      assert.match(src, /const RPC = "https:\/\/sepolia\./);
      assert.doesNotMatch(src, /hardhat\.network|networkConfig|process\.env\.\w*RPC/);
    }
  });
  it("deploy.ts guards both of its send paths (ERC20Users and RomeBridgeWithdraw)", () => {
    const src = readFileSync(path.join(repo, "scripts/bridge/deploy.ts"), "utf8");
    assert.ok(src.indexOf("assertTestnetSend(") < src.indexOf("viem.deployContract(\"ERC20Users\""));
    assert.ok(src.lastIndexOf("assertTestnetSend(") < src.indexOf("viem.deployContract(\"RomeBridgeWithdraw\""));
    assert.equal(src.split("assertTestnetSend(").length - 1 >= 2, true);
  });
  it("deploy.ts carries no unreachable mainnet branch and points to the separate Rubicon deploy script", () => {
    for (const f of ["deploy.ts", "lib/deploy-roles.ts"]) {
      const src = readFileSync(path.join(repo, "scripts/bridge", f), "utf8");
      assert.doesNotMatch(src, /MAINNET_NETWORKS|isMainnet|Required on Rubicon|required on mainnet/, `${f}: dead mainnet rules`);
      assert.match(src, /deploy-rubicon-v13/, `${f}: names the Rubicon deploy script`);
    }
  });
  it("ensure-bridge-atas only skips the guard in a dry run", () => {
    const src = readFileSync(path.join(repo, "scripts/bridge/ensure-bridge-atas.ts"), "utf8");
    assert.match(src, /if \(!dryRun\) await assertTestnetSend\(/);
  });
});

describe("the one mainnet exception: deploy-rubicon-v13.ts, with --i-understand-mainnet", () => {
  const OK = { script: RUBICON_V13_DEPLOY_SCRIPT, entry: RUBICON_V13_DEPLOY_SCRIPT, mainnetFlag: true };
  const SCRIPT_FILE = path.join(repo, RUBICON_V13_DEPLOY_SCRIPT);
  const client = (id: number) => ({ getChainId: async () => id });

  it("the exception names exactly one script and one flag", () => {
    assert.equal(RUBICON_V13_DEPLOY_SCRIPT, "scripts/bridge/deploy-rubicon-v13.ts");
    assert.equal(MAINNET_FLAG, "--i-understand-mainnet");
  });
  it("chain 7531 passes only for that script with the flag", () => {
    assert.equal(judgeRubiconV13Deploy(7531, OK).allowed, true);
    assert.equal(judgeRubiconV13Deploy(7531, { ...OK, mainnetFlag: false }).allowed, false);
    assert.match(judgeRubiconV13Deploy(7531, { ...OK, mainnetFlag: false }).reason, /--i-understand-mainnet/);
  });
  it("every other script is refused on 7531, flag or not, whatever its name resembles", () => {
    for (const script of [
      "scripts/bridge/deploy.ts", "scripts/bridge/enable-cctp-domains.ts", "scripts/bridge/deploy-rubicon-v13.mjs",
      "scripts/bridge/lib/deploy-rubicon-v13.ts", "scripts/other/deploy-rubicon-v13.ts", "deploy-rubicon-v13.ts", "", "scripts/bridge/deploy-rubicon-v13.ts ",
    ]) {
      for (const mainnetFlag of [true, false]) {
        const v = judgeRubiconV13Deploy(7531, { script, entry: script, mainnetFlag });
        assert.equal(v.allowed, false, `${script || "(empty)"} flag=${mainnetFlag}`);
      }
    }
    assert.match(judgeRubiconV13Deploy(7531, { script: "scripts/bridge/deploy.ts", entry: "scripts/bridge/deploy.ts", mainnetFlag: true }).reason, /only scripts\/bridge\/deploy-rubicon-v13\.ts may deploy/);
  });
  it("the exception opens chain 7531 and nothing else: other mainnets and unlisted ids stay shut, the extra list cannot unlock it", () => {
    for (const id of [1, 2, 10, 7530, 7532, 424242, 0, NaN, undefined]) {
      assert.equal(judgeRubiconV13Deploy(id as number | undefined, OK).allowed, false, String(id));
    }
    assert.equal(judgeRubiconV13Deploy(7532, OK, "7532").allowed, true, "an id listed on purpose is a testnet, as in judgeChain");
    assert.equal(judgeRubiconV13Deploy(7531, { script: "x", entry: "x", mainnetFlag: true }, "7531").allowed, false);
    for (const id of [200010, 121214, 121213, 121302, 210000, 31337]) assert.equal(judgeRubiconV13Deploy(id, { script: "x", entry: undefined, mainnetFlag: false }).allowed, true, String(id));
  });
  it("judgeChain and assertTestnetSend still refuse 7531 for everyone, flag or no flag", async () => {
    assert.equal(judgeChain(7531).allowed, false);
    assert.equal(judgeChain(7531, "7531").allowed, false);
    await assert.rejects(assertTestnetSend(client(7531), "any other script"), /mainnet/);
  });
  it("assertRubiconV13DeploySend reads the live chain id and throws with the script's name", async () => {
    const caller = { script: RUBICON_V13_DEPLOY_SCRIPT, mainnetFlag: true };
    assert.equal(await assertRubiconV13DeploySend(client(7531), "t", caller, undefined, SCRIPT_FILE), 7531);
    assert.equal(await assertRubiconV13DeploySend(client(31337), "t", { script: "x", mainnetFlag: false }, undefined, "elsewhere.ts"), 31337);
    await assert.rejects(assertRubiconV13DeploySend(client(7531), "rubicon deploy", { ...caller, mainnetFlag: false }, undefined, SCRIPT_FILE), /rubicon deploy.*--i-understand-mainnet/);
    await assert.rejects(assertRubiconV13DeploySend(client(7531), "copy", { script: "scripts/bridge/copy.ts", mainnetFlag: true }, undefined, SCRIPT_FILE), /copy.*only scripts\/bridge\/deploy-rubicon-v13\.ts/);
    await assert.rejects(assertRubiconV13DeploySend({ getChainId: async () => { throw new Error("ECONNREFUSED"); } }, "t", caller, undefined, SCRIPT_FILE), /cannot read the chain id.*refusing to send/);
  });
  it("on 7531 the PROCESS must have been started as the script: another entry point is refused even with the right script string and the flag", async () => {
    const caller = { script: RUBICON_V13_DEPLOY_SCRIPT, mainnetFlag: true };
    const other = path.join(repo, "scripts/bridge/enable-cctp-domains.ts");
    await assert.rejects(assertRubiconV13DeploySend(client(7531), "t", caller, undefined, other), /must be the file this process was started as.*enable-cctp-domains\.ts/);
    // the default entry is process.argv[1]: the test runner, not the script
    await assert.rejects(assertRubiconV13DeploySend(client(7531), "t", caller, undefined), /started as/);
    await assert.rejects(assertRubiconV13DeploySend(client(7531), "t", caller, undefined, undefined), /started as "unknown"|started as/);
    assert.equal(judgeRubiconV13Deploy(7531, { ...OK, entry: "scripts/bridge/other.ts" }).allowed, false);
    assert.equal(judgeRubiconV13Deploy(7531, { ...OK, entry: undefined }).allowed, false);
    // testnets and local chains do not care which file is the entry
    assert.equal(await assertRubiconV13DeploySend(client(31337), "t", caller, undefined, other), 31337);
  });
  it("entryScript maps argv[1] to a repo-relative path, resolves links, and gives undefined for anything outside the repo", () => {
    assert.equal(entryScript(SCRIPT_FILE), RUBICON_V13_DEPLOY_SCRIPT);
    assert.equal(entryScript(path.join(repo, "scripts/bridge/../bridge/deploy-rubicon-v13.ts")), RUBICON_V13_DEPLOY_SCRIPT);
    assert.equal(entryScript(path.join(repo, "scripts/bridge/deploy.ts")), "scripts/bridge/deploy.ts");
    assert.equal(entryScript(undefined), undefined);
    assert.equal(entryScript(""), undefined);
    assert.equal(entryScript(path.join(repo, "scripts/bridge/does-not-exist.ts")), undefined);
    const dir = mkdtempSync(path.join(tmpdir(), "entry-"));
    try {
      // a COPY of the script outside the repo is not the script
      const copy = path.join(dir, "deploy-rubicon-v13.ts");
      copyFileSync(SCRIPT_FILE, copy);
      assert.equal(entryScript(copy), undefined);
      // a link to the real file resolves to the real file
      const link = path.join(dir, "link.ts");
      symlinkSync(SCRIPT_FILE, link);
      assert.equal(entryScript(link), RUBICON_V13_DEPLOY_SCRIPT);
      // a link to a different file in the repo resolves to that file, whatever it is called
      const link2 = path.join(dir, "deploy-rubicon-v13.ts.link");
      symlinkSync(path.join(repo, "scripts/bridge/deploy.ts"), link2);
      assert.equal(entryScript(link2), "scripts/bridge/deploy.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function walkAll(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "artifacts" || name === "cache") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walkAll(full, out);
      else if (/\.(ts|mts|mjs|js|cjs|sh|yml|yaml)$/.test(name)) out.push(full);
    }
    return out;
  }
  const rel = (f: string) => path.relative(repo, f).split(path.sep).join("/");

  it("no file except the guard and deploy-rubicon-v13.ts uses the exception (scripts/, the workflows and the repo's other code)", () => {
    const EXCEPTION = /assertRubiconV13DeploySend|judgeRubiconV13Deploy|RUBICON_V13_DEPLOY_SCRIPT/;
    const users = [
      ...walkAll(path.join(repo, "scripts")),
      ...walkAll(path.join(repo, ".github")),
      ...walkAll(path.join(repo, "tests")).filter((f) => !f.endsWith("testnet-guard.test.ts") && !f.endsWith("deploy-rubicon-v13.test.ts")),
    ].filter((f) => EXCEPTION.test(readFileSync(f, "utf8"))).map(rel).sort();
    assert.deepEqual(users, ["scripts/bridge/deploy-rubicon-v13.ts", "scripts/bridge/lib/testnet-guard.ts"]);
  });
  it("only the script's own test file imports the script or lib/rubicon-v13 (the sending wiring cannot be reached from another file)", () => {
    const IMPORT = /(?:from|import|require)\s*\(?\s*["'][^"']*(?:deploy-rubicon-v13|rubicon-v13)(?:\.[mc]?[jt]s)?["']/;
    const importers = [
      ...walkAll(path.join(repo, "scripts")),
      ...walkAll(path.join(repo, ".github")),
      ...walkAll(path.join(repo, "tests")).filter((f) => !f.endsWith("testnet-guard.test.ts")), // this file quotes import lines as test data
    ].filter((f) => IMPORT.test(readFileSync(f, "utf8"))).map(rel).sort();
    assert.deepEqual(importers, ["scripts/bridge/deploy-rubicon-v13.ts", "tests/bridge/deploy-rubicon-v13.test.ts"]);
    // and the scan itself sees the forms an importer would use
    for (const line of [
      'import { depsFromConnection } from "./deploy-rubicon-v13.js";',
      'import { runRubiconV13Deploy } from "./lib/rubicon-v13.js";',
      "const m = await import('../bridge/deploy-rubicon-v13.ts');",
      'const m = require("./lib/rubicon-v13");',
    ]) assert.match(line, IMPORT, line);
    assert.doesNotMatch('// see deploy-rubicon-v13.ts for the Rubicon deploy', IMPORT);
  });
  it("the script's send step asks the guard itself, before it hands anything to the wallet", () => {
    const src = readFileSync(path.join(repo, RUBICON_V13_DEPLOY_SCRIPT), "utf8");
    const deploy = src.slice(src.search(/deploy:\s*async\s*\(args, mainnetFlag\)/));
    assert.ok(deploy.length < src.length, "found the deploy closure");
    assert.ok(deploy.indexOf("await guard(mainnetFlag)") >= 0 && deploy.indexOf("await guard(mainnetFlag)") < deploy.indexOf("wallet.deployContract("));
    assert.equal(src.split("wallet.deployContract(").length - 1, 1, "one send site");
  });
  it("the script computes its own path for the guard, and that path is the one the exception names", () => {
    const src = readFileSync(path.join(repo, RUBICON_V13_DEPLOY_SCRIPT), "utf8");
    assert.match(src, /script: SELF/);
    assert.match(src, /const SELF = path\.relative\(/);
    assert.doesNotMatch(src, /script: "/, "the script never types a path for the guard");
    // the file really lives where the exception says it does
    assert.equal(rel(path.join(repo, RUBICON_V13_DEPLOY_SCRIPT)), RUBICON_V13_DEPLOY_SCRIPT);
  });
  it("the script reads its arguments (which refuse Rubicon without the flag) before it connects to a network", () => {
    const src = readFileSync(path.join(repo, RUBICON_V13_DEPLOY_SCRIPT), "utf8");
    const main = src.slice(src.search(/async function main\(/));
    assert.ok(main.indexOf("parseArgs(") >= 0 && main.indexOf("parseArgs(") < main.indexOf("network.connect("));
  });
  it("the script sends no owner call: it has no write to the bridge besides its own deploy", () => {
    for (const f of [RUBICON_V13_DEPLOY_SCRIPT, "scripts/bridge/lib/rubicon-v13.ts"]) {
      const src = readFileSync(path.join(repo, f), "utf8");
      assert.doesNotMatch(src, /writeContract\(|\.write\.|sendTransaction\(|sendRawTransaction/, f);
      assert.equal(src.split("deployContract(").length - 1 <= 1, true, `${f}: one deploy site`);
    }
  });
});

describe("test burns pay an address the operator controls (submit-burn.ts, try-burn.ts)", () => {
  const SIGNER = "0x1111111111111111111111111111111111111111";
  const OTHER = "0x2222222222222222222222222222222222222222";
  it("defaults to the signer", () => {
    assert.equal(resolveBurnRecipient(SIGNER, undefined).toLowerCase(), SIGNER);
    assert.equal(resolveBurnRecipient(SIGNER, "  ").toLowerCase(), SIGNER);
  });
  it("takes an explicit controlled address", () => {
    assert.equal(resolveBurnRecipient(SIGNER, OTHER).toLowerCase(), OTHER);
  });
  it("refuses 0x...0001, zero and other burn-like addresses", () => {
    for (const a of ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000000", "0x00000000000000000000000000000000ffffffff", "0xff00000000000000000000000000000000000009".replace("ff", "00")]) {
      assert.throws(() => resolveBurnRecipient(SIGNER, a), /burn-like/);
    }
    assert.doesNotThrow(() => resolveBurnRecipient(SIGNER, "0x0000000000000000000000000000000100000000"));
  });
  it("refuses a malformed recipient or signer", () => {
    assert.throws(() => resolveBurnRecipient(SIGNER, "0x12"), /20-byte/);
    assert.throws(() => resolveBurnRecipient("nope", undefined), /not an address/);
  });
  it("amount: default 0.1 USDC, whole numbers only, never zero", () => {
    assert.equal(resolveBurnAmount(undefined), 100_000n);
    assert.equal(resolveBurnAmount("5"), 5n);
    assert.throws(() => resolveBurnAmount("0"), /zero/);
    assert.throws(() => resolveBurnAmount("1.5"), /whole number/);
  });
  it("the scripts no longer contain the fixed 0x...0001 recipient or the hard-coded selector", () => {
    for (const f of ["submit-burn.ts", "try-burn.ts"]) {
      const src = readFileSync(path.join(repo, "scripts/bridge", f), "utf8");
      assert.doesNotMatch(src, /0{63}1/, `${f}: fixed 0x1 recipient`);
      assert.doesNotMatch(src, /0x259acd3b/, `${f}: hard-coded selector`);
      assert.match(src, /resolveBurnRecipient\(/);
      assert.match(src, /assertTestnetSend\(/);
    }
  });
});
