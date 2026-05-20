import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Oracle Gateway V2 — Lazer extension deployment.
 *
 * Sequence:
 *   1. Read existing deployments/<network>.json to get OracleAdapterFactory.
 *   2. Deploy PythLazerFeedAdapter implementation contract.
 *   3. Deploy PythLazerCache (singleton, scoped to this chain).
 *   4. Wire factory: setLazerImplementations(cache, adapterImpl).
 *   5. Optionally iterate per-feed adapters from a feed-config JSON file.
 *   6. Persist all addresses back to deployments/<network>.json.
 *
 * Usage:
 *   npx hardhat run scripts/oracle/deploy-lazer.ts --network <chain>
 *
 * Env vars:
 *   LAZER_MAX_STALENESS    — chain-wide cache staleness (seconds, default 30)
 *   LAZER_FEEDS_FILE       — optional path to feeds JSON (see schema below).
 *                            When unset, deploys infrastructure only.
 *
 * LAZER_FEEDS_FILE schema (array; one entry per feed adapter to deploy):
 *   [
 *     { "feedId": 1, "description": "BTC / USD", "maxConfBps": 200 },
 *     { "feedId": 2, "description": "ETH / USD", "maxConfBps": 200 },
 *     ...
 *   ]
 *
 * Future: the foundation keeper service reads the canonical feed list
 * from registry/oracles/pyth-lazer.json; this script accepts that same
 * shape via LAZER_FEEDS_FILE so the deploy + keeper share one source.
 */

interface FeedSpec {
    feedId: number;
    description: string;
    maxConfBps: number;
}

async function main() {
    const maxStaleness = Number(process.env.LAZER_MAX_STALENESS ?? "30");
    if (!Number.isInteger(maxStaleness) || maxStaleness < 1 || maxStaleness > 86_400) {
        throw new Error(
            `LAZER_MAX_STALENESS out of range (got ${maxStaleness}; must be 1..86400)`,
        );
    }

    const feedsFile = process.env.LAZER_FEEDS_FILE;
    const feedSpecs: FeedSpec[] = feedsFile
        ? JSON.parse(fs.readFileSync(feedsFile, "utf8"))
        : [];

    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error(
            "No deployer wallet configured. Set <CHAIN>_PRIVATE_KEY via the hardhat keystore.",
        );
    }
    const publicClient = await viem.getPublicClient();

    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `No existing deployments file at ${filePath}. Run scripts/oracle/deploy.ts first to deploy the factory.`,
        );
    }
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // deploy-v2-polish.ts writes the factory address as a flat string
    // (`OracleAdapterFactory: "0xabc..."`); earlier ad-hoc deploys nested it
    // (`OracleAdapterFactory: { address: "0xabc..." }`). Handle both so this
    // script doesn't break against either schema.
    const factoryRaw = content.OracleGatewayV2?.OracleAdapterFactory;
    const factoryAddr: string | undefined =
        typeof factoryRaw === "string" ? factoryRaw : factoryRaw?.address;
    if (!factoryAddr) {
        throw new Error(
            `OracleAdapterFactory address not found in ${filePath}. Run scripts/oracle/deploy.ts first.`,
        );
    }

    console.log("=== Pyth Lazer — OG-V2 Deployment ===");
    console.log("Network:", networkName);
    console.log("Deployer:", deployer.account.address);
    console.log(
        "Balance:",
        (
            await publicClient.getBalance({ address: deployer.account.address })
        ).toString(),
    );
    console.log("OracleAdapterFactory:", factoryAddr);
    console.log("Cache maxStaleness:", maxStaleness, "seconds");
    console.log("Feeds to deploy:", feedSpecs.length);
    console.log();

    // 1. Deploy PythLazerFeedAdapter implementation
    console.log("1/4 Deploying PythLazerFeedAdapter implementation...");
    const lazerImpl = await viem.deployContract("PythLazerFeedAdapter", []);
    console.log("   PythLazerFeedAdapter (impl):", lazerImpl.address);

    // 2. Deploy PythLazerCache (singleton)
    console.log("2/4 Deploying PythLazerCache...");
    const cache = await viem.deployContract("PythLazerCache", [
        factoryAddr as `0x${string}`,
        BigInt(maxStaleness),
    ]);
    console.log("   PythLazerCache:", cache.address);

    // 3. Wire factory
    console.log("3/4 Calling factory.setLazerImplementations...");
    const factory = await viem.getContractAt(
        "OracleAdapterFactory",
        factoryAddr as `0x${string}`,
    );
    const setImplsHash = await factory.write.setLazerImplementations([
        cache.address,
        lazerImpl.address,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: setImplsHash });
    console.log("   ✓ Lazer implementations registered with factory");

    // 4. Iterate per-feed adapters
    console.log(
        `4/4 Deploying ${feedSpecs.length} per-feed adapter(s)...`,
    );
    const feedDeployments: {
        feedId: number;
        description: string;
        adapter: string;
        maxConfBps: number;
    }[] = [];
    for (const spec of feedSpecs) {
        const hash = await factory.write.createLazerFeed([
            spec.feedId,
            spec.description,
            BigInt(spec.maxConfBps),
        ]);
        await publicClient.waitForTransactionReceipt({ hash });
        const adapterAddr = (await factory.read.lazerAdapters([
            spec.feedId,
        ])) as `0x${string}`;
        feedDeployments.push({
            feedId: spec.feedId,
            description: spec.description,
            adapter: adapterAddr,
            maxConfBps: spec.maxConfBps,
        });
        console.log(
            `   ✓ Feed ${spec.feedId} "${spec.description}" @ ${adapterAddr}`,
        );
    }

    console.log();
    console.log("=== Lazer Deployment Complete ===");

    // 5. Persist artifacts
    content.OracleGatewayV2 = content.OracleGatewayV2 ?? {};
    content.OracleGatewayV2.PythLazerFeedAdapter = {
        address: lazerImpl.address,
        type: "implementation",
    };
    content.OracleGatewayV2.PythLazerCache = {
        address: cache.address,
        maxStaleness,
    };
    content.OracleGatewayV2.LazerFeeds = feedDeployments;
    content.OracleGatewayV2.lazerDeployedAt = new Date().toISOString();

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("Saved deployment to:", filePath);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
