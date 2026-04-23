import hardhat from "hardhat";
import { getAddress, isHex, zeroAddress } from "viem";
import {
    readPoolDeployment,
    resolveERC20SPLFactoryAddress,
    resolveFactoryAddress,
    savePoolDeployment,
} from "./lib/deployments.js";
import { requireEnv } from "./lib/helpers.js";
import { base58ToBytes32Hex } from "./lib/helpers.js";

function readBytes32FromHex(data: `0x${string}`, byteOffset: number): `0x${string}` {
    const start = 2 + byteOffset * 2;
    const end = start + 64;

    if (data.length < end) {
        throw new Error(`Pool account data is too short to read bytes32 at offset ${byteOffset}.`);
    }

    return `0x${data.slice(start, end)}` as `0x${string}`;
}

function parsePoolTokenMints(data: `0x${string}`): {
    tokenAMint: `0x${string}`;
    tokenBMint: `0x${string}`;
} {
    return {
        tokenAMint: readBytes32FromHex(data, 8 + 32),
        tokenBMint: readBytes32FromHex(data, 8 + 64),
    };
}

async function waitForSuccess(
    publicClient: {
        waitForTransactionReceipt: (
            args: { hash: `0x${string}` },
        ) => Promise<{ status: string; blockNumber: bigint }>;
    },
    txHash: `0x${string}`,
    label: string,
): Promise<{ status: string; blockNumber: bigint }> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
        throw new Error(`${label} transaction failed: ${txHash}`);
    }

    return receipt;
}

async function ensureSplTokenRegistered(args: {
    tokenFactory: any;
    publicClient: any;
    deployer: { account: { address: `0x${string}` } };
    mint: `0x${string}`;
    label: string;
}): Promise<`0x${string}`> {
    const { tokenFactory, publicClient, deployer, mint, label } = args;

    const existing = await tokenFactory.read.token_by_mint([mint]);
    if (existing !== zeroAddress) {
        const tokenAddress = getAddress(existing);
        console.log(`${label} already registered in ERC20SPLFactory:`, tokenAddress);
        return tokenAddress;
    }

    console.log(`Registering ${label} in ERC20SPLFactory using MPL metadata...`);
    const simulation = await tokenFactory.simulate.add_spl_token_with_metadata([mint], {
        account: deployer.account,
    });
    const txHash = await tokenFactory.write.add_spl_token_with_metadata(simulation.request);
    console.log(`${label} registration tx:`, txHash);
    await waitForSuccess(publicClient, txHash, `add_spl_token_with_metadata ${label}`);

    const tokenAddress = getAddress(await tokenFactory.read.token_by_mint([mint]));
    if (tokenAddress === zeroAddress) {
        throw new Error(`${label} registration completed but token_by_mint is still zero.`);
    }

    console.log(`${label} wrapper address:`, tokenAddress);
    return tokenAddress;
}

async function main() {
    const poolPubkey = base58ToBytes32Hex(requireEnv("POOL_ADDRESS"), "POOL_ADDRESS");

    const { viem, networkName } = await hardhat.network.connect() as unknown as {
        viem: {
            getWalletClients: () => Promise<Array<{ account?: { address: `0x${string}` } }>>;
            getPublicClient: () => Promise<{
                getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
                waitForTransactionReceipt: (
                    args: { hash: `0x${string}` },
                ) => Promise<{ status: string; blockNumber: bigint }>;
            }>;
            getContractAt: (name: string, address: `0x${string}`, config?: unknown) => Promise<any>;
        };
        networkName: string;
    };
    const factoryAddress = resolveFactoryAddress(networkName);
    const tokenFactoryAddress = resolveERC20SPLFactoryAddress(networkName);

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }
    const deployerAccount = deployer.account;

    const publicClient = await viem.getPublicClient();
    const factory = await viem.getContractAt("MeteoraDAMMv1Factory", factoryAddress);
    const tokenFactory = await viem.getContractAt("ERC20SPLFactory", tokenFactoryAddress);
    const cpiProgramAddress = await factory.read.cpi_program();
    const cpiProgram = await viem.getContractAt("ICrossProgramInvocation", cpiProgramAddress);

    console.log("Using network:", networkName);
    console.log("Using deployer:", deployerAccount.address);
    console.log("Using MeteoraDAMMv1Factory:", factoryAddress);
    console.log("Using ERC20SPLFactory:", tokenFactoryAddress);
    console.log("Pool pubkey:", poolPubkey);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployerAccount.address })).toString(),
    );

    const poolInfo = await cpiProgram.read.account_info([poolPubkey]);
    const lamports = poolInfo[0] as bigint;
    const poolData = poolInfo[5] as `0x${string}`;
    if (lamports === 0n) {
        throw new Error(`Pool account does not exist on Solana: ${poolPubkey}`);
    }

    const { tokenAMint, tokenBMint } = parsePoolTokenMints(poolData);
    console.log("Pool token A mint:", tokenAMint);
    console.log("Pool token B mint:", tokenBMint);

    const tokenAAddress = await ensureSplTokenRegistered({
        tokenFactory,
        publicClient,
        deployer: { account: deployerAccount },
        mint: tokenAMint,
        label: "token A",
    });
    const tokenBAddress = await ensureSplTokenRegistered({
        tokenFactory,
        publicClient,
        deployer: { account: deployerAccount },
        mint: tokenBMint,
        label: "token B",
    });

    const existingWrappedPool = getAddress(await factory.read.getPool([tokenAAddress, tokenBAddress]));
    if (existingWrappedPool !== zeroAddress) {
        const existingDeployment = readPoolDeployment(networkName, poolPubkey);
        if (!existingDeployment) {
            throw new Error(
                `Pool is already registered onchain at ${existingWrappedPool}, but deployments/${networkName}.json has no matching record.`,
            );
        }

        console.log("Pool already registered in MeteoraDAMMv1Factory:", existingWrappedPool);
        savePoolDeployment({
            networkName,
            pubkey: poolPubkey,
            address: existingWrappedPool,
            txHash: existingDeployment.txHash as `0x${string}`,
            blockNumber: BigInt(existingDeployment.blockNumber),
            tokenAMint,
            tokenBMint,
            tokenAAddress,
            tokenBAddress,
        });
        console.log(`Updated deployments/${networkName}.json with token details.`);
        return;
    }

    console.log("Registering pool in MeteoraDAMMv1Factory...");
    const txHash = await factory.write.addPool([poolPubkey], {
        account: deployerAccount,
    });
    console.log("Pool registration tx:", txHash);

    const receipt = await waitForSuccess(publicClient, txHash, "addPool");
    const wrappedPoolAddress = getAddress(await factory.read.getPool([tokenAAddress, tokenBAddress]));
    if (wrappedPoolAddress === zeroAddress) {
        throw new Error("Pool registration succeeded but getPool returned zero address.");
    }

    console.log("Wrapped pool address:", wrappedPoolAddress);

    savePoolDeployment({
        networkName,
        pubkey: poolPubkey,
        address: wrappedPoolAddress,
        txHash,
        blockNumber: receipt.blockNumber,
        tokenAMint,
        tokenBMint,
        tokenAAddress,
        tokenBAddress,
    });

    console.log(`Saved pool deployment to deployments/${networkName}.json`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
