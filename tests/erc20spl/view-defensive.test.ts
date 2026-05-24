import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// FB-2 regression suite for the defensive-guard arithmetic used by the
/// SPL_ERC20 view methods `allowance` and `totalSupply`. The on-chain SPL
/// CPI roundtrips that read the SPL Mint + TokenAccount account buffers
/// cannot run on hardhat-network — this verifies the predicate + early-exit
/// arithmetic via a mirror helper contract, identical in shape to FB-1's
/// `ApproveSaturationHelper`.
///
/// The contract-level arithmetic is the new behavior we're locking in:
///   FB-2a: when the spender has never been registered in the wrapper's
///          ERC20Users mapping, allowance must derive the spender's
///          unified PDA via HelperProgram.pda(spender) instead of
///          reverting via _users.get_user. Comparison against the on-chain
///          delegate field then resolves to "no match" → returns 0.
///   FB-2b: when the owner has no ATA yet for this wrapper's mint, the
///          ATA-read path is skipped and allowance returns 0 (matches
///          ERC-20 spec: never revert on a missing/empty pair).
///   FB-2c: when the SPL mint account itself is uninitialized, totalSupply
///          returns 0 instead of reverting via the underlying u64 read.
///
/// The harness uses `account_lamports(account) > 0` as the existence
/// probe — the same pattern balanceOf shipped (post-0acabea) for symmetric
/// behavior across the three view methods.
describe("SPL_ERC20 view-method defensive guards (FB-2)", function () {
    let helper: any;

    const U64_MAX = (1n << 64n) - 1n;

    // Stand-in values for tests; the helper doesn't actually read on-chain.
    const FAKE_SPENDER_PDA = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const FAKE_OTHER_PDA = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

    before(async function () {
        const { viem } = await hardhat.network.connect();
        helper = await viem.deployContract("ViewDefensiveHelper", []);
    });

    // ──────────────────────────────────────────────────────────────────
    // FB-2a — allowance with unregistered spender
    //
    // Pre-fix: `_users.get_user(spender)` reverts "User does not exist"
    // when the spender has never been registered via `ensure_user`.
    // Post-fix: we use `HelperProgram.pda(spender)` instead — never
    // reverts; same PDA derivation. When the on-chain delegate field
    // does not match the spender's PDA, allowance returns 0.
    // ──────────────────────────────────────────────────────────────────

    describe("FB-2a — tryReadAllowance with unregistered spender", function () {
        it("returns 0 when owner ATA exists but on-chain delegate does not match", async function () {
            // Owner has tokens (ATA exists, lamports > 0). On-chain
            // delegate is unset (is_some = false). Spender PDA from
            // HelperProgram.pda is FAKE_SPENDER_PDA. No match → 0.
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 12345n,
                /* delegateIsSome */ false,
                /* storedDelegate */ ZERO_BYTES32,
                /* spenderPda */ FAKE_SPENDER_PDA,
                /* delegatedAmount */ 0n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns 0 when delegate is some-but-different from spender PDA", async function () {
            // Owner approved someone else; allowance(owner, our spender)
            // must return 0 since our spender's PDA differs from the
            // recorded delegate.
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 12345n,
                /* delegateIsSome */ true,
                /* storedDelegate */ FAKE_OTHER_PDA,
                /* spenderPda */ FAKE_SPENDER_PDA,
                /* delegatedAmount */ 999n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns the delegated amount when on-chain delegate matches spender PDA", async function () {
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 12345n,
                /* delegateIsSome */ true,
                /* storedDelegate */ FAKE_SPENDER_PDA,
                /* spenderPda */ FAKE_SPENDER_PDA,
                /* delegatedAmount */ 1000n,
            ]);
            assert.equal(result, 1000n);
        });

        it("returns the raw u64 value at the upper bound (FB-2 scope; FB-1 PR #160 adds the MaxUint256 sentinel separately)", async function () {
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 12345n,
                /* delegateIsSome */ true,
                /* storedDelegate */ FAKE_SPENDER_PDA,
                /* spenderPda */ FAKE_SPENDER_PDA,
                /* delegatedAmount */ U64_MAX,
            ]);
            assert.equal(result, U64_MAX);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // FB-2b — allowance with owner's ATA missing
    //
    // Pre-fix: `AccountReader.readBytesAt(ata, 72, 36)` reverts
    // "account_data_at: range 72..108 out of 0 bytes" when the owner's
    // ATA is uninitialized.
    // Post-fix: gate the readBytesAt behind a lamports>0 probe; return
    // 0 when the ATA has no balance / no allocation.
    // ──────────────────────────────────────────────────────────────────

    describe("FB-2b — tryReadAllowance with owner's ATA missing", function () {
        it("returns 0 when ataLamports == 0 regardless of remaining inputs", async function () {
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 0n,
                /* delegateIsSome */ true,
                /* storedDelegate */ FAKE_SPENDER_PDA,
                /* spenderPda */ FAKE_SPENDER_PDA,
                /* delegatedAmount */ 1000n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns 0 when ataLamports == 0 even if all other inputs match", async function () {
            // The early-exit MUST fire BEFORE the delegate comparison.
            // If it didn't, on a missing ATA the bytes32 read would
            // revert on the real contract.
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 0n,
                /* delegateIsSome */ false,
                /* storedDelegate */ ZERO_BYTES32,
                /* spenderPda */ ZERO_BYTES32,
                /* delegatedAmount */ 0n,
            ]);
            assert.equal(result, 0n);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // FB-2c — totalSupply with uninitialized mint
    //
    // Pre-fix: `AccountReader.readU64At(mint_id, 36)` reverts when the
    // SPL Mint account has 0 bytes of data.
    // Post-fix: gate the u64 read behind a lamports>0 probe.
    // ──────────────────────────────────────────────────────────────────

    describe("FB-2c — tryReadTotalSupply with uninitialized mint", function () {
        it("returns 0 when mint account does not exist (lamports == 0)", async function () {
            const result = await helper.read.tryReadTotalSupply([
                /* mintLamports */ 0n,
                /* onChainSupply */ 1_000_000n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns the on-chain supply when mint exists", async function () {
            const result = await helper.read.tryReadTotalSupply([
                /* mintLamports */ 5000000n,
                /* onChainSupply */ 1_000_000n,
            ]);
            assert.equal(result, 1_000_000n);
        });

        it("returns 0 when mint exists but supply is 0 (uncirculated)", async function () {
            const result = await helper.read.tryReadTotalSupply([
                /* mintLamports */ 5000000n,
                /* onChainSupply */ 0n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns u64.max supply faithfully (no sentinel — totalSupply is not allowance)", async function () {
            const result = await helper.read.tryReadTotalSupply([
                /* mintLamports */ 5000000n,
                /* onChainSupply */ U64_MAX,
            ]);
            assert.equal(result, U64_MAX);
        });
    });

    // FB-2d — balanceOf returns 0 (not revert) on uninitialized ATA.

    describe("FB-2d — tryReadBalanceOf with uninitialized ATA", function () {
        it("returns 0 when ataLamports == 0 (fresh wallet / fresh pool probe)", async function () {
            const result = await helper.read.tryReadBalanceOf([
                /* ataLamports */ 0n,
                /* onChainBalance */ 0n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns 0 even when on-chain balance would be nonzero (ATA missing wins early-exit)", async function () {
            // Pathological / unreachable in practice (ATA can't have a
            // balance without existing) — but the early-exit MUST fire
            // before reading the cached account, mirroring the pattern
            // used by tryReadAllowance / tryReadTotalSupply.
            const result = await helper.read.tryReadBalanceOf([
                /* ataLamports */ 0n,
                /* onChainBalance */ 1_234_567n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns the on-chain balance when ATA exists", async function () {
            const result = await helper.read.tryReadBalanceOf([
                /* ataLamports */ 5_000_000n,
                /* onChainBalance */ 1_234_567n,
            ]);
            assert.equal(result, 1_234_567n);
        });

        it("returns 0 when ATA exists but balance is 0 (empty wrapper holder)", async function () {
            const result = await helper.read.tryReadBalanceOf([
                /* ataLamports */ 5_000_000n,
                /* onChainBalance */ 0n,
            ]);
            assert.equal(result, 0n);
        });

        it("returns u64.max balance faithfully (no sentinel — balanceOf is not allowance)", async function () {
            const result = await helper.read.tryReadBalanceOf([
                /* ataLamports */ 5_000_000n,
                /* onChainBalance */ U64_MAX,
            ]);
            assert.equal(result, U64_MAX);
        });
    });

    // FB-2e — approve auto-creates owner ATA when missing.

    describe("FB-2e — approve auto-creates owner ATA when missing (ownerNeedsAta predicate)", function () {
        it("returns true when ownerAtaLamports == 0 (ATA missing, must create before SPL approve)", async function () {
            const result = await helper.read.ownerNeedsAta([0n]);
            assert.equal(result, true);
        });

        it("returns false when ownerAtaLamports > 0 (ATA exists, skip the ensure call)", async function () {
            const result = await helper.read.ownerNeedsAta([1n]);
            assert.equal(result, false);
        });

        it("returns false for any positive lamports value (common case — user already has ATA)", async function () {
            const result = await helper.read.ownerNeedsAta([2_039_280n]);  // rent-exempt floor
            assert.equal(result, false);
        });

        it("returns false at u64.max lamports (no overflow / off-by-one)", async function () {
            const result = await helper.read.ownerNeedsAta([U64_MAX]);
            assert.equal(result, false);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // ERC-20 spec invariant: view methods never revert on missing pairs
    // ──────────────────────────────────────────────────────────────────

    describe("ERC-20 spec invariant — never revert on missing state", function () {
        it("allowance returns 0 for all-zero / unregistered inputs (fresh wallet probe)", async function () {
            // Fresh wallet on a fresh wrapper: owner has no ATA, no
            // delegate has ever been written, spender PDA is some
            // derived value. The whole path resolves to 0.
            const result = await helper.read.tryReadAllowance([
                /* ataLamports */ 0n,
                /* delegateIsSome */ false,
                /* storedDelegate */ ZERO_BYTES32,
                /* spenderPda */ FAKE_SPENDER_PDA,
                /* delegatedAmount */ 0n,
            ]);
            assert.equal(result, 0n);
        });

        it("totalSupply returns 0 on a wrapper pointing at an uninitialized mint", async function () {
            const result = await helper.read.tryReadTotalSupply([
                /* mintLamports */ 0n,
                /* onChainSupply */ 0n,
            ]);
            assert.equal(result, 0n);
        });

        it("balanceOf returns 0 on a fresh address (no ATA yet) — unblocks canonical Uniswap V3 pool.mint and the equivalent flow on V2/Aave/Compound/V4", async function () {
            const result = await helper.read.tryReadBalanceOf([
                /* ataLamports */ 0n,
                /* onChainBalance */ 0n,
            ]);
            assert.equal(result, 0n);
        });
    });
});
