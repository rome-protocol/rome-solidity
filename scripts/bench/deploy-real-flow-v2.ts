/**
 * Phase 2 — Deploy NEW (post-#165/#166/#167/#169) contracts side-by-side on
 * Hadrian for v1-vs-new flow-level CU benchmarking.
 *
 * What gets deployed:
 *   1. NEW ERC20SPLFactory — creates its own ERC20Users internally
 *   2. wBench mint (created via factory.create_token_mint + init_token_mint,
 *      which exercises A4 + A5) + SPL_ERC20 wrapper for it
 *   3. NEW RomeBridgeWithdraw — constructor uses v1's wUSDC + v1's wETH
 *      wrappers (bridges operate on the same wrapper state for fair compare)
 *
 * Output:
 *   deployments/hadrian.real-flow-bench.json
 *
 * Usage:
 *   export HARDHAT_VAR_HADRIAN_PRIVATE_KEY=...
 *   npx hardhat run scripts/bench/deploy-real-flow-v2.ts --network hadrian
 */
import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import {
    Wallet,
    JsonRpcProvider,
    ContractFactory,
    Contract,
    keccak256,
    solidityPacked,
} from "ethers";
import factoryArtifact from "../../artifacts/contracts/erc20spl/erc20spl_factory.sol/ERC20SPLFactory.json" with { type: "json" };
import withdrawArtifact from "../../artifacts/contracts/bridge/RomeBridgeWithdraw.sol/RomeBridgeWithdraw.json" with { type: "json" };
import { base58ToBytes32 } from "../lib/pubkey.js";
// Hadrian's v1 hadrian.json deployment receipt lives in the main rome-solidity
// checkout (gitignored locally — not in the worktree). Read it directly.
const V1_HADRIAN_RECEIPT_PATH = "/Users/anilkumar/rome/rome-solidity/deployments/hadrian.json";
function readV1Hadrian(): any {
    return JSON.parse(fs.readFileSync(V1_HADRIAN_RECEIPT_PATH, "utf8"));
}
import { PublicKey } from "@solana/web3.js";
import { deriveCctpAccounts } from "../bridge/derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "../bridge/derive/wormhole-accounts.js";
import { SOLANA_PROGRAM_IDS_DEVNET } from "../bridge/constants.js";

const CPI_PROGRAM_ADDRESS = "0xFF00000000000000000000000000000000000008" as const;
const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009" as const;

import { Interface } from "ethers";
const helperIface = new Interface([
    "function swap_gas_to_lamports(uint64 lamports) external",
    "function pda(address user) view returns (bytes32)",
]);

