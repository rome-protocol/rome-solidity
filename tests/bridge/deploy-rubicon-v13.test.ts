import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { decodeFunctionData, getAddress, keccak256, parseAbi, toFunctionSelector } from "viem";
import hardhat from "hardhat";
import {
  EXPECTED_VERSION, RECORD_KEY, buildOwnerCalls, deployDigest, parseArgs, predictedAddress, runRubiconV13Deploy, usdcFromDeployments, validateRoles,
  verifyDeployment, withV13Record, type DeployDeps, type DeployOptions,
} from "../../scripts/bridge/lib/rubicon-v13.js";
import { assertRubiconV13DeploySend } from "../../scripts/bridge/lib/testnet-guard.js";
import { buildWithdrawConstructorArgs, universalFor } from "../../scripts/bridge/lib/withdraw-ctor-args.js";
import { compileProject, depsFromConnection, fileStore, isEntryPoint } from "../../scripts/bridge/deploy-rubicon-v13.js";
import { checkBuildProvenance, checkDependencySources } from "../../scripts/bridge/lib/build-provenance.js";
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
    assert.deepEqual(parseArgs(ok), { network: "hardhatMainnet", owner: LEDGER, guardian: OPS, dryRun: false, mainnetFlag: false, deployDigest: undefined, verifyExisting: undefined, ownerDiffersFromV12: false });
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
  it("reads --deploy <digest> and --verify-existing with --deploy-tx, and refuses malformed or mixed ones", () => {
    const rub = ["--network", "rubicon", "--owner", LEDGER, "--guardian", OPS, FLAG];
    const digest = "0x0123456789abcdef";
    assert.equal(parseArgs([...rub, "--deploy", digest]).deployDigest, digest);
    assert.equal(parseArgs([...rub, `--deploy=${digest}`]).deployDigest, digest);
    assert.throws(() => parseArgs([...rub, "--deploy", "0x1234"]), /8-byte digest/);
    assert.throws(() => parseArgs([...rub, "--deploy", "yes"]), /8-byte digest/);
    assert.throws(() => parseArgs([...rub, "--deploy"]), /--deploy needs a value/);
    assert.throws(() => parseArgs([...rub, "--deploy", digest, "--dry-run"]), /different modes/);
    const tx = "0x" + "ab".repeat(32);
    const sha = "ab".repeat(20);
    const v = parseArgs([...rub, "--verify-existing", ADDR(0xabc), "--deploy-tx", tx, "--source-commit", sha]);
    assert.deepEqual(v.verifyExisting, { address: ADDR(0xabc), txHash: tx, sourceCommit: sha });
    assert.throws(() => parseArgs([...rub, "--verify-existing", ADDR(0xabc)]), /go together/);
    assert.throws(() => parseArgs([...rub, "--deploy-tx", tx]), /go together/);
    assert.throws(() => parseArgs([...rub, "--verify-existing", ADDR(0xabc), "--deploy-tx", tx]), /--source-commit go together/);
    assert.throws(() => parseArgs([...rub, "--source-commit", sha]), /go together/);
    assert.throws(() => parseArgs([...rub, "--verify-existing", ADDR(0xabc), "--deploy-tx", tx, "--source-commit", "abc123"]), /not a full 40-digit git commit hash/);
    assert.throws(() => parseArgs([...rub, "--verify-existing", "0x12", "--deploy-tx", tx, "--source-commit", sha]), /not a 20-byte address/);
    assert.throws(() => parseArgs([...rub, "--verify-existing", ADDR(0xabc), "--deploy-tx", "0x12", "--source-commit", sha]), /not a transaction hash/);
    assert.throws(() => parseArgs([...rub, "--verify-existing", ADDR(0xabc), "--deploy-tx", tx, "--source-commit", sha, "--deploy", digest]), /different modes/);
    assert.throws(() => parseArgs([...rub, "--verify-existing", ADDR(0xabc), "--deploy-tx", tx, "--source-commit", sha, "--dry-run"]), /different modes/);
  });
  it("reads --owner-differs-from-v12 as a flag", () => {
    const rub = ["--network", "rubicon", "--owner", LEDGER, "--guardian", OPS, FLAG];
    assert.equal(parseArgs(rub).ownerDiffersFromV12, false);
    assert.equal(parseArgs([...rub, "--owner-differs-from-v12"]).ownerDiffersFromV12, true);
    assert.throws(() => parseArgs([...rub, "--owner-differs-from-v12", "--owner-differs-from-v12"]), /given twice/);
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
  it("on Rubicon (strict) an all-lowercase address is refused: one typo would otherwise pass as an owner nobody controls", () => {
    const good = getAddress("0x52908400098527886E0F7030069857D2E4169EE7");
    assert.equal(validateRoles({ deployer: DEPLOYER, owner: good, guardian: OPS }, true).owner, good);
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: good.toLowerCase(), guardian: OPS }, true), /--owner .* not EIP-55 checksummed/);
    assert.throws(() => validateRoles({ deployer: DEPLOYER, owner: good, guardian: getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").toLowerCase() }, true), /--guardian .* not EIP-55 checksummed/);
    // off Rubicon the lowercase form still works
    assert.equal(validateRoles({ deployer: DEPLOYER, owner: good.toLowerCase(), guardian: OPS }).owner, good);
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
  it("the FIRST call is ensureBridgeAta(<Rubicon USDC mint>): the token account exists before any domain opens", () => {
    const d = decodeFunctionData({ abi: OWNER_ABI, data: calls[0].data });
    assert.equal(d.functionName, "ensureBridgeAta");
    assert.deepEqual(d.args, [USDC_MINT32]);
    assert.equal(calls[0].data.slice(0, 10), toFunctionSelector("ensureBridgeAta(bytes32)"));
    assert.equal((calls[0].data.length - 2) / 2, 4 + 32);
    assert.match(calls[0].description, /FIRST/);
  });
  it("the SECOND call decodes to exactly enableCctpDomain(0, 1)", () => {
    const d = decodeFunctionData({ abi: OWNER_ABI, data: calls[1].data });
    assert.equal(d.functionName, "enableCctpDomain");
    assert.deepEqual(d.args, [0, 1]);
    assert.equal(calls[1].data.slice(0, 10), toFunctionSelector("enableCctpDomain(uint32,uint8)"));
    assert.equal((calls[1].data.length - 2) / 2, 4 + 32 + 32);
    assert.match(calls[1].description, /SECOND/);
  });
  it("refuses a mint that is not a 32-byte base58 key", () => {
    assert.throws(() => buildOwnerCalls(BRIDGE, "not-a-mint"));
  });
});

describe("the deployments record", () => {
  const v12 = { address: "0xceea191761cdba2fc589996d7dd096e57db29c84", deployedAt: 1790219940 };
  const rec = { address: ADDR(0xabc), version: "13.0.0", owner: LEDGER, guardian: OPS, deployTx: ("0x" + "11".repeat(32)) as `0x${string}`, deployedAt: 1, commit: "c0ffee", build: { buildInfoId: "solc-x", solcVersion: "0.8.28" }, codeHash: ("0x" + "22".repeat(32)) as `0x${string}`, deployInputHash: ("0x" + "33".repeat(32)) as `0x${string}` };
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

  const text0 = (lines: string[]) => lines.join("\n");

  function memStore(initial: Record<string, any>) {
    let data = structuredClone(initial);
    return { read: () => structuredClone(data), write: (d: Record<string, any>) => { data = structuredClone(d); }, peek: () => data };
  }

  const opts = (over: Partial<DeployOptions> = {}): DeployOptions => ({
    network: "hardhatMainnet", owner: wallets[1].account.address, guardian: wallets[2].account.address, dryRun: false, mainnetFlag: false, deployDigest: undefined, verifyExisting: undefined, ownerDiffersFromV12: false, ...over,
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
    assert.deepEqual(decodeFunctionData({ abi: OWNER_ABI, data: res.ownerCalls![0].data }).args, [USDC_MINT32]);
    assert.deepEqual(decodeFunctionData({ abi: OWNER_ABI, data: res.ownerCalls![1].data }).args, [0, 1]);
    assert.ok(text0(lines).indexOf(res.ownerCalls![0].data) < text0(lines).indexOf(res.ownerCalls![1].data), "ensureBridgeAta is printed first");
    // the record carries the commit and two hashes a person can check against the chain
    assert.match(rec[RECORD_KEY].commit, /^[0-9a-f]{40}$|^unknown$/);
    assert.match(rec[RECORD_KEY].codeHash, /^0x[0-9a-f]{64}$/);
    assert.match(rec[RECORD_KEY].deployInputHash, /^0x[0-9a-f]{64}$/);
    assert.equal(rec[RECORD_KEY].bytecodeHash, undefined);
    const chainCode = (await pc.getCode({ address: res.deployed!.address })) as `0x${string}`;
    const chainTx = await pc.getTransaction({ hash: res.deployed!.txHash });
    assert.equal(rec[RECORD_KEY].codeHash, keccak256(chainCode), "codeHash = keccak256(eth_getCode)");
    assert.equal(rec[RECORD_KEY].deployInputHash, keccak256(chainTx.input), "deployInputHash = keccak256(deploy tx input)");
    assert.equal(rec[RECORD_KEY].deployedAt, Number((await pc.getBlock({ blockNumber: chainTx.blockNumber })).timestamp));
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
    let slept = 0;
    const evil: DeployDeps = {
      ...d,
      deploy: async (args, f) => {
        const a = [...args] as any[];
        a[4] = { ...a[4], admin: wrongOwner }; // the mock deploy puts someone else in as owner
        return d.deploy(a as any, f);
      },
      sleep: async () => { slept++; },
    };
    await assert.rejects(runRubiconV13Deploy(evil, opts()), (e: Error) => {
      assert.match(e.message, /FAILED the read-back and was NOT recorded/);
      assert.match(e.message, /owner\(\) is 0x[0-9a-fA-F]{40}, expected /);
      return true;
    });
    assert.equal(store.peek()[RECORD_KEY], undefined);
    assert.equal(slept, 0, "a wrong value is final: no retry");
    assert.equal(lines.some((l) => /OWNER CALLS/.test(l)), false, "no owner calls are printed for a bad contract");
  });

  it("a deploy with the wrong guardian, or the deploy key as owner, also fails", async () => {
    for (const bad of ["guardian", "deployer-owner"]) {
      const store = memStore(RUBICON_LIKE());
      const d = await deps(store, []);
      const evil: DeployDeps = {
        ...d,
        deploy: async (args, f) => {
          const a = [...args] as any[];
          if (bad === "guardian") a[5] = wallets[6].account.address;
          else a[4] = { ...a[4], admin: wallets[0].account.address };
          return d.deploy(a as any, f);
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

describe("Rubicon rules, run on a local chain with the guard faked to report 7531 (nothing is ever sent to Rubicon)", function () {
  let conn: any, viem: any, pc: any;
  let wallets: any[];
  let wrapper: any;
  let v12: any;
  const A = (n: number) => getAddress(wallets[n].account.address);

  const V12_OWNER_NOTE = /v12 owner\(\) is 0x[0-9a-fA-F]{40}; the new owner is /;

  const STORE = () => ({
    SPL_ERC20_USDC: { address: wrapper.address, mintId: USDC_MINT, symbol: "wUSDC" },
    RomeBridgeWithdraw: { address: v12.address, deployedAt: 1790219940 },
  });
  function memStore(initial: Record<string, any>) {
    let data = structuredClone(initial);
    return { read: () => structuredClone(data), write: (d: Record<string, any>) => { data = structuredClone(d); }, peek: () => data };
  }
  const opts = (over: Partial<DeployOptions> = {}): DeployOptions => ({
    network: "rubicon", owner: A(1), guardian: A(2),
    dryRun: false, mainnetFlag: true, deployDigest: undefined, verifyExisting: undefined, ownerDiffersFromV12: false, ...over,
  });
  const GOOD_SOURCE = { commit: "a".repeat(40), contractsClean: true, build: { ok: true, problems: [] as string[], buildInfoId: "solc-0_8_28-test", solcVersion: "0.8.28" } };
  const SOURCE_COMMIT = "a".repeat(40);
  const verifyOf = (landed: { address: string; txHash: string }) => ({ address: landed.address, txHash: landed.txHash, sourceCommit: SOURCE_COMMIT });
  const ctorFor = (owner: `0x${string}`) => buildWithdrawConstructorArgs({ networkName: "rubicon", usdcWrapper: wrapper.address, usdcMintBase58: USDC_MINT, owner, guardian: A(2) });

  /**
   * Real reads and a real deploy on the local chain, but the guard in the runner reports 7531
   * and the network is called rubicon. `counters.deploys` counts calls to the (local) deploy.
   */
  async function mainDeps(store: { read(): any; write(d: any): void }, lines: string[], over: Partial<DeployDeps> = {}) {
    const d = await depsFromConnection(conn, store, (l) => lines.push(l));
    const counters = { deploys: 0, estimates: 0 };
    const deps: DeployDeps = {
      ...d,
      networkName: "rubicon",
      guard: async () => 7531,
      source: async () => GOOD_SOURCE,
      sourceAt: async (c: string) => ({ commit: c, sameSources: true }),
      estimate: async () => { counters.estimates++; return { gas: 3_000_000n, gasPrice: 10n, gasPricePinned: true, balance: 10n ** 18n }; },
      deploy: async (args) => { counters.deploys++; return d.deploy(args, false); }, // the local chain's own guard: 31337
      sleep: async () => {},
      ...over,
    };
    return { deps, counters, d };
  }
  const digestFor = async (store: ReturnType<typeof memStore>, over: Partial<DeployOptions> = {}) => {
    const { deps } = await mainDeps(store, []);
    return (await runRubiconV13Deploy(deps, opts(over))).digest!;
  };

  before(async () => {
    conn = await hardhat.network.connect();
    viem = conn.viem;
    pc = await viem.getPublicClient();
    wallets = await viem.getWalletClients();
    wrapper = await viem.deployContract("MockSplErc20", [USDC_MINT32]);
    // v12's owner() is the chain's contract admin: the intended v13 owner (A(1) in these tests)
    const ctor = buildWithdrawConstructorArgs({ networkName: "hardhatMainnet", usdcWrapper: wrapper.address, usdcMintBase58: USDC_MINT, owner: A(1), guardian: A(9) });
    v12 = await viem.deployContract("RomeBridgeWithdraw", [...ctor]);
  });

  it("on Rubicon a run without --deploy is a dry run: nothing is sent, the digest is printed, and v12's owner is shown next to --owner", async () => {
    const store = memStore(STORE());
    const lines: string[] = [];
    const { deps, counters } = await mainDeps(store, lines);
    const nonce = await pc.getTransactionCount({ address: A(0) });
    const r = await runRubiconV13Deploy(deps, opts());   // neither --dry-run nor --deploy
    assert.equal(r.dryRun, true);
    assert.equal(counters.deploys, 0);
    assert.equal(await pc.getTransactionCount({ address: A(0) }), nonce);
    assert.deepEqual(store.peek(), STORE());
    const text = lines.join("\n");
    assert.match(text, /mode DRY RUN \(nothing is sent; the default on Rubicon\)/);
    assert.ok(text.includes(`deploy digest ${r.digest}`));
    assert.match(text, /run the same command with --deploy 0x[0-9a-f]{16}/);
    assert.match(text, V12_OWNER_NOTE);
    assert.match(text, new RegExp(`source: commit ${"a".repeat(40)}`));
    assert.match(text, /deploy input hash 0x[0-9a-f]{64}/);
    assert.match(text, /deploy key nonce \d+: the contract will be created at 0x[0-9a-fA-F]{40}/);
    assert.doesNotMatch(text, /bytecode hash/);
    assert.match(text, /pinned gas price 10/);
    // an explicit --dry-run says so
    const lines2: string[] = [];
    const { deps: d2 } = await mainDeps(memStore(STORE()), lines2);
    await runRubiconV13Deploy(d2, opts({ dryRun: true }));
    assert.match(lines2.join("\n"), /mode DRY RUN \(nothing is sent\)/);
  });

  it("the digest follows the bytecode, the constructor arguments (owner, guardian), the chain, the deploy key and its nonce", async () => {
    const { deps } = await mainDeps(memStore(STORE()), []);
    const base = (await runRubiconV13Deploy(deps, opts())).digest!;
    assert.match(base, /^0x[0-9a-f]{16}$/);
    assert.equal((await runRubiconV13Deploy(deps, opts())).digest, base, "stable");
    assert.notEqual((await runRubiconV13Deploy(deps, opts({ owner: A(3) }))).digest, base);
    assert.notEqual((await runRubiconV13Deploy(deps, opts({ guardian: A(3) }))).digest, base);
    const data = deps.deployData(ctorFor(A(1)));
    const nonce = await pc.getTransactionCount({ address: A(0), blockTag: "pending" });
    assert.equal(deployDigest(data, 7531, A(0), nonce), base);
    assert.notEqual(deployDigest(data, 7532, A(0), nonce), base);
    assert.notEqual(deployDigest(data, 7531, A(4), nonce), base);
    assert.notEqual(deployDigest(data, 7531, A(0), nonce + 1), base, "the deploy key's nonce is in the digest");
    assert.notEqual(deployDigest((data.slice(0, -2) + (data.endsWith("ff") ? "fe" : "ff")) as `0x${string}`, 7531, A(0), nonce), base, "one changed byte of the data");
  });

  it("a real deploy on Rubicon needs the digest: a wrong one, or the digest of a different owner, is refused and nothing is sent", async () => {
    const store = memStore(STORE());
    const good = await digestFor(store);
    for (const bad of ["0x0000000000000000", "0xffffffffffffffff", good.slice(0, -1) + (good.endsWith("0") ? "1" : "0")]) {
      const lines: string[] = [];
      const { deps, counters } = await mainDeps(store, lines);
      await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: bad })), (e: Error) => {
        assert.match(e.message, /does not match this deploy/);
        assert.equal(e.message.includes(good), false, "the error never prints the digest that would pass");
        return true;
      });
      assert.equal(counters.deploys, 0);
      assert.equal(lines.join("\n").toLowerCase().includes(good.toLowerCase()), false, "a refused run's log never contains the digest that would pass");
    }
    const other = await digestFor(memStore(STORE()), { owner: A(3) });
    const lines2: string[] = [];
    const { deps, counters } = await mainDeps(store, lines2);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: other })), /does not match this deploy/);
    assert.equal(counters.deploys, 0);
    assert.equal(lines2.join("\n").toLowerCase().includes(good.toLowerCase()), false);
    assert.equal(store.peek()[RECORD_KEY], undefined);
  });

  it("with the digest of the dry run the deploy goes ahead once, reads back, records the commit and bytecode hash beside v12, and prints ensureBridgeAta first", async () => {
    const store = memStore(STORE());
    const good = await digestFor(store);
    const { deps, counters } = await mainDeps(store, []);
    const r = await runRubiconV13Deploy(deps, opts({ deployDigest: good.toUpperCase().replace("0X", "0x") as `0x${string}` }));
    assert.equal(r.dryRun, false);
    assert.equal(counters.deploys, 1);
    const rec = store.peek();
    assert.equal(rec[RECORD_KEY].address, r.deployed!.address);
    assert.equal(rec[RECORD_KEY].commit, "a".repeat(40));
    // the recorded hashes are checkable against the chain: keccak256(eth_getCode) and keccak256(deploy tx input)
    const onChainCode = (await pc.getCode({ address: r.deployed!.address })) as `0x${string}`;
    const onChainTx = await pc.getTransaction({ hash: r.deployed!.txHash });
    assert.equal(rec[RECORD_KEY].codeHash, keccak256(onChainCode));
    assert.equal(rec[RECORD_KEY].deployInputHash, keccak256(onChainTx.input));
    assert.equal(rec[RECORD_KEY].deployInputHash, keccak256(deps.deployData(ctorFor(A(1)))));
    assert.equal(rec[RECORD_KEY].bytecodeHash, undefined, "the artifact hash (immutables zeroed) is not recorded: it can never match the chain");
    const deployBlock = await pc.getBlock({ blockNumber: onChainTx.blockNumber });
    assert.equal(rec[RECORD_KEY].deployedAt, Number(deployBlock.timestamp), "deployedAt is the deploy block's time");
    assert.deepEqual(rec.RomeBridgeWithdraw, STORE().RomeBridgeWithdraw);
    assert.equal(decodeFunctionData({ abi: OWNER_ABI, data: r.ownerCalls![0].data }).functionName, "ensureBridgeAta");
    assert.deepEqual(decodeFunctionData({ abi: OWNER_ABI, data: r.ownerCalls![1].data }).args, [0, 1]);
    // running it again is refused
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: good })), /already recorded/);
  });

  it("on Rubicon owner and guardian must be checksummed, hold no code, and the owner must hold gas", async () => {
    const lower = (a: string) => a.toLowerCase();
    const { deps, counters } = await mainDeps(memStore(STORE()), []);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ owner: lower(A(1)) })), /not EIP-55 checksummed/);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ guardian: lower(A(2)) })), /not EIP-55 checksummed/);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ owner: getAddress(wrapper.address) })), /--owner .* has contract code/);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ guardian: getAddress(wrapper.address) })), /--guardian .* has contract code/);
    assert.equal(counters.deploys, 0);
    // an owner with no gas: the dry run warns, the real deploy refuses
    const empty = A(1).toLowerCase();
    const noGas = { accountInfo: async (a: string) => ({ hasCode: false, balance: a.toLowerCase() === empty ? 0n : 1n }) };
    const lines: string[] = [];
    const { deps: dd } = await mainDeps(memStore(STORE()), lines, noGas as any);
    const dry = await runRubiconV13Deploy(dd, opts());
    assert.match(lines.join("\n"), /WARNING: the owner holds no Rubicon gas/);
    await assert.rejects(runRubiconV13Deploy(dd, opts({ deployDigest: dry.digest })), /owner .* holds no Rubicon gas/);
    // off Rubicon none of this applies: a lowercase owner works on the local chain
    const local = await depsFromConnection(conn, memStore(STORE()), () => {});
    const r = await runRubiconV13Deploy(local, { ...opts({ network: "hardhatMainnet", mainnetFlag: false, dryRun: true }), owner: lower(A(1)) });
    assert.equal(r.dryRun, true);
  });

  it("on Rubicon contracts/ must be clean, RUBICON_GAS_PRICE must be pinned, and the deploy key must cover the cost", async () => {
    const dirty = await mainDeps(memStore(STORE()), [], { source: async () => ({ ...GOOD_SOURCE, contractsClean: false }) });
    await assert.rejects(runRubiconV13Deploy(dirty.deps, opts()), /contracts\/, hardhat\.config\.ts or package-lock\.json has uncommitted changes/);
    await assert.rejects(runRubiconV13Deploy(dirty.deps, opts({ dryRun: true })), /has uncommitted changes/);
    assert.equal(dirty.counters.deploys, 0);

    const unpinned = await mainDeps(memStore(STORE()), [], { estimate: async () => ({ gas: 3_000_000n, gasPrice: 10n, gasPricePinned: false, balance: 10n ** 18n }) });
    await assert.rejects(runRubiconV13Deploy(unpinned.deps, opts()), /RUBICON_GAS_PRICE is not set/);
    assert.equal(unpinned.counters.deploys, 0);

    const lines: string[] = [];
    const poor = await mainDeps(memStore(STORE()), lines, { estimate: async () => ({ gas: 3_000_000n, gasPrice: 10n, gasPricePinned: true, balance: 29_999_999n }) });
    const dry = await runRubiconV13Deploy(poor.deps, opts());
    assert.match(lines.join("\n"), /WARNING: below the estimated cost/);
    await assert.rejects(runRubiconV13Deploy(poor.deps, opts({ deployDigest: dry.digest })), /below the estimated cost/);
    assert.equal(poor.counters.deploys, 0);
  });

  it("the estimate uses the network's pinned gas price (what the real deploy sends), and says when there is none", async () => {
    const via = (networkConfig: any) => depsFromConnection({ viem, networkName: conn.networkName, networkConfig }, memStore(STORE()), () => {});
    const args = ctorFor(A(1));
    const pinned = await (await via({ gasPrice: 1234n })).estimate(args);
    assert.equal(pinned.gasPrice, 1234n);
    assert.equal(pinned.gasPricePinned, true);
    assert.equal((await (await via({ gasPrice: "auto" })).estimate(args)).gasPricePinned, false);
    assert.equal((await (await via(undefined)).estimate(args)).gasPricePinned, false);
  });

  it("a read-back that fails on a lagging node is retried; a persistent failure points to --verify-existing and records nothing", async () => {
    const good = await digestFor(memStore(STORE()));
    // lag: no code for the first two reads
    const store = memStore(STORE());
    let slept = 0;
    let reads = 0;
    const { deps } = await mainDeps(store, [], { sleep: async () => { slept++; } });
    const lagging: DeployDeps = { ...deps, reader: (a) => ({ ...deps.reader(a), getCode: async () => (reads++ < 2 ? undefined : deps.reader(a).getCode()) }) };
    const r = await runRubiconV13Deploy(lagging, opts({ deployDigest: good }));
    assert.equal(r.dryRun, false);
    assert.equal(slept, 2);
    assert.ok(store.peek()[RECORD_KEY]);

    // the node never answers
    const store2 = memStore(STORE());
    const good2 = await digestFor(memStore(STORE())); // the first deploy moved the deploy key's nonce: a fresh digest
    const dead = await mainDeps(store2, [], { sleep: async () => { slept++; } });
    const failing: DeployDeps = { ...dead.deps, reader: (a) => ({ ...dead.deps.reader(a), getCode: async () => { throw new Error("socket hang up"); } }) };
    await assert.rejects(runRubiconV13Deploy(failing, opts({ deployDigest: good2 })), (e: Error) => {
      assert.match(e.message, /Do NOT deploy again/);
      assert.match(e.message, /--verify-existing 0x[0-9a-fA-F]{40} --deploy-tx 0x[0-9a-f]{64}/);
      assert.doesNotMatch(e.message, /FAILED the read-back/);
      return true;
    });
    assert.equal(store2.peek()[RECORD_KEY], undefined);
    assert.equal(dead.counters.deploys, 1);
  });

  it("--verify-existing checks the transaction, reads the contract back, records it and prints the owner calls, sending nothing", async () => {
    const store = memStore(STORE());
    const lines: string[] = [];
    const { deps, counters, d } = await mainDeps(store, lines);
    // the transient failure: the deploy landed, nothing was recorded
    const landed = await d.deploy(ctorFor(A(1)), false);
    assert.equal(store.peek()[RECORD_KEY], undefined);
    const nonce = await pc.getTransactionCount({ address: A(0) });
    const r = await runRubiconV13Deploy(deps, opts({ verifyExisting: verifyOf(landed) }));
    assert.equal(counters.deploys, 0);
    assert.equal(await pc.getTransactionCount({ address: A(0) }), nonce);
    assert.equal(r.deployed!.address, getAddress(landed.address));
    assert.equal(store.peek()[RECORD_KEY].address, getAddress(landed.address));
    assert.equal(store.peek()[RECORD_KEY].deployTx, landed.txHash);
    assert.equal(r.ownerCalls!.length, 2);
    assert.match(lines.join("\n"), /mode VERIFY EXISTING/);
    // the record is the same kind as a fresh deploy's: chain-checkable hashes and the deploy block's time
    const rec = store.peek()[RECORD_KEY];
    const tx = await pc.getTransaction({ hash: landed.txHash });
    assert.equal(rec.codeHash, keccak256((await pc.getCode({ address: landed.address })) as `0x${string}`));
    assert.equal(rec.deployInputHash, keccak256(tx.input));
    assert.equal(rec.deployedAt, Number((await pc.getBlock({ blockNumber: tx.blockNumber })).timestamp));
  });

  it("--verify-existing records the deploy block's time, not the time of the verify run", async () => {
    const store = memStore(STORE());
    const { deps, d } = await mainDeps(store, [], {});
    const landed = await d.deploy(ctorFor(A(1)), false);
    const tx = await pc.getTransaction({ hash: landed.txHash });
    const blockTime = Number((await pc.getBlock({ blockNumber: tx.blockNumber })).timestamp);
    await runRubiconV13Deploy(deps, opts({ verifyExisting: verifyOf(landed) }));
    assert.equal(store.peek()[RECORD_KEY].deployedAt, blockTime);
    // with no block time to read, verify refuses rather than record the verify time
    const store2 = memStore(STORE());
    const noTime = await mainDeps(store2, [], { getDeployTx: async (h) => ({ ...(await d.getDeployTx(h))!, blockTimestamp: undefined }) });
    await assert.rejects(runRubiconV13Deploy(noTime.deps, opts({ verifyExisting: verifyOf(landed) })), /block time .* could not be read/);
    assert.equal(store2.peek()[RECORD_KEY], undefined);
  });

  it("--verify-existing refuses another address, an unknown hash, and a transaction that deployed other constructor arguments", async () => {
    const store = memStore(STORE());
    const { deps, d } = await mainDeps(store, []);
    const landed = await d.deploy(ctorFor(A(1)), false);
    const other = await d.deploy(ctorFor(A(3)), false); // a different owner
    await assert.rejects(runRubiconV13Deploy(deps, opts({ verifyExisting: { ...verifyOf(landed), address: other.address } })), /created .*, not 0x/);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ verifyExisting: verifyOf(other) })), /not this artifact's bytecode with these constructor arguments/);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ verifyExisting: { ...verifyOf(landed), txHash: ("0x" + "cd".repeat(32)) as `0x${string}` } })), /does not know transaction/);
    assert.equal(store.peek()[RECORD_KEY], undefined);
  });

  // ── Findings from the PR #391 audit ───────────────────────────────────────

  it("the digest covers the deploy key's nonce: a transaction that lands after the dry run makes its digest stale, and nothing is sent", async () => {
    const store = memStore(STORE());
    const lines: string[] = [];
    const { deps, counters } = await mainDeps(store, lines);
    const dry = await runRubiconV13Deploy(deps, opts());
    assert.equal(dry.nonce, await pc.getTransactionCount({ address: A(0), blockTag: "pending" }));
    assert.match(lines.join("\n"), new RegExp(`the contract will be created at ${predictedAddress(A(0), dry.nonce!)}`));
    // something from the deploy key lands (another run, or a send whose answer was lost)
    await viem.deployContract("MockSplErc20", [USDC_MINT32]);
    const nonceAfter = await pc.getTransactionCount({ address: A(0) });
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: dry.digest })), /does not match this deploy.*nonce/s);
    assert.equal(counters.deploys, 0);
    assert.equal(await pc.getTransactionCount({ address: A(0) }), nonceAfter, "nothing was sent");
    // the fresh dry run has a new digest and a new predicted address, and that one deploys
    const dry2 = await runRubiconV13Deploy(deps, opts());
    assert.notEqual(dry2.digest, dry.digest);
    assert.equal(dry2.nonce, nonceAfter);
    const r = await runRubiconV13Deploy(deps, opts({ deployDigest: dry2.digest }));
    assert.equal(getAddress(r.deployed!.address), predictedAddress(A(0), nonceAfter), "the contract is where the dry run said");
  });

  it("a send whose answer is lost still leaves a trail: the error says it MAY have landed with the nonce and the predicted address, and the old digest is refused afterwards", async () => {
    const store = memStore(STORE());
    const lost = {
      getPublicClient: () => viem.getPublicClient(),
      getWalletClients: async () => {
        const [w, ...rest] = await viem.getWalletClients();
        // the node accepted and mined the transaction; the HTTP answer never came back (a 502 from the gateway)
        return [{ account: w.account, deployContract: async (a: unknown) => { await w.deployContract(a); throw new Error("An unknown RPC error occurred.\n\nStatus: 502\nReceived an unexpected status code"); } }, ...rest];
      },
    };
    const d = await depsFromConnection({ viem: lost, networkName: conn.networkName }, store, () => {});
    const deps: DeployDeps = { ...d, networkName: "rubicon", guard: async () => 7531, source: async () => GOOD_SOURCE, sourceAt: async (c) => ({ commit: c, sameSources: true }), sleep: async () => {}, estimate: async () => ({ gas: 3_000_000n, gasPrice: 10n, gasPricePinned: true, balance: 10n ** 18n }) };
    const dry = await runRubiconV13Deploy(deps, opts());
    const nonce = dry.nonce!;
    const predicted = predictedAddress(A(0), nonce);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: dry.digest })), (e: Error) => {
      assert.match(e.message, /MAY have landed/);
      assert.match(e.message, /Do NOT deploy again/);
      assert.ok(e.message.includes(`nonce ${nonce}`), "names the nonce");
      assert.ok(e.message.includes(predicted), "names the predicted address");
      assert.match(e.message, /cast nonce 0x[0-9a-fA-F]{40}/);
      assert.ok(e.message.includes(`cast code ${predicted}`));
      assert.match(e.message, /--verify-existing/);
      assert.match(e.message, /unknown RPC error/, "the cause is still there");
      return true;
    });
    // it did land: the nonce moved and the contract sits at the predicted address
    assert.equal(await pc.getTransactionCount({ address: A(0) }), nonce + 1);
    assert.notEqual(await pc.getCode({ address: predicted }), undefined);
    assert.equal(store.peek()[RECORD_KEY], undefined);
    // the operator re-runs the dry run: the digest is a NEW one, and the old one no longer deploys a second contract
    const dry2 = await runRubiconV13Deploy(deps, opts());
    assert.notEqual(dry2.digest, dry.digest);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: dry.digest })), /does not match this deploy/);
    assert.equal(await pc.getTransactionCount({ address: A(0) }), nonce + 1, "no second contract");
  });

  it("the send passes the approved nonce explicitly to the wallet, and the mined address and nonce must be the approved ones", async () => {
    const seen: any[] = [];
    const spy = {
      getPublicClient: () => viem.getPublicClient(),
      getWalletClients: async () => {
        const [w, ...rest] = await viem.getWalletClients();
        return [{ account: w.account, deployContract: async (a: any) => { seen.push(a); return w.deployContract(a); } }, ...rest];
      },
    };
    const d = await depsFromConnection({ viem: spy, networkName: conn.networkName }, memStore(STORE()), () => {});
    const nonce = await pc.getTransactionCount({ address: A(0), blockTag: "pending" });
    const out = await d.deploy(ctorFor(A(1)), false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].nonce, nonce, "the validated nonce is handed to the wallet, not left to it");
    assert.equal(getAddress(out.address), predictedAddress(A(0), nonce));
  });

  it("a deploy that was mined at another address or under another nonce than the approved ones is refused and not recorded, with what to do next", async () => {
    // another address than the predicted one
    const s1 = memStore(STORE());
    const good = await digestFor(memStore(STORE()));
    const m1 = await mainDeps(s1, [], {});
    const other: DeployDeps = { ...m1.deps, deploy: async (args) => { const r = await m1.d.deploy(args, false); return { ...r, address: A(7) as `0x${string}` }; } };
    await assert.rejects(runRubiconV13Deploy(other, opts({ deployDigest: good })), (e: Error) => {
      assert.match(e.message, /created 0x[0-9a-fA-F]{40}, not the approved 0x[0-9a-fA-F]{40} \(deploy key nonce \d+\), so it is NOT recorded/);
      assert.match(e.message, /do NOT deploy again yet/);
      assert.match(e.message, /--verify-existing/);
      return true;
    });
    assert.equal(s1.peek()[RECORD_KEY], undefined);
    // the mined transaction carries another nonce
    const s2 = memStore(STORE());
    const good2 = await digestFor(memStore(STORE()));
    const m2 = await mainDeps(s2, []);
    const wrapped: DeployDeps = { ...m2.deps, getDeployTx: async (h) => { const t = (await m2.d.getDeployTx(h))!; return { ...t, nonce: (t.nonce ?? 0) + 1 }; } };
    await assert.rejects(runRubiconV13Deploy(wrapped, opts({ deployDigest: good2 })), (e: Error) => {
      assert.match(e.message, /is not the approved deploy/);
      assert.match(e.message, /used nonce \d+, not the approved nonce \d+/);
      assert.match(e.message, /NOT recorded/);
      return true;
    });
    assert.equal(s2.peek()[RECORD_KEY], undefined);
    // a mined transaction that does not report its nonce at all is refused too
    const s3 = memStore(STORE());
    const good3 = await digestFor(memStore(STORE()));
    const m3 = await mainDeps(s3, []);
    const blind: DeployDeps = { ...m3.deps, getDeployTx: async (h) => ({ ...(await m3.d.getDeployTx(h))!, nonce: undefined }) };
    await assert.rejects(runRubiconV13Deploy(blind, opts({ deployDigest: good3 })), /used nonce \(unknown\), not the approved nonce/);
    assert.equal(s3.peek()[RECORD_KEY], undefined);
  });

  it("the real send boundary recomputes the digest from the bytes and nonce it sends; on a local chain no digest is needed (the 7531 rule is the guard's, tested in testnet-guard.test.ts)", async () => {
    const d = await depsFromConnection(conn, memStore(STORE()), () => {});
    const args = ctorFor(A(1));
    const nonce = await pc.getTransactionCount({ address: A(0), blockTag: "pending" });
    const good = deployDigest(d.deployData(args), 31337, A(0), nonce);
    assert.match(good, /^0x[0-9a-f]{16}$/);
    // on the local chain the guard does not need the digest, so the send goes ahead with or without it
    const a = await d.deploy(args, false, "0x0000000000000000" as `0x${string}`);
    assert.equal(getAddress(a.address), predictedAddress(A(0), nonce));
  });

  it("the mined hash is recorded, not the sent one: a repriced replacement comes back under its own hash", async () => {
    const hashA = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const hashB = ("0x" + "bb".repeat(32)) as `0x${string}`;
    const created = ADDR(0xc0de) as `0x${string}`;
    const fake = {
      getPublicClient: async () => ({
        getChainId: async () => 31337, getTransactionCount: async () => 7,
        waitForTransactionReceipt: async ({ hash }: { hash: string }) => { assert.equal(hash, hashA, "waits on the hash it sent"); return { status: "success", contractAddress: created, transactionHash: hashB }; },
      }),
      getWalletClients: async () => [{ account: { address: A(0) }, deployContract: async () => hashA }],
    };
    const lines: string[] = [];
    const d = await depsFromConnection({ viem: fake, networkName: "hardhatMainnet" }, memStore(STORE()), (l) => lines.push(l));
    const out = await d.deploy(ctorFor(A(1)), false);
    assert.equal(out.txHash, hashB);
    assert.equal(out.address, created);
    assert.match(lines.join("\n"), /was replaced; the mined one is 0xbb/);
  });

  it("a mined transaction that is not the approved deploy is refused and not recorded: other data, another sender, or a call", async () => {
    for (const [name, change, expected] of [
      ["other data (a replacement with different constructor arguments)", { input: "0x1234" }, /not this artifact's bytecode/],
      ["another sender", { from: A(5) }, /sent by .*, not by the deploy key/],
      ["a call, not a creation", { to: A(6) }, /call to .*not a contract creation/],
      ["a different created address", { contractAddress: A(7) }, /created .*, not 0x/],
      ["reverted", { status: "reverted" }, /status is reverted/],
    ] as const) {
      const store = memStore(STORE());
      const good = await digestFor(memStore(STORE()));
      const { deps, d } = await mainDeps(store, []);
      const wrapped: DeployDeps = { ...deps, getDeployTx: async (h) => ({ ...(await d.getDeployTx(h))!, ...change } as any) };
      await assert.rejects(runRubiconV13Deploy(wrapped, opts({ deployDigest: good })), (e: Error) => {
        assert.match(e.message, /is not the approved deploy/, name);
        assert.match(e.message, expected, name);
        assert.match(e.message, /NOT recorded/, name);
        return true;
      });
      assert.equal(store.peek()[RECORD_KEY], undefined, name);
    }
  });

  it("a fresh deploy never records the local clock: a missing block time is retried, and then nothing is recorded with the recovery command", async () => {
    // transient: the transaction, then its block, are not there for the first reads
    const good = await digestFor(memStore(STORE()));
    const store = memStore(STORE());
    let slept = 0;
    let calls = 0;
    const { deps, d } = await mainDeps(store, [], { sleep: async () => { slept++; } });
    const flaky: DeployDeps = {
      ...deps,
      getDeployTx: async (h) => {
        calls++;
        if (calls === 1) return undefined;
        if (calls === 2) return { ...(await d.getDeployTx(h))!, blockTimestamp: undefined };
        return d.getDeployTx(h);
      },
    };
    const r = await runRubiconV13Deploy(flaky, opts({ deployDigest: good }));
    assert.ok(slept >= 2);
    const tx = await pc.getTransaction({ hash: r.deployed!.txHash });
    assert.equal(store.peek()[RECORD_KEY].deployedAt, Number((await pc.getBlock({ blockNumber: tx.blockNumber })).timestamp), "the block's time");

    // persistent: no block time ever
    const store2 = memStore(STORE());
    const good2 = await digestFor(memStore(STORE()));
    const { deps: dd, d: d2 } = await mainDeps(store2, []);
    const lines: string[] = [];
    const never: DeployDeps = { ...dd, log: (l) => lines.push(l), getDeployTx: async (h) => ({ ...(await d2.getDeployTx(h))!, blockTimestamp: undefined }) };
    await assert.rejects(runRubiconV13Deploy(never, opts({ deployDigest: good2 })), (e: Error) => {
      assert.match(e.message, /block time .* could not be read, so deployedAt cannot be recorded/);
      assert.match(e.message, /Nothing was recorded/);
      assert.match(e.message, /Do NOT deploy again.*--verify-existing 0x[0-9a-fA-F]{40} --deploy-tx 0x[0-9a-f]{64} --source-commit a{40}/s);
      return true;
    });
    assert.equal(store2.peek()[RECORD_KEY], undefined);
    // the clock is not an input any more
    assert.equal("now" in dd, false);
    assert.doesNotMatch(readFileSync(path.join(repo, "scripts/bridge/lib/rubicon-v13.ts"), "utf8"), /Date\.now|deps\.now/);
  });

  it("the record carries the build (build-info id and solc version) and the commit the checks passed on", async () => {
    const store = memStore(STORE());
    const good = await digestFor(memStore(STORE()));
    const { deps } = await mainDeps(store, []);
    await runRubiconV13Deploy(deps, opts({ deployDigest: good }));
    assert.deepEqual(store.peek()[RECORD_KEY].build, { buildInfoId: "solc-0_8_28-test", solcVersion: "0.8.28" });
  });

  it("on Rubicon an artifact that was not compiled from the sources on disk is refused, dry run included; off Rubicon it only warns", async () => {
    const stale = { ...GOOD_SOURCE, build: { ok: false, problems: ["project/contracts/bridge/RomeBridgeWithdraw.sol: differs from what the artifact was compiled from (stale artifact: compile again)"], buildInfoId: "solc-old" } };
    const { deps, counters } = await mainDeps(memStore(STORE()), [], { source: async () => stale });
    await assert.rejects(runRubiconV13Deploy(deps, opts()), /artifact was not built from the sources and settings on disk.*RomeBridgeWithdraw\.sol: differs/s);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ dryRun: true })), /not built from the sources/);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: "0x0123456789abcdef" })), /not built from the sources/);
    assert.equal(counters.deploys, 0);
    const lines: string[] = [];
    const local = await depsFromConnection(conn, memStore(STORE()), (l) => lines.push(l));
    await runRubiconV13Deploy({ ...local, source: async () => stale }, { ...opts({ network: "hardhatMainnet", mainnetFlag: false, dryRun: true }), owner: A(1) });
    assert.match(lines.join("\n"), /artifact NOT built from these sources/);
  });

  it("the real source() reads the working tree: the artifact the tests compiled matches, and --source-commit is checked against HEAD", async () => {
    const d = await depsFromConnection(conn, memStore(STORE()), () => {});
    const src = await d.source();
    assert.deepEqual(src.build.problems, [], "the artifact matches the sources on disk");
    assert.equal(src.build.ok, true);
    assert.match(src.build.buildInfoId, /^solc-0_8_28-/);
    if (src.commit !== "unknown") {
      assert.deepEqual(await d.sourceAt(src.commit), { commit: src.commit, sameSources: true });
      const bad = await d.sourceAt("0".repeat(40));
      assert.equal(bad.sameSources, false);
      assert.match(bad.problem!, /not a commit/);
    }
  });

  it("--verify-existing records the --source-commit it was given, never its own HEAD, and refuses a commit whose sources differ", async () => {
    const store = memStore(STORE());
    const { deps, d } = await mainDeps(store, [], { sourceAt: async (c: string) => ({ commit: "c".repeat(40), sameSources: true }) });
    const landed = await d.deploy(ctorFor(A(1)), false);
    await runRubiconV13Deploy(deps, opts({ verifyExisting: { ...verifyOf(landed), sourceCommit: "b".repeat(40) } }));
    assert.equal(store.peek()[RECORD_KEY].commit, "c".repeat(40), "the resolved --source-commit, not GOOD_SOURCE.commit (the checkout's HEAD)");
    assert.notEqual(store.peek()[RECORD_KEY].commit, GOOD_SOURCE.commit);
    // sources differ
    const store2 = memStore(STORE());
    const { deps: d2 } = await mainDeps(store2, [], { sourceAt: async (c: string) => ({ commit: c, sameSources: false, problem: `${c} has different contracts/` }) });
    await assert.rejects(runRubiconV13Deploy(d2, opts({ verifyExisting: verifyOf(landed) })), /--source-commit .* cannot be recorded: .* has different contracts/);
    assert.equal(store2.peek()[RECORD_KEY], undefined);
  });

  it("an --owner that is not v12's owner() is refused on Rubicon (the swap of owner and guardian, another Ledger account) unless it is on purpose", async () => {
    // Ledger = A(1) (v12's owner), ops key = A(2). The operator pastes them the wrong way round.
    const swapped = { owner: A(2), guardian: A(1) };
    const lines: string[] = [];
    const { deps, counters } = await mainDeps(memStore(STORE()), lines);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ ...swapped, dryRun: true })), /--guardian .* is v12's owner\(\).*swapped.*a dry run included/s);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ ...swapped, ownerDiffersFromV12: true })), /is v12's owner\(\).*swapped/s, "the opt-out does not cover the swap");
    assert.equal(counters.deploys, 0);

    // another account as owner: the dry run says a real deploy will be refused, the real deploy refuses
    const other = { owner: A(3), guardian: A(2) };
    const l2: string[] = [];
    const m2 = await mainDeps(memStore(STORE()), l2);
    const dry = await runRubiconV13Deploy(m2.deps, opts(other));
    assert.match(l2.join("\n"), /WARNING: --owner .* is not v12's owner\(\) .*A real deploy will be refused.*--owner-differs-from-v12/);
    await assert.rejects(runRubiconV13Deploy(m2.deps, opts({ ...other, deployDigest: dry.digest })), /is not v12's owner\(\).*--owner-differs-from-v12/s);
    assert.equal(m2.counters.deploys, 0);
    // on purpose
    const ok = await runRubiconV13Deploy(m2.deps, opts({ ...other, deployDigest: dry.digest, ownerDiffersFromV12: true }));
    assert.equal(ok.dryRun, false);
    assert.equal(m2.counters.deploys, 1);

    // the intended owner needs no flag (every other test in this block deploys that way)
    const m3 = await mainDeps(memStore(STORE()), []);
    const d3 = await runRubiconV13Deploy(m3.deps, opts());
    assert.equal((await runRubiconV13Deploy(m3.deps, opts({ deployDigest: d3.digest }))).dryRun, false);
  });

  it("when v12's owner() cannot be read on Rubicon, a real deploy needs the opt-out too; and a testnet is not checked", async () => {
    const m = await mainDeps(memStore(STORE()), []);
    const blind: DeployDeps = { ...m.deps, reader: (a) => ({ ...m.deps.reader(a), read: async (fn, args) => { if (fn === "owner" && a.toLowerCase() === v12.address.toLowerCase()) throw new Error("boom"); return m.deps.reader(a).read(fn, args); } }) };
    const dry = await runRubiconV13Deploy(blind, opts());
    await assert.rejects(runRubiconV13Deploy(blind, opts({ deployDigest: dry.digest })), /could not be read as an account.*--owner-differs-from-v12/s);
    assert.equal((await runRubiconV13Deploy(blind, opts({ deployDigest: dry.digest, ownerDiffersFromV12: true }))).dryRun, false);
    // no v12 record at all: the dry run still runs (it warns); the real deploy is refused in the next test
    const noV12 = { SPL_ERC20_USDC: STORE().SPL_ERC20_USDC };
    const m2 = await mainDeps(memStore(noV12), []);
    assert.equal((await runRubiconV13Deploy(m2.deps, opts({ owner: A(3) }))).dryRun, true);
    // off Rubicon the local chain's v12 has another owner than wallets[1], and the deploy goes ahead
    const local = await depsFromConnection(conn, memStore(STORE()), () => {});
    assert.equal((await runRubiconV13Deploy(local, { ...opts({ network: "hardhatMainnet", mainnetFlag: false, dryRun: true }), owner: A(4) })).dryRun, true);
  });

  it("a missing or malformed v12 record does not switch the owner safeguard off: a real deploy on Rubicon refuses unless the exception flag is given", async () => {
    const usdc = STORE().SPL_ERC20_USDC;
    for (const [name, store] of [
      ["no v12 record", { SPL_ERC20_USDC: usdc }],
      ["a v12 record with no address", { SPL_ERC20_USDC: usdc, RomeBridgeWithdraw: { deployedAt: 1790219940 } }],
      ["a v12 record with a malformed address", { SPL_ERC20_USDC: usdc, RomeBridgeWithdraw: { address: "0x1234" } }],
    ] as const) {
      const lines: string[] = [];
      const m = await mainDeps(memStore(store), lines);
      const dry = await runRubiconV13Deploy(m.deps, opts());
      assert.match(lines.join("\n"), /WARNING: .*no valid RomeBridgeWithdraw \(v12\) address.*A real deploy will be refused/, name);
      await assert.rejects(runRubiconV13Deploy(m.deps, opts({ deployDigest: dry.digest })), /no valid RomeBridgeWithdraw \(v12\) address.*--owner-differs-from-v12/s, name);
      assert.equal(m.counters.deploys, 0, name);
      assert.equal((await runRubiconV13Deploy(m.deps, opts({ deployDigest: dry.digest, ownerDiffersFromV12: true }))).dryRun, false, name);
    }
  });

  it("a record file that cannot be written prints the record and says to use --verify-existing, not to deploy again", async () => {
    const inner = memStore(STORE());
    const store = { read: inner.read, write: () => { throw new Error("EACCES: permission denied"); } };
    const good = await digestFor(memStore(STORE()));
    const lines: string[] = [];
    const { deps } = await mainDeps(store, lines);
    await assert.rejects(runRubiconV13Deploy(deps, opts({ deployDigest: good })), /read back correctly but deployments\/rubicon\.json could not be written.*Do NOT deploy again.*--verify-existing/s);
    const text = lines.join("\n");
    assert.match(text, /COULD NOT WRITE the record/);
    assert.match(text, /"codeHash"/);
    assert.match(text, /"deployInputHash"/);
  });
});

