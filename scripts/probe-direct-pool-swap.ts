// Targeted use case: bypass router + EnsureAta entirely.
// User already has both ATAs (isActivated=true). Call the pool wrapper's
// swapExactTokensForTokens directly. If it fails with the same PrivilegeEscalation,
// the bug is in the dynamic-amm swap CPI itself, not in any composition state
// left by EnsureAta. If it succeeds, EnsureAta is poisoning some non-executable
// state that #369 didn't catch.

import hardhat from "hardhat";
import { parseAbi } from "viem";

const POOL_OUTER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";
const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";

const poolAbi = parseAbi([
    "function swapExactTokensForTokens(address token_in, uint256 amount_in, uint256 min_amount_out) external",
]);

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const [deployer] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();
    const me = deployer.account.address as `0x${string}`;
    console.log(`User: ${me}`);
    console.log(`Pool wrapper: ${POOL_OUTER}\n`);

    // Smallest legal amount; user has 1,544,815 wUSDC raw = ~1.54 wUSDC
    const amount_in = 10000n;
    const min_out = 1n;

    console.log(`Direct call: pool.swapExactTokensForTokens(wUSDC, ${amount_in}, ${min_out})`);
    console.log(`(no router, no EnsureAta — direct inner-CPI exercise)\n`);

    try {
        // Use simulateContract (eth_call shape) — should hit the same emulator path
        // as eth_sendRawTransaction's preflight without burning gas.
        const sim = await pc.simulateContract({
            address: POOL_OUTER,
            abi: poolAbi,
            functionName: "swapExactTokensForTokens",
            args: [WUSDC, amount_in, min_out],
            account: deployer.account,
            gas: 30_000_000n,
        });
        console.log("Simulation succeeded — no revert");
        console.log("This means EnsureAta WAS leaving poisoned state");
    } catch (e: any) {
        console.log(`Reverted: ${e.shortMessage || e.message}`);
        if (String(e.message || "").includes("PrivilegeEscalation")) {
            console.log("Same error as via router — bug is in swap CPI itself, not EnsureAta composition");
        }
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
