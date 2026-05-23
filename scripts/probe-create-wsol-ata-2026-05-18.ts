// Direct create_ata on the HelperProgram precompile to create the user's
// wSOL ATA on Solana. SimpleActivator's all-in-one flow is blocked by
// AlreadyActivated gate (user has PDA from prior activation but wSOL ATA
// wasn't created in that earlier flow). HelperProgram.create_ata is
// idempotent so this is safe even if state changes underneath.
import hardhat from "hardhat";
import { parseAbi } from "viem";

const HELPER = "0xff00000000000000000000000000000000000009" as const;
const SOL_MINT_BYTES32 = "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001" as const;
const CPI = "0xff00000000000000000000000000000000000008" as const;
const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const [deployer] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();
    const me = deployer.account.address as `0x${string}`;
    console.log(`User: ${me}`);

    const helperAbi = parseAbi([
        "function create_ata(address user, bytes32 mint) external",
        "function ata(address user, bytes32 mint) external view returns (bytes32)",
    ]);
    const cpiAbi = parseAbi([
        "function account_lamports(bytes32 pubkey) external view returns (uint64)",
    ]);

    const ataBefore = await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "ata", args: [me, SOL_MINT_BYTES32] }) as `0x${string}`;
    const lamportsBefore = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ataBefore] }) as bigint;
    console.log(`\nwSOL ATA: ${ataBefore}`);
    console.log(`wSOL ATA lamports pre: ${lamportsBefore}`);

    if (lamportsBefore > 0n) {
        console.log("✓ wSOL ATA already exists, nothing to do.");
        return;
    }

    console.log(`\nCalling helper.create_ata(user, sol_mint) ...`);
    const txHash = await deployer.writeContract({
        address: HELPER,
        abi: helperAbi,
        functionName: "create_ata",
        args: [me, SOL_MINT_BYTES32],
    });
    console.log(`  tx: ${txHash}`);
    const rc = await pc.waitForTransactionReceipt({ hash: txHash });
    console.log(`  status: ${rc.status}, evm gas: ${rc.gasUsed}`);

    const sigs: string[] = await pc.request({ method: "rome_solanaTxForEvmTx" as any, params: [txHash] }) as any ?? [];
    let totalCu = 0;
    for (const sig of sigs) {
        const r = await fetch(SOLANA_RPC, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
                params: [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }),
        });
        const j = await r.json();
        const cu = j?.result?.meta?.computeUnitsConsumed ?? 0;
        console.log(`    sig=${sig.slice(0, 16)}…  CU=${cu}`);
        totalCu += cu;
    }
    console.log(`  Solana CU: ${totalCu}`);

    const lamportsAfter = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ataBefore] }) as bigint;
    console.log(`\nwSOL ATA lamports post: ${lamportsAfter}`);
    console.log(`Created: ${lamportsAfter > 0n ? "✓" : "✗"}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
