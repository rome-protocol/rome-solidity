import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeFunctionData, getAddress, parseAbi, toFunctionSelector } from "viem";
import hardhat from "hardhat";
import {
  EXPECTED_VERSION, RECORD_KEY, buildOwnerCalls, parseArgs, runRubiconV13Deploy, usdcFromDeployments, validateRoles,
  verifyDeployment, withV13Record, type DeployDeps, type DeployOptions,
} from "../../scripts/bridge/lib/rubicon-v13.js";
import { buildWithdrawConstructorArgs, universalFor } from "../../scripts/bridge/lib/withdraw-ctor-args.js";
import { depsFromConnection, fileStore } from "../../scripts/bridge/deploy-rubicon-v13.js";
import { SOLANA_PROGRAM_IDS } from "../../scripts/bridge/constants.js";
import { base58ToBytes32 } from "../../scripts/lib/pubkey.js";
import { ADDR } from "./helpers/v13.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../..");

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT32 = base58ToBytes32(USDC_MINT);
const LEDGER = ADDR(0x1ed6e4);
const OPS = ADDR(0x0b5);
const FLAG = "--i-understand-mainnet";

const OWNER_ABI = parseAbi([
  "function enableCctpDomain(uint32 domain, uint8 recipientKind)",
  "function ensureBridgeAta(bytes32 mint)",
]);

describe("parseArgs", () => {
  const ok = ["--network", "hardhatMainnet", "--owner", LEDGER, "--guardian", OPS];
  it("reads the three required arguments and the two flags", () => {
    assert.deepEqual(parseArgs(ok), { network: "hardhatMainnet", owner: LEDGER, guardian: OPS, dryRun: false, mainnetFlag: false });
    const o = parseArgs([...ok, "--dry-run", FLAG]);
    assert.equal(o.dryRun, true);
    assert.equal(o.mainnetFlag, true);
    assert.equal(parseArgs([`--network=hardhatMainnet`, `--owner=${LEDGER}`, `--guardian=${OPS}`]).owner, LEDGER);
  });
  it("has no default owner, guardian or network", () => {
    assert.throws(() => parseArgs(["--network", "hardhatMainnet", "--guardian", OPS]), /--owner is required/);
    assert.throws(() => parseArgs(["--network", "hardhatMainnet", "--owner", LEDGER]), /--guardian is required/);
    assert.throws(() => parseArgs(["--owner", LEDGER, "--guardian", OPS]), /--network is required/);
    assert.throws(() => parseArgs([]), /is required/);
  });
  it("refuses a missing value, an unknown argument and a repeated option", () => {
    assert.throws(() => parseArgs(["--network", "hardhatMainnet", "--owner", "--guardian", OPS]), /--owner needs a value/);
    assert.throws(() => parseArgs([...ok, "--send"]), /unknown argument "--send"/);
    assert.throws(() => parseArgs([...ok, "--owner", OPS]), /given twice/);
    assert.throws(() => parseArgs([...ok, "extra"]), /unknown argument "extra"/);
  });
  it("refuses Rubicon without --i-understand-mainnet, a dry run included", () => {
    const rub = ["--network", "rubicon", "--owner", LEDGER, "--guardian", OPS];
    assert.throws(() => parseArgs(rub), /mainnet.*--i-understand-mainnet/);
    assert.throws(() => parseArgs([...rub, "--dry-run"]), /--i-understand-mainnet/);
    assert.equal(parseArgs([...rub, FLAG, "--dry-run"]).network, "rubicon");
  });
});

