// Integration test for the EnsureAta library against Hadrian.
//
// Three cases:
//   1. Existing ATA (user holds wUSDC, ATA already on-chain)
//      → ensure() returns success, no state change
//   2. Missing ATA (user has no wETH ATA on the post-redeploy wrappers)
//      → ensure() returns success, ATA materializes on Solana
//   3. Re-run of case 2 → succeeds (verifies idempotency)
//
// Hadrian network only (live state assertions); cannot run on the in-process
// hardhat simulated network because there's no Rome HelperProgram precompile
// behind 0xff…09 there.
//
// Run: npx hardhat test tests/ensure_ata.integration.ts --network hadrian
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { getAddress, parseAbi } from "viem";

const HELPER = "0xff00000000000000000000000000000000000009" as const;
const CPI = "0xff00000000000000000000000000000000000008" as const;

// Post-redeploy (2026-05-18) wrapper SPL mints on Hadrian, verified on-chain.
// USDC: user holds 1.8M+ → ATA already exists.
// ETH:  user holds 0 and no ATA on the new wrapper → fresh-create target.
const USDC_MINT = "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7" as `0x${string}`;
const WETH_MINT = "0x4de5b3fa1e6c00708f7ff480e2186357da3bc7110c576e9364da84c4c77ad904" as `0x${string}`;

const helperAbi = parseAbi([
    "function ata(address user, bytes32 mint) external view returns (bytes32)",
]);
const cpiAbi = parseAbi([
    "function account_lamports(bytes32 pubkey) external view returns (uint64)",
]);

describe("EnsureAta (Hadrian)", function () {
    let harness: any;
    let pc: any;
    let me: `0x${string}`;
    let deployerAccount: any;

    before(async function () {
        const { viem, networkName } = await hardhat.network.connect() as any;
        if (networkName !== "hadrian") {
            throw new Error(`This integration test must run against hadrian; got ${networkName}`);
        }
        const [deployer] = await viem.getWalletClients();
        deployerAccount = deployer.account;
        me = deployer.account.address;
        pc = await viem.getPublicClient();

        harness = await viem.deployContract("EnsureAtaHarness", []);
    });

    it("noop on an existing ATA (user holds wUSDC)", async function () {
        const ataBefore = await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "ata", args: [me, USDC_MINT] });
        const lamportsBefore = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ataBefore] });
        assert.ok(Number(lamportsBefore) > 0, `Test precondition: user must hold wUSDC ATA. Got ${lamportsBefore} lamports.`);

        const txHash = await harness.write.ensure([me, USDC_MINT], { account: deployerAccount });
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        assert.equal(rc.status, "success");

        const lamportsAfter = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ataBefore] });
        assert.equal(lamportsAfter, lamportsBefore, "ATA lamports should be unchanged on idempotent re-run");
    });

    it("creates ATA on first call (user has no wETH ATA)", async function () {
        const ata = await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "ata", args: [me, WETH_MINT] });
        const lamportsBefore = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ata] });

        if (Number(lamportsBefore) > 0) {
            // Race: a parallel run created it. Skip; case 3 (idempotency) covers
            // the same-state branch.
            console.log("ATA already exists — relying on case 3 to cover idempotency");
            return;
        }

        const txHash = await harness.write.ensure([me, WETH_MINT], { account: deployerAccount });
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        assert.equal(rc.status, "success");

        const lamportsAfter = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ata] });
        assert.ok(Number(lamportsAfter) > 0, `ATA must exist after ensure(). Got ${lamportsAfter} lamports.`);
    });

    it("idempotent: re-running ensure on an existing ATA does not revert", async function () {
        // Now that case 2 has created the wETH ATA, re-call ensure and verify success + no state churn.
        const ata = await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "ata", args: [me, WETH_MINT] });
        const lamportsBefore = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ata] });
        assert.ok(Number(lamportsBefore) > 0, "Test precondition: case 2 must have created the ATA");

        const txHash = await harness.write.ensure([me, WETH_MINT], { account: deployerAccount });
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        assert.equal(rc.status, "success");

        const lamportsAfter = await pc.readContract({ address: CPI, abi: cpiAbi, functionName: "account_lamports", args: [ata] });
        assert.equal(lamportsAfter, lamportsBefore, "ATA lamports should be unchanged on idempotent re-run");
    });
});
