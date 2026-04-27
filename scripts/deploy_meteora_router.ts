import hardhat from "hardhat";
import { getAddress, isAddress } from "viem";
import { resolveFactoryAddress, saveRouterDeployment } from "./lib/deployments.js";

const DEFAULT_CPI_CONTRACT_ADDRESS = "0xFF00000000000000000000000000000000000008";

function resolveAddress(value: string, name: string): `0x${string}` {
    if (!isAddress(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }

    return getAddress(value);
}

async function main() {
    const { viem, networkName } = await hardhat.network.connect() as unknown as {
        viem: {
            getWalletClients: () => Promise<Array<{ account?: { address: `0x${string}` } }>>;
            getPublicClient: () => Promise<{
                getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
            }>;
            deployContract: (
                name: "MeteoraDAMMv1Router",
                args: readonly [`0x${string}`, `0x${string}`],
            ) => Promise<{ address: `0x${string}` }>;
        };
        networkName: string;
    };

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();
    const factoryAddress = resolveFactoryAddress(networkName);
    const cpiContractAddress = resolveAddress(
        process.env.CPI_CONTRACT_ADDRESS ?? DEFAULT_CPI_CONTRACT_ADDRESS,
        "CPI_CONTRACT_ADDRESS",
    );

    console.log("Using network:", networkName);
    console.log("Using deployer:", deployer.account.address);
    console.log("Using MeteoraDAMMv1Factory:", factoryAddress);
    console.log("CPI contract address:", cpiContractAddress);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    console.log("Deploying MeteoraDAMMv1Router...");
    const router = await viem.deployContract("MeteoraDAMMv1Router", [
        factoryAddress,
        cpiContractAddress,
    ]);

    console.log("MeteoraDAMMv1Router deployed to:", router.address);

    saveRouterDeployment(networkName, router.address);
    console.log(`Saved deployment to deployments/${networkName}.json`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
