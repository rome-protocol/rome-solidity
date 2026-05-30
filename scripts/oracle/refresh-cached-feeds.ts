import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Keeper: refresh every OG-V2 cached adapter on a chain so its SLOAD cache stays
 * within maxStaleness. Cron this at an interval < the feeds' maxStaleness
 * (default 3600s) — without it, `latestRoundData()` reverts `StalePriceFeed` and
 * any consumer read/borrow reverts. See contracts/oracle/CACHED_FEEDS.md.
 *
 * Adapter list, in precedence order (parameterized — no hardcoded addresses):
 *   1. CACHED_FEEDS env — comma-separated adapter addresses (ad-hoc, or chains
 *      whose cached feeds aren't yet recorded in the deployments file).
 *   2. deployments/<network>.json OracleGatewayV2.feeds.cachedPyth + .cachedFeed
 *      (written by deploy-seed-feeds.ts).
 *
 * Usage:
 *   npx hardhat run scripts/oracle/refresh-cached-feeds.ts --network <chain>
 *   CACHED_FEEDS=0x..,0x.. npx hardhat run scripts/oracle/refresh-cached-feeds.ts --network <chain>
 */

const REFRESH_GAS = 80_000_000n;

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }
    const publicClient = await viem.getPublicClient();

    let feeds: string[] = [];
    const envList = (process.env.CACHED_FEEDS ?? "").trim();
    if (envList) {
        feeds = envList.split(",").map((s) => s.trim()).filter(Boolean);
        console.log(`Source: CACHED_FEEDS env (${feeds.length} feed(s))`);
    } else {
        const deployPath = path.resolve(process.cwd(), "deployments", `${networkName}.json`);
        if (fs.existsSync(deployPath)) {
            const og = JSON.parse(fs.readFileSync(deployPath, "utf8")).OracleGatewayV2;
            const adapters = (arr: Array<{ adapter: string }> | undefined) => (arr ?? []).map((f) => f.adapter);
            feeds = [...adapters(og?.feeds?.cachedPyth), ...adapters(og?.feeds?.cachedFeed)];
            console.log(`Source: deployments/${networkName}.json feeds.cachedPyth + .cachedFeed (${feeds.length} feed(s))`);
        }
    }
    if (feeds.length === 0) {
        throw new Error(
            "No cached feeds found. Set CACHED_FEEDS=0x..,0x.. or run deploy-seed-feeds.ts first.",
        );
    }

    console.log(`=== Refreshing ${feeds.length} cached feed(s) on ${networkName} ===`);
    let ok = 0;
    let fail = 0;
    for (const addr of feeds) {
        try {
            // Any cached adapter (CachedPythAdapter / CachedFeedAdapter) exposes refresh();
            // the CachedPythAdapter ABI supplies the selector for both.
            const c = await viem.getContractAt("CachedPythAdapter", addr as `0x${string}`);
            const tx = await c.write.refresh([], { gas: REFRESH_GAS });
            const r = await publicClient.waitForTransactionReceipt({ hash: tx });
            if (r.status === "success") {
                console.log(`  ✓ ${addr}`);
                ok++;
            } else {
                console.error(`  ✗ ${addr} (status=${r.status})`);
                fail++;
            }
        } catch (e: any) {
            console.error(`  ✗ ${addr}: ${e?.cause?.reason ?? e?.message ?? e}`);
            fail++;
        }
    }
    console.log(`=== ${ok} refreshed, ${fail} failed ===`);
    if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
