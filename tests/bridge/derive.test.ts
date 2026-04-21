/**
 * Bridge PDA derivation unit tests.
 *
 * Runs without a Rome stack or live network — pure TypeScript + @solana/web3.js.
 * Verifies that deriveCctpAccounts and deriveWormholeAccounts:
 *   1. Return the correct number of fields (7 CCTP, 9 Wormhole).
 *   2. All field values are well-formed bytes32 (0x + 64 hex digits).
 *   3. Derivations are deterministic (same input → same output).
 *
 * Run: npx hardhat test tests/bridge/derive.test.ts --network hardhatMainnet
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { deriveCctpAccounts } from "../../scripts/bridge/derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "../../scripts/bridge/derive/wormhole-accounts.js";
import { SPL_MINTS } from "../../scripts/bridge/constants.js";

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

describe("Bridge PDA derivations", () => {
  it("deriveCctpAccounts returns 7 well-formed bytes32 values", () => {
    const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
    const pdas = deriveCctpAccounts(usdcMint);
    const keys = Object.keys(pdas);
    assert.strictEqual(keys.length, 7);
    for (const [, value] of Object.entries(pdas)) {
      assert.match(value, BYTES32_RE, `Expected bytes32 hex, got: ${value}`);
    }
  });

  it("deriveWormholeAccounts returns 9 well-formed bytes32 values", () => {
    const wethMint = new PublicKey(SPL_MINTS.WETH_WORMHOLE);
    const pdas = deriveWormholeAccounts(wethMint);
    const keys = Object.keys(pdas);
    assert.strictEqual(keys.length, 9);
    for (const [, value] of Object.entries(pdas)) {
      assert.match(value, BYTES32_RE, `Expected bytes32 hex, got: ${value}`);
    }
  });

  it("CCTP derivations are deterministic", () => {
    const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
    const a = deriveCctpAccounts(usdcMint);
    const b = deriveCctpAccounts(usdcMint);
    assert.deepStrictEqual(a, b);
  });

  it("Wormhole derivations are deterministic", () => {
    const wethMint = new PublicKey(SPL_MINTS.WETH_WORMHOLE);
    const a = deriveWormholeAccounts(wethMint);
    const b = deriveWormholeAccounts(wethMint);
    assert.deepStrictEqual(a, b);
  });

  it("CCTP accounts use distinct PDA addresses", () => {
    const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
    const pdas = deriveCctpAccounts(usdcMint);
    const values = Object.values(pdas);
    const unique = new Set(values);
    assert.strictEqual(unique.size, values.length, "CCTP PDAs must all be distinct");
  });

  it("Wormhole accounts use distinct PDA addresses", () => {
    const wethMint = new PublicKey(SPL_MINTS.WETH_WORMHOLE);
    const pdas = deriveWormholeAccounts(wethMint);
    const values = Object.values(pdas);
    const unique = new Set(values);
    assert.strictEqual(unique.size, values.length, "Wormhole PDAs must all be distinct");
  });
});
