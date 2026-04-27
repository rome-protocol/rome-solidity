import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * Golden-vector tests for AccountMetaBuilder.
 *
 * Covers:
 *   - alloc(0).build() — empty array.
 *   - signer / writable / readonly / signerWritable flag semantics.
 *   - Overrun reverts with InvalidAccountCount.
 *   - Underfill + build() returns sub-sliced array.
 *   - Underfill + buildChecked() reverts.
 */

const K1 = ("0x" + "aa".repeat(32)) as `0x${string}`;
const K2 = ("0x" + "bb".repeat(32)) as `0x${string}`;
const K3 = ("0x" + "cc".repeat(32)) as `0x${string}`;

describe("AccountMetaBuilder", () => {
    let wrapper: any;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        wrapper = await viem.deployContract("AccountMetaBuilderWrapper", []);
    });

    it("alloc(0).build() returns empty array", async () => {
        const result: any[] = (await wrapper.read.emptyBuild([0n])) as any;
        assert.equal(result.length, 0);
    });

    it("signer / writable / readonly flags are correct", async () => {
        const result: any[] = (await wrapper.read.signerThenWritableThenReadonly([
            K1,
            K2,
            K3,
        ])) as any;

        assert.equal(result.length, 3);

        assert.equal((result[0].pubkey as string).toLowerCase(), K1);
        assert.equal(result[0].is_signer, true);
        assert.equal(result[0].is_writable, false);

        assert.equal((result[1].pubkey as string).toLowerCase(), K2);
        assert.equal(result[1].is_signer, false);
        assert.equal(result[1].is_writable, true);

        assert.equal((result[2].pubkey as string).toLowerCase(), K3);
        assert.equal(result[2].is_signer, false);
        assert.equal(result[2].is_writable, false);
    });

    it("signerWritable flags both true", async () => {
        const result: any[] = (await wrapper.read.signerWritableOnly([K1])) as any;
        assert.equal(result.length, 1);
        assert.equal(result[0].is_signer, true);
        assert.equal(result[0].is_writable, true);
    });

    it("overrun reverts with InvalidAccountCount", async () => {
        await assert.rejects(
            async () => wrapper.read.overrun([2n, K1]),
            (err: any) => String(err?.message ?? "").includes("InvalidAccountCount"),
        );
    });

    it("alloc(3) with 2 pushes + build() returns 2-element array", async () => {
        // Documented behaviour — adapters use underfill for conditional tails
        // (e.g. Kamino's 0-N refreshReserves append).
        const result: any[] = (await wrapper.read.underfillBuild([K1, K2])) as any;
        assert.equal(result.length, 2);
        assert.equal((result[0].pubkey as string).toLowerCase(), K1);
        assert.equal((result[1].pubkey as string).toLowerCase(), K2);
    });

    it("alloc(3) with 2 pushes + buildChecked() reverts", async () => {
        await assert.rejects(
            async () => wrapper.read.underfillBuildChecked([K1, K2]),
            (err: any) => String(err?.message ?? "").includes("InvalidAccountCount"),
        );
    });
});
