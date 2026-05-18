// Unit test pinning DAMMv1Lib.VAULT_MIN_LEN to the parser's actual byte
// consumption. The constant is used in two ways:
//   1. parse_vault's prefix-length sanity check
//   2. The size of the slice load_vault requests from account_data_at
// If (1) is smaller than what parse_vault actually advances through, the
// slice is too short and parse_vault reverts "oob u64" when it reads past
// the slice end. That's exactly what broke on the freshly-deployed Meteora
// factory `0xa3a4a275…` on Hadrian, 2026-05-18.
//
// parse_vault offsets (from damm_v1_pool.sol::parse_vault):
//   8   anchor discriminator
//   +3  enabled (u8) + vault_bump (u8) + token_vault_bump (u8)
//   +8  total_amount (u64)
//   +128  4× bytes32 (token_vault, fee_vault, token_mint, lp_mint)
//   +960  strategies[30]            (32 × 30)
//   +96   base + admin + operator   (32 × 3)
//   +24   3× u64 locked_profit_tracker fields
//   =1227 bytes
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

// Total bytes parse_vault actually advances through.
const PARSE_VAULT_CONSUMPTION = 1227;

function zeroBuffer(len: number): `0x${string}` {
    return ("0x" + "00".repeat(len)) as `0x${string}`;
}

describe("DAMMv1Lib.parse_vault — VAULT_MIN_LEN bounds", function () {
    let harness: any;
    let minLen: bigint;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        harness = await viem.deployContract("DAMMv1VaultParserHarness", []);
        minLen = await harness.read.vaultMinLen();
    });

    it("VAULT_MIN_LEN must be >= what parse_vault consumes (1227 bytes)", function () {
        assert.ok(
            Number(minLen) >= PARSE_VAULT_CONSUMPTION,
            `VAULT_MIN_LEN=${minLen} is smaller than parse_vault's actual byte consumption ` +
            `(${PARSE_VAULT_CONSUMPTION}). load_vault's slice will be too short and parse_vault will revert "oob u64".`
        );
    });

    it("parse_vault must succeed on a buffer of length VAULT_MIN_LEN", async function () {
        const buf = zeroBuffer(Number(minLen));
        // No field-level validation — just byte advancement. Must not revert.
        await harness.read.parseVault([buf]);
    });

    it("parse_vault must revert on a buffer shorter than VAULT_MIN_LEN", async function () {
        const buf = zeroBuffer(Number(minLen) - 1);
        await assert.rejects(
            () => harness.read.parseVault([buf]),
            /InvalidVaultDataLength|reverted/i,
            "parse_vault should reject buffers smaller than VAULT_MIN_LEN"
        );
    });
});
