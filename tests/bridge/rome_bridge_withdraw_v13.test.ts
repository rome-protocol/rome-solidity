import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseEventLogs, toFunctionSelector, toHex } from "viem";
import hardhat from "hardhat";
import {
  ADDR, CCTP, CCTP_TMM_PROGRAM, EVM, FORWARDER, PK, RAW32, Rail, WH, ZERO32, ZERO_ADDR,
  circleAccountData, enableDomain, evmMessenger, installMock, plantCircleAccount,
  remoteMessengerPda, suiMessenger,
} from "./helpers/v13.js";

/**
 * RomeBridgeWithdraw 13.0.0 — owner-managed CCTP destinations, per-rail pause,
 * two-step ownership, recipient kinds.
 *
 * Runs on the simulated EVM through BridgePrecompileMock. The mock stands in for
 * Circle's accounts (account_info) and for find_program_address; what it cannot
 * prove is listed in the PR body (account reads inside a state-changing tx on a
 * live Rome chain, Ledger signing).
 */

const RECIPIENT32 = PK(0x99);
const EVM_RECIPIENT = ADDR(0xe0e0);
const NO_WH = (admin: `0x${string}`) => ({ admin, targetChains: [], assetWrappers: [] as `0x${string}`[] });

describe("RomeBridgeWithdraw 13.0.0", function () {
  let conn: any, viem: any, pc: any;
  let helper: any, cpi: any;
  let usdc: any, weth: any;
  let bridge: any;
  let owner: any, user: any, guardian: any, stranger: any, other: any;
  const planted: `0x${string}`[] = [];

  async function plant(domain: number, opts: Parameters<typeof plantCircleAccount>[2] = {}) {
    const key = await plantCircleAccount(cpi, domain, opts);
    planted.push(key);
  }

  /** Plant a good account for `domain` and enable it as the owner. */
  async function enable(domain: number, kind: number = EVM, as: any = owner) {
    await plant(domain, { messenger: kind === EVM ? evmMessenger(0xc0de00 + domain) : suiMessenger });
    return bridge.write.enableCctpDomain([domain, kind], { account: as.account });
  }

  async function deploy(opts: { forwarder?: `0x${string}`; guardianAddr?: `0x${string}`; whg?: any } = {}) {
    return viem.deployContract("RomeBridgeWithdraw", [
      opts.forwarder ?? FORWARDER, usdc.address, CCTP, WH,
      opts.whg ?? { admin: owner.account.address, targetChains: [10002], assetWrappers: [weth.address] },
      opts.guardianAddr ?? guardian.account.address,
    ]);
  }

  async function domains(b: any = bridge): Promise<number[]> {
    return ((await b.read.cctpDomains()) as number[]).map(Number);
  }

  async function logsOf(hash: `0x${string}`, eventName: string) {
    const receipt = await pc.waitForTransactionReceipt({ hash });
    return parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: eventName as any }) as any[];
  }

  /** Sets up a user whose pulls from `mint`'s ATA the bridge may make. */
  async function fund(wrapper: any, mint: `0x${string}`, amount: bigint, who: any = user) {
    await wrapper.write.setBalance([who.account.address, amount]);
    const ata = await helper.read.ata([who.account.address, mint]);
    await helper.write.setAuthorized([ata, bridge.address, true]);
  }

  before(async function () {
    conn = await hardhat.network.connect();
    viem = conn.viem;
    pc = await viem.getPublicClient();
    ({ helper, cpi } = await installMock(conn));
    const w = await viem.getWalletClients();
    [owner, user, other, guardian, stranger] = [w[0], w[1], w[2], w[3], w[4]];
  });

  beforeEach(async function () {
    await helper.write.reset();
    await cpi.write.reset();
    for (const k of planted.splice(0)) await cpi.write.clearAccount([k]);
    usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    weth = await viem.deployContract("MockSplErc20", [PK(41)]);
    bridge = await deploy();
  });

  // ── Version, removed surface, constructor ──────────────────────────────────

  describe("surface", () => {
    it("reports version 13.0.0", async () => {
      assert.equal(await bridge.read.VERSION(), "13.0.0");
    });

    it("burnETH is gone: no ABI entry, and its selector reverts", async () => {
      const names = bridge.abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
      assert.ok(!names.includes("burnETH"));
      for (const gone of ["wethWrapper", "wethMint", "wethDecimals", "wormholeTargetChain", "wormholeCustody", "wormholeWrappedMeta"]) {
        assert.ok(!names.includes(gone), `${gone} must be removed with burnETH`);
      }
      const data = (toFunctionSelector("burnETH(uint256,address)") +
        "0".repeat(63) + "1" + "0".repeat(24) + "11".repeat(20)) as `0x${string}`;
      await assert.rejects(user.sendTransaction({ to: bridge.address, data }));
    });

    it("burnUSDC has no same-arity overload: the RAW32 entry has its own name, so a hand-written ABI cannot mis-pick", async () => {
      const burns = bridge.abi.filter((e: any) => e.type === "function" && e.name.startsWith("burn"));
      const sigs = burns.map((e: any) => `${e.name}(${e.inputs.map((i: any) => i.type).join(",")})`).sort();
      assert.ok(sigs.includes("burnUSDC(uint256,address)"));
      assert.ok(sigs.includes("burnUSDC(uint256,address,uint32)"));
      assert.ok(sigs.includes("burnUSDCToBytes32(uint256,bytes32,uint32)"));
      assert.ok(!sigs.includes("burnUSDC(uint256,bytes32,uint32)"));
      const burnUSDC = burns.filter((e: any) => e.name === "burnUSDC");
      assert.equal(new Set(burnUSDC.map((e: any) => e.inputs.length)).size, burnUSDC.length, "burnUSDC overloads must differ in arity");
    });

    it("a domain's PDA and recipient kind sit in consecutive storage slots (one lookup on Rome)", async () => {
      await enable(6);
      const pda = remoteMessengerPda(6);
      let found = -1;
      for (let slot = 0; slot < 40 && found < 0; slot++) {
        const base = BigInt(keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }], [6, BigInt(slot)])));
        const v = await pc.getStorageAt({ address: bridge.address, slot: toHex(base, { size: 32 }) });
        if (v && v.toLowerCase() === pda) {
          found = slot;
          const k = await pc.getStorageAt({ address: bridge.address, slot: toHex(base + 1n, { size: 32 }) });
          assert.equal(BigInt(k as string), BigInt(EVM));
        }
      }
      assert.ok(found >= 0, "the PDA was not found in a mapping slot");
    });

    it("the constructor takes the CCTP list out: a new bridge has no destination", async () => {
      assert.deepEqual(await domains(), []);
    });

    it("owner and guardian are set in the constructor", async () => {
      assert.equal((await bridge.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
      assert.equal((await bridge.read.guardian()).toLowerCase(), guardian.account.address.toLowerCase());
      assert.equal(await bridge.read.pendingOwner(), ZERO_ADDR);
    });

    it("a zero owner is refused at deploy", async () => {
      await assert.rejects(deploy({ whg: NO_WH(ZERO_ADDR) }), /ZeroOwner/);
    });

    it("a zero guardian means no guardian: only the owner can pause", async () => {
      const b = await deploy({ guardianAddr: ZERO_ADDR });
      await assert.rejects(b.write.pauseRail([Rail.CCTP], { account: stranger.account }), /NotOwnerOrGuardian\(/);
      await b.write.pauseRail([Rail.CCTP]);
      assert.equal(await b.read.railPaused([Rail.CCTP]), true);
    });
  });

  // ── Access control ─────────────────────────────────────────────────────────

  describe("setter access", () => {
    it("enableCctpDomain: owner may, guardian and stranger may not", async () => {
      await plant(6);
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM], { account: guardian.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM], { account: stranger.account }), /NotOwner\(/);
      assert.deepEqual(await domains(), []);
      await bridge.write.enableCctpDomain([6, EVM], { account: owner.account });
      assert.deepEqual(await domains(), [6]);
    });

    it("disableCctpDomain: owner and guardian may, stranger may not", async () => {
      await enable(0);
      await enable(1);
      await enable(3);
      await assert.rejects(bridge.write.disableCctpDomain([0], { account: stranger.account }), /NotOwnerOrGuardian\(/);
      await bridge.write.disableCctpDomain([0], { account: guardian.account });
      await bridge.write.disableCctpDomain([1], { account: owner.account });
      assert.deepEqual(await domains(), [3]);
    });

    it("pauseRail: owner and guardian may, stranger may not", async () => {
      await assert.rejects(bridge.write.pauseRail([Rail.CCTP], { account: stranger.account }), /NotOwnerOrGuardian\(/);
      await bridge.write.pauseRail([Rail.CCTP], { account: guardian.account });
      await bridge.write.pauseRail([Rail.WORMHOLE], { account: owner.account });
      assert.equal(await bridge.read.railPaused([Rail.CCTP]), true);
      assert.equal(await bridge.read.railPaused([Rail.WORMHOLE]), true);
    });

    it("unpauseRail is owner-only: not the guardian, not a stranger", async () => {
      await bridge.write.pauseRail([Rail.CCTP], { account: guardian.account });
      await assert.rejects(bridge.write.unpauseRail([Rail.CCTP], { account: guardian.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.unpauseRail([Rail.CCTP], { account: stranger.account }), /NotOwner\(/);
      assert.equal(await bridge.read.railPaused([Rail.CCTP]), true);
      await bridge.write.unpauseRail([Rail.CCTP], { account: owner.account });
      assert.equal(await bridge.read.railPaused([Rail.CCTP]), false);
    });

    it("setGuardian is owner-only; the guardian cannot name a successor or itself", async () => {
      await assert.rejects(bridge.write.setGuardian([stranger.account.address], { account: guardian.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.setGuardian([stranger.account.address], { account: stranger.account }), /NotOwner\(/);
      await bridge.write.setGuardian([other.account.address], { account: owner.account });
      assert.equal((await bridge.read.guardian()).toLowerCase(), other.account.address.toLowerCase());
      // The removed guardian is powerless; the new one can pause.
      await assert.rejects(bridge.write.pauseRail([Rail.CCTP], { account: guardian.account }), /NotOwnerOrGuardian\(/);
      await bridge.write.pauseRail([Rail.CCTP], { account: other.account });
    });

    it("the existing admin setters stay owner-only", async () => {
      await assert.rejects(bridge.write.setMessageRents([1n, 1n], { account: guardian.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.setWormholeTargetChainAllowed([23, true], { account: guardian.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.setWormholeAssetAllowed([weth.address, false], { account: guardian.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.ensureBridgeAta([PK(40)], { account: guardian.account }), /NotOwner\(/);
    });

    it("a non-zero ERC-2771 forwarder is refused at construction, so no forwarder can spoof a burner or the owner", async () => {
      await assert.rejects(deploy({ forwarder: stranger.account.address }), /ForwarderNotAllowed/);
      // A zero forwarder deploys, and admin calls resolve to the real sender.
      const b = await deploy({ forwarder: ZERO_ADDR });
      await plant(6);
      await assert.rejects(b.write.enableCctpDomain([6, EVM], { account: stranger.account }), /NotOwner\(/);
      await b.write.enableCctpDomain([6, EVM], { account: owner.account });
      assert.deepEqual(await domains(b), [6]);
    });
  });

  // ── Enable / disable / enumerate ───────────────────────────────────────────

  describe("enableCctpDomain", () => {
    it("derives Circle's PDA itself, stores it, and emits the event with Circle's messenger", async () => {
      await plant(15, { messenger: evmMessenger(0xabc) });
      const hash = await bridge.write.enableCctpDomain([15, EVM]);
      assert.equal((await bridge.read.cctpRemoteTokenMessengers([15])).toLowerCase(), remoteMessengerPda(15));
      assert.equal(await bridge.read.cctpRecipientKind([15]), EVM);
      const [ev] = await logsOf(hash, "CctpDomainEnabled");
      assert.equal(ev.args.domain, 15);
      assert.equal(ev.args.recipientKind, EVM);
      assert.equal(ev.args.remoteTokenMessengerPda.toLowerCase(), remoteMessengerPda(15));
      assert.equal(ev.args.circleMessenger.toLowerCase(), evmMessenger(0xabc));
    });

    it("domain 5 (Solana) is refused even when Circle has an account for it", async () => {
      await plant(5);
      await assert.rejects(bridge.write.enableCctpDomain([5, EVM]), /UnsupportedDestinationDomain/);
      await assert.rejects(bridge.write.enableCctpDomain([5, RAW32]), /UnsupportedDestinationDomain/);
      assert.deepEqual(await domains(), []);
    });

    it("a domain Circle has not registered (no account) is refused", async () => {
      await assert.rejects(bridge.write.enableCctpDomain([9, EVM]), /InvalidCctpAccount/);
      assert.deepEqual(await domains(), []);
    });

    it("an account owned by another program is refused", async () => {
      await plant(6, { owner: PK(0x77) });
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM]), /InvalidCctpAccount/);
    });

    it("an account owned by the system program (zero owner) is refused", async () => {
      await plant(6, { owner: ZERO32 });
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM]), /InvalidCctpAccount/);
    });

    it("an account with the wrong discriminator is refused", async () => {
      await plant(6, { discriminator: "0011223344556677" });
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM]), /InvalidCctpAccount/);
    });

    it("an account whose stored domain differs from the requested domain is refused", async () => {
      await plant(6, { storedDomain: 7 });
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM]), /InvalidCctpAccount/);
    });

    it("an account too short to hold the record is refused", async () => {
      const key = remoteMessengerPda(6);
      planted.push(key);
      await cpi.write.setAccount([key, CCTP_TMM_PROGRAM, circleAccountData(6, evmMessenger(1)).slice(0, 2 + 2 * 43) as `0x${string}`]);
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM]), /InvalidCctpAccount/);
    });

    it("a 32-byte (Sui-shaped) messenger is refused for the EVM kind", async () => {
      await plant(8, { messenger: suiMessenger });
      await assert.rejects(bridge.write.enableCctpDomain([8, EVM]), /MessengerNotEvmShaped/);
      assert.deepEqual(await domains(), []);
    });

    it("the same Sui-shaped account is accepted for the RAW32 kind", async () => {
      await plant(8, { messenger: suiMessenger });
      await bridge.write.enableCctpDomain([8, RAW32]);
      assert.deepEqual(await domains(), [8]);
      assert.equal(await bridge.read.cctpRecipientKind([8]), RAW32);
    });

    it("a recipient kind other than EVM (1) or RAW32 (2) is refused", async () => {
      await plant(6);
      await assert.rejects(bridge.write.enableCctpDomain([6, 0]), /InvalidRecipientKind/);
      await assert.rejects(bridge.write.enableCctpDomain([6, 3]), /InvalidRecipientKind/);
      await assert.rejects(bridge.write.enableCctpDomain([6, 255]), /InvalidRecipientKind/);
    });

    it("enabling an enabled domain again is clean: listed once, event emitted, PDA unchanged", async () => {
      await enable(6);
      const hash = await bridge.write.enableCctpDomain([6, EVM]);
      assert.deepEqual(await domains(), [6]);
      assert.equal((await bridge.read.cctpRemoteTokenMessengers([6])).toLowerCase(), remoteMessengerPda(6));
      assert.equal((await logsOf(hash, "CctpDomainEnabled")).length, 1);
    });

    it("the kind can be changed by enabling again: EVM to RAW32 and back", async () => {
      await enable(6);
      await bridge.write.enableCctpDomain([6, RAW32]); // EVM-shaped is fine for RAW32
      assert.equal(await bridge.read.cctpRecipientKind([6]), RAW32);
      await bridge.write.enableCctpDomain([6, EVM]);
      assert.equal(await bridge.read.cctpRecipientKind([6]), EVM);
      assert.deepEqual(await domains(), [6]);
    });

    it("switching a RAW32 domain to EVM re-checks the messenger and leaves state unchanged when it fails", async () => {
      await plant(8, { messenger: suiMessenger });
      await bridge.write.enableCctpDomain([8, RAW32]);
      await assert.rejects(bridge.write.enableCctpDomain([8, EVM]), /MessengerNotEvmShaped/);
      assert.equal(await bridge.read.cctpRecipientKind([8]), RAW32);
      assert.deepEqual(await domains(), [8]);
    });

    it("re-enabling re-reads Circle's record: a messenger Circle changed to non-EVM is caught", async () => {
      await enable(6);
      await plant(6, { messenger: suiMessenger });
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM]), /MessengerNotEvmShaped/);
    });

    it("works for multi-digit domains (ASCII seed, not a byte)", async () => {
      await enable(15);
      await enable(30);
      assert.equal((await bridge.read.cctpRemoteTokenMessengers([30])).toLowerCase(), remoteMessengerPda(30));
      assert.notEqual(remoteMessengerPda(15), remoteMessengerPda(30));
    });
  });

  describe("disableCctpDomain and the enumerable list", () => {
    it("lists domains as they are added", async () => {
      await enable(0); await enable(1); await enable(3);
      assert.deepEqual((await domains()).sort((a, b) => a - b), [0, 1, 3]);
    });

    it("removes the first, a middle and the last entry and keeps the rest intact", async () => {
      for (const d of [0, 1, 3, 6, 7]) await enable(d);
      await bridge.write.disableCctpDomain([0]);                       // first
      assert.deepEqual((await domains()).sort((a, b) => a - b), [1, 3, 6, 7]);
      await bridge.write.disableCctpDomain([3]);                       // middle
      assert.deepEqual((await domains()).sort((a, b) => a - b), [1, 6, 7]);
      await bridge.write.disableCctpDomain([7]);                       // last
      assert.deepEqual((await domains()).sort((a, b) => a - b), [1, 6]);
      await bridge.write.disableCctpDomain([1]);
      await bridge.write.disableCctpDomain([6]);
      assert.deepEqual(await domains(), []);
    });

    it("clears the stored PDA and kind, and burns to it then revert", async () => {
      await enable(6);
      await bridge.write.disableCctpDomain([6]);
      assert.equal(await bridge.read.cctpRemoteTokenMessengers([6]), ZERO32);
      assert.equal(await bridge.read.cctpRecipientKind([6]), 0);
      await assert.rejects(bridge.write.burnUSDC([1000n, EVM_RECIPIENT, 6]), /UnsupportedDestinationDomain/);
    });

    it("emits CctpDomainDisabled with the caller", async () => {
      await enable(6);
      const hash = await bridge.write.disableCctpDomain([6], { account: guardian.account });
      const [ev] = await logsOf(hash, "CctpDomainDisabled");
      assert.equal(ev.args.domain, 6);
      assert.equal(ev.args.by.toLowerCase(), guardian.account.address.toLowerCase());
    });

    it("disabling a domain that is not enabled reverts", async () => {
      await assert.rejects(bridge.write.disableCctpDomain([6]), /CctpDomainNotEnabled/);
      await enable(6);
      await bridge.write.disableCctpDomain([6]);
      await assert.rejects(bridge.write.disableCctpDomain([6]), /CctpDomainNotEnabled/);
    });

    it("add, remove and re-add leaves exactly one entry and the domain burns again", async () => {
      await enable(6);
      await enable(7);
      await bridge.write.disableCctpDomain([6]);
      await enable(6);
      assert.deepEqual((await domains()).sort((a, b) => a - b), [6, 7]);
      await enable(6); // and once more, no duplicate
      assert.deepEqual((await domains()).sort((a, b) => a - b), [6, 7]);
      // The domain clears its guards again: it now fails on the zero recipient, not the domain.
      await assert.rejects(bridge.write.burnUSDC([1000n, ZERO_ADDR, 6]), /ZeroRecipient/);
    });

    it("re-adding a disabled domain after its Circle record changed to non-EVM needs RAW32", async () => {
      await enable(8, RAW32);
      await bridge.write.disableCctpDomain([8]);
      await assert.rejects(bridge.write.enableCctpDomain([8, EVM]), /MessengerNotEvmShaped/);
      await bridge.write.enableCctpDomain([8, RAW32]);
      assert.deepEqual(await domains(), [8]);
    });
  });

  // ── Recipient kinds on the burn overloads ──────────────────────────────────

  describe("recipient kinds", () => {
    const burn = (args: any[], who: any = user) => bridge.write.burnUSDC(args, { account: who.account });
    const burnRaw = (args: any[], who: any = user) => bridge.write.burnUSDCToBytes32(args, { account: who.account });

    it("EVM domain: the address overload passes its guards; burnUSDCToBytes32 is refused", async () => {
      await enable(6);
      await assert.rejects(burnRaw([1000n, RECIPIENT32, 6]), /RecipientKindMismatch/);
      await assert.rejects(burn([1000n, ZERO_ADDR, 6]), /ZeroRecipient/); // past the kind check
    });

    it("RAW32 domain: burnUSDCToBytes32 passes its guards; the address overload is refused", async () => {
      await enable(8, RAW32);
      await assert.rejects(burn([1000n, EVM_RECIPIENT, 8]), /RecipientKindMismatch/);
      await assert.rejects(burnRaw([1000n, ZERO32, 8]), /ZeroRecipient/); // past the kind check
    });

    it("the 2-argument burnUSDC targets domain 0 and needs it enabled as EVM", async () => {
      await assert.rejects(bridge.write.burnUSDC([1000n, EVM_RECIPIENT], { account: user.account }), /UnsupportedDestinationDomain/);
      await enable(0, EVM);
      await bridge.write.enableCctpDomain([0, RAW32]); // an EVM-shaped record is fine for RAW32
      await assert.rejects(bridge.write.burnUSDC([1000n, EVM_RECIPIENT], { account: user.account }), /RecipientKindMismatch/);
      await bridge.write.enableCctpDomain([0, EVM]);
      await assert.rejects(bridge.write.burnUSDC([1000n, ZERO_ADDR], { account: user.account }), /ZeroRecipient/);
    });

    it("burnUSDCToBytes32 on an unlisted domain reverts UnsupportedDestinationDomain", async () => {
      await assert.rejects(burnRaw([1000n, RECIPIENT32, 8]), /UnsupportedDestinationDomain/);
    });

    it("EVM burn: pulls into the bridge, emits Withdrawn and WithdrawnToDomain unchanged, mints to the padded address", async () => {
      await enable(6);
      await fund(usdc, PK(40), 5_000n);
      const hash = await burn([5_000n, EVM_RECIPIENT, 6]);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const w = parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: "Withdrawn" }) as any[];
      const wd = parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: "WithdrawnToDomain" }) as any[];
      const raw = parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: "WithdrawnToDomainRaw" }) as any[];
      assert.equal(w.length, 1);
      assert.equal(wd.length, 1);
      assert.equal(raw.length, 0);
      assert.equal(w[0].args.ethereumRecipient.toLowerCase(), EVM_RECIPIENT);
      assert.equal(w[0].args.amount, 5_000n);
      assert.equal(w[0].args.path, 0);
      assert.equal(wd[0].args.destinationDomain, 6);
      assert.equal(await cpi.read.invokeSignedCount(), 1n);
      // remote_token_messenger meta is the PDA the owner enabled (account index 7).
      assert.equal((await cpi.read.lastAccount([7n]))[0].toLowerCase(), remoteMessengerPda(6));
    });

    it("RAW32 burn: emits only WithdrawnToDomainRaw, carrying the full 32 bytes", async () => {
      await enable(8, RAW32);
      await fund(usdc, PK(40), 7_000n);
      const hash = await burnRaw([7_000n, RECIPIENT32, 8]);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const raw = parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: "WithdrawnToDomainRaw" }) as any[];
      const w = parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: "Withdrawn" }) as any[];
      const wd = parseEventLogs({ abi: bridge.abi, logs: receipt.logs, eventName: "WithdrawnToDomain" }) as any[];
      assert.equal(raw.length, 1);
      assert.equal(w.length + wd.length, 0, "the address-typed events must not carry a 32-byte recipient");
      assert.equal(raw[0].args.recipient.toLowerCase(), RECIPIENT32);
      assert.equal(raw[0].args.destinationDomain, 8);
      assert.equal(raw[0].args.amount, 7_000n);
      assert.equal(await cpi.read.invokeSignedCount(), 1n);
      assert.equal((await cpi.read.lastAccount([7n]))[0].toLowerCase(), remoteMessengerPda(8));
    });

    it("burning to Solana's domain 5 can never succeed: it cannot be enabled, so the burn is an unsupported domain", async () => {
      await plant(5);
      await assert.rejects(bridge.write.enableCctpDomain([5, EVM]), /UnsupportedDestinationDomain/);
      await assert.rejects(burn([1000n, EVM_RECIPIENT, 5]), /UnsupportedDestinationDomain/);
      await assert.rejects(burnRaw([1000n, RECIPIENT32, 5]), /UnsupportedDestinationDomain/);
    });

    it("no RAW32 domain exists on a fresh bridge", async () => {
      for (let d = 0; d < 31; d++) assert.equal(await bridge.read.cctpRecipientKind([d]), 0);
    });
  });

  // ── Gas against v12 ────────────────────────────────────────────────────────

  describe("gas", () => {
    // v12 on the same simulated EVM and the same mock, third consecutive
    // burnUSDC(amount, address, 0) (the first two pay one-off mock storage
    // writes): 259,993 gas (2-argument overload: 259,376). v13 adds the pause
    // flag read and the recipient kind (next to the PDA, in the same struct).
    // This is simulated-EVM gas only: it says nothing about Rome CU or accounts.
    const V12_STEADY_STATE_GAS = 259_993n;

    it("burnUSDC costs about what v12 did (steady state)", async () => {
      await enable(0);
      await fund(usdc, PK(40), 10_000_000n);
      const gases: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        const hash = await bridge.write.burnUSDC([1000n, EVM_RECIPIENT, 0], { account: user.account });
        gases.push((await pc.waitForTransactionReceipt({ hash })).gasUsed);
      }
      console.log(`GAS v13 burnUSDC(uint256,address,uint32) first/second/third: ${gases.join(" / ")}  (v12 third: ${V12_STEADY_STATE_GAS})`);
      const third = gases[2];
      assert.ok(third <= V12_STEADY_STATE_GAS + 10_000n, `burnUSDC gas ${third} is more than 10,000 above v12's ${V12_STEADY_STATE_GAS}`);
    });
  });

  // ── Pause, per rail ────────────────────────────────────────────────────────

  describe("pause per rail", () => {
    const RECIPIENT_SOL = PK(0x98);

    async function prepare() {
      await enable(6);
      await fund(usdc, PK(40), 1_000_000n);
      await fund(weth, PK(41), 1_000_000n);
    }
    const cctp = () => bridge.write.burnUSDC([1_000n, EVM_RECIPIENT, 6], { account: user.account });
    const cctpDefault = async () => {
      await enableIfNeeded(0);
      return bridge.write.burnUSDC([1_000n, EVM_RECIPIENT], { account: user.account });
    };
    async function enableIfNeeded(d: number) {
      if ((await bridge.read.cctpRemoteTokenMessengers([d])) === ZERO32) await enable(d);
    }
    const wormhole = () => bridge.write.burnToWormhole([weth.address, 1_000n, RECIPIENT32, 10002], { account: user.account });
    const wormholeNative = () => bridge.write.transferNativeToWormhole([weth.address, 1_000n, RECIPIENT32, 10002], { account: user.account });
    const toSolana = () => bridge.write.bridgeOutToSolana([RECIPIENT_SOL, 1_000n, PK(41)], { account: user.account });
    const ensureAta = () => bridge.write.ensureRecipientAta([RECIPIENT_SOL, PK(41)], { account: user.account });

    it("with nothing paused, every rail works", async () => {
      await prepare();
      await cctp(); await wormhole(); await wormholeNative(); await toSolana(); await ensureAta();
    });

    it("pausing CCTP stops both burnUSDC overloads and the default one, and nothing else", async () => {
      await prepare();
      await bridge.write.pauseRail([Rail.CCTP], { account: guardian.account });
      await assert.rejects(cctp(), /RailPaused/);
      await assert.rejects(bridge.write.burnUSDCToBytes32([1_000n, RECIPIENT32, 6], { account: user.account }), /RailPaused/);
      await assert.rejects(bridge.write.burnUSDC([1_000n, EVM_RECIPIENT], { account: user.account }), /RailPaused/);
      await wormhole(); await wormholeNative(); await toSolana(); await ensureAta();
    });

    it("pausing Wormhole stops burnToWormhole and transferNativeToWormhole, and nothing else", async () => {
      await prepare();
      await bridge.write.pauseRail([Rail.WORMHOLE], { account: guardian.account });
      await assert.rejects(wormhole(), /RailPaused/);
      await assert.rejects(wormholeNative(), /RailPaused/);
      await cctp(); await toSolana(); await ensureAta();
    });

    it("pausing to-Solana stops bridgeOutToSolana, and nothing else", async () => {
      await prepare();
      await bridge.write.pauseRail([Rail.TO_SOLANA], { account: guardian.account });
      await assert.rejects(toSolana(), /RailPaused/);
      // ensureRecipientAta spends operator rent for anyone: it is part of this rail.
      await assert.rejects(ensureAta(), /RailPaused/);
      await cctp(); await wormhole(); await wormholeNative();
    });

    it("pausing every rail stops every outbound path", async () => {
      await prepare();
      for (const r of [Rail.CCTP, Rail.WORMHOLE, Rail.TO_SOLANA]) await bridge.write.pauseRail([r]);
      await assert.rejects(cctp(), /RailPaused/);
      await assert.rejects(wormhole(), /RailPaused/);
      await assert.rejects(wormholeNative(), /RailPaused/);
      await assert.rejects(toSolana(), /RailPaused/);
      await assert.rejects(ensureAta(), /RailPaused/);
    });

    it("a paused rail still lets the owner administer: enable, disable, setters", async () => {
      await bridge.write.pauseRail([Rail.CCTP]);
      await enable(7);
      await bridge.write.disableCctpDomain([7], { account: guardian.account });
      await bridge.write.setMessageRents([3_000_000n, 2_600_000n]);
    });

    it("unpause restores the rail; pause and unpause are real state changes (no silent no-ops)", async () => {
      await prepare();
      const hash = await bridge.write.pauseRail([Rail.CCTP], { account: guardian.account });
      const [ev] = await logsOf(hash, "RailPausedSet");
      assert.equal(ev.args.rail, Rail.CCTP);
      assert.equal(ev.args.by.toLowerCase(), guardian.account.address.toLowerCase());
      await assert.rejects(bridge.write.pauseRail([Rail.CCTP]), /RailPaused/);
      await assert.rejects(bridge.write.unpauseRail([Rail.WORMHOLE]), /RailNotPaused/);
      const hash2 = await bridge.write.unpauseRail([Rail.CCTP]);
      assert.equal((await logsOf(hash2, "RailUnpausedSet")).length, 1);
      await cctp();
    });

    it("unpausing one rail leaves the other paused rails paused", async () => {
      await bridge.write.pauseRail([Rail.CCTP]);
      await bridge.write.pauseRail([Rail.WORMHOLE]);
      await bridge.write.unpauseRail([Rail.CCTP]);
      assert.equal(await bridge.read.railPaused([Rail.CCTP]), false);
      assert.equal(await bridge.read.railPaused([Rail.WORMHOLE]), true);
      assert.equal(await bridge.read.railPaused([Rail.TO_SOLANA]), false);
    });

    it("an unknown rail value is refused", async () => {
      await assert.rejects(bridge.write.pauseRail([3]));
    });
  });

  // ── Two-step ownership ─────────────────────────────────────────────────────

  describe("two-step ownership", () => {
    it("transferOwnership only names a pending owner; nothing else changes", async () => {
      const hash = await bridge.write.transferOwnership([other.account.address]);
      assert.equal((await bridge.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
      assert.equal((await bridge.read.pendingOwner()).toLowerCase(), other.account.address.toLowerCase());
      const [ev] = await logsOf(hash, "OwnershipTransferStarted");
      assert.equal(ev.args.pendingOwner.toLowerCase(), other.account.address.toLowerCase());
      // The old owner can still administer, the pending one cannot yet.
      await plant(6);
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM], { account: other.account }), /NotOwner\(/);
      await bridge.write.enableCctpDomain([6, EVM]);
    });

    it("only the pending owner can accept: not the old owner, not a stranger", async () => {
      await bridge.write.transferOwnership([other.account.address]);
      await assert.rejects(bridge.write.acceptOwnership({ account: owner.account }), /NotPendingOwner\(/);
      await assert.rejects(bridge.write.acceptOwnership({ account: stranger.account }), /NotPendingOwner\(/);
      assert.equal((await bridge.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    });

    it("acceptOwnership completes the move, clears pending, and the old owner loses every right", async () => {
      await bridge.write.transferOwnership([other.account.address]);
      const hash = await bridge.write.acceptOwnership({ account: other.account });
      const [ev] = await logsOf(hash, "OwnershipTransferred");
      assert.equal(ev.args.previousOwner.toLowerCase(), owner.account.address.toLowerCase());
      assert.equal(ev.args.newOwner.toLowerCase(), other.account.address.toLowerCase());
      assert.equal((await bridge.read.owner()).toLowerCase(), other.account.address.toLowerCase());
      assert.equal(await bridge.read.pendingOwner(), ZERO_ADDR);
      await plant(6);
      await assert.rejects(bridge.write.enableCctpDomain([6, EVM], { account: owner.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.setGuardian([stranger.account.address], { account: owner.account }), /NotOwner\(/);
      await bridge.write.enableCctpDomain([6, EVM], { account: other.account });
      // The old owner cannot accept a second time.
      await assert.rejects(bridge.write.acceptOwnership({ account: other.account }), /NotPendingOwner\(/);
    });

    it("a second transferOwnership overwrites the pending owner: the first can no longer accept", async () => {
      await bridge.write.transferOwnership([other.account.address]);
      await bridge.write.transferOwnership([stranger.account.address]);
      assert.equal((await bridge.read.pendingOwner()).toLowerCase(), stranger.account.address.toLowerCase());
      await assert.rejects(bridge.write.acceptOwnership({ account: other.account }), /NotPendingOwner\(/);
      await bridge.write.acceptOwnership({ account: stranger.account });
      assert.equal((await bridge.read.owner()).toLowerCase(), stranger.account.address.toLowerCase());
    });

    it("transferOwnership(0) cancels a pending transfer and cannot burn the admin", async () => {
      await bridge.write.transferOwnership([other.account.address]);
      await bridge.write.transferOwnership([ZERO_ADDR]);
      assert.equal(await bridge.read.pendingOwner(), ZERO_ADDR);
      await assert.rejects(bridge.write.acceptOwnership({ account: other.account }), /NotPendingOwner\(/);
      await assert.rejects(bridge.write.acceptOwnership({ account: stranger.account }), /NotPendingOwner\(/);
      assert.equal((await bridge.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    });

    it("naming the current owner as pending is harmless", async () => {
      await bridge.write.transferOwnership([owner.account.address]);
      await bridge.write.acceptOwnership({ account: owner.account });
      assert.equal((await bridge.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    });

    it("a stranger and the guardian cannot start a transfer", async () => {
      await assert.rejects(bridge.write.transferOwnership([stranger.account.address], { account: stranger.account }), /NotOwner\(/);
      await assert.rejects(bridge.write.transferOwnership([guardian.account.address], { account: guardian.account }), /NotOwner\(/);
    });

    it("the guardian survives an ownership change; the new owner can replace it", async () => {
      await bridge.write.transferOwnership([other.account.address]);
      await bridge.write.acceptOwnership({ account: other.account });
      assert.equal((await bridge.read.guardian()).toLowerCase(), guardian.account.address.toLowerCase());
      await bridge.write.setGuardian([ZERO_ADDR], { account: other.account });
      assert.equal(await bridge.read.guardian(), ZERO_ADDR);
    });
  });
});
