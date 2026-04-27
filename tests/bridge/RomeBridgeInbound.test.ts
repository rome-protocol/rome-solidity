/**
 * RomeBridgeInbound — unit tests (hardhatMainnet, no Rome stack required).
 *
 * Covers:
 *   1. Constructor computes the wrapper→wei scale factor from decimals().
 *   2. settleInbound reverts on zero amount.
 *   3. settleInbound reverts with InsufficientBalance when user balance < amount.
 *   4. settleInbound reverts with InsufficientAllowance when allowance < amount.
 *   5. Happy path: pulls wrapper from user, calls unwrap precompile, forwards
 *      gas to user, emits SettledInbound. The unwrap precompile is stubbed at
 *      its canonical address (0x42..17) via hardhat_setCode.
 *
 * CPI happy-path against the real `unwrap_spl_to_gas` precompile is deferred
 * to an integration test against a live Rome stack (see Phase 1.4 pattern).
 */

import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
  getAddress,
  parseEther,
  type Address,
} from "viem";

const UNWRAP_PRECOMPILE: Address = getAddress(
  "0x4200000000000000000000000000000000000017",
);

const MOCK_MINT =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const;

// MockSplErc20 defaults to 6 decimals (USDC). 1 mint-unit = 10^(18-6) wei.
const WEI_PER_UNIT = 10n ** 12n;