describe("validateRoles", () => {
  const DEPLOYER = ADDR(0xde9107e5);
  it("accepts three different non-zero addresses", () => {
    const r = validateRoles({ deployer: DEPLOYER, owner: LEDGER, guardian: OPS });
    assert.equal(r.owner, getAddress(LEDGER));
    assert.equal(r.guardian, getAddress(OPS));
  });
  it("refuses a zero owner or guardian", () => {
    const Z = ADDR(0);
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: Z, guardian: OPS }), /--owner is the zero address/);
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: LEDGER, guardian: Z }), /--guardian is the zero address/);
  });
  it("refuses an owner equal to the guardian", () => {
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: LEDGER, guardian: getAddress(LEDGER) }), /same address/);
  });
  it("refuses the deploy key as owner or as guardian", () => {
    assert.throws(() => validateRoles({ deployer: LEDGER, owner: LEDGER, guardian: OPS }), /owner is the deploy key/);
    assert.throws(() => validateRoles({ deployer: OPS, owner: LEDGER, guardian: OPS }), /guardian is the deploy key/);
  });
  it("refuses a malformed address and a bad checksum", () => {
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: "0x12", guardian: OPS }), /not a 20-byte address/);
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: "nope", guardian: OPS }), /not a 20-byte address/);
    const good = getAddress("0x52908400098527886E0F7030069857D2E4169EE7");
    const bad = good.replace(/[A-F]/, (c) => c.toLowerCase()); // one letter's case flipped: the checksum no longer holds
    assert.notEqual(bad, good);
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: bad, guardian: OPS }), /not a 20-byte address/);
  });
});

describe("buildOwnerCalls: printed, and exactly the two Ledger calls", () => {
  const BRIDGE = ADDR(0xb41d6e);
  const calls = buildOwnerCalls(BRIDGE, USDC_MINT);
  it("is two calls, to the bridge, with no value", () => {
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.to, BRIDGE);
      assert.equal(c.value, "0");
      assert.ok(c.description.length > 30);
    }
  });
  it("the first call decodes to exactly enableCctpDomain(0, 1)", () => {
    const d = decodeFunctionData({ abi: OWNER_ABI, data: calls[0].data });
    assert.equal(d.functionName, "enableCctpDomain");
    assert.deepEqual(d.args, [0, 1]);
    assert.equal(calls[0].data.slice(0, 10), toFunctionSelector("enableCctpDomain(uint32,uint8)"));
    assert.equal((calls[0].data.length - 2) / 2, 4 + 32 + 32);
  });
  it("the second call decodes to exactly ensureBridgeAta(<Rubicon USDC mint>)", () => {
    const d = decodeFunctionData({ abi: OWNER_ABI, data: calls[1].data });
    assert.equal(d.functionName, "ensureBridgeAta");
    assert.deepEqual(d.args, [USDC_MINT32]);
    assert.equal(calls[1].data.slice(0, 10), toFunctionSelector("ensureBridgeAta(bytes32)"));
    assert.equal((calls[1].data.length - 2) / 2, 4 + 32);
  });
  it("refuses a mint that is not a 32-byte base58 key", () => {
    assert.throws(() => buildOwnerCalls(BRIDGE, "not-a-mint"));
  });
});

