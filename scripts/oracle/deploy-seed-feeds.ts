import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";

/**
 * Deploy seed Pyth Pull + Switchboard V3 adapters against the deployed
 * OracleAdapterFactory.
 *
 * REQUIRES: `deploy-v2-polish.ts` has been run first so
 * `deployments/<network>.json` contains the `OracleGatewayV2` block
 * (PythPullAdapterImpl / SwitchboardV3AdapterImpl / OracleAdapterFactory).
 *
 * Writes the resulting adapter addresses back into the `feeds.pyth` /
 * `feeds.switchboard` arrays under `OracleGatewayV2`. Idempotent:
 * pubkeys already registered in the factory's `pythAdapters` /
 * `switchboardAdapters` mappings are skipped.
 *
 * Usage:
 *   npx hardhat run scripts/oracle/deploy-seed-feeds.ts --network monti_spl
 */

type SeedFeed = {
    pair: string;
    pubkeyBase58: string;
    description: string;
    staleness?: number;
};

// Pyth Pull receiver PDAs on Solana devnet (shard_id=0, owner=pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT).
// Verify each via `scripts/oracle/check-account-owner.ts` before running.
const PYTH_SEEDS: SeedFeed[] = [
    {
        pair: "SOL/USD",
        pubkeyBase58: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
        description: "SOL / USD",
    },
    {
        pair: "BTC/USD",
        pubkeyBase58: "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
        description: "BTC / USD",
    },
    {
        pair: "ETH/USD",
        pubkeyBase58: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC",
        description: "ETH / USD",
    },
    {
        pair: "USDC/USD",
        pubkeyBase58: "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
        description: "USDC / USD",
    },
    {
        pair: "USDT/USD",
        pubkeyBase58: "HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM",
        description: "USDT / USD",
    },
    {
        pair: "JUP/USD",
        pubkeyBase58: "2F9M59yYX6F4eHxWNCbvSGiZxRw6CcmpNqf9HsN7jC5o",
        description: "JUP / USD",
    },
    {
        pair: "JTO/USD",
        pubkeyBase58: "D8UUgr8a3aR3yUeHLu7v8FWK7E1FADA92Hmj8CeuSrvs",
        description: "JTO / USD",
    },
];

