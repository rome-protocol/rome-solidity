// Integration test for WrappedGasFacade against Hadrian.
//
// The facade is the WETH9-shaped surface over the gas-wrapper precompile legs
// (cached track): `deposit()` wraps native gas into the chain's gas-mint
// wrapper token, `withdraw(uint256)` unwraps it back, and both emit the
// canonical WETH9 `Deposit` / `Withdrawal` events so explorers, indexers and
// eth_getLogs consumers see the movement without special-casing.
//
// Cases:
//   1. deposit() with sub-token dust → wrapper balance credited, dust
//      refunded, Deposit event emitted
//   2. plain native send (receive()) → wraps, WETH9-equivalent
//   3. approve + withdraw() → native credited, Withdrawal event emitted
//   4. withdraw() with sub-token granularity → reverts
//
// Hadrian network only (live precompiles behind 0xff…0b are required).
// Run: npx hardhat test tests/wrapped_gas_facade.integration.ts --network hadrian
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { getAddress, parseAbi, parseEventLogs } from "viem";
import { readDeployments } from "../scripts/lib/deployments";

const erc20Abi = parseAbi([
    "function balanceOf(address) external view returns (uint256)",
    "function approve(address spender, uint256 value) external returns (bool)",
    "function decimals() external view returns (uint8)",
]);

const facadeEventsAbi = parseAbi([
    "event Deposit(address indexed dst, uint256 wad)",
    "event Withdrawal(address indexed src, uint256 wad)",
]);

describe("WrappedGasFacade (Hadrian)", function () {
    let facade: any;
    let pc: any;
    let me: `0x${string}`;
    let deployerAccount: any;
    let viem: any;
    let wrapperAddr: `0x${string}`;
    let weiPerToken: bigint;

    // 0.002 gas tokens — 2 000 raw at 6 decimals. Small on purpose.
    const WRAP_WEI = 2_000_000_000_000_000n;
    const DUST_WEI = 123_456_789n; // below weiPerToken; must be refunded

    before(async function () {
        const conn = (await hardhat.network.connect()) as any;
        viem = conn.viem;
        if (conn.networkName !== "hadrian") {
            throw new Error(`This integration test must run against hadrian; got ${conn.networkName}`);
        }
        const [deployer] = await viem.getWalletClients();
        deployerAccount = deployer.account;
        me = deployer.account.address;
        pc = await viem.getPublicClient();

        const wrapper = (readDeployments("hadrian") as any).SPL_ERC20_USDC?.address;
        if (!wrapper) throw new Error("SPL_ERC20_USDC missing from deployments/hadrian.json");
        wrapperAddr = getAddress(wrapper);

        facade = await viem.deployContract("WrappedGasFacade", [wrapperAddr]);
        const ensureHash = await facade.write.ensureAta([], { account: deployerAccount });
        await pc.waitForTransactionReceipt({ hash: ensureHash });
        const decimals = await pc.readContract({ address: wrapperAddr, abi: erc20Abi, functionName: "decimals", args: [] });
        weiPerToken = 10n ** BigInt(18 - Number(decimals));
        assert.equal(await facade.read.weiPerToken(), weiPerToken);
    });

    async function wrapperBalance(of: `0x${string}`): Promise<bigint> {
        return (await pc.readContract({ address: wrapperAddr, abi: erc20Abi, functionName: "balanceOf", args: [of] })) as bigint;
    }

    it("deposit() wraps native gas, refunds sub-token dust, emits Deposit", async function () {
        const balBefore = await wrapperBalance(me);
        const nativeBefore = await pc.getBalance({ address: me });

        const txHash = await facade.write.deposit([], { account: deployerAccount, value: WRAP_WEI + DUST_WEI });
        const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
        assert.equal(receipt.status, "success");

        const events = parseEventLogs({ abi: facadeEventsAbi, logs: receipt.logs, eventName: "Deposit" });
        assert.equal(events.length, 1, "exactly one Deposit event");
        assert.equal(events[0].args.dst.toLowerCase(), me.toLowerCase());
        assert.equal(events[0].args.wad, WRAP_WEI);

        const balAfter = await wrapperBalance(me);
        assert.equal(balAfter - balBefore, WRAP_WEI / weiPerToken, "wrapper tokens credited");

        // Dust must come back: native spent = WRAP_WEI + gas (not the dust).
        const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
        const nativeAfter = await pc.getBalance({ address: me });
        assert.equal(nativeBefore - nativeAfter, WRAP_WEI + gasPaid, "only whole-token wei + gas leaves the wallet");
    });

    it("plain native send wraps via receive()", async function () {
        const balBefore = await wrapperBalance(me);
        const [wallet] = await viem.getWalletClients();
        const txHash = await wallet.sendTransaction({ to: facade.address, value: WRAP_WEI });
        const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
        assert.equal(receipt.status, "success");

        const events = parseEventLogs({ abi: facadeEventsAbi, logs: receipt.logs, eventName: "Deposit" });
        assert.equal(events.length, 1, "receive() emits Deposit");
        assert.equal(await wrapperBalance(me) - balBefore, WRAP_WEI / weiPerToken);
    });

    it("withdraw() unwraps back to native gas, emits Withdrawal", async function () {
        const tokens = WRAP_WEI / weiPerToken;
        const [wallet] = await viem.getWalletClients();
        const approveHash = await wallet.writeContract({
            address: wrapperAddr,
            abi: erc20Abi,
            functionName: "approve",
            args: [facade.address, tokens],
        });
        await pc.waitForTransactionReceipt({ hash: approveHash });

        const balBefore = await wrapperBalance(me);
        const nativeBefore = await pc.getBalance({ address: me });

        const txHash = await facade.write.withdraw([WRAP_WEI], { account: deployerAccount });
        const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
        assert.equal(receipt.status, "success");

        const events = parseEventLogs({ abi: facadeEventsAbi, logs: receipt.logs, eventName: "Withdrawal" });
        assert.equal(events.length, 1, "exactly one Withdrawal event");
        assert.equal(events[0].args.src.toLowerCase(), me.toLowerCase());
        assert.equal(events[0].args.wad, WRAP_WEI);

        assert.equal(balBefore - (await wrapperBalance(me)), tokens, "wrapper tokens pulled");

        const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
        const nativeAfter = await pc.getBalance({ address: me });
        assert.equal(nativeAfter - nativeBefore, WRAP_WEI - gasPaid, "native credited minus gas");

        // No residue may accumulate on the facade.
        assert.equal(await wrapperBalance(facade.address), 0n, "facade holds no wrapper residue");
        assert.equal(await pc.getBalance({ address: facade.address }), 0n, "facade holds no native residue");
    });

    it("withdraw() with sub-token granularity reverts", async function () {
        await assert.rejects(
            facade.write.withdraw([WRAP_WEI + DUST_WEI], { account: deployerAccount }),
            /granularity|revert/i,
        );
    });
});
