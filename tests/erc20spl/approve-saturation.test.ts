import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// FB-1 regression suite for the saturation + sentinel arithmetic used by
/// `approve`/`allowance` on the SPL-CPI-backed delegate grant. The
/// on-chain SPL CPI roundtrip is out of scope for hardhat-network — this
/// verifies the pure Solidity arithmetic via a mirror helper. The table is
/// the FB-1 spec.
///
/// #511 note: `SPL_ERC20.approve`/`.allowance` (the legacy/direct-CPI
/// wrapper) moved to a plain EVM `uint256` mapping and no longer saturates
/// at u64::max at all — see EvmAllowanceHelper +
/// tests/erc20spl/evm-allowance.test.ts for that contract's current
/// behavior. This arithmetic still describes `SPL_ERC20_cached.approve`/
/// `.allowance` (`erc20spl_cached.sol`), which is still on the pre-#511
/// CPI path pending its own PR.
describe("SPL_ERC20 approve saturation + sentinel arithmetic (FB-1)", function () {
    let helper: any;

    const U64_MAX = (1n << 64n) - 1n;
    const U256_MAX = (1n << 256n) - 1n;
    const U128_MAX = (1n << 128n) - 1n;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        helper = await viem.deployContract("ApproveSaturationHelper", []);
    });

    // ──────────────────────────────────────────────────────────────────
    // saturateApproval — what approve() will store + emit
    // ──────────────────────────────────────────────────────────────────

    describe("saturateApproval", function () {
        it("value=0 — stores 0, emits 0", async function () {
            const [stored, emitted] = await helper.read.saturateApproval([0n]);
            assert.equal(stored, 0n);
            assert.equal(emitted, 0n);
        });

        it("value=1000 — stores 1000, emits 1000", async function () {
            const [stored, emitted] = await helper.read.saturateApproval([1000n]);
            assert.equal(stored, 1000n);
            assert.equal(emitted, 1000n);
        });

        it("value=u64.max - 1 — stores u64.max - 1, emits u64.max - 1 (not saturated)", async function () {
            const v = U64_MAX - 1n;
            const [stored, emitted] = await helper.read.saturateApproval([v]);
            assert.equal(stored, v);
            assert.equal(emitted, v);
        });

        it("value=u64.max — stores u64.max, emits type(uint256).max (sentinel kicks in at the boundary)", async function () {
            const [stored, emitted] = await helper.read.saturateApproval([U64_MAX]);
            assert.equal(stored, U64_MAX);
            assert.equal(emitted, U256_MAX);
        });

        it("value=u64.max + 1 — stores u64.max (saturated), emits type(uint256).max", async function () {
            const [stored, emitted] = await helper.read.saturateApproval([U64_MAX + 1n]);
            assert.equal(stored, U64_MAX);
            assert.equal(emitted, U256_MAX);
        });

        it("value=u128.max — stores u64.max (saturated), emits type(uint256).max", async function () {
            const [stored, emitted] = await helper.read.saturateApproval([U128_MAX]);
            assert.equal(stored, U64_MAX);
            assert.equal(emitted, U256_MAX);
        });

        it("value=type(uint256).max — stores u64.max (saturated), emits type(uint256).max", async function () {
            const [stored, emitted] = await helper.read.saturateApproval([U256_MAX]);
            assert.equal(stored, U64_MAX);
            assert.equal(emitted, U256_MAX);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // readAllowance — what allowance() reads back from u64 storage
    // ──────────────────────────────────────────────────────────────────

    describe("readAllowance", function () {
        it("delegated=0 — reads 0", async function () {
            const result = await helper.read.readAllowance([0n]);
            assert.equal(result, 0n);
        });

        it("delegated=1000 — reads 1000", async function () {
            const result = await helper.read.readAllowance([1000n]);
            assert.equal(result, 1000n);
        });

        it("delegated=u64.max - 1 — reads u64.max - 1 (no sentinel)", async function () {
            const v = U64_MAX - 1n;
            const result = await helper.read.readAllowance([v]);
            assert.equal(result, v);
        });

        it("delegated=u64.max — reads type(uint256).max (infinite-approval sentinel)", async function () {
            const result = await helper.read.readAllowance([U64_MAX]);
            assert.equal(result, U256_MAX);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // Round-trip: approve(value) → readAllowance(stored) must match the
    // event payload that approve() emits. This is the key invariant —
    // event/state divergence is the FB-1 bug we're fixing.
    // ──────────────────────────────────────────────────────────────────

    describe("emitted == readAllowance(stored) round-trip invariant", function () {
        const inputs: Array<{ label: string; value: bigint }> = [
            { label: "0", value: 0n },
            { label: "1000", value: 1000n },
            { label: "u64.max - 1", value: U64_MAX - 1n },
            { label: "u64.max", value: U64_MAX },
            { label: "u64.max + 1", value: U64_MAX + 1n },
            { label: "u128.max", value: U128_MAX },
            { label: "type(uint256).max", value: U256_MAX },
        ];

        for (const { label, value } of inputs) {
            it(`value=${label} — emitted matches allowance readback`, async function () {
                const [stored, emitted] = await helper.read.saturateApproval([value]);
                const readback = await helper.read.readAllowance([stored]);
                assert.equal(readback, emitted);
            });
        }
    });
});
