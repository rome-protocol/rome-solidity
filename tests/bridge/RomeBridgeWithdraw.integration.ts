// Integration tests for RomeBridgeWithdraw.
//
// PRECONDITIONS:
//   - rome-setup/deploy/start-local.sh must be running (Docker stack)
//   - scripts/bridge/deploy.ts must have been executed with --network local
//   - Test user PDA ATA must be pre-seeded with USDC and wETH (see seed.ts)
//
// Run: npx hardhat test tests/bridge/RomeBridgeWithdraw.integration.ts --network local
//
// These tests will FAIL on hardhatMainnet — they require CPI precompiles and a
// live Solana cluster. Phase 1.5 documents the setup; Phase 1.6 runs them against
// monti_spl devnet.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { readDeployments } from "../../scripts/lib/deployments.js";

describe("RomeBridgeWithdraw — integration (requires local Rome stack)", () => {
  let viem: Awaited<ReturnType<typeof hardhat.network.connect>>["viem"];
  let withdraw: any;
  let usdcWrapper: any;
  let wethWrapper: any;
  let user: `0x${string}`;

  before(async () => {
    const conn = await hardhat.network.connect();
    viem = conn.viem;
    const [userClient] = await viem.getWalletClients();
    user = userClient.account!.address;

    const d = readDeployments(conn.networkName) as any;
    if (!d.RomeBridgeWithdraw?.address) {
      throw new Error(
        "Integration test prerequisites missing: RomeBridgeWithdraw not deployed. " +
        "Run: npx hardhat run scripts/bridge/deploy.ts --network local"
      );
    }
    withdraw = await viem.getContractAt("RomeBridgeWithdraw", d.RomeBridgeWithdraw.address);
    usdcWrapper = await viem.getContractAt("SPL_ERC20", d.SPL_ERC20_USDC.address);
    wethWrapper = await viem.getContractAt("SPL_ERC20", d.SPL_ERC20_WETH.address);
  });

  it("reverts InsufficientBalance when user has zero USDC", async () => {
    const balance = await usdcWrapper.read.balanceOf([user]);
    if (balance > 0n) {
      return; // skip — pre-seeded
    }
    await assert.rejects(
      () => withdraw.write.burnUSDC([1_000_000n, user]),
      /InsufficientBalance/
    );
  });

  it("emits Withdrawn(path=0) when burnUSDC succeeds", async () => {
    const publicClient = await viem.getPublicClient();
    const initial = await usdcWrapper.read.balanceOf([user]);
    if (initial < 1_000_000n) {
      console.warn("Skipping burnUSDC happy-path test — user needs >= 1 USDC seeded in PDA ATA");
      return;
    }
    const txHash = await withdraw.write.burnUSDC([1_000_000n, user]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const final = await usdcWrapper.read.balanceOf([user]);
    assert.strictEqual(final, initial - 1_000_000n);

    const events = await withdraw.getEvents.Withdrawn(
      { user },
      { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber }
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].args.path, 0);
    assert.strictEqual(events[0].args.amount, 1_000_000n);
  });

  it("emits Withdrawn(path=1) when burnETH succeeds", async () => {
    const publicClient = await viem.getPublicClient();
    const initial = await wethWrapper.read.balanceOf([user]);
    if (initial < 10_000_000n) {
      console.warn("Skipping burnETH happy-path test — user needs >= 0.1 wETH seeded in PDA ATA");
      return;
    }
    const txHash = await withdraw.write.burnETH([10_000_000n, user]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const final = await wethWrapper.read.balanceOf([user]);
    assert.strictEqual(final, initial - 10_000_000n);

    const events = await withdraw.getEvents.Withdrawn(
      { user },
      { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber }
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].args.path, 1);
  });
});
