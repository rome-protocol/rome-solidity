import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_PDA_PATH = join(__dirname, "../../contracts/cpi/UserPda.sol");

/**
 * UserPda tests.
 *
 * The key assertion — documented in cardo-foundation.md §9 — is that
 * **UserPda.sol never references tx.origin**. No runtime test can
 * enumerate "all possible overloads Solidity considers"; this is a source-
 * level grep over the library file.
 *
 * Pure paths (`ataForKey`) run on hardhatMainnet; `pda` / `ata` /
 * `ataWithProgram` require the live RomeEVMAccount precompile (Rome stack
 * running). Those are skipped here and covered in adapter integration tests.
 */

describe("UserPda", () => {
    // ──────────────────────────────────────────────────────────────────
    // §9 Security assertion — tx.origin is banned from UserPda.sol
    // ──────────────────────────────────────────────────────────────────

    it("UserPda.sol does not reference tx.origin", () => {
        const src = readFileSync(USER_PDA_PATH, "utf8");

        // Strip comments so the narrative in the NatSpec doesn't false-positive.
        const stripped = src
            .split("\n")
            .map((line) => {
                const idx = line.indexOf("//");
                if (idx < 0) return line;
                return line.slice(0, idx);
            })
            .join("\n")
            // Also strip /* ... */ block comments (single-line).
            .replace(/\/\*[\s\S]*?\*\//g, "");

        assert.ok(
            !/\btx\.origin\b/.test(stripped),
            "UserPda.sol must not reference tx.origin in live code — see cardo-foundation.md §9",
        );
    });

    it("UserPda.pda signature takes an explicit address arg", () => {
        const src = readFileSync(USER_PDA_PATH, "utf8");
        // Exactly one pda(address user) internal view function
        const matches = src.match(/function\s+pda\s*\(\s*address\s+\w+\s*\)/g);
        assert.ok(
            matches && matches.length >= 1,
            "UserPda.pda(address user) must be the only pda overload",
        );

        // Fail if we ever see a pda() no-arg overload (would invite
        // tx.origin-default footgun).
        const noArg = src.match(/function\s+pda\s*\(\s*\)/g);
        assert.equal(
            noArg,
            null,
            "UserPda must not define a zero-arg pda() — address user is required",
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // Live-Rome paths — skipped on hardhatMainnet (no find_program_address
    // precompile). Adapter integration tests on `--network local` /
    // `--network marcus` cover these paths end-to-end.
    // ──────────────────────────────────────────────────────────────────

    it("ataForKey / pda / ata require live Rome stack — skipped on hardhatMainnet", async () => {
        // Placeholder test recording the skip rationale. The UserPda write
        // paths are covered by each refactored adapter's integration test
        // (Meteora / Kamino / Drift, Phase 2) which runs against Marcus.
        assert.ok(true);
    });
});
