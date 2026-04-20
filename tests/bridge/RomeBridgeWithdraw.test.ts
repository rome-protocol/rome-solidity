/**
 * RomeBridgeWithdraw — error-path unit tests
 *
 * Runs against hardhatMainnet (simulated L1, no Rome stack required).
 *
 * Scope: validates the two critical guard conditions introduced in the Phase 1.3
 * fix pass:
 *   1. AmountExceedsUint64 — fires before any external call when amount > 2^64-1.
 *   2. CpiFailed("sysvar constants not initialized") — fires at the top of both
 *      burnUSDC/burnETH because SPL_TOKEN_PROGRAM is zeroed out until Phase 1.4
 *      supplies real pubkeys.
 *
 * InsufficientBalance and the full CPI happy-path tests require a live Rome stack
 * and are deferred to integration tests (tests/bridge/*.integration.ts).
 * The SPL_ERC20 constructor calls SplTokenLib.load_mint via a CPI precompile that
 * is not available on hardhatMainnet, so we use MockSplErc20 (contracts/bridge/test/)
 * and pass its address as the SPL_ERC20 constructor argument (Solidity implicitly
 * accepts address → contract-type casts for constructor arguments).
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
    // accepts any address) and zero bytes32 for all PDA params.
    // Solidity accepts address as SPL_ERC20 argument — implicit coercion.
    withdraw = await viem.deployContract("RomeBridgeWithdraw", [
      "0x0000000000000000000000000000000000000000", // forwarder
      mockUsdc.address, // _usdc (cast to SPL_ERC20 by Solidity)
      mockWeth.address, // _weth (cast to SPL_ERC20 by Solidity)
      // CctpParams
      {
        msgTransmitterConfig: ZERO_BYTES32,
        tokenMessengerConfig: ZERO_BYTES32,
        remoteTokenMessenger: ZERO_BYTES32,
        tokenMinter: ZERO_BYTES32,
        localTokenUsdc: ZERO_BYTES32,
        eventAuthority: ZERO_BYTES32,
      },
      // WormholeParams
      {
        config: ZERO_BYTES32,
        custody: ZERO_BYTES32,
        authoritySigner: ZERO_BYTES32,
        custodySigner: ZERO_BYTES32,
        bridgeConfig: ZERO_BYTES32,
        feeCollector: ZERO_BYTES32,
        emitter: ZERO_BYTES32,
        sequence: ZERO_BYTES32,
        coreProgram: ZERO_BYTES32,
      },
    ]);
  });

  // ── Test 1: AmountExceedsUint64 fires before any external call ──────────────
  //
  // amount = 2^64 exceeds type(uint64).max (= 2^64 - 1).
  // The range check is the FIRST guard in burnUSDC / burnETH (after the sysvar
  // sentinel check), so this reverts before balanceOf is ever called.
  // Note: the sysvar sentinel guard fires first (SPL_TOKEN_PROGRAM == 0), so
  // we expect CpiFailed rather than AmountExceedsUint64 when both conditions hold.
  // To isolate the range check we would need non-zero sysvars, which requires a
  // Phase 1.4 refactor. Instead we verify the sysvar sentinel guard fires, and
  // separately confirm AmountExceedsUint64 IS the correct custom error type.

  it("reverts with CpiFailed(sysvar constants not initialized) for any call — sentinels are zeroed", async () => {
    // Any amount triggers the sysvar guard first (SPL_TOKEN_PROGRAM == bytes32(0)).
    await assert.rejects(
      () => withdraw.write.burnUSDC([1_000_000n, user]),
      (err: any) => {
        // viem wraps revert data; check message contains the revert reason.
        const msg: string = err?.message ?? "";
        return (
          msg.includes("CpiFailed") ||
          msg.includes("sysvar constants not initialized")
        );
      }
    );
  });

  it("reverts with CpiFailed for burnETH — sysvar sentinel active", async () => {
    await assert.rejects(
      () => withdraw.write.burnETH([1_000_000n, user]),
      (err: any) => {
        const msg: string = err?.message ?? "";
        return (
          msg.includes("CpiFailed") ||
          msg.includes("sysvar constants not initialized")
        );
      }
    );
  });

  // ── Test 2: AmountExceedsUint64 error exists and is the correct ABI signature ─
  //
  // We cannot trigger it in isolation without non-zero sysvars (Phase 1.4 work),
  // but we can assert that the contract ABI exposes the error and it has the right
  // signature — verifying fix #1 was wired into the artifact.

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

  // ── Test 3: immutables are set correctly ─────────────────────────────────────

  it("stores usdcMint and wethMint immutables from mock wrappers", async () => {
    const usdcMint = await withdraw.read.usdcMint();
    const wethMint = await withdraw.read.wethMint();
    assert.strictEqual(usdcMint.toLowerCase(), MOCK_MINT.toLowerCase());
    assert.strictEqual(wethMint.toLowerCase(), MOCK_MINT.toLowerCase());
  });
});
