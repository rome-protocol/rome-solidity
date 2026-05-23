// One-shot activation against the post-redeploy SimpleActivator on Hadrian.
import hardhat from "hardhat";
import { getAddress, parseAbi } from "viem";

const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";
const ACTIVATOR = "0x6f09def2c283fa5c10616ca440846760ae6e4382" as const;

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const [deployer] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();
    const me = deployer.account.address as `0x${string}`;
    console.log(`User: ${me}\n`);

    const abi = parseAbi([
        "function activate() external payable",
        "function activationCost() view returns (uint256)",
        "function isActivated(address) view returns (bool)",
    ]);

    const activated = await pc.readContract({ address: ACTIVATOR, abi, functionName: "isActivated", args: [me] }) as boolean;
    console.log(`isActivated(user) pre: ${activated}`);
    if (activated) {
        console.log("Already activated. Nothing to do.");
        return;
    }

    const cost = await pc.readContract({ address: ACTIVATOR, abi, functionName: "activationCost" }) as bigint;
    console.log(`activationCost: ${cost} wei (= ${Number(cost) / 1e18} ETH-equivalent units)`);

    const balance = await pc.getBalance({ address: me });
    console.log(`User balance: ${balance} (needed: ${cost})\n`);
    if (balance < cost) {
        console.log("✗ HALT — insufficient balance to cover activation cost");
        return;
    }

    console.log(`Calling activator.activate{value: ${cost}}()...`);
    const activator = await viem.getContractAt("SimpleActivator", ACTIVATOR);
    const txHash = await activator.write.activate([], { value: cost, account: deployer.account });
    console.log(`  tx: ${txHash}`);
    const rc = await pc.waitForTransactionReceipt({ hash: txHash });
    console.log(`  status: ${rc.status}, evm gas: ${rc.gasUsed}`);

    // CU capture
    const sigs: string[] = await pc.request({ method: "rome_solanaTxForEvmTx" as any, params: [txHash] }) as any ?? [];
    let total = 0;
    for (const sig of sigs) {
        const r = await fetch(SOLANA_RPC, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
                params: [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }),
        });
        const j = await r.json();
        const cu = j?.result?.meta?.computeUnitsConsumed ?? 0;
        console.log(`    sig=${sig.slice(0, 16)}…  CU=${cu}`);
        total += cu;
    }
    console.log(`  TOTAL Solana CU: ${total}`);

    const activatedAfter = await pc.readContract({ address: ACTIVATOR, abi, functionName: "isActivated", args: [me] }) as boolean;
    console.log(`\nisActivated(user) post: ${activatedAfter} ${activatedAfter ? "✓" : "✗"}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