const SWITCHBOARD_SEEDS: SeedFeed[] = [
    {
        pair: "SOL/USD",
        pubkeyBase58: "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR",
        description: "SOL / USD (Switchboard)",
    },
    // BTC, ETH contingent on reliable Switchboard devnet feeds — verify
    // via `scripts/oracle/check-switchboard.ts` before adding.
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function b58ToBytes32(b58: string): `0x${string}` {
    const bytes = bs58.decode(b58);
    if (bytes.length !== 32) {
        throw new Error(
            `pubkey not 32 bytes (got ${bytes.length}): ${b58}`,
        );
    }
    return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

type DeployResult = {
    pair: string;
    adapter: `0x${string}`;
    pubkey: string;
    pubkeyBytes32: `0x${string}`;
    skipped: boolean;
};

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error(
            "No deployer wallet found. Configure a funded account for this network.",
        );
    }
    const publicClient = await viem.getPublicClient();

    // Read the deployments artifact for this network and pull the V2 block.
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const deployPath = path.resolve(deploymentsDir, `${networkName}.json`);
    if (!fs.existsSync(deployPath)) {
        throw new Error(
            `Deployments file missing: ${deployPath}. Run deploy-v2-polish.ts first.`,
        );
    }
    const deployments = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    const v2 = deployments.OracleGatewayV2;
    if (!v2) {
        throw new Error(
            "OracleGatewayV2 block missing — run deploy-v2-polish.ts first.",
        );
    }
    const factoryAddr = v2.OracleAdapterFactory as `0x${string}`;
    if (!factoryAddr) {
        throw new Error(
            "OracleGatewayV2.OracleAdapterFactory address missing.",
        );
    }

    console.log("=== Oracle Gateway V2 — Seed Feed Deployment ===");
    console.log("Network:", networkName);
    console.log("Deployer:", deployer.account.address);
    console.log("Factory:", factoryAddr);
    console.log();

    const factory = await viem.getContractAt(
        "OracleAdapterFactory",
        factoryAddr,
    );

    async function deployPythSeed(seed: SeedFeed): Promise<DeployResult> {
        const pubkeyBytes32 = b58ToBytes32(seed.pubkeyBase58);
        const staleness = BigInt(seed.staleness ?? 0);

        const existing = await factory.read.pythAdapters([pubkeyBytes32]);
        if (existing !== ZERO_ADDRESS) {
            console.log(
                `  pyth ${seed.pair} already deployed at ${existing} — skipping`,
            );
            return {
                pair: seed.pair,
                adapter: existing,
                pubkey: seed.pubkeyBase58,
                pubkeyBytes32,
                skipped: true,
            };
        }

        console.log(
            `Deploying pyth ${seed.pair} (${seed.pubkeyBase58})...`,
        );
        const txHash = await factory.write.createPythFeed([
            pubkeyBytes32,
            seed.description,
            staleness,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
        });
        if (receipt.status !== "success") {
            throw new Error(
                `tx ${txHash} reverted (status=${receipt.status})`,
            );
        }

        // Re-read the registry post-confirmation. Avoids abi-dependent event
        // decoding and matches the idempotency check above.
        const adapter = await factory.read.pythAdapters([pubkeyBytes32]);
        if (adapter === ZERO_ADDRESS) {
            throw new Error(
                `registry empty after deploy of ${seed.pair} — tx ${txHash}`,
            );
        }
        console.log(`  -> ${adapter} (tx ${txHash})`);
        return {
            pair: seed.pair,
            adapter,
            pubkey: seed.pubkeyBase58,
            pubkeyBytes32,
            skipped: false,
        };
    }

    async function deploySwitchboardSeed(
        seed: SeedFeed,
    ): Promise<DeployResult> {
        const pubkeyBytes32 = b58ToBytes32(seed.pubkeyBase58);
        const staleness = BigInt(seed.staleness ?? 0);

        const existing = await factory.read.switchboardAdapters([pubkeyBytes32]);
        if (existing !== ZERO_ADDRESS) {
            console.log(
                `  switchboard ${seed.pair} already deployed at ${existing} — skipping`,
            );
            return {
                pair: seed.pair,
                adapter: existing,
                pubkey: seed.pubkeyBase58,
                pubkeyBytes32,
                skipped: true,
            };
        }

        console.log(
            `Deploying switchboard ${seed.pair} (${seed.pubkeyBase58})...`,
        );
        const txHash = await factory.write.createSwitchboardFeed([
            pubkeyBytes32,
            seed.description,
            staleness,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
        });
        if (receipt.status !== "success") {
            throw new Error(
                `tx ${txHash} reverted (status=${receipt.status})`,
            );
        }

        const adapter = await factory.read.switchboardAdapters([pubkeyBytes32]);
        if (adapter === ZERO_ADDRESS) {
            throw new Error(
                `registry empty after deploy of ${seed.pair} — tx ${txHash}`,
            );
        }
        console.log(`  -> ${adapter} (tx ${txHash})`);
        return {
            pair: seed.pair,
            adapter,
            pubkey: seed.pubkeyBase58,
            pubkeyBytes32,
            skipped: false,
        };
    }

    // ─── Pyth ───
    console.log("=== Deploying Pyth seed feeds ===");
    const pythResults: DeployResult[] = [];
    for (const seed of PYTH_SEEDS) {
        try {
            pythResults.push(await deployPythSeed(seed));
        } catch (e: any) {
            console.error(
                `  FAILED pyth ${seed.pair}: ${e?.cause?.reason ?? e?.message ?? e}`,
            );
        }
    }

    // ─── Switchboard ───
    console.log("\n=== Deploying Switchboard seed feeds ===");
    const sbResults: DeployResult[] = [];
    for (const seed of SWITCHBOARD_SEEDS) {
        try {
            sbResults.push(await deploySwitchboardSeed(seed));
        } catch (e: any) {
            console.error(
                `  FAILED switchboard ${seed.pair}: ${e?.cause?.reason ?? e?.message ?? e}`,
            );
        }
    }

    // ─── Persist ───
    v2.feeds = {
        pyth: pythResults.map(({ pair, adapter, pubkey, pubkeyBytes32 }) => ({
            pair,
            adapter,
            pubkey,
            pubkeyBytes32,
        })),
        switchboard: sbResults.map(
            ({ pair, adapter, pubkey, pubkeyBytes32 }) => ({
                pair,
                adapter,
                pubkey,
                pubkeyBytes32,
            }),
        ),
    };
    fs.writeFileSync(
        deployPath,
        JSON.stringify(deployments, null, 2) + "\n",
        "utf8",
    );

    const pythDeployed = pythResults.filter((r) => !r.skipped).length;
    const pythSkipped = pythResults.filter((r) => r.skipped).length;
    const sbDeployed = sbResults.filter((r) => !r.skipped).length;
    const sbSkipped = sbResults.filter((r) => r.skipped).length;

    console.log();
    console.log("=== Summary ===");
    console.log(
        `Pyth:        ${pythDeployed} deployed, ${pythSkipped} skipped, ${PYTH_SEEDS.length - pythResults.length} failed`,
    );
    console.log(
        `Switchboard: ${sbDeployed} deployed, ${sbSkipped} skipped, ${SWITCHBOARD_SEEDS.length - sbResults.length} failed`,
    );
    console.log(
        `Wrote ${pythResults.length} Pyth + ${sbResults.length} Switchboard entries to ${deployPath}`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
