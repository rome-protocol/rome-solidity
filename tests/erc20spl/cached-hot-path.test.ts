import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, encodePacked, zeroAddress, parseEventLogs } from "viem";
import {
    HELPER_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
    ASSOCIATED_SPL_CACHED_ADDRESS,
} from "../precompile-addresses";

/// SPL_ERC20_cached (the canonical wrapper) — a transfer probes the recipient's token account
/// with `SplCached.account` (overlay-aware) on every call and creates it on a miss. Nothing is
/// remembered per recipient, so a closed account is created again. An account the transaction
/// does not list fails closed with `SolanaAccountNotListed`; a listed but absent one is created.
describe("SPL_ERC20_cached — transfer path", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const SPL_CACHED = SPL_CACHED_ADDRESS;
    const ASSOC = ASSOCIATED_SPL_CACHED_ADDRESS;
    const MINT = `0x${"c1".repeat(32)}` as `0x${string}`;
    const FEE_MINT = `0x${"c2".repeat(32)}` as `0x${string}`;
    const TRANSFER_FEE_CONFIG_BIT = 1 << 1;

    let viem: any;
    let conn: any;
    let ledger: any;
    let wrapper: any;
    let feeWrapper: any;
    let wallets: any[];

    const deriveAta = (user: `0x${string}`, mint: `0x${string}`) =>
        keccak256(encodePacked(["string", "address", "bytes32"], ["mock-ata", user, mint]));
    const addr = (i: number) => wallets[i].account.address as `0x${string}`;
    const as = (i: number, c: any) =>
        viem.getContractAt("SPL_ERC20_cached", c.address, { client: { wallet: wallets[i] } });

    async function disarmAll() {
        await ledger.write.setMintInfoTrap([false]);
        await ledger.write.setAccountReadTrap([false]);
        await ledger.write.setCreateTrap([false]);
    }

    before(async () => {
        conn = await hardhat.network.connect();
        viem = conn.viem;
        wallets = await viem.getWalletClients();
        ledger = await viem.deployContract("HotPathLedger", []);
        const mock = await viem.deployContract("HotPathPrecompileMock", [ledger.address]);
        const assoc = await viem.deployContract("HotPathAssocMock", [ledger.address]);
        const client = await viem.getPublicClient();
        const code = await client.getCode({ address: mock.address });
        const assocCode = await client.getCode({ address: assoc.address });
        assert.ok(code && code !== "0x" && assocCode && assocCode !== "0x");
        for (const a of [HELPER, SPL_CACHED]) {
            await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
        }
        await conn.provider.request({ method: "hardhat_setCode", params: [ASSOC, assocCode] });
        await ledger.write.setMint([0, 0]);
        wrapper = await viem.deployContract("SPL_ERC20_cached", [MINT, ASSOC, "Wrapped", "WRAP"]);
        await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
        feeWrapper = await viem.deployContract("SPL_ERC20_cached", [FEE_MINT, ASSOC, "Fee", "FEE"]);
        await ledger.write.setMint([0, 0]);
    });

    it("fee capability is a constructor fact", async () => {
        assert.equal(await wrapper.read.fee_capable(), false);
        assert.equal(await feeWrapper.read.fee_capable(), true);
    });

    it("a cold transfer creates the recipient ATA", async () => {
        const w = await as(0, wrapper);
        await w.write.transfer([addr(1), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(1), MINT)]), true);
    });

    it("a warm transfer neither reads the mint nor creates, but probes the recipient", async () => {
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        assert.ok(await w.write.transfer([addr(1), 5n]), "warm transfer must succeed with the mint and create traps armed");
        await ledger.write.setAccountReadTrap([true]);
        // A probe that reverts reads as a miss, so a tripped probe shows up as the create it then attempts.
        await assert.rejects(w.write.transfer([addr(1), 5n]), /create must not run/, "the recipient is probed on every transfer");
        await disarmAll();
    });

    it("transferFrom takes the same path", async () => {
        const w0 = await as(0, wrapper);
        await w0.write.approve([addr(2), 100n]);
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const w2 = await as(2, wrapper);
        assert.ok(await w2.write.transferFrom([addr(0), addr(1), 5n]));
        assert.equal(await wrapper.read.allowance([addr(0), addr(2)]), 95n);
        await disarmAll();
    });

    it("a recipient whose ATA pre-exists is found by the probe and not created", async () => {
        await ledger.write.recordCreated([deriveAta(addr(3), MINT)]);
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        assert.ok(await w.write.transfer([addr(3), 5n]));
        await disarmAll();
    });

    it("a fresh recipient is created", async () => {
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        await assert.rejects(w.write.transfer([addr(4), 5n]), /create must not run/);
        await disarmAll();
        await w.write.transfer([addr(4), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(4), MINT)]), true);
    });

    it("a closed recipient ATA is created again", async () => {
        const w = await as(0, wrapper);
        await w.write.transfer([addr(5), 5n]);
        const ata = deriveAta(addr(5), MINT);
        await ledger.write.close([ata]);
        await w.write.transfer([addr(5), 5n]);
        assert.equal(await ledger.read.created([ata]), true, "a closed ATA must be re-created, not remembered as existing");
    });

    it("ensure_token_account probes, creates only when missing and answers the ATA", async () => {
        const ata = deriveAta(addr(6), MINT);
        await wrapper.write.ensure_token_account([addr(6)]);
        assert.equal(await ledger.read.created([ata]), true);
        await ledger.write.setCreateTrap([true]);
        const { result } = await wrapper.simulate.ensure_token_account([addr(6)]);
        assert.equal(result, ata);
        await ledger.write.setAccountReadTrap([true]);
        await assert.rejects(wrapper.simulate.ensure_token_account([addr(6)]), /create must not run/, "the probe runs on every call");
        await disarmAll();
    });

    it("ensure_token_account and create_token_account refuse the zero address", async () => {
        await assert.rejects(wrapper.write.ensure_token_account([zeroAddress]), /ERC20InvalidReceiver/);
        await assert.rejects(wrapper.write.create_token_account([zeroAddress]), /ERC20InvalidReceiver/);
    });

    it("a transfer to the zero address reverts", async () => {
        const w = await as(0, wrapper);
        await assert.rejects(w.write.transfer([zeroAddress, 5n]), /ERC20InvalidReceiver/);
        await assert.rejects(w.write.transfer([zeroAddress, 0n]), /ERC20InvalidReceiver/);
    });

    it("a zero-value transfer emits Transfer and touches no precompile", async () => {
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setAccountReadTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        const hash = await w.write.transfer([addr(7), 0n]);
        const receipt = await (await viem.getPublicClient()).getTransactionReceipt({ hash });
        const logs = parseEventLogs({ abi: wrapper.abi, logs: receipt.logs, eventName: "Transfer" });
        assert.equal(logs.length, 1);
        assert.equal(logs[0].args.value, 0n);
        assert.equal(await ledger.read.created([deriveAta(addr(7), MINT)]), false, "no ATA is created for a zero value");
        await disarmAll();
    });

    describe("an account the transaction does not list fails closed", () => {
        it("balanceOf and isEnabled revert; a listed but empty account still reads 0", async () => {
            const ata = deriveAta(addr(8), MINT);
            assert.equal(await wrapper.read.balanceOf([addr(8)]), 0n, "absent but listed: reads 0");
            assert.equal(await wrapper.read.isEnabled([addr(8)]), false);
            await ledger.write.setNotListed([ata, true]);
            await assert.rejects(wrapper.read.balanceOf([addr(8)]), /SolanaAccountNotListed/);
            await assert.rejects(wrapper.read.isEnabled([addr(8)]), /SolanaAccountNotListed/);
            await ledger.write.setNotListed([ata, false]);
        });

        it("a transfer to an unlisted recipient reverts and creates nothing", async () => {
            const ata = deriveAta(addr(9), MINT);
            await ledger.write.setNotListed([ata, true]);
            const w = await as(0, wrapper);
            await assert.rejects(w.write.transfer([addr(9), 5n]), /SolanaAccountNotListed/);
            await assert.rejects(wrapper.write.ensure_token_account([addr(9)]), /SolanaAccountNotListed/);
            assert.equal(await ledger.read.created([ata]), false);
            await ledger.write.setNotListed([ata, false]);
        });

        it("an unlisted escrow ATA reverts a transfer to a contract holder", async () => {
            const escrow = deriveAta(wrapper.address, MINT);
            await ledger.write.setNotListed([escrow, true]);
            const w = await as(0, wrapper);
            await assert.rejects(w.write.transfer([ledger.address, 5n]), /SolanaAccountNotListed/);
            await ledger.write.setNotListed([escrow, false]);
        });

        it("a fee-capable wrapper's pre-transfer balance read fails closed too", async () => {
            await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
            const ata = deriveAta(addr(10), FEE_MINT);
            await ledger.write.setNotListed([ata, true]);
            const f = await as(0, feeWrapper);
            await assert.rejects(f.write.transfer([addr(10), 5n]), /SolanaAccountNotListed/);
            await ledger.write.setNotListed([ata, false]);
            await ledger.write.setMint([0, 0]);
        });

        it("a fee-capable wrapper's escrow balance read fails closed once the escrow is created", async () => {
            await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
            const f = await as(0, feeWrapper);
            await f.write.transfer([ledger.address, 5n]);
            const escrow = deriveAta(feeWrapper.address, FEE_MINT);
            await ledger.write.setNotListed([escrow, true]);
            await assert.rejects(f.write.transfer([ledger.address, 5n]), /SolanaAccountNotListed/);
            await ledger.write.setNotListed([escrow, false]);
            await ledger.write.setMint([0, 0]);
        });
    });

    it("a fee-capable wrapper still reads the live fee on every transfer", async () => {
        await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
        const f = await as(0, feeWrapper);
        await f.write.transfer([addr(1), 5n]);
        await ledger.write.setMintInfoTrap([true]);
        await assert.rejects(f.write.transfer([addr(1), 5n]), /mint_info fired/);
        await disarmAll();
        await ledger.write.setMint([0, 0]);
    });
});
