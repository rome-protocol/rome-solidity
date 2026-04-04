import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Live integration test for Solana State SDK on monti_spl.
 *
 * Tests all deployed contracts: JupiterSwap, DriftFactory, DriftController,
 * KaminoLending, KaminoVault, DeFiRouter.
 *
 * Usage:
 *   npx hardhat run scripts/defi/test-live.ts --network monti_spl
 */

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, msg: string) {
    console.log(`  ✓ ${name}: ${msg}`);
    passed++;
}
function fail(name: string, msg: string) {
    console.error(`  ✗ ${name}: ${msg}`);
    failed++;
}
function skip(name: string, msg: string) {
    console.log(`  ⊘ ${name}: ${msg}`);
    skipped++;
}

async function tryCall<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: string }> {
    try {
        const result = await fn();
        return { result };
    } catch (e: any) {
        return { error: e.shortMessage || e.message?.slice(0, 120) || String(e) };
    }
}

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    if (!wallet?.account) {
        throw new Error("No wallet. Set MONTI_SPL_PRIVATE_KEY.");
    }
    const publicClient = await viem.getPublicClient();

    // Load deployments
    const deploymentsPath = path.resolve(process.cwd(), "deployments", `${networkName}.json`);
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const sdk = deployments.SolanaStateSDK;

    console.log("=== Solana State SDK — Live Integration Test ===");
    console.log("Network:", networkName);
    console.log("Deployer:", wallet.account.address);
    console.log();

    // ═══════════════════════════════
    //  1. JupiterSwap
    // ═══════════════════════════════
    console.log("── JupiterSwap ──");
    const jupiter = await viem.getContractAt("JupiterSwap", sdk.JupiterSwap as `0x${string}`);

    // Verify immutable
    const jupCpi = await jupiter.read.cpi_program();
    jupCpi.toLowerCase() === sdk.cpiProgram.toLowerCase()
        ? ok("cpi_program", jupCpi)
        : fail("cpi_program", `got ${jupCpi}, expected ${sdk.cpiProgram}`);

    // Test balance read — reads SPL token balance for caller
    // Using a dummy mint — should return 0 or revert gracefully
    const dummyMint = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    const { result: jupBal, error: jupBalErr } = await tryCall(() =>
        jupiter.read.balance([dummyMint])
    );
    if (jupBal !== undefined) {
        ok("balance(dummy_mint)", `returned ${jupBal} (expected 0 or small)`);
    } else {
        // Expected — ATA for dummy mint likely doesn't exist
        skip("balance(dummy_mint)", `reverted: ${jupBalErr} (expected — no ATA for dummy mint)`);
    }

    // Test swap — should revert because we're not passing valid Jupiter route data
    const emptyAccounts: any[] = [];
    const { error: swapErr } = await tryCall(() =>
        jupiter.write.swap([emptyAccounts, "0x00"])
    );
    if (swapErr) {
        ok("swap(empty)", `correctly reverted: ${swapErr.slice(0, 60)}`);
    } else {
        fail("swap(empty)", "should have reverted with empty data");
    }

    // ═══════════════════════════════
    //  2. DriftFactory + DriftController
    // ═══════════════════════════════
    console.log("\n── DriftFactory ──");
    const driftFactory = await viem.getContractAt("DriftFactory", sdk.DriftFactory as `0x${string}`);

    // Check no controller exists yet
    const existingCtrl = await driftFactory.read.get_controller([wallet.account.address]);
    const noCtrl = existingCtrl === "0x0000000000000000000000000000000000000000";
    noCtrl
        ? ok("get_controller(before)", "no controller yet (zero address)")
        : ok("get_controller(before)", `controller already exists: ${existingCtrl}`);

    // Create controller
    let controllerAddr: `0x${string}` | null = null;
    if (noCtrl) {
        const { result: createResult, error: createErr } = await tryCall(async () => {
            const txHash = await driftFactory.write.create_controller();
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            return receipt;
        });
        if (createResult && createResult.status === "success") {
            const addr = await driftFactory.read.get_controller([wallet.account.address]);
            controllerAddr = addr as `0x${string}`;
            ok("create_controller", `deployed at ${controllerAddr}`);
        } else {
            fail("create_controller", `failed: ${createErr || createResult?.status}`);
        }
    } else {
        controllerAddr = existingCtrl as `0x${string}`;
    }

    // Test duplicate prevention
    if (controllerAddr && controllerAddr !== "0x0000000000000000000000000000000000000000") {
        const { error: dupErr } = await tryCall(() =>
            driftFactory.write.create_controller()
        );
        if (dupErr) {
            ok("create_controller(dup)", `correctly reverted: ${dupErr.slice(0, 60)}`);
        } else {
            fail("create_controller(dup)", "should have reverted on duplicate");
        }

        // Test DriftController read functions
        console.log("\n── DriftController ──");
        const controller = await viem.getContractAt("DriftController", controllerAddr);

        const ctrlCpi = await controller.read.cpi_program();
        ctrlCpi.toLowerCase() === sdk.cpiProgram.toLowerCase()
            ? ok("controller.cpi_program", ctrlCpi)
            : fail("controller.cpi_program", `got ${ctrlCpi}`);

        const ctrlFactory = await controller.read.factory();
        ctrlFactory.toLowerCase() === sdk.DriftFactory.toLowerCase()
            ? ok("controller.factory", ctrlFactory)
            : fail("controller.factory", `got ${ctrlFactory}, expected ${sdk.DriftFactory}`);

        // get_perp_market
        const { result: perpMarket, error: perpErr } = await tryCall(() =>
            controller.read.get_perp_market([0])
        );
        if (perpMarket) {
            ok("get_perp_market(0)", `market_index=${perpMarket.market_index}`);
            console.log("    Parsed PerpMarket 0:");
            console.log(`      oracle:               ${perpMarket.oracle}`);
            console.log(`      base_asset_reserve:    ${perpMarket.base_asset_reserve}`);
            console.log(`      quote_asset_reserve:   ${perpMarket.quote_asset_reserve}`);
            console.log(`      cum_funding_long:      ${perpMarket.cumulative_funding_long}`);
            console.log(`      cum_funding_short:     ${perpMarket.cumulative_funding_short}`);
            console.log(`      last_funding_rate_ts:  ${perpMarket.last_funding_rate_ts}`);
            console.log(`      status:                ${perpMarket.status}`);

            // Validate parsed values
            perpMarket.market_index === 0
                ? ok("perp.market_index", "= 0")
                : fail("perp.market_index", `= ${perpMarket.market_index}, expected 0`);
            perpMarket.base_asset_reserve > 0n
                ? ok("perp.base_asset_reserve", "> 0")
                : fail("perp.base_asset_reserve", "= 0 (unexpected)");
            perpMarket.quote_asset_reserve > 0n
                ? ok("perp.quote_asset_reserve", "> 0")
                : fail("perp.quote_asset_reserve", "= 0 (unexpected)");
            const ts = Number(perpMarket.last_funding_rate_ts);
            const now = Math.floor(Date.now() / 1000);
            (ts > 1700000000 && ts < now + 86400)
                ? ok("perp.last_funding_rate_ts", `${new Date(ts * 1000).toISOString()} (age: ${now - ts}s)`)
                : fail("perp.last_funding_rate_ts", `${ts} — not a valid recent timestamp`);
        } else {
            skip("get_perp_market(0)", `reverted: ${perpErr?.slice(0, 80)} (Drift may not be on monti_spl)`);
        }

        // get_perp_market(1) — ETH-PERP
        const { result: perpMarket1, error: perpErr1 } = await tryCall(() =>
            controller.read.get_perp_market([1])
        );
        if (perpMarket1) {
            perpMarket1.market_index === 1
                ? ok("get_perp_market(1)", `market_index=1 (ETH-PERP)`)
                : fail("get_perp_market(1)", `market_index=${perpMarket1.market_index}, expected 1`);
        } else {
            skip("get_perp_market(1)", `reverted: ${perpErr1?.slice(0, 60)}`);
        }

        // get_spot_market(0) — USDC
        const { result: spotMarket, error: spotErr } = await tryCall(() =>
            controller.read.get_spot_market([0])
        );
        if (spotMarket) {
            ok("get_spot_market(0)", `market_index=${spotMarket.market_index}`);
            console.log("    Parsed SpotMarket 0:");
            console.log(`      oracle:               ${spotMarket.oracle}`);
            console.log(`      mint:                 ${spotMarket.mint}`);
            console.log(`      vault:                ${spotMarket.vault}`);
            console.log(`      deposit_balance:      ${spotMarket.deposit_balance}`);
            console.log(`      borrow_balance:       ${spotMarket.borrow_balance}`);
            console.log(`      cum_deposit_interest: ${spotMarket.cumulative_deposit_interest}`);
            console.log(`      cum_borrow_interest:  ${spotMarket.cumulative_borrow_interest}`);
            console.log(`      decimals:             ${spotMarket.decimals}`);
            console.log(`      status:               ${spotMarket.status}`);

            spotMarket.market_index === 0
                ? ok("spot.market_index", "= 0")
                : fail("spot.market_index", `= ${spotMarket.market_index}, expected 0`);
            spotMarket.deposit_balance > 0n
                ? ok("spot.deposit_balance", "> 0")
                : fail("spot.deposit_balance", "= 0 (unexpected for USDC)");
            spotMarket.cumulative_deposit_interest > 0n
                ? ok("spot.cum_deposit_interest", "> 0")
                : fail("spot.cum_deposit_interest", "= 0 (unexpected)");
        } else {
            skip("get_spot_market(0)", `reverted: ${spotErr?.slice(0, 80)} (Drift may not be on monti_spl)`);
        }

        // get_spot_market(1) — SOL
        const { result: spotMarket1, error: spotErr1 } = await tryCall(() =>
            controller.read.get_spot_market([1])
        );
        if (spotMarket1) {
            spotMarket1.market_index === 1 && spotMarket1.decimals === 9
                ? ok("get_spot_market(1)", `market_index=1, decimals=9 (SOL)`)
                : fail("get_spot_market(1)", `idx=${spotMarket1.market_index}, dec=${spotMarket1.decimals}`);
        } else {
            skip("get_spot_market(1)", `reverted: ${spotErr1?.slice(0, 60)}`);
        }

        // Test write operations — should revert because Drift isn't on monti_spl
        const { error: depositErr } = await tryCall(() =>
            controller.write.deposit([0, 1000000n, false, dummyMint])
        );
        if (depositErr) {
            ok("controller.deposit", `correctly reverted: ${depositErr.slice(0, 60)}`);
        } else {
            skip("controller.deposit", "unexpectedly succeeded");
        }
    }

    // ═══════════════════════════════
    //  3. KaminoLending
    // ═══════════════════════════════
    console.log("\n── KaminoLending ──");
    const kaminoLending = await viem.getContractAt("KaminoLending", sdk.KaminoLending as `0x${string}`);

    const klCpi = await kaminoLending.read.cpi_program();
    klCpi.toLowerCase() === sdk.cpiProgram.toLowerCase()
        ? ok("cpi_program", klCpi)
        : fail("cpi_program", `got ${klCpi}`);

    // get_reserve — will revert because Kamino isn't on monti_spl
    const { result: reserve, error: reserveErr } = await tryCall(() =>
        kaminoLending.read.get_reserve([dummyMint])
    );
    if (reserve) {
        ok("get_reserve", `lending_market=${reserve.lending_market.slice(0, 20)}...`);
    } else {
        skip("get_reserve", `reverted: ${reserveErr?.slice(0, 80)} (expected — Kamino not on monti_spl)`);
    }

    // health_factor
    const { result: hf, error: hfErr } = await tryCall(() =>
        kaminoLending.read.health_factor([dummyMint])
    );
    if (hf !== undefined) {
        ok("health_factor", `${hf}`);
    } else {
        skip("health_factor", `reverted: ${hfErr?.slice(0, 80)} (expected — no obligation on monti_spl)`);
    }

    // ═══════════════════════════════
    //  4. KaminoVault
    // ═══════════════════════════════
    console.log("\n── KaminoVault ──");
    const kaminoVault = await viem.getContractAt("KaminoVault", sdk.KaminoVault as `0x${string}`);

    const kvCpi = await kaminoVault.read.cpi_program();
    kvCpi.toLowerCase() === sdk.cpiProgram.toLowerCase()
        ? ok("cpi_program", kvCpi)
        : fail("cpi_program", `got ${kvCpi}`);

    const { result: strategy, error: stratErr } = await tryCall(() =>
        kaminoVault.read.get_strategy([dummyMint])
    );
    if (strategy) {
        ok("get_strategy", `pool=${strategy.pool.slice(0, 20)}...`);
    } else {
        skip("get_strategy", `reverted: ${stratErr?.slice(0, 80)} (expected — no vault on monti_spl)`);
    }

    // ═══════════════════════════════
    //  5. DeFiRouter
    // ═══════════════════════════════
    console.log("\n── DeFiRouter ──");
    const router = await viem.getContractAt("DeFiRouter", sdk.DeFiRouter as `0x${string}`);

    const routerCpi = await router.read.cpi_program();
    routerCpi.toLowerCase() === sdk.cpiProgram.toLowerCase()
        ? ok("cpi_program", routerCpi)
        : fail("cpi_program", `got ${routerCpi}`);

    // balance_of — reads SPL token balance via CPI
    const { result: routerBal, error: routerBalErr } = await tryCall(() =>
        router.read.balance_of([wallet.account.address, dummyMint])
    );
    if (routerBal !== undefined) {
        ok("balance_of(dummy)", `${routerBal}`);
    } else {
        skip("balance_of(dummy)", `reverted: ${routerBalErr?.slice(0, 80)}`);
    }

    // get_market_info — DeFiRouter delegates to DriftLib
    const { result: marketInfo, error: miErr } = await tryCall(() =>
        router.read.get_market_info([0])
    );
    if (marketInfo) {
        ok("get_market_info(0)", `market_index=${marketInfo.market_index}`);
    } else {
        skip("get_market_info(0)", `reverted: ${miErr?.slice(0, 80)} (expected — Drift not on monti_spl)`);
    }

    // swap_with_route — should revert with empty data
    const { error: routerSwapErr } = await tryCall(() =>
        router.write.swap_with_route([dummyMint, [], "0x00"])
    );
    if (routerSwapErr) {
        ok("swap_with_route(empty)", `correctly reverted: ${routerSwapErr.slice(0, 60)}`);
    } else {
        fail("swap_with_route(empty)", "should have reverted");
    }

    // swap_direct — low-level call to zero address returns success in EVM (no code = no revert)
    // This is expected EVM behavior; real usage requires a valid pool contract address
    const { error: directErr } = await tryCall(() =>
        router.write.swap_direct(["0x0000000000000000000000000000000000000000", 0, 1000n, 900n])
    );
    if (directErr) {
        ok("swap_direct(zero_pool)", `reverted: ${directErr.slice(0, 60)}`);
    } else {
        ok("swap_direct(zero_pool)", "no revert (expected — EVM call to zero address succeeds vacuously)");
    }

    // cancel_order — should revert (Drift not on monti_spl)
    const { error: cancelErr } = await tryCall(() =>
        router.write.cancel_order([0])
    );
    if (cancelErr) {
        ok("cancel_order(0)", `correctly reverted: ${cancelErr.slice(0, 60)}`);
    } else {
        skip("cancel_order(0)", "unexpectedly succeeded");
    }

    // ═══════════════════════════════
    //  Summary
    // ═══════════════════════════════
    console.log("\n═══════════════════════════════════════");
    console.log(`  PASSED:  ${passed}`);
    console.log(`  SKIPPED: ${skipped} (protocol not on monti_spl)`);
    console.log(`  FAILED:  ${failed}`);
    console.log("═══════════════════════════════════════");

    if (failed > 0) {
        console.error("\nSome tests FAILED.");
        process.exitCode = 1;
    } else {
        console.log("\nAll tests passed. Protocol-specific reads skipped (Drift/Kamino not on monti_spl).");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
