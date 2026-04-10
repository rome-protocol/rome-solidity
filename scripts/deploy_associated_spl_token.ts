import hardhat from "hardhat";

import { getAddress, isAddress } from "viem";
import { saveAssociatedSplTokenDeployment } from "./lib/deployments.js";
import { base58ToBytes32Hex } from "./lib/helpers.js";

const DEFAULT_CPI_CONTRACT_ADDRESS = "0xFF00000000000000000000000000000000000008";
const DEFAULT_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const DEFAULT_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DEFAULT_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

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
                name: "AssociatedSplToken",
                args: readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
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
    const systemProgramId = base58ToBytes32Hex(
        process.env.SYSTEM_PROGRAM_ID ?? DEFAULT_SYSTEM_PROGRAM_ID,
        "SYSTEM_PROGRAM_ID",
    );
    const tokenProgramId = base58ToBytes32Hex(
        process.env.TOKEN_PROGRAM_ID ?? DEFAULT_TOKEN_PROGRAM_ID,
        "TOKEN_PROGRAM_ID",
    );
    const associatedTokenProgramId = base58ToBytes32Hex(
        process.env.ASSOCIATED_TOKEN_PROGRAM_ID ?? DEFAULT_ASSOCIATED_TOKEN_PROGRAM_ID,
        "ASSOCIATED_TOKEN_PROGRAM_ID",
    );

    console.log("Using network:", networkName);
    console.log("Using deployer:", deployer.account.address);
    console.log("CPI contract address:", cpiContractAddress);
    console.log("System program ID:", systemProgramId);
    console.log("Token program ID:", tokenProgramId);
    console.log("Associated token program ID:", associatedTokenProgramId);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    const associatedSplToken = await viem.deployContract("AssociatedSplToken", [
        cpiContractAddress,
        systemProgramId,
        tokenProgramId,
        associatedTokenProgramId,
    ]);

    console.log("AssociatedSplToken deployed to:", associatedSplToken.address);

    saveAssociatedSplTokenDeployment({
        networkName,
        address: associatedSplToken.address,
        cpiContractAddress,
        systemProgramId,
        tokenProgramId,
        associatedTokenProgramId,
    });

    console.log(`Saved deployment to deployments/${networkName}.json`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
