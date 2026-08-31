import hardhat from "hardhat";
import { isAddress, parseAbi } from "viem";
import { readDeployments } from "../lib/deployments.js";

// Create a deployer-authored test mint.
//
//   1. HelperProgram.create_and_init_mint(...) — called DIRECTLY by the
//      deployer (not via the factory — see ERC20SPLFactory.create_token_mint's
//      NatSpec for why: the rome-evm DELEGATECALL identity gate requires
//      context.caller == the actual creator for both the salt-derived mint
//      PDA and its rent payer to resolve correctly, which only a user-direct
//      call preserves). System CreateAccount + SPL InitializeMint2 in one
//      dispatch, mint authority = the deployer's own EXTERNAL_AUTHORITY PDA.
//   2. factory.confirm_created_mint(mint) — advances the deployer's nonce so
//      get_current_mint predicts a fresh salt for their next mint.
//
// Prints the resulting mint pubkey. Use it as WRAPPER_MINT_ID for the
// SPL_ERC20_cached deploy script.

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009" as const;
const DEFAULT_DECIMALS = 9;

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
        "function confirm_created_mint(bytes32 mint) external",
        "function get_current_mint(address user) external view returns (bytes32, bytes32)",
    ]);
    const helperAbi = parseAbi([
        "function pda(address user) external view returns (bytes32)",
        "function create_and_init_mint(uint8 decimals, bytes32 mint_authority, bool has_freeze_authority, bytes32 freeze_authority, bytes32 salt) external",
    ]);

    // Pre-compute the mint pubkey + salt via get_current_mint — same value
    // create_and_init_mint will produce for this caller's next nonce.
    const [predicted, mintSeed] = (await publicClient.readContract({
        address: factoryAddress as `0x${string}`,
        abi: factoryAbi,
        functionName: "get_current_mint",
        args: [wallet.account.address],
    })) as [`0x${string}`, `0x${string}`];

    const mintAuthority = (await publicClient.readContract({
        address: HELPER_PROGRAM,
        abi: helperAbi,
        functionName: "pda",
        args: [wallet.account.address],
    })) as `0x${string}`;

    console.log(`Predicted mint pubkey: ${predicted}`);
    console.log(`Calling HelperProgram.create_and_init_mint(...) directly...`);

    const createHash = await wallet.writeContract({
        address: HELPER_PROGRAM,
        abi: helperAbi,
        functionName: "create_and_init_mint",
        args: [DEFAULT_DECIMALS, mintAuthority, false, `0x${"0".repeat(64)}` as `0x${string}`, mintSeed],
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    if (createReceipt.status !== "success") {
        throw new Error(`create_and_init_mint reverted: tx ${createHash}`);
    }
    console.log(`  create_and_init_mint tx: ${createHash} (block ${createReceipt.blockNumber})`);

    console.log(`Calling factory.confirm_created_mint(${predicted})...`);
    const confirmHash = await wallet.writeContract({
        address: factoryAddress as `0x${string}`,
        abi: factoryAbi,
        functionName: "confirm_created_mint",
        args: [predicted],
    });
    const confirmReceipt = await publicClient.waitForTransactionReceipt({ hash: confirmHash });
    if (confirmReceipt.status !== "success") {
        throw new Error(`confirm_created_mint reverted: tx ${confirmHash}`);
    }
    console.log(`  confirm_created_mint tx: ${confirmHash} (block ${confirmReceipt.blockNumber})`);

    console.log("");
    console.log("Test mint created. Use it for SPL_ERC20_cached deploy:");
    console.log(`  WRAPPER_MINT_ID=${predicted} \\`);
    console.log(`    npx hardhat run scripts/erc20spl/deploy_cached.ts --network ${networkName}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
