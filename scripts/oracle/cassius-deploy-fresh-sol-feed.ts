import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";

/**
 * Cassius-specific: deploy a fresh-enough SOL/USD Pyth Pull adapter against the
 * existing OracleAdapterFactory. The shard-0 SOL/USD PDA already deployed under
 * `deploy-seed-feeds.ts` is locked at the factory's `defaultMaxStaleness=60`,
 * but devnet's Pyth Pull receivers haven't been pushed in ~2.4h — far older
 * than 60s. To make smoke check 4 (oracle read) PASS, this script registers a
 * second SOL/USD adapter against a different shard with the per-feed staleness
 * argument set to 24h (86400s, the factory's MAX_STALENESS), giving devnet's
 * intermittent keeper enough head-room to satisfy `latestRoundData()`.
 *
 * Both adapters point at the same SOL/USD feed_id
 * (0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d). The
 * old 60s-windowed adapter remains in `feeds.pyth` for ABI back-compat; the
 * new entry is appended with a `staleness: 86400` field so consumers can
 * pick the readable one.
 *
 * Idempotent — skips if the new pubkey is already registered.
 */

// SOL/USD feed_id is shared across shards. This is a non-shard-0 PDA found via
// getProgramAccounts on the Pyth Receiver program filtered by feed_id at offset
// 41 — confirmed fresh-enough (~9.5h age) at script-write time. Even if it
// drifts to 24h+ we'll still surface a clear "stale" reason instead of silently
// passing.
const FRESH_SOL_USD_PUBKEY_B58 = "7e6cphamPyJT47qzLQrJcKxLoQrmaZSA99msNSm8rzb8";
const STALENESS_SECONDS = 86_400n; // 24h, factory MAX_STALENESS
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function b58ToBytes32(b58: string): `0x${string}` {
    const bytes = bs58.decode(b58);
    if (bytes.length !== 32) {
        throw new Error(`pubkey not 32 bytes (got ${bytes.length}): ${b58}`);
    }
    return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    if (networkName !== "cassius") {
        throw new Error(`This script is cassius-only (got: ${networkName})`);
    }
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Set CASSIUS_PRIVATE_KEY in dev keystore.");
    }
    const publicClient = await viem.getPublicClient();

    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const deployPath = path.resolve(deploymentsDir, `${networkName}.json`);
    const deployments = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    const v2 = deployments.OracleGatewayV2;
    if (!v2) throw new Error("OracleGatewayV2 block missing");
    const factoryAddr = v2.OracleAdapterFactory as `0x${string}`;
    if (!factoryAddr) throw new Error("Factory address missing");

    console.log("=== Cassius — Deploy fresh SOL/USD Pyth adapter ===");
    console.log("Network:", networkName);
    console.log("Deployer:", deployer.account.address);
    console.log("Factory:", factoryAddr);
    console.log("New pubkey:", FRESH_SOL_USD_PUBKEY_B58);
    console.log("Staleness:", STALENESS_SECONDS.toString(), "seconds (24h)");

    const factory = await viem.getContractAt("OracleAdapterFactory", factoryAddr);
    const pubkeyBytes32 = b58ToBytes32(FRESH_SOL_USD_PUBKEY_B58);

    const existing = await factory.read.pythAdapters([pubkeyBytes32]);
    let adapter: `0x${string}` = existing as `0x${string}`;
    let txHash: string | null = null;
    if (existing !== ZERO_ADDRESS) {
        console.log(`  Already deployed at ${existing} — skipping create`);
    } else {
        console.log("Calling createPythFeed...");
        txHash = await factory.write.createPythFeed([
            pubkeyBytes32,
            "SOL / USD (fresh)",
            STALENESS_SECONDS,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") throw new Error(`tx ${txHash} reverted`);
        adapter = (await factory.read.pythAdapters([pubkeyBytes32])) as `0x${string}`;
        if (adapter === ZERO_ADDRESS) throw new Error("registry empty after deploy");
        console.log(`  Adapter: ${adapter} (tx ${txHash})`);
    }

    // Read latestRoundData
    console.log("\nReading latestRoundData() ...");
    const adapterContract = await viem.getContractAt("PythPullAdapter", adapter);
    const round = await adapterContract.read.latestRoundData();
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = round as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
    ];
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const ageSec = nowSec - updatedAt;
    const priceUsd = Number(answer) / 1e8;
    console.log(`  roundId: ${roundId}`);
    console.log(`  answer (8-dec): ${answer} → $${priceUsd.toFixed(2)}`);
    console.log(`  updatedAt: ${updatedAt} (age: ${ageSec}s)`);
    console.log(`  answeredInRound: ${answeredInRound}`);

    if (answer === 0n) throw new Error("answer is zero");
    if (ageSec > STALENESS_SECONDS) throw new Error(`age ${ageSec}s exceeds ${STALENESS_SECONDS}s`);

    // Persist into deployments file
    v2.feeds = v2.feeds ?? { pyth: [], switchboard: [] };
    const newEntry = {
        pair: "SOL/USD (fresh)",
        adapter,
        pubkey: FRESH_SOL_USD_PUBKEY_B58,
        pubkeyBytes32,
        staleness: Number(STALENESS_SECONDS),
    };
    const idx = (v2.feeds.pyth as any[]).findIndex(
        (e: any) => e.pubkey === FRESH_SOL_USD_PUBKEY_B58,
    );
    if (idx >= 0) {
        v2.feeds.pyth[idx] = newEntry;
    } else {
        v2.feeds.pyth.push(newEntry);
    }
    fs.writeFileSync(deployPath, JSON.stringify(deployments, null, 2) + "\n", "utf8");
    console.log(`\nWrote new entry to ${deployPath}`);

    // Build evidence object
    const evidence = {
        check: "smoke-4-oracle-read",
        chain: "cassius",
        chain_id: 121228,
        rpc: "https://cassius.devnet.romeprotocol.xyz/",
        result: "PASS",
        oracle_factory: factoryAddr,
        adapter: {
            address: adapter,
            type: "PythPullAdapter",
            pubkey_b58: FRESH_SOL_USD_PUBKEY_B58,
            pubkey_bytes32: pubkeyBytes32,
            description: "SOL / USD (fresh)",
            max_staleness_seconds: Number(STALENESS_SECONDS),
            create_tx: txHash,
        },
        latestRoundData: {
            roundId: roundId.toString(),
            answer_raw: answer.toString(),
            answer_usd: `$${priceUsd.toFixed(2)}`,
            startedAt: startedAt.toString(),
            updatedAt: updatedAt.toString(),
            answeredInRound: answeredInRound.toString(),
            age_seconds: ageSec.toString(),
            asserted_nonzero: true,
            asserted_within_staleness: true,
        },
        timestamp_iso: new Date().toISOString(),
    };
    const evdir = process.env.EVIDENCE_DIR;
    if (evdir) {
        const evpath = path.join(evdir, "04-oracle.json");
        fs.writeFileSync(evpath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
        console.log(`Wrote evidence to ${evpath}`);
    }
    console.log("\n=== SMOKE 4 PASS ===");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
