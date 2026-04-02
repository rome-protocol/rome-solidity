import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { type Address } from "viem";

/**
 * Deploy ERC20SPLFactory + SPL_ERC20 wrapper over an existing SPL mint,
 * then run live integration tests.
 *
 * Uses an SPL mint from the Meteora DAMM pool deployment (already on-chain).
 * Tests: balanceOf, totalSupply, decimals, transfer, approve, allowance,
 * transferFrom, events, factory duplicate check.
 *
 * Usage:
 *   npx hardhat run scripts/erc20spl/deploy-and-test.ts --network monti_spl
 */

const CPI_PROGRAM = "0xFF00000000000000000000000000000000000008" as Address;
const SPL_TOKEN_ADDR = "0xff00000000000000000000000000000000000005" as Address;

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) throw new Error("No deployer.");
    const publicClient = await viem.getPublicClient();
    console.log("Deployer:", deployer.account.address);

    // ─── Find an existing SPL mint from deployed Meteora pools ───
    const deploymentsPath = path.resolve(process.cwd(), "deployments", `${networkName}.json`);
    if (!fs.existsSync(deploymentsPath)) throw new Error(`No deployments file at ${deploymentsPath}`);
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

    const poolAddr = deployments.MeteoraDAMMv1Pools?.[0]?.address;
    if (!poolAddr) throw new Error("No Meteora pool deployment found — need an existing SPL mint on-chain");

    const pool = await viem.getContractAt("DAMMv1Pool", poolAddr as Address);
    const mintA: `0x${string}` = await pool.read.token_a_mint();
    const mintB: `0x${string}` = await pool.read.token_b_mint();
    console.log("Using SPL mints from Meteora pool:", poolAddr);
    console.log("  Token A mint:", mintA);
    console.log("  Token B mint:", mintB);

    // Use Token A mint for tests
    const testMint = mintA;

    // ─── Step 1: Deploy Convert + ERC20SPLFactory ───
    console.log("\n=== Step 1: Deploy infrastructure ===");
    const convertLib = await viem.deployContract("Convert", []);
    const libs = { "project/contracts/convert.sol:Convert": convertLib.address };
    const factory = await viem.deployContract("ERC20SPLFactory", [CPI_PROGRAM], { libraries: libs });
    console.log("Convert:", convertLib.address, "| Factory:", factory.address);

    // ─── Step 2: Deploy SPL_ERC20 wrapper ───
    console.log("\n=== Step 2: Deploy SPL_ERC20 wrapper ===");
    const addTx = await factory.write.add_spl_token([testMint], { account: deployer.account });
    const addReceipt = await publicClient.waitForTransactionReceipt({ hash: addTx });
    assertEq(addReceipt.status, "success", "add_spl_token");

    const wrapperAddr = (await factory.read.token_by_mint([testMint])) as Address;
    const wrapper = await viem.getContractAt("contracts/erc20spl/erc20spl.sol:SPL_ERC20", wrapperAddr);
    console.log("SPL_ERC20 wrapper:", wrapperAddr);

    // ─── Step 3: Test read operations ───
    console.log("\n=== Step 3: Read operations ===");

    const supply = await wrapper.read.totalSupply();
    console.log("totalSupply:", supply.toString());
    assert(supply >= 0n, "supply non-negative");

    const decimals = await wrapper.read.decimals();
    console.log("decimals:", decimals);
    assert(decimals >= 0 && decimals <= 18, "decimals in range");

    // balanceOf may revert if user has no ATA — that's acceptable
    let balance = 0n;
    try {
        balance = await wrapper.read.balanceOf([deployer.account.address]);
        console.log("balanceOf(deployer):", balance.toString());
    } catch {
        console.log("balanceOf: deployer has no ATA for this mint (expected on devnet)");
    }
    pass("Read operations");

    // ─── Step 3b: Create ATA for deployer (needed for approve/transfer) ───
    console.log("\n=== Step 3b: Ensure deployer ATA exists ===");
    const asplToken = await viem.getContractAt(
        "IAssociatedSplToken",
        "0xFF00000000000000000000000000000000000006" as Address,
    );
    try {
        const createAtaTx = await asplToken.write.create_associated_token_account(
            [deployer.account.address, testMint],
            { account: deployer.account },
        );
        const ataReceipt = await publicClient.waitForTransactionReceipt({ hash: createAtaTx });
        console.log("ATA created:", ataReceipt.status);
    } catch {
        console.log("ATA already exists or creation not needed");
    }

    // Re-check balance now that ATA exists
    try {
        balance = await wrapper.read.balanceOf([deployer.account.address]);
        console.log("balanceOf after ATA creation:", balance.toString());
    } catch {
        console.log("balanceOf still fails (ATA may be in different state)");
    }

    // ─── Step 4: Test transfer ───
    console.log("\n=== Step 4: Transfer ===");
    if (balance > 0n) {
        // Self-transfer
        const tx1 = await wrapper.write.transfer([deployer.account.address, 0n], { account: deployer.account });
        const r1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
        assertEq(r1.status, "success", "zero transfer");

        // Check Transfer event
        const hasEvt = r1.logs.some(
            (l: any) =>
                l.address.toLowerCase() === wrapperAddr.toLowerCase() &&
                l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        );
        assert(hasEvt, "Transfer event emitted");

        if (balance >= 100n) {
            // Self-transfer with value
            const balBefore = await wrapper.read.balanceOf([deployer.account.address]);
            const tx2 = await wrapper.write.transfer([deployer.account.address, 50n], { account: deployer.account });
            const r2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
            assertEq(r2.status, "success", "self-transfer");
            const balAfter = await wrapper.read.balanceOf([deployer.account.address]);
            assertEq(balAfter, balBefore, "balance unchanged after self-transfer");
        }
    } else {
        console.log("  (deployer has 0 balance — skipping transfer tests, only testing overflow)");
    }

    // Overflow check
    await expectRevert(
        () => wrapper.write.transfer([deployer.account.address, 1n << 64n], { account: deployer.account }),
        "uint64 overflow",
    );
    pass("Transfer");

    // ─── Step 5: Test approve + allowance ───
    console.log("\n=== Step 5: Approve + Allowance ===");
    const tx3 = await wrapper.write.approve([deployer.account.address, 500n], { account: deployer.account });
    const r3 = await publicClient.waitForTransactionReceipt({ hash: tx3 });
    assertEq(r3.status, "success", "approve");

    const allowance0 = await wrapper.read.allowance([deployer.account.address, deployer.account.address]);
    console.log("allowance:", allowance0.toString());
    assertEq(allowance0, 500n, "allowance=500");

    // Approval event
    const hasApproval = r3.logs.some(
        (l: any) =>
            l.address.toLowerCase() === wrapperAddr.toLowerCase() &&
            l.topics[0] === "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    );
    assert(hasApproval, "Approval event");

    // Overwrite
    await wrapper.write.approve([deployer.account.address, 200n], { account: deployer.account });
    assertEq(
        await wrapper.read.allowance([deployer.account.address, deployer.account.address]),
        200n,
        "overwrite=200",
    );

    // Revoke
    await wrapper.write.approve([deployer.account.address, 0n], { account: deployer.account });
    assertEq(
        await wrapper.read.allowance([deployer.account.address, deployer.account.address]),
        0n,
        "revoke=0",
    );

    // Overflow
    await expectRevert(
        () => wrapper.write.approve([deployer.account.address, 1n << 64n], { account: deployer.account }),
        "uint64 overflow",
    );
    pass("Approve + Allowance");

    // ─── Step 6: Test transferFrom ───
    console.log("\n=== Step 6: TransferFrom ===");
    if (balance >= 300n) {
        await wrapper.write.approve([deployer.account.address, 500n], { account: deployer.account });
        const tx4 = await wrapper.write.transferFrom(
            [deployer.account.address, deployer.account.address, 300n],
            { account: deployer.account },
        );
        const r4 = await publicClient.waitForTransactionReceipt({ hash: tx4 });
        assertEq(r4.status, "success", "transferFrom");

        const remaining = await wrapper.read.allowance([deployer.account.address, deployer.account.address]);
        console.log("Remaining allowance:", remaining.toString());
        assertEq(remaining, 200n, "remaining=200");

        // Transfer event from transferFrom
        const hasTfEvt = r4.logs.some(
            (l: any) =>
                l.address.toLowerCase() === wrapperAddr.toLowerCase() &&
                l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        );
        assert(hasTfEvt, "Transfer event from transferFrom");
    } else {
        console.log("  (deployer has < 300 tokens — testing reverts only)");
    }

    // Revoke + try transferFrom
    await wrapper.write.approve([deployer.account.address, 0n], { account: deployer.account });
    if (balance > 0n) {
        await expectRevert(
            () =>
                wrapper.write.transferFrom(
                    [deployer.account.address, deployer.account.address, 50n],
                    { account: deployer.account },
                ),
            "transferFrom without approval",
        );
    }
    pass("TransferFrom");

    // ─── Step 7: Factory checks ───
    console.log("\n=== Step 7: Factory checks ===");
    await expectRevert(
        () => factory.write.add_spl_token([testMint], { account: deployer.account }),
        "duplicate mint",
    );

    // Verify wrapper address matches
    const storedAddr = await factory.read.token_by_mint([testMint]);
    assertEq((storedAddr as string).toLowerCase(), wrapperAddr.toLowerCase(), "stored wrapper");
    pass("Factory checks");

    // ─── Done ───
    console.log("\n" + "=".repeat(60));
    console.log("ALL TESTS PASSED");
    console.log("=".repeat(60));
    console.log("SPL Mint:", testMint);
    console.log("SPL_ERC20 Wrapper:", wrapperAddr);
    console.log("ERC20SPLFactory:", factory.address);
}

function assert(c: any, m: string): asserts c { if (!c) throw new Error(`FAIL: ${m}`); }
function assertEq(a: any, b: any, m: string) { assert(a === b, `${m}: expected ${b}, got ${a}`); }
function pass(n: string) { console.log(`${n} PASS`); }
async function expectRevert(fn: () => Promise<any>, label: string) {
    try { await fn(); throw new Error(`FAIL: ${label} should have reverted`); }
    catch (e: any) { if (e.message?.startsWith("FAIL:")) throw e; console.log(`  ${label}: correctly reverted`); }
}

main().catch((e) => { console.error("\nTEST FAILED:", e.message ?? e); process.exitCode = 1; });
