import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const SIMPLE_ACTIVATOR = "0xc478604d116222190750fe9a52dd3d6ae9140212";
const abi = parseAbi([
    "function isActivated(address user) external view returns (bool)",
    "function activationCost() external view returns (uint256)",
    "function usdcMint() external view returns (bytes32)",
    "function wsolMint() external view returns (bytes32)",
    "function activate() external payable",
]);

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const [d] = await viem.getWalletClients();
    const me = d.account.address as `0x${string}`;

    const isAct = await pc.readContract({ address: SIMPLE_ACTIVATOR, abi, functionName: "isActivated", args: [me] }) as boolean;
    const cost = await pc.readContract({ address: SIMPLE_ACTIVATOR, abi, functionName: "activationCost" }) as bigint;
    console.log(`User:           ${me}`);
    console.log(`isActivated:    ${isAct}`);
    console.log(`activationCost: ${cost} wei`);

    if (!isAct) {
        console.log(`\nCalling activate()...`);
        const act = await viem.getContractAt("SimpleActivator", SIMPLE_ACTIVATOR);
        const txHash = await act.write.activate({ account: d.account, value: cost });
        console.log(`  tx: ${txHash}`);
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        console.log(`  status: ${rc.status}, gas: ${rc.gasUsed}`);

        const isAct2 = await pc.readContract({ address: SIMPLE_ACTIVATOR, abi, functionName: "isActivated", args: [me] }) as boolean;
        console.log(`  isActivated now: ${isAct2}`);
    } else {
        console.log("Already activated — proceeding to re-run swap probe.");
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