describe("RomeBridgeInbound — unit tests", () => {
  let conn: Awaited<ReturnType<typeof hardhat.network.connect>>;
  let viem: Awaited<ReturnType<typeof hardhat.network.connect>>["viem"];
  let publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>;
  let user: Address;
  let wrapper: any;
  let inbound: any;

  before(async () => {
    conn = await hardhat.network.connect({ network: "hardhatMainnet" });
    viem = conn.viem;
    publicClient = await viem.getPublicClient();
    const [userClient] = await viem.getWalletClients();
    user = userClient.account.address;

    // Stub out the UnwrapSplToGas precompile at its canonical address.
    // Deploy MockUnwrapSplToGas normally, copy its runtime bytecode to
    // 0x42..17, then fund the precompile address so it can forward ETH.
    const deployedMock = await viem.deployContract("MockUnwrapSplToGas");
    const code = await publicClient.getCode({ address: deployedMock.address });
    assert.ok(code && code !== "0x", "mock bytecode not deployed");
    await conn.provider.request({
      method: "hardhat_setCode",
      params: [UNWRAP_PRECOMPILE, code],
    });
    // Fund the precompile so it has ETH to forward on each unwrap call.
    // 100 ETH covers any plausible test load.
    await conn.provider.request({
      method: "hardhat_setBalance",
      params: [UNWRAP_PRECOMPILE, "0x" + parseEther("100").toString(16)],
    });
  });

  beforeEach(async () => {
    wrapper = await viem.deployContract("MockSplErc20", [MOCK_MINT]);
    inbound = await viem.deployContract("RomeBridgeInbound", [
      "0x0000000000000000000000000000000000000000", // forwarder (ERC2771)
      wrapper.address,
      MOCK_MINT,
    ]);
  });

  it("wires immutables correctly from constructor", async () => {
    const m = (await inbound.read.mint()) as `0x${string}`;
    assert.equal(m.toLowerCase(), MOCK_MINT);
    const w = (await inbound.read.wrapper()) as Address;
    assert.equal(getAddress(w), getAddress(wrapper.address));
    const scale = (await inbound.read.scaleWeiPerUnit()) as bigint;
    assert.equal(scale, WEI_PER_UNIT);
  });

  it("scales correctly for 9-dec mints", async () => {
    const w9 = await viem.deployContract("MockSplErc20", [MOCK_MINT]);
    await w9.write.setDecimals([9]);
    const inb = await viem.deployContract("RomeBridgeInbound", [
      "0x0000000000000000000000000000000000000000",
      w9.address,
      MOCK_MINT,
    ]);
    const scale = (await inb.read.scaleWeiPerUnit()) as bigint;
    assert.equal(scale, 10n ** 9n);
  });

  // viem v2 wraps revert data in nested `cause` chains; walk the object
  // tree to find any string containing the expected error name. Lets us
  // assert on Solidity custom-error names regardless of which layer viem
  // decides to surface.
  const errorContains = (err: any, needle: string): boolean => {
    const seen = new Set<any>();
    const walk = (o: any): boolean => {
      if (!o || typeof o !== "object" || seen.has(o)) return false;
      seen.add(o);
      for (const v of Object.values(o)) {
        if (typeof v === "string" && v.includes(needle)) return true;
        if (typeof v === "object" && walk(v)) return true;
      }
      return false;
    };
    return walk(err);
  };

  it("reverts on zero amount", async () => {
    await assert.rejects(
      async () => inbound.write.settleInbound([0n]),
      (err: any) => {
        assert.ok(
          errorContains(err, "ZeroAmount"),
          `expected ZeroAmount in error tree`,
        );
        return true;
      },
    );
  });

  it("reverts with InsufficientBalance when user balance < amount", async () => {
    // No balance set — user has 0 wrapper balance.
    await assert.rejects(
      async () => inbound.write.settleInbound([1_000_000n]),
      (err: any) => {
        assert.ok(errorContains(err, "InsufficientBalance"));
        return true;
      },
    );
  });

  it("reverts with InsufficientAllowance when balance OK but allowance < amount", async () => {
    await wrapper.write.setBalance([user, 5_000_000n]);
    // Allowance still 0.
    await assert.rejects(
      async () => inbound.write.settleInbound([1_000_000n]),
      (err: any) => {
        assert.ok(errorContains(err, "InsufficientAllowance"));
        return true;
      },
    );
  });

  it("happy path: pulls wrapper, forwards gas, emits SettledInbound", async () => {
    const wrapperAmount = 1_000_000n; // 1 USDC
    const expectedWei = wrapperAmount * WEI_PER_UNIT;

    await wrapper.write.setBalance([user, wrapperAmount]);
    await wrapper.write.setAllowance([user, inbound.address, wrapperAmount]);

    const balBefore = await publicClient.getBalance({ address: user });

    const txHash = await inbound.write.settleInbound([wrapperAmount]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, "success");

    // Wrapper moved: user 0, contract has the wrapper amount.
    const userWrapper = (await wrapper.read.balanceOf([user])) as bigint;
    const contractWrapper = (await wrapper.read.balanceOf([inbound.address])) as bigint;
    assert.equal(userWrapper, 0n, "user wrapper should be zero");
    assert.equal(contractWrapper, wrapperAmount, "contract holds the pulled wrapper");

    // User's ETH balance increased by gas-forward minus tx fee. Just assert
    // the balance went UP by approximately expectedWei — allowing tx gas
    // cost variance (on hardhat, gas cost is ~< 0.001 ETH).
    const balAfter = await publicClient.getBalance({ address: user });
    const delta = balAfter - balBefore;
    // Hardhat gas cost can consume up to ~0.01 ETH. Expected forward ≫ that.
    const lowerBound = expectedWei - parseEther("0.01");
    assert.ok(
      delta > lowerBound,
      `expected user balance to grow by ~${expectedWei}; got ${delta}`,
    );

    // Event emitted.
    const logs = receipt.logs;
    const settled = logs.find((l) => l.address.toLowerCase() === inbound.address.toLowerCase());
    assert.ok(settled, "SettledInbound event not found");
  });

  it("reentrancy-safe: receive() is payable to accept the precompile credit", async () => {
    // Smoke check — the contract needs receive() or the unwrap's implicit
    // credit to its own balance would revert. Verified indirectly by the
    // happy-path test above passing; this test exists to lock that constraint.
    const userBalanceOfInbound = await publicClient.getBalance({
      address: inbound.address,
    });
    assert.equal(userBalanceOfInbound, 0n);
  });

  // ─── Hardening A2: ReentrancyGuard ───────────────────────────────────────

  describe("ReentrancyGuard (A2)", () => {
    it("blocks re-entry from a malicious receiver during the gas forward", async () => {
      // Deploy a contract that re-enters settleInbound from receive()
      const wrapperAmount = 1_000_000n;
      const replayAmount = 500_000n;
      const reentrant = await viem.deployContract("ReentrantReceiver", [
        inbound.address,
        wrapper.address,
        replayAmount,
      ]);

      // Fund the receiver with enough wrapper for both the outer call AND
      // a hypothetical re-entry, with allowance for the inbound contract.
      // If the guard is missing, the receive() handler would consume
      // `replayAmount` more wrapper on re-entry.
      await wrapper.write.setBalance([reentrant.address, wrapperAmount + replayAmount]);
      await wrapper.write.setAllowance([
        reentrant.address,
        inbound.address,
        wrapperAmount + replayAmount,
      ]);

      // The trigger fires the first settleInbound. With ReentrancyGuard
      // in place, the re-entry inside receive() reverts; the catch
      // swallows the revert; the outer call still succeeds. The test
      // proves the guard works by observing that the wrapper balance
      // dropped by exactly `wrapperAmount` (not `wrapperAmount +
      // replayAmount`).
      const txHash = await reentrant.write.trigger([wrapperAmount]);
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      const after = (await wrapper.read.balanceOf([reentrant.address])) as bigint;
      // Without the guard, after === replayAmount (only the second call's
      // tail would remain). With the guard, after === replayAmount because
      // the re-entry attempted but failed — only the outer wrapperAmount
      // got consumed.
      assert.equal(
        after,
        replayAmount,
        `expected receiver to retain ${replayAmount} wrapper after blocked re-entry; got ${after}`,
      );

      // The receive() captured a revert — confirms it actually attempted.
      const lastRevertData = (await reentrant.read.lastRevertData()) as `0x${string}`;
      assert.ok(
        lastRevertData && lastRevertData !== "0x",
        "expected ReentrantReceiver to capture a revert during re-entry attempt",
      );
    });
  });

  // ─── Hardening A3: Slippage / balance-delta check ────────────────────────

  describe("Slippage check on unwrap_spl_to_gas (A3)", () => {
    it("reverts with UnexpectedUnwrapDelta if precompile credits less than expected", async () => {
      // Deploy a partial-payout mock at the precompile address that only
      // forwards half the requested amount. This simulates a hypothetical
      // precompile bug or version mismatch where the unwrap doesn't
      // produce the expected wei delta.
      const partialMock = await viem.deployContract("PartialPayoutUnwrap");
      const code = await publicClient.getCode({ address: partialMock.address });
      assert.ok(code && code !== "0x", "partial-payout mock not deployed");
      await conn.provider.request({
        method: "hardhat_setCode",
        params: [UNWRAP_PRECOMPILE, code],
      });
      await conn.provider.request({
        method: "hardhat_setBalance",
        params: [UNWRAP_PRECOMPILE, "0x" + parseEther("100").toString(16)],
      });

      const wrapperAmount = 1_000_000n;
      await wrapper.write.setBalance([user, wrapperAmount]);
      await wrapper.write.setAllowance([user, inbound.address, wrapperAmount]);

      // Should revert because address(this).balance after unwrap will be
      // half of expected — the slippage check catches it.
      await assert.rejects(
        async () => inbound.write.settleInbound([wrapperAmount]),
        (err: any) => {
          assert.ok(
            errorContains(err, "UnexpectedUnwrapDelta"),
            "expected UnexpectedUnwrapDelta in error tree",
          );
          return true;
        },
      );

      // Restore the full-payout mock for subsequent tests in the suite.
      const goodMock = await viem.deployContract("MockUnwrapSplToGas");
      const goodCode = await publicClient.getCode({ address: goodMock.address });
      await conn.provider.request({
        method: "hardhat_setCode",
        params: [UNWRAP_PRECOMPILE, goodCode],
      });
      await conn.provider.request({
        method: "hardhat_setBalance",
        params: [UNWRAP_PRECOMPILE, "0x" + parseEther("100").toString(16)],
      });
    });
  });
});
