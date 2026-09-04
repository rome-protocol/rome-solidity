/**
 * WrappedGasFacade — moved off the wrapper's ERC-20 surface.
 *
 * The migrated cached wrapper (`spl-wrappers-direct-call`, PR #338) routes a
 * contract holder's SPL through its own escrow ATA (`ata(external_auth(wrapper),
 * mint)`), while `WithdrawCached.withdraw_to_ata` / `.deposit` always target
 * `ata(external_auth(context.caller), mint)` — the facade's own ATA when called
 * by direct CALL. Those are two distinct PDAs the wrapper's `_escrow` ledger
 * never reconciles (see facade-status.md), so `wrapper.transfer` /
 * `wrapper.transferFrom` cannot carry the gas legs. This fix stops calling
 * them: the facade moves the underlying SPL straight to/from each caller's own
 * ATA by direct CALL, relying on the fact that an EOA's wrapper balance IS its
 * on-chain ATA balance — no wrapper-side change.
 *
 * Two layers:
 *   - structural: read the real source file, assert the ERC-20 `wrapper.transfer`
 *     / `wrapper.transferFrom` calls are gone and the direct-CALL replacements
 *     are present.
 *   - behavioral: drive the real deployed contract through `FacadePrecompileMock`,
 *     installed via `hardhat_setCode` at the real WithdrawCached/SplCached/
 *     AssociatedSplCached/HelperProgram/SystemProgram addresses, and assert the
 *     precompile sees the FACADE as `msg.sender` (proof of a direct CALL) with
 *     the right ATA/amount at each site.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import hardhat from "hardhat";

const WITHDRAW_CACHED_ADDRESS = "0xFF0000000000000000000000000000000000000B" as const;
const SPL_CACHED_ADDRESS = "0xff00000000000000000000000000000000000005" as const;
const ASSOCIATED_SPL_CACHED_ADDRESS = "0xFF00000000000000000000000000000000000006" as const;
const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009" as const;
const SYSTEM_PROGRAM_ADDRESS = "0xfF00000000000000000000000000000000000007" as const;

describe("WrappedGasFacade — direct-call migration", () => {
  describe("structural — source is ground truth", () => {
    const srcPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "contracts", "wrap", "WrappedGasFacade.sol"
    );
    const src = readFileSync(srcPath, "utf8");

    it("never calls the wrapper's ERC-20 transfer/transferFrom", () => {
      assert.ok(!/wrapper\.transfer\(/.test(src), "wrapper.transfer must be gone");
      assert.ok(!/wrapper\.transferFrom\(/.test(src), "wrapper.transferFrom must be gone");
    });

    it("deposit's wrap leg forwards via SplCached.transfer, a direct CALL", () => {
      assert.ok(src.includes("SplCached.transfer(msg.sender, wad / weiPerToken)"));
    });

    it("withdraw's unwrap leg pulls via HelperProgram.transfer_spl, a direct CALL", () => {
      const start = src.indexOf("function withdraw(uint256 wad)");
      assert.ok(start >= 0, "withdraw not found");
      const body = src.slice(start);
      assert.ok(body.includes("HelperProgram.transfer_spl("));
    });

    it("constructor pins the wrapper to the chain's gas mint", () => {
      assert.ok(src.includes("SystemProgram.mint_id()"));
      assert.ok(src.includes("MintMismatch"));
    });
  });

  describe("behavioral — driven through FacadePrecompileMock", () => {
    let viem: any;
    let conn: any;
    let withdrawCached: any;
    let splCached: any;
    let associatedSplCached: any;
    let helper: any;
    let wrapperMock: any;
    let facade: any;
    let userWallet: any;
    let mintId: `0x${string}`;
    const DECIMALS = 6;
    const WEI_PER_TOKEN = 10n ** BigInt(18 - DECIMALS);

    before(async function () {
      conn = await hardhat.network.connect();
      viem = conn.viem;

      const mockProto = await viem.deployContract("FacadePrecompileMock");
      const client = await viem.getPublicClient();
      const code = await client.getCode({ address: mockProto.address });
      assert.ok(code && code !== "0x", "mock must have deployed code to install");
      for (const addr of [
        WITHDRAW_CACHED_ADDRESS,
        SPL_CACHED_ADDRESS,
        ASSOCIATED_SPL_CACHED_ADDRESS,
        HELPER_PROGRAM_ADDRESS,
        SYSTEM_PROGRAM_ADDRESS,
      ]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
      }
      // WithdrawCached.deposit() mints native by paying it out — fund the mock.
      await conn.provider.request({
        method: "hardhat_setBalance",
        params: [WITHDRAW_CACHED_ADDRESS, "0x21e19e0c9bab2400000"], // 10_000 ether
      });

      withdrawCached = await viem.getContractAt("FacadePrecompileMock", WITHDRAW_CACHED_ADDRESS);
      splCached = await viem.getContractAt("FacadePrecompileMock", SPL_CACHED_ADDRESS);
      associatedSplCached = await viem.getContractAt("FacadePrecompileMock", ASSOCIATED_SPL_CACHED_ADDRESS);
      helper = await viem.getContractAt("FacadePrecompileMock", HELPER_PROGRAM_ADDRESS);
      mintId = await withdrawCached.read.GAS_MINT();

      const wallets = await viem.getWalletClients();
      userWallet = wallets[1]; // distinct from the deployer (wallets[0])
    });

    beforeEach(async function () {
      // Shared mock storage lives at the fixed precompile addresses across the
      // whole describe block (hardhat_setCode replaces code, not storage) —
      // reset the counters so each test starts from zero.
      for (const c of [withdrawCached, splCached, associatedSplCached, helper]) {
        await c.write.reset();
      }
      wrapperMock = await viem.deployContract("MockSplErc20", [mintId]);
      await wrapperMock.write.setDecimals([DECIMALS]);
      facade = await viem.deployContract("WrappedGasFacade", [wrapperMock.address]);
    });

    it("constructor pins weiPerToken from the wrapper's decimals against the chain's gas mint", async function () {
      assert.equal(await facade.read.weiPerToken(), WEI_PER_TOKEN);
      assert.equal(await facade.read.mintId(), mintId);
    });

    it("constructor reverts when the wrapper's mint does not match the chain's gas mint", async function () {
      const otherMint = ("0x" + "ab".repeat(32)) as `0x${string}`;
      const mismatched = await viem.deployContract("MockSplErc20", [otherMint]);
      await assert.rejects(
        viem.deployContract("WrappedGasFacade", [mismatched.address]),
        /MintMismatch/
      );
    });

    it("deposit() burns wei via WithdrawCached (signed by the facade) then forwards SPL straight to the caller via SplCached, never through the wrapper", async function () {
      const wad = 2_000_000n * WEI_PER_TOKEN;
      const user = userWallet.account.address;

      await facade.write.deposit([], { account: userWallet.account, value: wad });

      assert.equal(await withdrawCached.read.withdrawToAtaCount(), 1n);
      assert.equal((await withdrawCached.read.lastWithdrawToAtaCaller()).toLowerCase(), facade.address.toLowerCase());
      assert.equal(await withdrawCached.read.lastWithdrawToAtaWei(), wad);

      assert.equal(await splCached.read.transferCount(), 1n);
      assert.equal((await splCached.read.lastTransferCaller()).toLowerCase(), facade.address.toLowerCase());
      assert.equal((await splCached.read.lastTransferTo()).toLowerCase(), user.toLowerCase());
      assert.equal(await splCached.read.lastTransferAmount(), wad / WEI_PER_TOKEN);

      // The wrapper's own ERC-20 surface is never touched.
      assert.equal(await wrapperMock.read.balanceOf([facade.address]), 0n);
    });

    it("deposit() refunds sub-token dust and emits Deposit for the exact whole-token wad", async function () {
      const wad = 3_000_000n * WEI_PER_TOKEN;
      const dust = WEI_PER_TOKEN / 2n;
      const pc = await viem.getPublicClient();
      const user = userWallet.account.address;
      const nativeBefore = await pc.getBalance({ address: user });

      const txHash = await facade.write.deposit([], { account: userWallet.account, value: wad + dust });
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
      assert.equal(receipt.status, "success");

      const facadeAbi = (await hardhat.artifacts.readArtifact("WrappedGasFacade")).abi;
      const { parseEventLogs } = await import("viem");
      const events = parseEventLogs({ abi: facadeAbi, logs: receipt.logs, eventName: "Deposit" });
      assert.equal(events.length, 1);
      assert.equal(events[0].args.wad, wad);

      const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
      const nativeAfter = await pc.getBalance({ address: user });
      assert.equal(nativeBefore - nativeAfter, wad + gasPaid, "only whole-token wei + gas leaves the wallet");
    });

    it("deposit() with sub-granularity value reverts with Granularity", async function () {
      await assert.rejects(
        facade.write.deposit([], { account: userWallet.account, value: WEI_PER_TOKEN / 2n }),
        /Granularity/
      );
    });

    it("withdraw() pulls the caller's own SPL as their delegate into the facade's own ATA, then unwraps and forwards native — no wrapper.approve needed", async function () {
      const wad = 1_500_000n * WEI_PER_TOKEN;
      const user = userWallet.account.address;
      const userAta = await helper.read.ata([user, mintId]);
      const facadeAta = await helper.read.ata([facade.address, mintId]);
      await helper.write.setAuthorized([userAta, facade.address, true]);

      const pc = await viem.getPublicClient();
      const nativeBefore = await pc.getBalance({ address: user });
      const txHash = await facade.write.withdraw([wad], { account: userWallet.account });
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
      assert.equal(receipt.status, "success");

      assert.equal(await helper.read.transferSplCount(), 1n);
      assert.equal((await helper.read.lastTransferSplCaller()).toLowerCase(), facade.address.toLowerCase());
      assert.equal(await helper.read.lastTransferSplFromAta(), userAta);
      assert.equal(await helper.read.lastTransferSplToAta(), facadeAta);
      assert.equal(await helper.read.lastTransferSplTokens(), wad / WEI_PER_TOKEN);

      assert.equal(await withdrawCached.read.depositCount(), 1n);
      assert.equal((await withdrawCached.read.lastDepositCaller()).toLowerCase(), facade.address.toLowerCase());
      assert.equal(await withdrawCached.read.lastDepositWei(), wad);

      const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
      const nativeAfter = await pc.getBalance({ address: user });
      assert.equal(nativeAfter - nativeBefore, wad - gasPaid, "native credited minus gas");

      // No residue may accumulate on the facade.
      assert.equal(await pc.getBalance({ address: facade.address }), 0n);
    });

    it("withdraw() reverts when the caller never granted the facade an SPL-level delegate", async function () {
      const wad = 1_000_000n * WEI_PER_TOKEN;
      // Deliberately no `setAuthorized` call — control varies the world (the
      // authorization the caller's identity depends on), not the ruler.
      await assert.rejects(
        facade.write.withdraw([wad], { account: userWallet.account }),
        (err: any) => {
          const msg: string = err?.message ?? "";
          return msg.includes("neither owner nor delegate");
        }
      );
      assert.equal(await withdrawCached.read.depositCount(), 0n);
    });

    it("withdraw() with sub-token granularity reverts with Granularity", async function () {
      await assert.rejects(
        facade.write.withdraw([WEI_PER_TOKEN + 1n], { account: userWallet.account }),
        /Granularity/
      );
    });
  });
});
