import hardhat from "hardhat";
import { isAddress, parseAbi } from "viem";
import { readDeployments } from "../lib/deployments.js";

// Create a deployer-authored test mint via the existing ERC20SPLFactory.
//
//   1. create_token_mint() — System CreateAccount for a salt-derived PDA
//                            with the deployer as the mint creator
//   2. init_token_mint(mint) — InitializeMint2 with the deployer's
//                              external_auth PDA as the mint authority
//                              (so SPL_ERC20_cached.mint_to works when
//                              called by the deployer)
//
// Prints the resulting mint pubkey. Use it as WRAPPER_MINT_ID for the
// SPL_ERC20_cached deploy script.

async function main() {
    const networkName = process.env.HARDHAT_NETWORK ?? "hadrian";
    const deployments = readDeployments(networkName);

    const factoryAddress = deployments.ERC20SPLFactory?.address;
    if (!factoryAddress || !isAddress(factoryAddress)) {
        throw new Error(
            `ERC20SPLFactory not deployed on ${networkName}. ` +
            `Run scripts/bridge/deploy.ts first.`,
        );
    }

    const { viem } = await hardhat.network.connect();
    const publicClient = await viem.getPublicClient();
    const wallets = await viem.getWalletClients();
    if (wallets.length === 0) {
        throw new Error("no wallet client — set HADRIAN_PRIVATE_KEY in keystore");
    }
    const wallet = wallets[0];

    const factoryAbi = parseAbi([
        "function create_token_mint() external returns (bytes32)",
        "function init_token_mint(bytes32 mint) external",
        "function get_current_mint(address user) external view returns (bytes32, bytes32)",
    ]);

    // Pre-compute the mint pubkey via get_current_mint — same value
    // create_token_mint will produce on this caller's next nonce.
    const [predicted] = (await publicClient.readContract({
        address: factoryAddress as `0x${string}`,
        abi: factoryAbi,
        functionName: "get_current_mint",
        args: [wallet.account.address],
    })) as [`0x${string}`, `0x${string}`];

    console.log(`Predicted mint pubkey: ${predicted}`);
    console.log(`Calling factory.create_token_mint()...`);

    const createHash = await wallet.writeContract({
        address: factoryAddress as `0x${string}`,
        abi: factoryAbi,
        functionName: "create_token_mint",
        args: [],
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    if (createReceipt.status !== "success") {
        throw new Error(`create_token_mint reverted: tx ${createHash}`);
    }
    console.log(`  create_token_mint tx: ${createHash} (block ${createReceipt.blockNumber})`);

    console.log(`Calling factory.init_token_mint(${predicted})...`);
    const initHash = await wallet.writeContract({
        address: factoryAddress as `0x${string}`,
        abi: factoryAbi,
        functionName: "init_token_mint",
        args: [predicted],
    });
    const initReceipt = await publicClient.waitForTransactionReceipt({ hash: initHash });
    if (initReceipt.status !== "success") {
        throw new Error(`init_token_mint reverted: tx ${initHash}`);
    }
    console.log(`  init_token_mint tx: ${initHash} (block ${initReceipt.blockNumber})`);

    console.log("");
    console.log("Test mint created. Use it for SPL_ERC20_cached deploy:");
    console.log(`  WRAPPER_MINT_ID=${predicted} \\`);
    console.log(`    npx hardhat run scripts/erc20spl/deploy_cached.ts --network ${networkName}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
