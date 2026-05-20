import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * PythLazerCache.setMaxStaleness — owner-gated admin update.
 *
 * The cache exposes a `setMaxStaleness` admin function so the foundation can
 * tighten or loosen staleness without redeploying the contract. Auth defers
 * to the OG-V2 factory's `owner()` so admin uses the same multisig as the
 * rest of OG-V2. Mirrors the spec's "no redeploy required for freshness
 * changes" guarantee.
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.2
 *
 * Test plan:
 *  - owner can update; emits MaxStalenessUpdated
 *  - non-owner caller reverts with OnlyFactoryOwner
 *  - out-of-range update reverts with StalenessOutOfRange
 */
describe("PythLazerCache.setMaxStaleness", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    const INIT_STALENESS = 30n;

    async function deployAll() {
        const ownerAccount = accounts[0].account.address;
        const factory = await viem.deployContract("MockAdapterFactoryWithOwner", [
            ownerAccount,
        ]);
        const cache = await viem.deployContract("PythLazerCache", [
            factory.address,
            INIT_STALENESS,
        ]);
        return { factory, cache, ownerAccount };
    }

    it("owner can update maxStaleness", async function () {
        const { cache } = await deployAll();
        const newValue = 60n;
        await cache.write.setMaxStaleness([newValue]);
        const got: bigint = await cache.read.maxStaleness();
        assert.equal(got, newValue);
    });

    it("non-owner caller reverts with OnlyFactoryOwner", async function () {
        const { cache } = await deployAll();
        // Get a contract handle that uses accounts[1] as the wallet —
        // overriding `account` on the call lost ABI info needed to decode
        // the custom error.
        const otherClient = accounts[1];
        const cacheAsOther = await viem.getContractAt(
            "PythLazerCache",
            cache.address,
            { client: { wallet: otherClient } },
        );
        await assert.rejects(
            async () => cacheAsOther.write.setMaxStaleness([60n]),
            (err: any) =>
                err?.message?.includes("OnlyFactoryOwner") ||
                // Selector fallback: keccak256("OnlyFactoryOwner()")[:4]
                err?.message?.includes("0x4bf08e86")
                    ? true
                    : false,
        );
    });

    it("owner update with maxStaleness == 0 reverts with StalenessOutOfRange", async function () {
        const { cache } = await deployAll();
        await assert.rejects(
            async () => cache.write.setMaxStaleness([0n]),
            (err: any) => err?.message?.includes("StalenessOutOfRange") ?? false,
        );
    });

    it("owner update with maxStaleness > 24h reverts with StalenessOutOfRange", async function () {
        const { cache } = await deployAll();
        const over24h = 24n * 60n * 60n + 1n;
        await assert.rejects(
            async () => cache.write.setMaxStaleness([over24h]),
            (err: any) => err?.message?.includes("StalenessOutOfRange") ?? false,
        );
    });

    it("emits MaxStalenessUpdated event with new value", async function () {
        const { cache, ownerAccount } = await deployAll();
        const publicClient = await viem.getPublicClient();
        const txHash = await cache.write.setMaxStaleness([60n]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        // viem-style event parsing — match anonymous topic to known signature
        const events = await cache.getEvents.MaxStalenessUpdated();
        assert.equal(events.length, 1);
        assert.equal(events[0].args.newValue, 60n);
    });
});