async function main() {
    const networkName = "hadrian";
    const rpcUrl = "https://hadrian.testnet.romeprotocol.xyz/";
    const pk = process.env.HARDHAT_VAR_HADRIAN_PRIVATE_KEY;
    if (!pk) throw new Error("Missing HARDHAT_VAR_HADRIAN_PRIVATE_KEY");

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(pk, provider);
    console.log(`Deployer:  ${wallet.address}`);
    console.log(`Balance:   ${(await provider.getBalance(wallet.address)).toString()} wei`);

    // Read v1 receipt.
    const v1 = readV1Hadrian();
    const v1USDCWrapper = v1.SPL_ERC20_USDC?.address as `0x${string}`;
    const v1WETHWrapper = v1.SPL_ERC20_WETH?.address as `0x${string}`;
    const v1USDCMint = v1.SPL_ERC20_USDC?.mintId as string;
    const v1WETHMint = v1.SPL_ERC20_WETH?.mintId as string;
    const v1Paymaster = v1.RomeBridgePaymaster?.address as `0x${string}`;
    const v1WithdrawAddr = v1.RomeBridgeWithdraw?.address as `0x${string}`;
    if (!v1USDCWrapper || !v1WETHWrapper || !v1Paymaster) {
        throw new Error("v1 hadrian.json missing required addresses");
    }
    console.log(`v1.SPL_ERC20_USDC:        ${v1USDCWrapper}  (mint ${v1USDCMint})`);
    console.log(`v1.SPL_ERC20_WETH:        ${v1WETHWrapper}  (mint ${v1WETHMint})`);
    console.log(`v1.RomeBridgePaymaster:   ${v1Paymaster}`);
    console.log(`v1.RomeBridgeWithdraw:    ${v1WithdrawAddr}`);

    // ──────────────────────────────────────────────────────────────────────
    // Step 1 — Deploy NEW ERC20SPLFactory.
    // ──────────────────────────────────────────────────────────────────────
    console.log("\n[1/5] Deploy NEW ERC20SPLFactory...");
    const factoryFactory = new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, wallet);
    const v2Factory = await factoryFactory.deploy(CPI_PROGRAM_ADDRESS);
    await v2Factory.waitForDeployment();
    const v2FactoryAddr = await v2Factory.getAddress();
    console.log(`        v2.ERC20SPLFactory: ${v2FactoryAddr}`);

    const v2FactoryContract = new Contract(v2FactoryAddr, factoryArtifact.abi, wallet);
    const v2UsersAddr = (await v2FactoryContract.users()) as string;
    console.log(`        v2.ERC20Users:      ${v2UsersAddr}`);

    // ──────────────────────────────────────────────────────────────────────
    // Step 1.5 — Top up deployer's external_auth PDA with lamports.
    //   create_mint_account allocates an 82-byte SPL Mint account (~1.5M
    //   lamports rent). If the PDA is at the rent-exempt floor only,
    //   create_token_mint reverts with Custom(1) = InsufficientFunds.
    //   Pre-top-up via HelperProgram.swap_gas_to_lamports (gas-token → SOL
    //   lamports on caller's PDA). 3M lamports = ~0.003 SOL covers the
    //   mint rent + buffer.
    // ──────────────────────────────────────────────────────────────────────
    console.log("\n[1.5] Top up deployer PDA via HelperProgram.swap_gas_to_lamports(3_000_000)...");
    const swapData = helperIface.encodeFunctionData("swap_gas_to_lamports", [3_000_000n]);
    const swapTx = await wallet.sendTransaction({
        to: HELPER_PROGRAM_ADDRESS,
        data: swapData,
        gasLimit: 5_000_000n,
    });
    await swapTx.wait();
    console.log(`        swap_gas_to_lamports tx: ${swapTx.hash}`);

    // ──────────────────────────────────────────────────────────────────────
    // Step 2 — Read the (mint, salt) the factory will produce on next
    //          create_token_mint, then call create + init.
    //          A4 (create_mint_account) gets exercised by create_token_mint;
    //          A5 (init_spl_mint) by init_token_mint.
    // ──────────────────────────────────────────────────────────────────────
    console.log("\n[2/5] Create + init wBench mint (exercises A4 + A5)...");
    const [wBenchMint, wBenchSalt] = (await v2FactoryContract.get_current_mint(wallet.address)) as [
        string,
        string,
    ];
    console.log(`        wBench mint (bytes32): ${wBenchMint}`);
    console.log(`        wBench salt:           ${wBenchSalt}`);

    const createMintTx = await v2FactoryContract.create_token_mint({ gasLimit: 5_000_000n });
    await createMintTx.wait();
    console.log(`        create_token_mint tx:  ${createMintTx.hash}`);

    const initMintTx = await v2FactoryContract.init_token_mint(wBenchMint, { gasLimit: 5_000_000n });
    await initMintTx.wait();
    console.log(`        init_token_mint tx:    ${initMintTx.hash}`);

    // ──────────────────────────────────────────────────────────────────────
    // Step 3 — Register the SPL_ERC20 wrapper via add_spl_token_no_metadata.
    // ──────────────────────────────────────────────────────────────────────
    console.log("\n[3/5] Register wBench wrapper via factory.add_spl_token_no_metadata...");
    const addTokenTx = await v2FactoryContract.add_spl_token_no_metadata(
        wBenchMint,
        "Bench Test Token",
        "wBench",
        { gasLimit: 80_000_000n },
    );
    const addTokenReceipt = await addTokenTx.wait();
    console.log(`        add_spl_token tx:      ${addTokenTx.hash}`);

    let v2BenchWrapperAddr: string | null = null;
    for (const log of addTokenReceipt.logs ?? []) {
        try {
            const parsed = v2FactoryContract.interface.parseLog(log);
            if (parsed?.name === "TokenCreated") {
                v2BenchWrapperAddr = parsed.args.wrapper as string;
                break;
            }
        } catch {}
    }
    if (!v2BenchWrapperAddr) {
        // Fallback — symbol-hash lookup
        const symbolHash = keccak256(solidityPacked(["string"], ["wBench"]));
        v2BenchWrapperAddr = (await v2FactoryContract.token_by_symbol_hash(symbolHash)) as string;
    }
    console.log(`        v2.SPL_ERC20_wBench:   ${v2BenchWrapperAddr}`);

    // ──────────────────────────────────────────────────────────────────────
    // Step 4 — Deploy NEW RomeBridgeWithdraw using v1 wUSDC + v1 wETH.
    //          Solana PDAs derived from v1 mints (same mints v1 uses).
    // ──────────────────────────────────────────────────────────────────────
    console.log("\n[4/5] Deploy NEW RomeBridgeWithdraw...");
    const ids = SOLANA_PROGRAM_IDS_DEVNET;
    const usdcMintPK = new PublicKey(v1USDCMint);
    const wethMintPK = new PublicKey(v1WETHMint);
    const pdas = {
        ...deriveCctpAccounts(usdcMintPK),
        ...deriveWormholeAccounts(wethMintPK, {
            tokenBridgeProgramId: ids.WORMHOLE_TOKEN_BRIDGE,
            coreProgramId:        ids.WORMHOLE_CORE,
        }),
    };

    const cctpParams = {
        tokenMessengerProgram:     base58ToBytes32(ids.CCTP_TOKEN_MESSENGER),
        messageTransmitterProgram: base58ToBytes32(ids.CCTP_MESSAGE_TRANSMITTER),
        splTokenProgram:           base58ToBytes32(ids.SPL_TOKEN),
        systemProgram:             base58ToBytes32(ids.SYSTEM_PROGRAM),
        messageTransmitterConfig:  pdas.cctpMessageTransmitterConfig,
        tokenMessengerConfig:      pdas.cctpTokenMessengerConfig,
        remoteTokenMessenger:      pdas.cctpRemoteTokenMessenger,
        tokenMinter:               pdas.cctpTokenMinter,
        localTokenUsdc:            pdas.cctpLocalTokenUsdc,
        senderAuthorityPda:        pdas.cctpSenderAuthorityPda,
        eventAuthority:            pdas.cctpEventAuthority,
        messageTransmitterEventAuthority: pdas.cctpMessageTransmitterEventAuthority,
    };

    const wormholeParams = {
        tokenBridgeProgram: base58ToBytes32(ids.WORMHOLE_TOKEN_BRIDGE),
        coreProgram:        base58ToBytes32(ids.WORMHOLE_CORE),
        splTokenProgram:    base58ToBytes32(ids.SPL_TOKEN),
        systemProgram:      base58ToBytes32(ids.SYSTEM_PROGRAM),
        clockSysvar:        base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
        rentSysvar:         base58ToBytes32("SysvarRent111111111111111111111111111111111"),
        config:             pdas.wormholeConfig,
        custody:            pdas.wormholeCustody,
        authoritySigner:    pdas.wormholeAuthoritySigner,
        custodySigner:      pdas.wormholeCustodySigner,
        bridgeConfig:       pdas.wormholeBridgeConfig,
        feeCollector:       pdas.wormholeFeeCollector,
        emitter:            pdas.wormholeEmitter,
        sequence:           pdas.wormholeSequence,
        wrappedMeta:        pdas.wormholeWrappedMeta,
        targetChain:        10002, // Sepolia
    };

    const withdrawFactory = new ContractFactory(withdrawArtifact.abi, withdrawArtifact.bytecode, wallet);
    const v2Withdraw = await withdrawFactory.deploy(
        v1Paymaster,
        v1USDCWrapper,
        v1WETHWrapper,
        cctpParams,
        wormholeParams,
    );
    await v2Withdraw.waitForDeployment();
    const v2WithdrawAddr = await v2Withdraw.getAddress();
    console.log(`        v2.RomeBridgeWithdraw: ${v2WithdrawAddr}`);

    // ──────────────────────────────────────────────────────────────────────
    // Step 5 — Write artifact
    // ──────────────────────────────────────────────────────────────────────
    const artifact = {
        network: networkName,
        chainId: 200010,
        deployedAt: new Date().toISOString(),
        deployer: wallet.address,
        v1: {
            ERC20SPLFactory:       v1.ERC20SPLFactory?.address,
            SPL_ERC20_USDC:        v1USDCWrapper,
            SPL_ERC20_WETH:        v1WETHWrapper,
            SPL_ERC20_WSOL:        v1.SPL_ERC20_WSOL?.address,
            RomeBridgeWithdraw:    v1WithdrawAddr,
            RomeBridgePaymaster:   v1Paymaster,
            usdcMint:              v1USDCMint,
            wethMint:              v1WETHMint,
            wsolMint:              v1.SPL_ERC20_WSOL?.mintId,
        },
        v2: {
            ERC20SPLFactory:       v2FactoryAddr,
            ERC20Users:            v2UsersAddr,
            wBenchMint:            wBenchMint,
            wBenchSalt:            wBenchSalt,
            SPL_ERC20_wBench:      v2BenchWrapperAddr,
            RomeBridgeWithdraw:    v2WithdrawAddr,
        },
    };

    const out = path.resolve(process.cwd(), "deployments", "hadrian.real-flow-bench.json");
    fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
    console.log(`\nArtifact: ${out}`);
    console.log(`Deployer balance after: ${(await provider.getBalance(wallet.address)).toString()} wei`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
