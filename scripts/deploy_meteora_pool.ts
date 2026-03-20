import hardhat from "hardhat";
import { getAddress, isHex } from "viem";
import { resolveFactoryAddress, savePoolDeployment } from "./lib/deployments.js";

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