describe("the real wiring cannot send on Rubicon unless this process was started as deploy-rubicon-v13.ts", function () {
  let viem: any, wallets: any[];
  before(async () => {
    const conn = await hardhat.network.connect();
    viem = conn.viem;
    wallets = await viem.getWalletClients();
  });

  /** A viem whose public client reports 7531 and whose wallet records any deploy. A real RPC is never used. */
  function fakeViem() {
    const sent: unknown[] = [];
    return {
      sent,
      viem: {
        getPublicClient: async () => ({
          getChainId: async () => 7531,
          getTransactionCount: async () => 0,
          estimateGas: async () => 1n, getGasPrice: async () => 1n, getBalance: async () => 1n, getCode: async () => undefined,
          waitForTransactionReceipt: async () => { throw new Error("no chain"); },
        }),
        getWalletClients: async () => [{ account: { address: wallets[0].account.address }, deployContract: async (a: unknown) => { sent.push(a); return "0x" + "00".repeat(32); } }],
      },
    };
  }
  const args = () => buildWithdrawConstructorArgs({ networkName: "rubicon", usdcWrapper: ADDR(0x77), usdcMintBase58: USDC_MINT, owner: LEDGER, guardian: OPS });

  it("an importer's own entry point is refused: guard(true), guard(false) and deploy(args, true) all fail, and no deploy is sent", async () => {
    const f = fakeViem();
    const d = await depsFromConnection({ viem: f.viem, networkName: "rubicon" }, { read: () => ({}), write: () => {} }, () => {});
    // process.argv[1] here is the test runner, not scripts/bridge/deploy-rubicon-v13.ts
    await assert.rejects(d.guard(true), /must be the file this process was started as/);
    await assert.rejects(d.guard(false), /mainnet/);
    await assert.rejects(d.deploy(args(), true), /must be the file this process was started as/);
    await assert.rejects(d.deploy(args(), false), /mainnet/);
    assert.deepEqual(f.sent, [], "no deployContract call reached the wallet");
  });

  it("no argument of the guard names another entry point: a fifth argument is ignored, and 7531 is refused for every caller in this process", async () => {
    const client = { getChainId: async () => 7531 };
    const script = path.join(repo, "scripts/bridge/deploy-rubicon-v13.ts");
    const caller = { script: "scripts/bridge/deploy-rubicon-v13.ts", mainnetFlag: true, phase: "send" as const, digestMatches: true };
    // the old override: a path that IS the script, as the fifth argument
    await assert.rejects((assertRubiconV13DeploySend as any)(client, "t", caller, undefined, script), /must be the file this process was started as/);
    await assert.rejects(assertRubiconV13DeploySend(client, "t", caller), /must be the file this process was started as/);
    await assert.rejects(assertRubiconV13DeploySend(client, "t", { ...caller, phase: "inspect" }), /must be the file this process was started as/);
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
  it("refuses a malformed --deploy digest before it connects to anything", () => {
    const r = run(["--network", "rubicon", "--owner", LEDGER, "--guardian", OPS, FLAG, "--deploy", "0x12"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /8-byte digest/);
    assert.doesNotMatch(r.stderr + r.stdout, /RUBICON_RPC_URL|chain 7531/);
  });
  it("started through a symlink it still runs (not a silent exit 0): the same real-path rule as the guard", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v13-symlink-"));
    try {
      const link = path.join(dir, "linked-deploy.ts");
      fs.symlinkSync(script, link);
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^RUBICON_|^HARDHAT_/.test(k)) delete env[k];
      const r = spawnSync(tsx, [link], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
      assert.notEqual(r.status, 0, "ran main(): the missing arguments are an error, not a silent success");
      assert.match(r.stderr, /is required and has no default/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("isEntryPoint compares real paths: this file by its path or through a symlink, nothing else", () => {
    const self = pathToFileURL(script).href;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v13-entry-"));
    try {
      const link = path.join(dir, "link.ts");
      fs.symlinkSync(script, link);
      assert.equal(isEntryPoint(script, self), true);
      assert.equal(isEntryPoint(link, self), true);
      assert.equal(isEntryPoint(path.join(repo, "scripts/bridge/deploy.ts"), self), false);
      assert.equal(isEntryPoint(path.join(dir, "missing.ts"), self), false);
      assert.equal(isEntryPoint(undefined, self), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("importing the script does not run it", async () => {
    // depsFromConnection and fileStore were imported at the top of this file without a run.
    assert.equal(typeof fileStore, "function");
    assert.equal(typeof depsFromConnection, "function");
  });
});

describe("the deployments file store replaces the file atomically and serializes writers", () => {
  const V12 = { RomeBridgeWithdraw: { address: "0xceea191761cdba2fc589996d7dd096e57db29c84", deployedAt: 1790219940 }, SPL_ERC20_USDC: { address: ADDR(5), mintId: USDC_MINT } };
  const rec = { address: ADDR(0xabc), version: "13.0.0" };
  const withTmp = (fn: (dir: string, file: string, raw: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-atomic-"));
    try {
      const file = path.join(dir, "rubicon.json");
      const raw = JSON.stringify(V12, null, 2) + "\n";
      writeFileSync(file, raw, { mode: 0o640 });
      fn(dir, file, raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const left = (dir: string) => fs.readdirSync(dir).sort();

  it("a write that dies after partial output leaves the original file byte for byte, and no temp or lock file", () => {
    withTmp((dir, file, raw) => {
      // the disk fills after 10 bytes of the new text
      const faulty = { ...fs, writeSync: ((fd: number, buf: Buffer, off: number) => { fs.writeSync(fd, buf, off, 10); throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); }) as unknown as typeof fs.writeSync };
      const store = fileStore(file, faulty);
      assert.throws(() => store.update!((cur) => withV13Record(cur, rec as any)), /ENOSPC/);
      assert.equal(readFileSync(file, "utf8"), raw, "v12 is intact");
      assert.deepEqual(left(dir), ["rubicon.json"]);
      assert.throws(() => store.write({ ...V12, x: 1 }), /ENOSPC/);
      assert.equal(readFileSync(file, "utf8"), raw);
      assert.deepEqual(left(dir), ["rubicon.json"]);
    });
  });

  it("a failure at the flush, or at the rename, also keeps the original and cleans up", () => {
    for (const op of ["fsyncSync", "renameSync"] as const) {
      withTmp((dir, file, raw) => {
        const faulty = { ...fs, [op]: () => { throw new Error(`${op} failed`); } } as typeof fs;
        assert.throws(() => fileStore(file, faulty).update!((cur) => withV13Record(cur, rec as any)), new RegExp(`${op} failed`));
        assert.equal(readFileSync(file, "utf8"), raw, op);
        assert.deepEqual(left(dir), ["rubicon.json"], op);
      });
    }
  });

  it("a good update adds the record, keeps v12 and the file mode, and leaves no temp or lock file", () => {
    withTmp((dir, file) => {
      fileStore(file).update!((cur) => withV13Record(cur, rec as any));
      const back = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(back.RomeBridgeWithdraw, V12.RomeBridgeWithdraw);
      assert.equal(back[RECORD_KEY].address, rec.address);
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
      assert.deepEqual(left(dir), ["rubicon.json"]);
      // a store on a file that does not exist yet creates it
      const fresh = path.join(dir, "new", "x.json");
      fileStore(fresh).write({ a: 1 });
      assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { a: 1 });
    });
  });

  it("a symlinked deployments file is replaced where it really lives, and the link stays a link", () => {
    withTmp((dir, file) => {
      const link = path.join(dir, "link.json");
      fs.symlinkSync(file, link);
      fileStore(link).update!((cur) => withV13Record(cur, rec as any));
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(JSON.parse(readFileSync(file, "utf8"))[RECORD_KEY].address, rec.address);
    });
  });

  it("an existing lock is never taken over, not even a dead process's: the run refuses with instructions, and leaves the lock and the file alone", () => {
    withTmp((dir, file, raw) => {
      const dead = spawnSync(process.execPath, ["-e", "0"]);
      for (const content of [String(process.pid), String(dead.pid), `${dead.pid}:some-token`, ""]) {
        writeFileSync(`${file}.lock`, content);
        assert.throws(() => fileStore(file).update!((cur) => withV13Record(cur, rec as any)), /is locked.*never takes a lock over.*Confirm that no other deploy run is active.*remove the lock file by hand/s, content);
        assert.equal(readFileSync(file, "utf8"), raw);
        assert.equal(readFileSync(`${file}.lock`, "utf8"), content, "the lock is exactly as it was");
      }
      fs.rmSync(`${file}.lock`);
      fileStore(file).update!((cur) => withV13Record(cur, rec as any));
      assert.equal(JSON.parse(readFileSync(file, "utf8"))[RECORD_KEY].address, rec.address);
      assert.deepEqual(left(dir), ["rubicon.json"]);
    });
  });

  it("a run releases only the lock it created: if the lock was removed and another writer took it meanwhile, that writer's lock stays", () => {
    withTmp((dir, file) => {
      const lock = `${file}.lock`;
      // while this run holds the lock (inside update), the file is removed by hand and another run creates its own
      fileStore(file).update!((cur) => {
        fs.rmSync(lock);
        writeFileSync(lock, "4242:the-other-writers-token", { flag: "wx" });
        return { ...cur, A: 1 };
      });
      assert.equal(readFileSync(lock, "utf8"), "4242:the-other-writers-token", "the other writer's live lock is not deleted");
      // and the lock the run did create is gone after a normal update
      fs.rmSync(lock);
      fileStore(file).update!((cur) => ({ ...cur, B: 2 }));
      assert.equal(fs.existsSync(lock), false);
      // a failing update also releases its own lock, and only its own
      assert.throws(() => fileStore(file).update!(() => { throw new Error("boom"); }), /boom/);
      assert.equal(fs.existsSync(lock), false);
    });
  });

  it("two updates under the lock do not lose each other's change, and update re-reads inside the lock", () => {
    withTmp((dir, file) => {
      const a = fileStore(file);
      const b = fileStore(file);
      a.update!((cur) => ({ ...cur, A: 1 }));
      b.update!((cur) => ({ ...cur, B: 2 }));
      const back = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(back.A, 1);
      assert.equal(back.B, 2);
      assert.deepEqual(back.RomeBridgeWithdraw, V12.RomeBridgeWithdraw);
    });
  });

  it("the deploy flow writes the record through update (the atomic path) when the store has it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-flow-"));
    try {
      const conn = await hardhat.network.connect();
      const wallet = (await conn.viem.getWalletClients())[0];
      const wrapperC = await conn.viem.deployContract("MockSplErc20", [USDC_MINT32]);
      const file = path.join(dir, "hardhatMainnet.json");
      const base = { SPL_ERC20_USDC: { address: wrapperC.address, mintId: USDC_MINT }, RomeBridgeWithdraw: V12.RomeBridgeWithdraw };
      writeFileSync(file, JSON.stringify(base, null, 2) + "\n");
      const raw = readFileSync(file, "utf8");
      // the write fails after partial output: the flow reports it, and v12 is still whole
      const faulty = { ...fs, writeSync: ((fd: number, buf: Buffer, off: number) => { fs.writeSync(fd, buf, off, 5); throw new Error("EIO"); }) as unknown as typeof fs.writeSync };
      const d = await depsFromConnection(conn, fileStore(file, faulty), () => {});
      const wallets = await conn.viem.getWalletClients();
      await assert.rejects(runRubiconV13Deploy({ ...d, sleep: async () => {} }, {
        network: "hardhatMainnet", owner: wallets[1].account.address, guardian: wallets[2].account.address, dryRun: false, mainnetFlag: false,
        deployDigest: undefined, verifyExisting: undefined, ownerDiffersFromV12: false,
      }), /could not be written.*Do NOT deploy again.*--verify-existing/s);
      assert.equal(readFileSync(file, "utf8"), raw, "the existing record file is intact");
      assert.deepEqual(left(dir), ["hardhatMainnet.json"]);
      assert.ok(wallet);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the artifact must come from the sources on disk (build-info provenance)", () => {
  const SETTINGS = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" };
  const NAME = "project/contracts/A.sol";
  const code = "6080aa";

  /** A tiny project: a project source, an npm source, a build-info and its output. */
  function fixture(over: { aSource?: string; npmSource?: string; npmVersion?: string; settings?: any; solc?: string; bytecode?: string } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "prov-"));
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
    const A = "contract A { uint x = 1; }";
    const B = "library B {}";
    w("contracts/A.sol", over.aSource ?? A);
    w("node_modules/@oz/contracts/utils/B.sol", over.npmSource ?? B);
    w("node_modules/@oz/contracts/package.json", JSON.stringify({ name: "@oz/contracts", version: over.npmVersion ?? "5.6.1" }));
    const id = "solc-0_8_28-abc";
    w(`artifacts/build-info/${id}.json`, JSON.stringify({ id, solcVersion: "0.8.28", input: { settings: { ...SETTINGS, outputSelection: {}, remappings: [] }, sources: { [NAME]: { content: A }, "npm/@oz/contracts@5.6.1/utils/B.sol": { content: B } } } }));
    w(`artifacts/build-info/${id}.output.json`, JSON.stringify({ id, output: { contracts: { [NAME]: { A: { evm: { bytecode: { object: over.bytecode ?? code } } } } } } }));
    return {
      root,
      input: { root, artifactsDir: path.join(root, "artifacts"), buildInfoId: id, inputSourceName: NAME, contractName: "A", artifactBytecode: "0x" + code, expectedSolcVersion: over.solc ?? "0.8.28", expectedSettings: over.settings ?? { ...SETTINGS, outputSelection: { "*": {} }, remappings: ["x"] } },
      clean: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it("accepts an artifact built from exactly these sources, settings and compiler output", () => {
    const f = fixture();
    try {
      const r = checkBuildProvenance(f.input);
      assert.deepEqual(r.problems, []);
      assert.equal(r.ok, true);
      assert.equal(r.buildInfoId, "solc-0_8_28-abc");
      assert.equal(r.solcVersion, "0.8.28");
    } finally { f.clean(); }
  });

  it("refuses a stale artifact: a project source that was compiled differently, then switched back (a changed constant the read-back never looks at)", () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.root, "contracts/A.sol"), "contract A { uint x = 2; }");   // the tree no longer matches what was compiled
      const r = checkBuildProvenance(f.input);
      assert.equal(r.ok, false);
      assert.match(r.problems.join("\n"), /project\/contracts\/A\.sol: differs from what the artifact was compiled from \(stale artifact/);
    } finally { f.clean(); }
  });

  it("refuses a changed dependency source, another dependency version, a missing source, other settings, another solc and bytecode that is not the compiler's", () => {
    const cases: Array<[string, Parameters<typeof fixture>[0], RegExp]> = [
      ["npm source edited", { npmSource: "library B { /* x */ }" }, /npm\/@oz\/contracts@5\.6\.1\/utils\/B\.sol: differs/],
      ["npm version moved", { npmVersion: "5.7.0" }, /built with @oz\/contracts@5\.6\.1, node_modules has @oz\/contracts@5\.7\.0/],
      ["other optimizer runs", { settings: { ...SETTINGS, optimizer: { enabled: true, runs: 1 } } }, /settings\.optimizer/],
      ["viaIR off in the profile", { settings: { ...SETTINGS, viaIR: false } }, /settings\.viaIR/],
      ["other solc", { solc: "0.8.29" }, /built with solc 0\.8\.28, the build profile says 0\.8\.29/],
      ["bytecode swapped", { bytecode: "6080bb" }, /creation bytecode is not the compiler output/],
    ];
    for (const [name, over, re] of cases) {
      const f = fixture(over);
      try {
        const r = checkBuildProvenance(f.input);
        assert.equal(r.ok, false, name);
        assert.match(r.problems.join("\n"), re, name);
      } finally { f.clean(); }
    }
    const f = fixture();
    try {
      fs.rmSync(path.join(f.root, "contracts/A.sol"));
      assert.match(checkBuildProvenance(f.input).problems.join("\n"), /not on disk any more/);
      fs.rmSync(path.join(f.root, "artifacts/build-info"), { recursive: true });
      assert.match(checkBuildProvenance(f.input).problems.join("\n"), /cannot be read: compile again/);
      assert.match(checkBuildProvenance({ ...f.input, buildInfoId: "../../etc/passwd" }).problems.join("\n"), /not a plain file name/);
    } finally { f.clean(); }
  });

  describe("dependency contents against the lockfile (a patched node_modules with an unchanged lockfile)", () => {
    const PUBLISHED = "library B {}";
    const LOCKED_URL = "https://registry.npmjs.org/@oz/contracts/-/contracts-5.6.1.tgz";

    /** The real published tarball of the fixture package, made with tar, and its sha512 integrity. */
    function publishedTarball(text: string = PUBLISHED) {
      const tmp = mkdtempSync(path.join(tmpdir(), "prov-tgz-"));
      try {
        fs.mkdirSync(path.join(tmp, "package/utils"), { recursive: true });
        writeFileSync(path.join(tmp, "package/utils/B.sol"), text);
        writeFileSync(path.join(tmp, "package/package.json"), JSON.stringify({ name: "@oz/contracts", version: "5.6.1" }));
        const r = spawnSync("tar", ["-czf", "p.tgz", "package"], { cwd: tmp });
        assert.equal(r.status, 0);
        const buf = readFileSync(path.join(tmp, "p.tgz"));
        return { buf, integrity: `sha512-${createHash("sha512").update(buf).digest("base64")}` };
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    const lockWith = (entry: any) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...(entry ? { "node_modules/@oz/contracts": entry } : {}) } });
    function lockedFixture(entry?: any | null) {
      const f = fixture();
      const published = publishedTarball();
      const good = { version: "5.6.1", resolved: LOCKED_URL, integrity: published.integrity };
      writeFileSync(path.join(f.root, "package-lock.json"), lockWith(entry === null ? undefined : (entry ?? good)));
      const dep = { root: f.root, artifactsDir: f.input.artifactsDir, buildInfoId: f.input.buildInfoId };
      return { f, published, dep, fetched: [] as string[] };
    }

    it("accepts a node_modules whose compiler-input files are the locked package's own", async () => {
      const { f, published, dep, fetched } = lockedFixture();
      try {
        const problems = await checkDependencySources({ ...dep, fetchTarball: async (u) => { fetched.push(u); return published.buf; } });
        assert.deepEqual(problems, []);
        assert.deepEqual(fetched, [LOCKED_URL], "one download, from the lockfile's own registry URL");
      } finally { f.clean(); }
    });

    it("refuses a locally patched dependency that the lockfile and the on-disk check both pass (patched, then compiled)", async () => {
      const { f, published, dep } = lockedFixture();
      try {
        // the patch: same version, same lockfile, node_modules edited, then compiled, so the build-info holds the patched text
        const patched = "library B { /* backdoor */ }";
        writeFileSync(path.join(f.root, "node_modules/@oz/contracts/utils/B.sol"), patched);
        const infoFile = path.join(f.root, "artifacts/build-info", `${f.input.buildInfoId}.json`);
        const info = JSON.parse(readFileSync(infoFile, "utf8"));
        info.input.sources["npm/@oz/contracts@5.6.1/utils/B.sol"].content = patched;
        writeFileSync(infoFile, JSON.stringify(info));
        // the existing check has nothing to say: the disk equals what the compiler saw
        assert.deepEqual(checkBuildProvenance(f.input).problems, []);
        // this one does
        const problems = await checkDependencySources({ ...dep, fetchTarball: async () => published.buf });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /npm\/@oz\/contracts@5\.6\.1\/utils\/B\.sol: the compiler read text that is not in the locked @oz\/contracts@5\.6\.1 package \(a patched or replaced dependency\)/);
      } finally { f.clean(); }
    });

    it("refuses what the lockfile cannot vouch for: a tarball that does not match its integrity, a non-registry URL, a missing entry, another version, no sha512", async () => {
      const cases: Array<[string, any, RegExp, "good" | "other"]> = [
        ["a tarball of other bytes", undefined, /downloaded tarball does not match the lockfile's integrity/, "other"],
        ["a URL outside the npm registry", { version: "5.6.1", resolved: "https://evil.example/c.tgz", integrity: "sha512-x" }, /does not resolve it to the npm registry/, "good"],
        ["a git dependency", { version: "5.6.1", resolved: "git+ssh://git@github.com/x/y.git#abc", integrity: "sha512-x" }, /does not resolve it to the npm registry/, "good"],
        ["no entry", null, /package-lock\.json has no entry for it/, "good"],
        ["another locked version", { version: "5.7.0", resolved: LOCKED_URL, integrity: "sha512-x" }, /package-lock\.json locks @oz\/contracts@5\.7\.0/, "good"],
        ["no integrity", { version: "5.6.1", resolved: LOCKED_URL }, /no sha512 integrity/, "good"],
        ["sha1 only", { version: "5.6.1", resolved: LOCKED_URL, integrity: "sha1-abc" }, /no sha512 integrity/, "good"],
      ];
      for (const [name, entry, re, bytes] of cases) {
        const { f, published, dep } = lockedFixture(entry);
        try {
          const served = bytes === "other" ? publishedTarball("library B { /* other */ }").buf : published.buf;
          const problems = await checkDependencySources({ ...dep, fetchTarball: async () => served });
          assert.match(problems.join("\n"), re, name);
        } finally { f.clean(); }
      }
    });

    it("refuses when the tarball cannot be downloaded or the lockfile cannot be read; nothing is skipped silently", async () => {
      const { f, dep } = lockedFixture();
      try {
        assert.match((await checkDependencySources({ ...dep, fetchTarball: async () => { throw new Error("HTTP 503"); } })).join("\n"), /could not be downloaded for the check \(HTTP 503\)/);
        assert.match((await checkDependencySources({ ...dep, fetchTarball: async () => Buffer.from("not a tarball") })).join("\n"), /does not match the lockfile's integrity/);
        fs.rmSync(path.join(f.root, "package-lock.json"));
        assert.match((await checkDependencySources({ ...dep, fetchTarball: async () => Buffer.alloc(0) })).join("\n"), /package-lock\.json cannot be read/);
      } finally { f.clean(); }
    });

    it("the real source() runs this check on Rubicon only, and without --network rubicon it needs no network", async () => {
      const calls: string[] = [];
      const offCalls: string[] = [];
      const store = { read: () => ({}), write: () => {} };
      const off = await depsFromConnection(await hardhat.network.connect(), store, () => {}, { fetchTarball: async (u) => { offCalls.push(u); throw new Error("no network in tests"); } });
      assert.equal((await off.source()).build.ok, true);
      assert.equal(offCalls.length, 0, "a rehearsal network does not download");
      const c = await hardhat.network.connect();
      const on = await depsFromConnection({ viem: c.viem, networkName: "rubicon" }, store, () => {}, { fetchTarball: async (u) => { calls.push(u); throw new Error("no network in tests"); } });
      const src = await on.source();
      assert.equal(src.build.ok, false, "a download that fails refuses the run");
      assert.match(src.build.problems.join("\n"), /locked tarball could not be downloaded for the check \(no network in tests\)/);
      assert.ok(calls.length >= 1 && calls.every((u) => u.startsWith("https://registry.npmjs.org/")));
    });
  });

  it("the script compiles before it reads the artifact, on every run, and the compile has a watchdog", () => {
    const src = readFileSync(path.join(repo, "scripts/bridge/deploy-rubicon-v13.ts"), "utf8");
    const main = src.slice(src.search(/async function main\(/));
    assert.ok(main.indexOf("parseArgs(") < main.indexOf("await compileProject()"), "after the arguments are read");
    assert.ok(main.indexOf("await compileProject()") < main.indexOf("network.connect("), "before any network or artifact");
    assert.ok(main.indexOf("await compileProject()") < main.indexOf("depsFromConnection("));
    assert.match(src, /hardhat\.tasks\.getTask\("compile"\)\.run\(\{\}\)/);
    assert.match(src, /COMPILE_WATCHDOG_MS = 10 \* 60 \* 1000/);
    assert.match(src, /BUILD_PATHS = \["contracts\/", "hardhat\.config\.ts", "package-lock\.json"\]/);
  });

  it("compileProject runs the real compile task (up to date here, so it returns at once)", async () => {
    await compileProject();
  });
});
