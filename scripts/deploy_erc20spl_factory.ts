import hardhat from "hardhat";
import { getAddress, isAddress } from "viem";
import {
    resolveERC20SPLLibrariesDeployment,
    saveERC20SPLFactoryDeployment,
} from "./lib/deployments.js";

const DEFAULT_CPI_CONTRACT_ADDRESS = "0xFF00000000000000000000000000000000000008";

type Libraries = Record<string, `0x${string}`>;

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
                name: "ERC20SPLFactory",
                args: readonly [`0x${string}`],
                config?: { libraries?: Libraries },
            ) => Promise<{ address: `0x${string}` }>;
        };
        networkName: string;
    };

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();
    const cpiContractAddress = resolveAddress(
        process.env.CPI_CONTRACT_ADDRESS ?? DEFAULT_CPI_CONTRACT_ADDRESS,
        "CPI_CONTRACT_ADDRESS",
    );

    console.log("Using network:", networkName);
    console.log("Using deployer:", deployer.account.address);
    console.log("CPI contract address:", cpiContractAddress);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    console.log("Deploying ERC20SPLFactory...");
    const factory = await viem.deployContract("ERC20SPLFactory", [cpiContractAddress]);
    console.log("ERC20SPLFactory deployed to:", factory.address);

    saveERC20SPLFactoryDeployment({
        networkName,
        address: factory.address,
        cpiContractAddress,
    });

    console.log(`Saved deployment to deployments/${networkName}.json`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
