import hardhat from "hardhat";
import { getAddress, isAddress, isHex } from "viem";
import { resolveERC20SPLFactoryAddress, saveFactoryDeployment } from "./lib/deployments.js";

const DEFAULT_PROG_DYNAMIC_AMM =
    "0xccf802d4cccc84d7fb21b5f73b49d81a16c5b4c88ee32394e1c91d3588cc4080";
const DEFAULT_PROG_DYNAMIC_VAULT =
    "0x0fbfe8846d685cbdc62cca7e04c7e8f68dcc313ab31277e2e0112a2ec0e052e5";
const DEFAULT_CPI_CONTRACT_ADDRESS = "0xFF00000000000000000000000000000000000008";

const VAULT_OVERRIDE_NETWORK = {
    Mainnet: 0,
    Devnet: 1,
} as const;

type VaultOverrideNetwork = (typeof VAULT_OVERRIDE_NETWORK)[keyof typeof VAULT_OVERRIDE_NETWORK];

function resolveBytes32(value: string, name: string): `0x${string}` {
    if (!isHex(value, { strict: true }) || value.length !== 66) {
        throw new Error(`Invalid ${name}: expected bytes32 hex value, got ${value}`);
    }

    return value as `0x${string}`;
}

function resolveAddress(value: string, name: string): `0x${string}` {
    if (!isAddress(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }

    return getAddress(value);
}

function resolveVaultOverrideNetwork(networkName: string): VaultOverrideNetwork {
    const configured = process.env.VAULT_OVERRIDE_NETWORK?.trim().toLowerCase();
    if (configured) {
        if (configured === "mainnet") {
            return VAULT_OVERRIDE_NETWORK.Mainnet;
        }
        if (configured === "devnet") {
            return VAULT_OVERRIDE_NETWORK.Devnet;
        }

        throw new Error(
            `Invalid VAULT_OVERRIDE_NETWORK: ${process.env.VAULT_OVERRIDE_NETWORK}. Use mainnet or devnet.`,
        );
    }

    return networkName === "monti_spl"
        ? VAULT_OVERRIDE_NETWORK.Devnet
        : VAULT_OVERRIDE_NETWORK.Mainnet;
}

async function main() {
    const { viem, networkName } = await hardhat.network.connect() as unknown as {
        viem: {
            getWalletClients: () => Promise<Array<{ account?: { address: `0x${string}` } }>>;
            getPublicClient: () => Promise<{
                getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
            }>;
            deployContract: (
                name: "MeteoraDAMMv1Factory",
                args: readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, VaultOverrideNetwork],
            ) => Promise<{ address: `0x${string}` }>;
        };
        networkName: string;
    };

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();
    const progDynamicVault = resolveBytes32(
        process.env.PROG_DYNAMIC_VAULT ?? DEFAULT_PROG_DYNAMIC_VAULT,
        "PROG_DYNAMIC_VAULT",
    );
    const progDynamicAmm = resolveBytes32(
        process.env.PROG_DYNAMIC_AMM ?? DEFAULT_PROG_DYNAMIC_AMM,
        "PROG_DYNAMIC_AMM",
    );
    const cpiContractAddress = resolveAddress(
        process.env.CPI_CONTRACT_ADDRESS ?? DEFAULT_CPI_CONTRACT_ADDRESS,
        "CPI_CONTRACT_ADDRESS",
    );
    const tokenFactoryAddress = resolveERC20SPLFactoryAddress(networkName);
    const vaultOverrideNetwork = resolveVaultOverrideNetwork(networkName);

    console.log("Using network:", networkName);
    console.log("Using deployer:", deployer.account.address);
    console.log("prog_dynamic_vault:", progDynamicVault);
    console.log("prog_dynamic_amm:", progDynamicAmm);
    console.log("CPI contract address:", cpiContractAddress);
    console.log("ERC20SPLFactory:", tokenFactoryAddress);
    console.log(
        "vault_override_network:",
        vaultOverrideNetwork === VAULT_OVERRIDE_NETWORK.Devnet ? "Devnet" : "Mainnet",
    );
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    console.log("Deploying MeteoraDAMMv1Factory...");
    const factory = await viem.deployContract("MeteoraDAMMv1Factory", [
        tokenFactoryAddress,
        progDynamicVault,
        progDynamicAmm,
        cpiContractAddress,
        vaultOverrideNetwork,
    ]);

    console.log("MeteoraDAMMv1Factory deployed to:", factory.address);

    saveFactoryDeployment(networkName, factory.address);
    console.log(`Saved deployment to deployments/${networkName}.json`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
