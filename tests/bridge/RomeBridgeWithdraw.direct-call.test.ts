/**
 * RomeBridgeWithdraw — direct-call migration off borrowed owner authority.
 *
 * The rome-evm program refuses DELEGATECALL/CALLCODE into any mutating
 * non-EVM precompile selector that isn't explicitly exempt
 * (`program/src/state/handler_non_evm.rs:28-30`). Every mutating call this
 * contract makes is now a direct CALL, signing as the bridge's own PDA
 * instead of borrowing the caller's — except `ensureRecipientAta`, which
 * stays on `create_ata_for_key`, an exempt selector, byte-identical.
 *
 * Two layers:
 *   - structural: read the real source file, assert `.call(` not
 *     `.delegatecall(` at each converted site, and that the two deleted
 *     approve functions are gone from both source and the compiled ABI.
 *   - behavioral: drive the real deployed contract through
 *     `BridgePrecompileMock`, installed via `hardhat_setCode` at the real
 *     HelperProgram/CpiProgram/SystemProgram precompile addresses, and
 *     assert (a) the precompile sees the BRIDGE as `msg.sender` — proof of a
 *     direct CALL, since a delegatecall would leave the original EOA caller
 *     in that slot — and (b) the account plan names the bridge's own PDA/ATA,
 *     not the user's.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import hardhat from "hardhat";

// Must track contracts/interface.sol's `..._address` constants exactly.
const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009" as const;
const CPI_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000008" as const;
const SYSTEM_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000007" as const;

const ZERO = "0x" + "00".repeat(32);
const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
const RECIPIENT = PK(0x99);
const ADDR = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
const ETH_RECIPIENT_A = ADDR(0xaaa);
const ETH_RECIPIENT_B = ADDR(0xbbb);
const FORWARDER = "0x0000000000000000000000000000000000000000" as const;

const CCTP = {
  tokenMessengerProgram: PK(1),
  messageTransmitterProgram: PK(2),
  splTokenProgram: PK(3),
  systemProgram: ZERO,
  messageTransmitterConfig: PK(4),
  tokenMessengerConfig: PK(5),
  tokenMinter: PK(6),
  localTokenUsdc: PK(7),
  domains: [0],
  remoteTokenMessengers: [PK(8)],
  senderAuthorityPda: PK(10),
  eventAuthority: PK(11),
  messageTransmitterEventAuthority: PK(12),
};
const WH = {
  tokenBridgeProgram: PK(20), coreProgram: PK(21), splTokenProgram: PK(3),
  systemProgram: ZERO, clockSysvar: PK(22), rentSysvar: PK(23),
  config: PK(24), custody: PK(25), authoritySigner: PK(26), custodySigner: PK(27),
  bridgeConfig: PK(28), feeCollector: PK(29), emitter: PK(30), sequence: PK(31),
  wrappedMeta: PK(32), targetChain: 10002,
};

describe("RomeBridgeWithdraw — direct-call migration", () => {
  describe("structural — source is ground truth", () => {
    const srcPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "contracts", "bridge", "RomeBridgeWithdraw.sol"
    );
    const src = readFileSync(srcPath, "utf8");

    function bodyOf(fnSignatureStart: string): string {
      const start = src.indexOf(fnSignatureStart);
      assert.ok(start >= 0, `function not found: ${fnSignatureStart}`);
      const next = src.indexOf("\n    function ", start + fnSignatureStart.length);
      return next === -1 ? src.slice(start) : src.slice(start, next);
    }

    it("approveBurnETH no longer exists in source", () => {
      assert.ok(!/function approveBurnETH\(/.test(src), "approveBurnETH must be deleted");
    });

    it("approveWormholeBurn no longer exists in source", () => {
      assert.ok(!/function approveWormholeBurn\(/.test(src), "approveWormholeBurn must be deleted");
    });

    it("approveBurnETH and approveWormholeBurn are absent from the compiled ABI", async function () {
      const hre: any = hardhat;
      const artifact = await hre.artifacts.readArtifact("RomeBridgeWithdraw");
      const names = artifact.abi
        .filter((e: any) => e.type === "function")
        .map((e: any) => e.name);
      assert.ok(!names.includes("approveBurnETH"), "approveBurnETH must not be in the ABI");
      assert.ok(!names.includes("approveWormholeBurn"), "approveWormholeBurn must not be in the ABI");
    });

    it("_burnUSDC's CPI is a direct CALL, never a delegatecall", () => {
      const body = bodyOf("function _burnUSDC(");
      assert.ok(body.includes("address(CpiProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
    });

    it("burnETH's own CPI is a direct CALL, never a delegatecall", () => {
      const body = bodyOf("function burnETH(");
      assert.ok(body.includes("address(CpiProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
    });

    it("burnToWormhole's own CPI is a direct CALL, never a delegatecall", () => {
      const body = bodyOf("function burnToWormhole(");
      assert.ok(body.includes("address(CpiProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
    });

    it("transferNativeToWormhole's own CPI is a direct CALL, never a delegatecall", () => {
      const body = bodyOf("function transferNativeToWormhole(");
      assert.ok(body.includes("address(CpiProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
    });

    // burnETH / burnToWormhole / transferNativeToWormhole all route their pull
    // and delegate-approve legs through these two private helpers — checked
    // once here rather than per call-site, since the caller-body checks above
    // don't see inside them.
    it("_pullToBridge is a direct CALL, never a delegatecall", () => {
      const body = bodyOf("function _pullToBridge(");
      assert.ok(body.includes("address(HelperProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
    });

    it("_approveWormholeDelegate is a direct CALL, never a delegatecall", () => {
      const body = bodyOf("function _approveWormholeDelegate(");
      assert.ok(body.includes("address(HelperProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
    });

    it("bridgeOutToSolana's transfer is a direct CALL, with an explicit from_ata", () => {
      const body = bodyOf("function bridgeOutToSolana(");
      assert.ok(body.includes("address(HelperProgram).call("));
      assert.ok(body.includes('"transfer_spl(bytes32,bytes32,uint64,bytes32)"'));
      assert.ok(!body.includes(".delegatecall("));
    });

    it("ensureRecipientAta is untouched — still the exempt selector via delegatecall", () => {
      const body = bodyOf("function ensureRecipientAta(");
      assert.ok(body.includes("address(HelperProgram).delegatecall("));
      assert.ok(body.includes('"create_ata_for_key(bytes32,bytes32)"'));
    });

    it("ensureBridgeAta is owner-gated and a direct CALL (not delegatecall, not the exemption list), targeting the bridge's own PDA", () => {
      const fnStart = src.indexOf("function ensureBridgeAta(");
      assert.ok(fnStart >= 0, "ensureBridgeAta not found");
      const signatureEnd = src.indexOf("{", fnStart);
      assert.ok(src.slice(fnStart, signatureEnd).includes("onlyOwner"), "must be onlyOwner");
      const body = bodyOf("function ensureBridgeAta(");
      assert.ok(body.includes("address(HelperProgram).call("));
      assert.ok(!body.includes(".delegatecall("));
      assert.ok(body.includes('"create_ata_for_key(bytes32,bytes32)"'));
      assert.ok(body.includes("RomeEVMAccount.pda(address(this))"));
    });

    it("ensureBridgeAta is declared in the discovery interface", async function () {
      const hre: any = hardhat;
      const artifact = await hre.artifacts.readArtifact("RomeBridgeWithdraw");
      const names = artifact.abi
        .filter((e: any) => e.type === "function")
        .map((e: any) => e.name);
      assert.ok(names.includes("ensureBridgeAta"));
    });
  });

  describe("behavioral — driven through BridgePrecompileMock", () => {
    let viem: any;
    let conn: any;
    let helper: any;
    let cpi: any;
    let usdc: any;
    let weth: any;
    let bridge: any;
    let userWallet: any;

    before(async function () {
      conn = await hardhat.network.connect();
      viem = conn.viem;

      const mockProto = await viem.deployContract("BridgePrecompileMock");
      const client = await viem.getPublicClient();
      const code = await client.getCode({ address: mockProto.address });
      assert.ok(code && code !== "0x", "mock must have deployed code to install");
      for (const addr of [HELPER_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
      }
      helper = await viem.getContractAt("BridgePrecompileMock", HELPER_PROGRAM_ADDRESS);
      cpi = await viem.getContractAt("BridgePrecompileMock", CPI_PROGRAM_ADDRESS);

      const wallets = await viem.getWalletClients();
      userWallet = wallets[1]; // distinct from the deployer/admin (wallets[0])
    });

    beforeEach(async function () {
      // Shared mock storage lives at the fixed precompile addresses across
      // the whole describe block (hardhat_setCode replaces code, not
      // storage) — reset the counters so each test starts from zero.
      await helper.write.reset();
      await cpi.write.reset();

      const wallets = await viem.getWalletClients();
      usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
      weth = await viem.deployContract("MockSplErc20", [PK(41)]);
      const whg = {
        admin: wallets[0].account.address,
        targetChains: [10002],
        assetWrappers: [weth.address],
      };
      bridge = await viem.deployContract("RomeBridgeWithdraw", [
        FORWARDER, usdc.address, weth.address, CCTP, WH, whg,
      ]);
    });

    it("bridgeOutToSolana succeeds when the bridge is authorized as delegate of the explicit from_ata", async function () {
      const amount = 1000n;
      const user = userWallet.account.address;
      const fromAta = await helper.read.ata([user, PK(41)]);
      await helper.write.setAuthorized([fromAta, bridge.address, true]);

      await bridge.write.bridgeOutToSolana([RECIPIENT, amount, PK(41)], { account: userWallet.account });

      assert.equal(await helper.read.transferCount(), 1n);
      assert.equal((await helper.read.lastTransferCaller()).toLowerCase(), bridge.address.toLowerCase());
      assert.equal(await helper.read.lastFromAta(), fromAta);
      assert.equal(await helper.read.lastTransferTokens(), amount);
    });

    it("bridgeOutToSolana reverts when the bridge is neither owner nor delegate of the from_ata", async function () {
      const amount = 1000n;
      // Deliberately no `setAuthorized` call — control varies the world (the
      // authorization the caller's identity depends on), not the ruler.
      await assert.rejects(
        () => bridge.write.bridgeOutToSolana([RECIPIENT, amount, PK(41)], { account: userWallet.account }),
        (err: any) => {
          const msg: string = err?.message ?? "";
          return msg.includes("CpiFailed") || msg.includes("neither owner nor delegate");
        }
      );
      assert.equal(await helper.read.transferCount(), 0n);
    });

    it("ensureBridgeAta reverts NotOwner for a non-owner caller, before ever reaching the precompile", async function () {
      await assert.rejects(
        bridge.write.ensureBridgeAta([PK(40)], { account: userWallet.account }),
        /NotOwner/
      );
    });

    it("ensureBridgeAta delegatecalls create_ata_for_key targeting the bridge's own PDA, not an arbitrary wallet", async function () {
      const wallets = await viem.getWalletClients();
      const ownerWallet = wallets[0];
      const pc = await viem.getPublicClient();
      const mint = PK(40);

      const txHash = await bridge.write.ensureBridgeAta([mint], { account: ownerWallet.account });
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

      const mockAbi = (await hardhat.artifacts.readArtifact("BridgePrecompileMock")).abi;
      const { parseEventLogs } = await import("viem");
      const events = parseEventLogs({ abi: mockAbi, logs: receipt.logs, eventName: "CreateAtaForKey" });
      assert.equal(events.length, 1);
      const bridgePda = await helper.read.pda([bridge.address]);
      assert.equal(events[0].args.wallet, bridgePda, "must target the bridge's own PDA, not an arbitrary wallet");
      assert.equal(events[0].args.mint, mint);
    });

    it("ensureRecipientAta delegatecalls create_ata_for_key with (solanaRecipient, mint) unswapped", async function () {
      const pc = await viem.getPublicClient();
      const mint = PK(41);

      const txHash = await bridge.write.ensureRecipientAta([RECIPIENT, mint], { account: userWallet.account });
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

      const mockAbi = (await hardhat.artifacts.readArtifact("BridgePrecompileMock")).abi;
      const { parseEventLogs } = await import("viem");
      const events = parseEventLogs({ abi: mockAbi, logs: receipt.logs, eventName: "CreateAtaForKey" });
      assert.equal(events.length, 1);
      assert.equal(events[0].args.wallet, RECIPIENT, "wallet must be solanaRecipient, not mint");
      assert.equal(events[0].args.mint, mint);
    });

    it("ensureRecipientAta reverts ZeroRecipient for a zero solanaRecipient", async function () {
      await assert.rejects(
        bridge.write.ensureRecipientAta([ZERO, PK(41)], { account: userWallet.account }),
        /ZeroRecipient/
      );
    });

    it("burnETH pulls the user's wETH into the bridge's own ATA, re-grants Wormhole's delegate there, and signs invoke_signed as the bridge", async function () {
      const amount = 500n;
      const user = userWallet.account.address;
      await weth.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, PK(41)]);
      const bridgeAta = await helper.read.ata([bridge.address, PK(41)]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);

      await bridge.write.burnETH([amount, ETH_RECIPIENT_A], { account: userWallet.account });

      // pull: userAta -> bridgeAta, signed by the bridge
      assert.equal(await helper.read.transferCount(), 1n);
      assert.equal((await helper.read.lastTransferCaller()).toLowerCase(), bridge.address.toLowerCase());
      assert.equal(await helper.read.lastFromAta(), userAta);
      assert.equal(await helper.read.lastToAta(), bridgeAta);
      assert.equal(await helper.read.lastTransferTokens(), amount);

      // Wormhole authority_signer re-granted on the bridge's OWN ata
      assert.equal(await helper.read.approveCount(), 1n);
      assert.equal((await helper.read.lastApproveCaller()).toLowerCase(), bridge.address.toLowerCase());
      assert.equal(await helper.read.lastApproveAta(), bridgeAta);

      // invoke_signed signed by the bridge, naming the bridge's PDA/ATA
      assert.equal(await cpi.read.invokeSignedCount(), 1n);
      assert.equal((await cpi.read.lastInvokeSignedCaller()).toLowerCase(), bridge.address.toLowerCase());
      const bridgePda = await helper.read.pda([bridge.address]);
      const payer = await cpi.read.lastAccount([0n]); // TransferWrappedAccounts.payer
      assert.equal(payer[0], bridgePda);
      const from = await cpi.read.lastAccount([2n]); // .from
      assert.equal(from[0], bridgeAta);
      const fromOwner = await cpi.read.lastAccount([3n]); // .from_owner
      assert.equal(fromOwner[0], bridgePda);
    });

    it("burnUSDC pulls the user's wUSDC into the bridge's own ATA and signs the CCTP CPI as the bridge — no Wormhole delegate step", async function () {
      const amount = 250n;
      const user = userWallet.account.address;
      await usdc.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, PK(40)]);
      const bridgeAta = await helper.read.ata([bridge.address, PK(40)]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);

      await bridge.write.burnUSDC([amount, ETH_RECIPIENT_B, 0], { account: userWallet.account });

      assert.equal(await helper.read.transferCount(), 1n);
      assert.equal(await helper.read.lastFromAta(), userAta);
      assert.equal(await helper.read.lastToAta(), bridgeAta);
      // CCTP burns via `owner`-as-authority directly — no Wormhole-style
      // authority_signer re-approval belongs on this rail.
      assert.equal(await helper.read.approveCount(), 0n);

      assert.equal(await cpi.read.invokeSignedCount(), 1n);
      assert.equal((await cpi.read.lastInvokeSignedCaller()).toLowerCase(), bridge.address.toLowerCase());
      const bridgePda = await helper.read.pda([bridge.address]);
      const owner = await cpi.read.lastAccount([0n]); // DepositForBurnAccounts.owner
      assert.equal(owner[0], bridgePda);
      const eventRentPayer = await cpi.read.lastAccount([1n]);
      assert.equal(eventRentPayer[0], bridgePda);
      const burnTokenAccount = await cpi.read.lastAccount([3n]);
      assert.equal(burnTokenAccount[0], bridgeAta);
    });

    it("burnToWormhole pulls into the bridge's own ATA for the asset's mint and signs as the bridge", async function () {
      const amount = 111n;
      const user = userWallet.account.address;
      await weth.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, PK(41)]);
      const bridgeAta = await helper.read.ata([bridge.address, PK(41)]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);

      await bridge.write.burnToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userWallet.account });

      assert.equal(await helper.read.transferCount(), 1n);
      assert.equal(await helper.read.lastToAta(), bridgeAta, "pull must land in the bridge's own ATA, not a no-op");
      assert.equal(await helper.read.approveCount(), 1n);
      assert.equal(await helper.read.lastApproveAta(), bridgeAta);
      assert.equal(await cpi.read.invokeSignedCount(), 1n);
      const bridgePda = await helper.read.pda([bridge.address]);
      const from = await cpi.read.lastAccount([2n]);
      assert.equal(from[0], bridgeAta);
      const fromOwner = await cpi.read.lastAccount([3n]);
      assert.equal(fromOwner[0], bridgePda);
    });

    it("transferNativeToWormhole pulls into the bridge's own ATA and signs as the bridge", async function () {
      const amount = 222n;
      const user = userWallet.account.address;
      await weth.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, PK(41)]);
      const bridgeAta = await helper.read.ata([bridge.address, PK(41)]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);

      await bridge.write.transferNativeToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userWallet.account });

      assert.equal(await helper.read.transferCount(), 1n);
      assert.equal(await helper.read.lastToAta(), bridgeAta, "pull must land in the bridge's own ATA, not a no-op");
      assert.equal(await helper.read.approveCount(), 1n);
      assert.equal(await helper.read.lastApproveAta(), bridgeAta, "authority_signer must be re-granted on the bridge's own ATA, not the user's");
      assert.equal(await cpi.read.invokeSignedCount(), 1n);
      const bridgePda = await helper.read.pda([bridge.address]);
      const payer = await cpi.read.lastAccount([0n]);
      assert.equal(payer[0], bridgePda);
      const from = await cpi.read.lastAccount([2n]);
      assert.equal(from[0], bridgeAta);
    });

    it("transferNativeToWormhole reverts on a sub-8-decimal remainder instead of stranding it in the bridge's ATA", async function () {
      await weth.write.setDecimals([9]); // e.g. wSOL/LSTs — transfer_native normalizes to 8dp
      const amount = 12345n; // not a multiple of 10 == 10**(9-8)
      const user = userWallet.account.address;
      await weth.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, PK(41)]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);

      await assert.rejects(
        () => bridge.write.transferNativeToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userWallet.account }),
        (err: any) => ((err?.message ?? "") as string).includes("SubGranularityAmount")
      );
      assert.equal(await helper.read.transferCount(), 0n, "must reject before any pull happens");
    });

    it("transferNativeToWormhole accepts a granularity-aligned amount at 9 decimals", async function () {
      await weth.write.setDecimals([9]);
      const amount = 12340n; // multiple of 10
      const user = userWallet.account.address;
      await weth.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, PK(41)]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);

      await bridge.write.transferNativeToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userWallet.account });
      assert.equal(await helper.read.transferCount(), 1n);
    });

    // REVIEW — per-tx message PDA must stay unique across users
    it("burnETH: two different users' FIRST burns get different Wormhole message accounts", async function () {
      const wallets = await viem.getWalletClients();
      const userA = wallets[1];
      const userB = wallets[2];
      const amount = 10n;

      await weth.write.setBalance([userA.account.address, amount]);
      await weth.write.setBalance([userB.account.address, amount]);
      const userAtaA = await helper.read.ata([userA.account.address, PK(41)]);
      const userAtaB = await helper.read.ata([userB.account.address, PK(41)]);
      await helper.write.setAuthorized([userAtaA, bridge.address, true]);
      await helper.write.setAuthorized([userAtaB, bridge.address, true]);

      await bridge.write.burnETH([amount, ETH_RECIPIENT_A], { account: userA.account });
      const messageA = (await cpi.read.lastAccount([8n]))[0]; // TransferWrappedAccounts.message

      await bridge.write.burnETH([amount, ETH_RECIPIENT_A], { account: userB.account });
      const messageB = (await cpi.read.lastAccount([8n]))[0];

      assert.notEqual(messageA, messageB, "messageAccount collided across users");
    });

    it("burnUSDC: two different users' FIRST burns get different CCTP event-data accounts", async function () {
      const wallets = await viem.getWalletClients();
      const userA = wallets[1];
      const userB = wallets[2];
      const amount = 10n;

      await usdc.write.setBalance([userA.account.address, amount]);
      await usdc.write.setBalance([userB.account.address, amount]);
      const userAtaA = await helper.read.ata([userA.account.address, PK(40)]);
      const userAtaB = await helper.read.ata([userB.account.address, PK(40)]);
      await helper.write.setAuthorized([userAtaA, bridge.address, true]);
      await helper.write.setAuthorized([userAtaB, bridge.address, true]);

      await bridge.write.burnUSDC([amount, ETH_RECIPIENT_B, 0], { account: userA.account });
      const eventDataA = (await cpi.read.lastAccount([11n]))[0]; // DepositForBurnAccounts.messageSentEventData

      await bridge.write.burnUSDC([amount, ETH_RECIPIENT_B, 0], { account: userB.account });
      const eventDataB = (await cpi.read.lastAccount([11n]))[0];

      assert.notEqual(eventDataA, eventDataB, "messageSentEventData collided across users");
    });

    it("burnToWormhole: two different users' FIRST burns get different Wormhole message accounts", async function () {
      const wallets = await viem.getWalletClients();
      const userA = wallets[1];
      const userB = wallets[2];
      const amount = 10n;

      await weth.write.setBalance([userA.account.address, amount]);
      await weth.write.setBalance([userB.account.address, amount]);
      const userAtaA = await helper.read.ata([userA.account.address, PK(41)]);
      const userAtaB = await helper.read.ata([userB.account.address, PK(41)]);
      await helper.write.setAuthorized([userAtaA, bridge.address, true]);
      await helper.write.setAuthorized([userAtaB, bridge.address, true]);

      await bridge.write.burnToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userA.account });
      const messageA = (await cpi.read.lastAccount([8n]))[0]; // TransferWrappedAccounts.message

      await bridge.write.burnToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userB.account });
      const messageB = (await cpi.read.lastAccount([8n]))[0];

      assert.notEqual(messageA, messageB, "messageAccount collided across users");
    });

    it("transferNativeToWormhole: two different users' FIRST burns get different Wormhole message accounts", async function () {
      const wallets = await viem.getWalletClients();
      const userA = wallets[1];
      const userB = wallets[2];
      const amount = 10n;

      await weth.write.setBalance([userA.account.address, amount]);
      await weth.write.setBalance([userB.account.address, amount]);
      const userAtaA = await helper.read.ata([userA.account.address, PK(41)]);
      const userAtaB = await helper.read.ata([userB.account.address, PK(41)]);
      await helper.write.setAuthorized([userAtaA, bridge.address, true]);
      await helper.write.setAuthorized([userAtaB, bridge.address, true]);

      await bridge.write.transferNativeToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userA.account });
      const messageA = (await cpi.read.lastAccount([8n]))[0]; // TransferNativeAccounts.message

      await bridge.write.transferNativeToWormhole([weth.address, amount, RECIPIENT, 10002], { account: userB.account });
      const messageB = (await cpi.read.lastAccount([8n]))[0];

      assert.notEqual(messageA, messageB, "messageAccount collided across users");
    });
  });
});
