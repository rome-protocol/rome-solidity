import hardhat from "hardhat";
import path from "node:path";
import fs from "node:fs";
import { isAddress, getAddress, isHex } from "viem";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function poolAddressToBytes32(address: string): `0x${string}` {
    if (!address.startsWith("0x")) {
        throw new Error(`POOL_ADDRESS must be in hex format (0x...): ${address}`);
    }

    if (!isHex(address, { strict: true })) {
        throw new Error(`POOL_ADDRESS is not valid hex: ${address}`);
    }

    if (address.length !== 66) {
        throw new Error(
            `Invalid bytes32 format: ${address}. Expected 66 characters (0x + 64 hex chars).`,
        );
    }

    return address as `0x${string}`;
}

type DeploymentsFile = {
    MeteoraDAMMv1Factory?: {
        address?: string;
    };
    MeteoraDAMMv1Pools?: Array<{
        pubkey: string;
        address: string;
        txHash: string;
        blockNumber: string;
    }>;
};

function deploymentsFilePath(networkName: string): string {
    return path.resolve(process.cwd(), "deployments", `${networkName}.json`);
}

function readDeployments(networkName: string): DeploymentsFile {
    const filePath = deploymentsFilePath(networkName);

    if (!fs.existsSync(filePath)) {
        return {};
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as DeploymentsFile;
}

function writeDeployments(networkName: string, data: DeploymentsFile): void {
    const dirPath = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = deploymentsFilePath(networkName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function savePoolDeployment(args: {
    networkName: string;
    pubkey: string;
    address: `0x${string}`;
    txHash: `0x${string}`;
    blockNumber: bigint;
}): void {
    const deployments = readDeployments(args.networkName);

    const pools = deployments.MeteoraDAMMv1Pools ?? [];

    const alreadyExists = pools.some(
        (pool) =>
            pool.pubkey.toLowerCase() === args.pubkey.toLowerCase() ||
            pool.address.toLowerCase() === args.address.toLowerCase(),
    );

    if (!alreadyExists) {
        pools.push({
            pubkey: args.pubkey,
            address: args.address,
            txHash: args.txHash,
            blockNumber: args.blockNumber.toString(),
        });
    } else {
        for (const pool of pools) {
            if (
                pool.pubkey.toLowerCase() === args.pubkey.toLowerCase() ||
                pool.address.toLowerCase() === args.address.toLowerCase()
            ) {
                pool.pubkey = args.pubkey;
                pool.address = args.address;
                pool.txHash = args.txHash;
                pool.blockNumber = args.blockNumber.toString();
            }
        }
    }

    deployments.MeteoraDAMMv1Pools = pools;
    writeDeployments(args.networkName, deployments);
}

function readFactoryAddressFromDeployments(networkName: string): `0x${string}` | null {
    const parsed = readDeployments(networkName);

    const address = parsed?.MeteoraDAMMv1Factory?.address;
    if (!address) {
        return null;
    }

    if (!isAddress(address)) {
        throw new Error(
            `Invalid MeteoraDAMMv1Factory.address in deployments/${networkName}.json: ${address}`,
        );
    }

    return getAddress(address);
}

function resolveFactoryAddress(networkName: string): `0x${string}` {
    const envAddress = process.env.FACTORY_ADDRESS;
    if (envAddress) {
        if (!isAddress(envAddress)) {
            throw new Error(`Invalid FACTORY_ADDRESS: ${envAddress}`);
        }
        return getAddress(envAddress);
    }

    const fromFile = readFactoryAddressFromDeployments(networkName);
    if (fromFile) {
        return fromFile;
    }

    throw new Error(
        `Factory address not found. Set FACTORY_ADDRESS env var or create deployments/${networkName}.json`,
    );
}

async function main() {
    const poolPubkey = poolAddressToBytes32(requireEnv("POOL_ADDRESS"));

    const { viem, networkName } = await hardhat.network.connect();
    const factoryAddress = resolveFactoryAddress(networkName);

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();

    console.log("Using network:", networkName);
    console.log("Using deployer:", deployer.account.address);
    console.log("Using factory:", factoryAddress);
    console.log("Pool pubkey:", poolPubkey);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    const factory = await viem.getContractAt("MeteoraDAMMv1Factory", factoryAddress);

    console.log("Sending addPool transaction...");
    const txHash = await factory.write.addPool([poolPubkey], {
        account: deployer.account,
    });

    console.log("Transaction hash:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Transaction mined in block:", receipt.blockNumber.toString());
    console.log("Status:", receipt.status);

    const allPoolsLength = await factory.read.allPoolsLength();
    console.log("allPoolsLength:", allPoolsLength.toString());

    if (allPoolsLength === 0n) {
        throw new Error("Pool was not added: allPoolsLength is 0");
    }

    const newPoolAddress = await factory.read.allPools([allPoolsLength - 1n]);
    console.log("Last pool address:", newPoolAddress);

    savePoolDeployment({
        networkName,
        pubkey: poolPubkey,
        address: getAddress(newPoolAddress),
        txHash,
        blockNumber: receipt.blockNumber,
    });

    console.log(
        `Saved pool deployment to deployments/${networkName}.json`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});