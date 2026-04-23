/**
 * Devnet validation test for CostEstimator.rentForSpace — SKIPPED by default.
 *
 * Per cardo-foundation.md §7 Task 7 step 4.5.
 *
 * Intent:
 *   On Marcus (or any live Rome devnet), trigger creation of one SPL Token
 *   account + one Drift User PDA, read lamports from each via RPC, assert
 *   equality with `rentForSpace(space)`. Catches divergence if Rome ever
 *   customises rent away from the canonical Solana formula.
 *
 * Why skipped:
 *   The creation step requires a funded wallet + a live Rome stack with SPL
 *   and Drift account creation paths set up. That is out-of-scope for the
 *   Phase 1 foundation PR (no adapter deployed yet with the foundation
 *   plumbing). Re-enable once Phase 2 lands:
 *
 *     CARDO_DEVNET_RENT=1 npx hardhat test --network marcus \
 *        tests/cpi/rent.devnet.test.ts
 */

import { describe, it } from "node:test";

const ENABLED = process.env.CARDO_DEVNET_RENT === "1";

describe("CostEstimator.rentForSpace — devnet validation", { skip: !ENABLED }, () => {
    it("canonical rent formula matches live lamport read (SKIPPED until Phase 2)", async () => {
        // Re-enable wiring:
        //   1. Deploy one SPL Token ATA for the test wallet → read lamports.
        //   2. Deploy one Drift User PDA → read lamports.
        //   3. Assert lamports === rentForSpace(space).
        //
        // Pseudocode:
        //   const conn = await hardhat.network.connect();
        //   const { web3Solana } = conn;
        //   const lam = await web3Solana.getMinimumBalanceForRentExemption(165);
        //   assert.equal(lam, 2_039_280n);
        throw new Error("devnet validation scaffold — re-enable in Phase 2");
    });
});
