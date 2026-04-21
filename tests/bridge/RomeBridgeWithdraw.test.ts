/**
 * RomeBridgeWithdraw — error-path unit tests
 *
 * Runs against hardhatMainnet (simulated L1, no Rome stack required).
 *
 * Scope: validates guard conditions in RomeBridgeWithdraw:
 *   1. AmountExceedsUint64 — fires before any external call when amount > 2^64-1.
 *   2. InsufficientBalance — fires when user balance < amount.
 *   3. Immutables (usdcMint, wethMint) are wired correctly from mock wrappers.
 *
 * Phase 1.4 refactor: all Solana pubkeys are now constructor params (no more
 * internal constant sentinels). The sysvar-sentinel guard tests are removed —
 * the revert-on-zero-sysvar behaviour no longer exists in the contract.
 *
 * The full CPI happy-path tests require a live Rome stack and are deferred to
 * integration tests (tests/bridge/*.integration.ts).
 */

import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import type { Address } from "viem";

describe("RomeBridgeWithdraw — error paths", () => {
  let viem: Awaited<ReturnType<typeof hardhat.network.connect>>["viem"];
  let withdraw: any;
  let user: Address;

  // Zero bytes32 — used as dummy PDA values for CCTP/Wormhole constructor params.
  const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

  // Arbitrary non-zero mint id for the mock.
  const MOCK_MINT =
    "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const;

  // Dummy non-zero program IDs for the new constructor fields.
  const DUMMY_PROGRAM =
    "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef00000001" as const;

  before(async () => {
    const conn = await hardhat.network.connect({ network: "hardhatMainnet" });
    viem = conn.viem;
    const [userClient] = await viem.getWalletClients();
    user = userClient.account.address;
  });

  beforeEach(async () => {
    // Deploy two MockSplErc20 instances (no CPI precompile needed).
    const mockUsdc = await viem.deployContract("MockSplErc20", [MOCK_MINT]);
    const mockWeth = await viem.deployContract("MockSplErc20", [MOCK_MINT]);

    // Deploy RomeBridgeWithdraw with a zero-address forwarder (ERC2771Context
    // accepts any address) and non-zero bytes32 for all new program ID fields.
    // Solidity accepts address as SPL_ERC20 argument — implicit coercion.
    withdraw = await viem.deployContract("RomeBridgeWithdraw", [
      "0x0000000000000000000000000000000000000000", // forwarder
      mockUsdc.address, // _usdc (cast to SPL_ERC20 by Solidity)
      mockWeth.address, // _weth (cast to SPL_ERC20 by Solidity)
      // CctpParams — all fields now required including program IDs
      {
        tokenMessengerProgram: DUMMY_PROGRAM,
        messageTransmitterProgram: DUMMY_PROGRAM,
        splTokenProgram: DUMMY_PROGRAM,
        systemProgram: ZERO_BYTES32,
        messageTransmitterConfig: ZERO_BYTES32,
        tokenMessengerConfig: ZERO_BYTES32,
        remoteTokenMessenger: ZERO_BYTES32,
        tokenMinter: ZERO_BYTES32,
        localTokenUsdc: ZERO_BYTES32,
        senderAuthorityPda: ZERO_BYTES32,
        eventAuthority: ZERO_BYTES32,
      },
      // WormholeParams — all fields now required including program IDs and sysvars
      {
        tokenBridgeProgram: DUMMY_PROGRAM,
        coreProgram: DUMMY_PROGRAM,
        splTokenProgram: DUMMY_PROGRAM,
        systemProgram: ZERO_BYTES32,
        clockSysvar: DUMMY_PROGRAM,
        rentSysvar: DUMMY_PROGRAM,
        config: ZERO_BYTES32,
        custody: ZERO_BYTES32,
        authoritySigner: ZERO_BYTES32,
        custodySigner: ZERO_BYTES32,
        bridgeConfig: ZERO_BYTES32,
        feeCollector: ZERO_BYTES32,
        emitter: ZERO_BYTES32,
        sequence: ZERO_BYTES32,
        wrappedMeta: ZERO_BYTES32,
        targetChain: 2,
      },
    ]);
  });

  // ── Test 1: AmountExceedsUint64 fires when amount > 2^64-1 ──────────────────
  //
  // amount = 2^64 exceeds type(uint64).max (= 2^64 - 1).
  // The range check is the FIRST guard in burnUSDC / burnETH (Phase 1.4 removed
  // the sysvar-sentinel guard, so AmountExceedsUint64 now fires first).

  it("reverts with AmountExceedsUint64 for burnUSDC when amount exceeds uint64", async () => {
    const tooLarge = 2n ** 64n; // = type(uint64).max + 1
    await assert.rejects(
      () => withdraw.write.burnUSDC([tooLarge, user]),
      (err: any) => {
        const msg: string = err?.message ?? "";
        return msg.includes("AmountExceedsUint64");
      }
    );
  });

  it("reverts with AmountExceedsUint64 for burnETH when amount exceeds uint64", async () => {
    const tooLarge = 2n ** 64n;
    await assert.rejects(
      () => withdraw.write.burnETH([tooLarge, user]),
      (err: any) => {
        const msg: string = err?.message ?? "";
        return msg.includes("AmountExceedsUint64");
      }
    );
  });

  // ── Test 2: InsufficientBalance fires when user has no balance ──────────────
  //
  // MockSplErc20 returns zero balance by default, so any non-zero amount triggers
  // InsufficientBalance (amount passes uint64 range, then balance check fails).
  // This test confirms the balance guard is reached now that the sysvar sentinel
  // has been removed.

  it("reverts with InsufficientBalance for burnUSDC when user has zero balance", async () => {
    await assert.rejects(
      () => withdraw.write.burnUSDC([1_000_000n, user]),
      (err: any) => {
        const msg: string = err?.message ?? "";
        return msg.includes("InsufficientBalance");
      }
    );
  });

  it("reverts with InsufficientBalance for burnETH when user has zero balance", async () => {
    await assert.rejects(
      () => withdraw.write.burnETH([1_000_000n, user]),
      (err: any) => {
        const msg: string = err?.message ?? "";
        return msg.includes("InsufficientBalance");
      }
    );
  });

  // ── Test 3: Custom error ABI presence ────────────────────────────────────────

  it("exposes AmountExceedsUint64 custom error in the contract ABI", async () => {
    const abi: any[] = withdraw.abi;
    const errorDef = abi.find(
      (entry: any) => entry.type === "error" && entry.name === "AmountExceedsUint64"
    );
    assert.ok(errorDef, "AmountExceedsUint64 not found in ABI");
    assert.strictEqual(errorDef.inputs.length, 1, "expected 1 input (amount)");
    assert.strictEqual(errorDef.inputs[0].type, "uint256");
  });

  it("exposes InsufficientBalance custom error in the contract ABI", async () => {
    const abi: any[] = withdraw.abi;
    const errorDef = abi.find(
      (entry: any) => entry.type === "error" && entry.name === "InsufficientBalance"
    );
    assert.ok(errorDef, "InsufficientBalance not found in ABI");
    assert.strictEqual(errorDef.inputs.length, 3);
  });

  // ── Test 4: Immutables are set correctly ─────────────────────────────────────

  it("stores usdcMint and wethMint immutables from mock wrappers", async () => {
    const usdcMint = await withdraw.read.usdcMint();
    const wethMint = await withdraw.read.wethMint();
    assert.strictEqual(usdcMint.toLowerCase(), MOCK_MINT.toLowerCase());
    assert.strictEqual(wethMint.toLowerCase(), MOCK_MINT.toLowerCase());
  });
});
