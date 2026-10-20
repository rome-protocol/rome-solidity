import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EXTRA_ENV, assertSolanaTestnetRpc, assertTestnetChainId, assertTestnetRpc, assertTestnetSend, judgeChain, judgeSolanaGenesis,
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
  const SEND = /sendTransaction\(|deployContract\(|writeContract\(|\.write\.|sendRawTransaction|sendAndConfirmTransaction/;
  const GUARD = /assertTestnet(Send|Rpc|ChainId)\(|assertSolanaTestnetRpc\(|canSend\(/;
  /** Scripts that send only on a hard-coded Sepolia RPC (an Ethereum testnet), never on a Rome chain or Solana. */
  const SEPOLIA_ONLY = new Set(["inbound/01-submit-deposit.mjs", "inbound/01b-submit-whETH.mjs"]);

  const files = walk(path.join(repo, "scripts/bridge"))
    .filter((f) => !f.includes(`${path.sep}lib${path.sep}`)) // helpers, no entry points
    .map((f) => [path.relative(path.join(repo, "scripts/bridge"), f), readFileSync(f, "utf8")] as const);

  it("finds the send sites at all (the scan is not vacuous)", () => {
    assert.ok(files.filter(([, src]) => SEND.test(src)).length >= 15);
  });
  it("each file with a send site calls the guard, and a script without a main() calls it before its first send", () => {
    const open: string[] = [];
    for (const [rel, src] of files) {
      if (!SEND.test(src) || SEPOLIA_ONLY.has(rel.split(path.sep).join("/"))) continue;
      const g = src.search(GUARD);
      if (g < 0) { open.push(rel); continue; }
      // A top-level script has no function boundary: the guard must come first.
      if (!/function main\(|const main\s*=/.test(src) && g > src.search(SEND)) open.push(rel);
    }
    assert.deepEqual(open, [], "scripts that can send without the testnet guard");
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
  it("ensure-bridge-atas only skips the guard in a dry run", () => {
    const src = readFileSync(path.join(repo, "scripts/bridge/ensure-bridge-atas.ts"), "utf8");
    assert.match(src, /if \(!dryRun\) await assertTestnetSend\(/);
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
