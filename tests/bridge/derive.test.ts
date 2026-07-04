/**
 * Bridge PDA derivation unit tests.
 *
 * Runs without a Rome stack or live network — pure TypeScript + @solana/web3.js.
 * Verifies that deriveCctpAccounts and deriveWormholeAccounts:
 *   1. Return the correct number of fields (8 CCTP, 9 Wormhole).
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
import { base58ToBytes32 } from "../../scripts/lib/pubkey.js";

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

describe("Bridge PDA derivations", () => {
  it("deriveCctpAccounts (v2) reproduces the LANDED devnet v2 config accounts", () => {
    // Ground truth = the account list of a landed devnet v2 deposit_for_burn
    // (4L4D7Qo7…) + a landed v2 receive (3KsdvCJr…). Not derived offsets —
    // real on-chain pubkeys.
    const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
    const pdas = deriveCctpAccounts(usdcMint, [0, 15]);
    const expect58 = {
      cctpMessageTransmitterConfig: "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU",
      cctpTokenMessengerConfig: "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W",
      cctpTokenMinter: "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux",
      cctpLocalTokenUsdc: "7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU",
      cctpSenderAuthorityPda: "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE",
      cctpEventAuthority: "6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd",
      cctpMessageTransmitterEventAuthority: "2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV",
    } as const;
    for (const [k, v] of Object.entries(expect58)) {
      assert.strictEqual((pdas as any)[k], base58ToBytes32(v), k);
    }
    assert.deepStrictEqual(pdas.cctpDomains, [0, 15]);
    assert.strictEqual(pdas.cctpRemoteTokenMessengers.length, 2);
    // Domain 0's remote_token_messenger from the landed burn:
    assert.strictEqual(
      pdas.cctpRemoteTokenMessengers[0],
      base58ToBytes32("3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9"),
    );
    // Domain 15 (Monad) derives to a distinct, well-formed PDA.
    assert.match(pdas.cctpRemoteTokenMessengers[1], BYTES32_RE);
    assert.notStrictEqual(pdas.cctpRemoteTokenMessengers[1], pdas.cctpRemoteTokenMessengers[0]);
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
    const a = deriveCctpAccounts(usdcMint, [0, 1, 3, 6, 7, 15]);
    const b = deriveCctpAccounts(usdcMint, [0, 1, 3, 6, 7, 15]);
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
    const pdas = deriveCctpAccounts(usdcMint, [0, 1, 3, 6, 7, 15]);
    const { cctpDomains, cctpRemoteTokenMessengers, ...configs } = pdas;
    const values = [...Object.values(configs), ...cctpRemoteTokenMessengers];
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

describe("deploy wiring — CPI target must be the v2 programs (audit C1)", () => {
  it("universalFor returns the CCTP v2 program ids for the constructor fields", async () => {
    const { universalFor } = await import("../../scripts/bridge/deploy.js");
    const { SOLANA_PROGRAM_IDS } = await import("../../scripts/bridge/constants.js");
    for (const net of ["hadrian", "nerva"]) {
      const u = universalFor(net);
      assert.strictEqual(
        u.cctpTokenMessengerProgram,
        base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_V2_TOKEN_MESSENGER),
        `${net}: constructor must target the v2 TMM (v1 target = every burn reverts)`,
      );
      assert.strictEqual(
        u.cctpMessageTransmitterProgram,
        base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_V2_MESSAGE_TRANSMITTER),
      );
    }
  });
});