describe("the deployments record", () => {
  const v12 = { address: "0xceea191761cdba2fc589996d7dd096e57db29c84", deployedAt: 1790219940 };
  const rec = { address: ADDR(0xabc), version: "13.0.0", owner: LEDGER, guardian: OPS, deployTx: ("0x" + "11".repeat(32)) as `0x${string}`, deployedAt: 1 };
  it("adds the V13 key and leaves every other key as it was", () => {
    const before = { SPL_ERC20_USDC: { address: ADDR(5), mintId: USDC_MINT }, RomeBridgeWithdraw: v12 };
    const after = withV13Record(before, rec);
    assert.deepEqual(after.RomeBridgeWithdraw, v12);
    assert.deepEqual(after.SPL_ERC20_USDC, before.SPL_ERC20_USDC);
    assert.deepEqual(after[RECORD_KEY], rec);
    assert.equal(RECORD_KEY, "RomeBridgeWithdrawV13");
  });
  it("refuses to replace an existing V13 record", () => {
    assert.throws(() => withV13Record({ [RECORD_KEY]: { address: ADDR(1) } }, rec), /already recorded/);
  });
  it("takes the USDC wrapper and mint from the record, and refuses without them", () => {
    assert.deepEqual(usdcFromDeployments({ SPL_ERC20_USDC: { address: ADDR(0x77), mintId: USDC_MINT } }, "rubicon"), { wrapper: getAddress(ADDR(0x77)), mintBase58: USDC_MINT });
    assert.throws(() => usdcFromDeployments({}, "rubicon"), /no SPL_ERC20_USDC/);
    assert.throws(() => usdcFromDeployments({ SPL_ERC20_USDC: { address: ADDR(1) } }, "rubicon"), /no SPL_ERC20_USDC/);
    assert.throws(() => usdcFromDeployments({ SPL_ERC20_USDC: { address: ADDR(1), mintId: "zzz" } }, "rubicon"));
  });
  it("the real rubicon.json today has the v12 record and no V13 key; the file store round-trips it byte for byte", () => {
    const file = path.join(repo, "deployments/rubicon.json");
    const raw = readFileSync(file, "utf8");
    const d = JSON.parse(raw);
    assert.ok(d.RomeBridgeWithdraw?.address);
    assert.equal(d[RECORD_KEY], undefined, "the V13 record is written by the real deploy, not committed here");
    assert.equal(d.SPL_ERC20_USDC.mintId, USDC_MINT);
    const dir = mkdtempSync(path.join(tmpdir(), "rubicon-store-"));
    try {
      const copy = path.join(dir, "rubicon.json");
      writeFileSync(copy, raw);
      const store = fileStore(copy);
      store.write(store.read());
      assert.equal(readFileSync(copy, "utf8"), raw);
      store.write(withV13Record(store.read(), rec));
      const back = JSON.parse(readFileSync(copy, "utf8"));
      assert.deepEqual(back.RomeBridgeWithdraw, d.RomeBridgeWithdraw);
      assert.equal(back[RECORD_KEY].address, rec.address);
      assert.equal(fileStore(path.join(dir, "absent.json")).read() instanceof Object, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("constructor arguments", () => {
  it("rubicon gets mainnet-beta Wormhole ids, CCTP v2 ids, the owner as admin, empty lists and no forwarder", () => {
    const wrapper = ADDR(0x77);
    const a = buildWithdrawConstructorArgs({ networkName: "rubicon", usdcWrapper: wrapper, usdcMintBase58: USDC_MINT, owner: LEDGER, guardian: OPS });
    const u = universalFor("rubicon");
    assert.equal(a[0], ADDR(0));
    assert.equal(a[1], wrapper);
    assert.equal(a[2].tokenMessengerProgram, base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_V2_TOKEN_MESSENGER));
    assert.equal(a[2].messageTransmitterProgram, base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_V2_MESSAGE_TRANSMITTER));
    assert.equal(a[3].tokenBridgeProgram, base58ToBytes32(SOLANA_PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE));
    assert.equal(a[3].coreProgram, u.wormholeCoreProgram);
    assert.deepEqual(a[4], { admin: LEDGER, targetChains: [], assetWrappers: [] });
    assert.equal(a[5], OPS);
    // devnet ids differ: the shared builder really follows the network
    const h = buildWithdrawConstructorArgs({ networkName: "hadrian", usdcWrapper: wrapper, usdcMintBase58: USDC_MINT, owner: LEDGER, guardian: OPS });
    assert.notEqual(h[3].tokenBridgeProgram, a[3].tokenBridgeProgram);
  });
});

describe("the deploy flow on a local Hardhat chain", function () {
  let conn: any, viem: any, pc: any;
  let wallets: any[];
  let wrapper: any;

  const RUBICON_LIKE = () => ({
    SPL_ERC20_USDC: { address: wrapper.address, mintId: USDC_MINT, symbol: "wUSDC" },
    RomeBridgeWithdraw: { address: "0xceea191761cdba2fc589996d7dd096e57db29c84", deployedAt: 1790219940 },
  });

  function memStore(initial: Record<string, any>) {
    let data = structuredClone(initial);
    return { read: () => structuredClone(data), write: (d: Record<string, any>) => { data = structuredClone(d); }, peek: () => data };
  }

  const opts = (over: Partial<DeployOptions> = {}): DeployOptions => ({
    network: "hardhatMainnet", owner: wallets[1].account.address, guardian: wallets[2].account.address, dryRun: false, mainnetFlag: false, ...over,
  });

  async function deps(store: ReturnType<typeof memStore>, lines: string[]): Promise<DeployDeps> {
    return depsFromConnection(conn, store, (l) => lines.push(l));
  }

  before(async () => {
    conn = await hardhat.network.connect();
    viem = conn.viem;
    pc = await viem.getPublicClient();
    wallets = await viem.getWalletClients();
    wrapper = await viem.deployContract("MockSplErc20", [USDC_MINT32]);
  });

  it("deploys, reads everything back, records beside v12, and prints the two owner calls without sending them", async () => {
    const store = memStore(RUBICON_LIKE());
    const lines: string[] = [];
    const d = await deps(store, lines);
    const nonceBefore = await pc.getTransactionCount({ address: wallets[0].account.address });
    const ownerNonceBefore = await pc.getTransactionCount({ address: wallets[1].account.address });

    const res = await runRubiconV13Deploy(d, opts());

    // one transaction from the deploy key, none from the owner
    assert.equal(await pc.getTransactionCount({ address: wallets[0].account.address }), nonceBefore + 1);
    assert.equal(await pc.getTransactionCount({ address: wallets[1].account.address }), ownerNonceBefore);

    const bridge = await viem.getContractAt("RomeBridgeWithdraw", res.deployed!.address);
    assert.equal(await bridge.read.VERSION(), EXPECTED_VERSION);
    assert.equal((await bridge.read.owner()).toLowerCase(), wallets[1].account.address.toLowerCase());
    assert.equal((await bridge.read.guardian()).toLowerCase(), wallets[2].account.address.toLowerCase());
    assert.equal(await bridge.read.pendingOwner(), ADDR(0));
    assert.deepEqual(await bridge.read.cctpDomains(), []);

    // recorded under the new key; v12 and the USDC wrapper untouched
    const rec = store.peek();
    assert.equal(rec[RECORD_KEY].address, res.deployed!.address);
    assert.equal(rec[RECORD_KEY].version, "13.0.0");
    assert.equal(rec[RECORD_KEY].deployTx, res.deployed!.txHash);
    assert.deepEqual(rec.RomeBridgeWithdraw, RUBICON_LIKE().RomeBridgeWithdraw);
    assert.deepEqual(rec.SPL_ERC20_USDC, RUBICON_LIKE().SPL_ERC20_USDC);

    // printed calls decode to exactly the two owner calls, and nothing was sent for them
    assert.equal(res.ownerCalls!.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: OWNER_ABI, data: res.ownerCalls![0].data }).args, [0, 1]);
    assert.deepEqual(decodeFunctionData({ abi: OWNER_ABI, data: res.ownerCalls![1].data }).args, [USDC_MINT32]);
    const text = lines.join("\n");
    assert.ok(text.includes(res.ownerCalls![0].data) && text.includes(res.ownerCalls![1].data));
    assert.match(text, /This script does not send them/);
    assert.match(text, /Wormhole allowlists stay empty/);
    // no private key material in the output
    assert.doesNotMatch(text, /private ?key|mnemonic|seed phrase/i);
  });

  it("a dry run estimates gas, prints the deploy and the arguments, and sends nothing", async () => {
    const store = memStore(RUBICON_LIKE());
    const lines: string[] = [];
    const d = await deps(store, lines);
    const nonce = await pc.getTransactionCount({ address: wallets[0].account.address });
    const block = await pc.getBlockNumber();
    let deployCalled = false;
    const res = await runRubiconV13Deploy({ ...d, deploy: async () => { deployCalled = true; throw new Error("must not be called"); } }, opts({ dryRun: true }));
    assert.equal(deployCalled, false);
    assert.equal(res.dryRun, true);
    assert.equal(res.deployed, undefined);
    assert.equal(res.ownerCalls, undefined);
    assert.equal(await pc.getTransactionCount({ address: wallets[0].account.address }), nonce);
    assert.equal(await pc.getBlockNumber(), block, "no block was mined");
    assert.deepEqual(store.peek(), RUBICON_LIKE(), "the deployments record is unchanged");
    const text = lines.join("\n");
    assert.match(text, /DRY RUN/);
    assert.match(text, /estimated gas \d+/);
    assert.match(text, /constructor args/);
    assert.ok(text.includes(wallets[1].account.address) || text.toLowerCase().includes(wallets[1].account.address.toLowerCase()));
  });

  it("a deploy with the wrong owner fails the read-back, says so, and records nothing", async () => {
    const store = memStore(RUBICON_LIKE());
    const lines: string[] = [];
    const d = await deps(store, lines);
    const wrongOwner = wallets[5].account.address as `0x${string}`;
    const evil: DeployDeps = {
      ...d,
      deploy: async (args) => {
        const a = [...args] as any[];
        a[4] = { ...a[4], admin: wrongOwner }; // the mock deploy puts someone else in as owner
        return d.deploy(a as any);
      },
    };
    await assert.rejects(runRubiconV13Deploy(evil, opts()), (e: Error) => {
      assert.match(e.message, /FAILED the read-back and was NOT recorded/);
      assert.match(e.message, /owner\(\) is 0x[0-9a-fA-F]{40}, expected /);
      return true;
    });
    assert.equal(store.peek()[RECORD_KEY], undefined);
    assert.equal(lines.some((l) => /OWNER CALLS/.test(l)), false, "no owner calls are printed for a bad contract");
  });

  it("a deploy with the wrong guardian, or the deploy key as owner, also fails", async () => {
    for (const bad of ["guardian", "deployer-owner"]) {
      const store = memStore(RUBICON_LIKE());
      const d = await deps(store, []);
      const evil: DeployDeps = {
        ...d,
        deploy: async (args) => {
          const a = [...args] as any[];
          if (bad === "guardian") a[5] = wallets[6].account.address;
          else a[4] = { ...a[4], admin: wallets[0].account.address };
          return d.deploy(a as any);
        },
      };
      await assert.rejects(runRubiconV13Deploy(evil, opts()), bad === "guardian" ? /guardian\(\) is/ : /deploy key .* holds the owner role/);
      assert.equal(store.peek()[RECORD_KEY], undefined);
    }
  });

  it("verifyDeployment on a good deploy lists what it checked; on no code, a wrong wrapper or a paused rail it fails", async () => {
    const roles = { owner: wallets[1].account.address, guardian: wallets[2].account.address };
    const ctor = buildWithdrawConstructorArgs({ networkName: "hardhatMainnet", usdcWrapper: wrapper.address, usdcMintBase58: USDC_MINT, ...roles });
    const bridge = await viem.deployContract("RomeBridgeWithdraw", [...ctor]);
    const d = await deps(memStore(RUBICON_LIKE()), []);
    const want = { ...roles, deployer: wallets[0].account.address, usdcWrapper: wrapper.address, usdcMintBase58: USDC_MINT };
    const ok = await verifyDeployment(d.reader(bridge.address), want);
    assert.ok(ok.some((l) => l.startsWith("VERSION() = 13.0.0")));
    assert.ok(ok.some((l) => l.startsWith("cctpDomains() = []")));
    assert.ok(ok.some((l) => l.startsWith("railPaused(CCTP) = false")));
    // an address with no contract
    await assert.rejects(verifyDeployment(d.reader(wallets[3].account.address), want), /no contract code/);
    // wrong expected wrapper
    await assert.rejects(verifyDeployment(d.reader(bridge.address), { ...want, usdcWrapper: ADDR(0x999) }), /usdcWrapper\(\) is/);
    // a paused rail: the guardian pauses CCTP, the read-back sees it
    await bridge.write.pauseRail([0], { account: wallets[2].account });
    await assert.rejects(verifyDeployment(d.reader(bridge.address), want), /railPaused\(CCTP\) is true, expected false/);
    // a pending owner
    const b2 = await viem.deployContract("RomeBridgeWithdraw", [...ctor]);
    await b2.write.transferOwnership([wallets[7].account.address], { account: wallets[1].account });
    await assert.rejects(verifyDeployment(d.reader(b2.address), want), /pendingOwner\(\) is/);
  });

  it("refuses before anything is estimated or sent when the guard says no", async () => {
    const store = memStore(RUBICON_LIKE());
    const d = await deps(store, []);
    const calls: string[] = [];
    const guarded: DeployDeps = {
      ...d,
      guard: async () => { calls.push("guard"); throw new Error("guard says no"); },
      estimate: async () => { calls.push("estimate"); throw new Error("x"); },
      deploy: async () => { calls.push("deploy"); throw new Error("x"); },
    };
    await assert.rejects(runRubiconV13Deploy(guarded, opts()), /guard says no/);
    await assert.rejects(runRubiconV13Deploy(guarded, opts({ dryRun: true })), /guard says no/);
    assert.deepEqual(calls, ["guard", "guard"]);
  });

  it("the guard sees the flag the operator gave", async () => {
    const store = memStore(RUBICON_LIKE());
    const d = await deps(store, []);
    const seen: boolean[] = [];
    await runRubiconV13Deploy({ ...d, guard: async (f) => { seen.push(f); return 31337; } }, opts({ dryRun: true, mainnetFlag: true }));
    await runRubiconV13Deploy({ ...d, guard: async (f) => { seen.push(f); return 31337; } }, opts({ dryRun: true }));
    assert.deepEqual(seen, [true, false]);
  });

  it("the network name and the chain id must agree", async () => {
    const d = await deps(memStore(RUBICON_LIKE()), []);
    // a network called "rubicon" that reports a testnet id
    await assert.rejects(runRubiconV13Deploy({ ...d, networkName: "rubicon" }, opts({ network: "rubicon", mainnetFlag: true })), /not 7531/);
    // an RPC that reports Rubicon under another name
    await assert.rejects(runRubiconV13Deploy({ ...d, guard: async () => 7531 }, opts()), /reports Rubicon \(7531\) but the network is called "default"/);
  });

  it("refuses to run twice, and without a recorded USDC wrapper", async () => {
    const done = memStore({ ...RUBICON_LIKE(), [RECORD_KEY]: { address: ADDR(0xd0e) } });
    await assert.rejects(runRubiconV13Deploy(await deps(done, []), opts()), /already recorded/);
    const none = memStore({ RomeBridgeWithdraw: { address: ADDR(1) } });
    await assert.rejects(runRubiconV13Deploy(await deps(none, []), opts()), /no SPL_ERC20_USDC/);
  });

  it("refuses bad roles before any estimate or deploy", async () => {
    const store = memStore(RUBICON_LIKE());
    const d = await deps(store, []);
    let sent = false;
    const spy: DeployDeps = { ...d, deploy: async () => { sent = true; throw new Error("x"); }, estimate: async () => { sent = true; throw new Error("x"); } };
    const deployer = wallets[0].account.address;
    await assert.rejects(runRubiconV13Deploy(spy, opts({ owner: deployer })), /owner is the deploy key/);
    await assert.rejects(runRubiconV13Deploy(spy, opts({ guardian: wallets[1].account.address })), /same address/);
    await assert.rejects(runRubiconV13Deploy(spy, opts({ owner: ADDR(0) })), /zero address/);
    assert.equal(sent, false);
  });
});

describe("the script as a command (arguments are checked before any network exists)", () => {
  const tsx = path.join(repo, "node_modules/.bin/tsx");
  const script = path.join(repo, "scripts/bridge/deploy-rubicon-v13.ts");
  function run(args: string[]) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^RUBICON_|^HARDHAT_/.test(k)) delete env[k];
    return spawnSync(tsx, [script, ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
  }
  it("exits non-zero with no arguments, naming what is missing", () => {
    const r = run([]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is required and has no default/);
  });
  it("exits non-zero for Rubicon without --i-understand-mainnet, before it connects to anything", () => {
    const r = run(["--network", "rubicon", "--owner", LEDGER, "--guardian", OPS, "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--i-understand-mainnet/);
    assert.doesNotMatch(r.stderr + r.stdout, /RUBICON_RPC_URL|chain 7531/);
  });
  it("importing the script does not run it", async () => {
    // depsFromConnection and fileStore were imported at the top of this file without a run.
    assert.equal(typeof fileStore, "function");
    assert.equal(typeof depsFromConnection, "function");
  });
});
