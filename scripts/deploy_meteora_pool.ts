import hardhat from "hardhat";
import path from "node:path";
import fs from "node:fs";
import { type Abi, isAddress, getAddress } from "viem";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function poolAddressToBytes32(address: string): string {
    // Convert pool address from base58 or hex string to bytes32 format
    // If it's already a hex string starting with 0x, use it directly
    if (address.startsWith("0x")) {
        if (address.length !== 66) {
            throw new Error(`Invalid bytes32 format: ${address}. Expected 66 characters (0x + 64 hex chars).`);
        }
        return address;
    }
    // If provided in other format, throw error asking for bytes32 format
    throw new Error(`POOL_ADDRESS must be in hex format (0x...): ${address}`);
}

function readFactoryAddressFromDeployments(networkName: string): `0x${string}` | null {
    const filePath = path.resolve(process.cwd(), "deployments", `${networkName}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
        MeteoraDAMMv1Factory?: {
            address?: string;
        };
    };

    const address = parsed?.MeteoraDAMMv1Factory?.address;
    if (!address) {
        return null;
    }

    if (!isAddress(address)) {
        throw new Error(`Invalid MeteoraDAMMv1Factory.address in ${filePath}: ${address}`);
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
    const poolAddress = requireEnv("POOL_ADDRESS");
    if (!isAddress(poolAddress)) {
        throw new Error(`Invalid POOL_ADDRESS: ${poolAddress}`);
    }

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
    console.log("Pool pubkey:", poolAddress);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    const factory = await viem.getContractAt("MeteoraDAMMv1Factory", factoryAddress);

    console.log("Sending addPool transaction...");
    const txHash = await factory.write.addPool([poolAddress], {
        account: deployer.account,
    });

    console.log("Transaction hash:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Transaction mined in block:", receipt.blockNumber.toString());
    console.log("Status:", receipt.status);

    const allPoolsLength = await factory.read.allPoolsLength();
    console.log("allPoolsLength:", allPoolsLength.toString());

    if (allPoolsLength > 0n) {
        const newPoolAddress = await factory.read.allPools([allPoolsLength - 1n]);
        console.log("Last pool address:", newPoolAddress);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
