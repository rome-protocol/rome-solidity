import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, encodePacked, zeroAddress, parseEventLogs } from "viem";
import { HELPER_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS } from "../precompile-addresses";

/// SPL_ERC20 (CPI-track wrapper) — the transfer path reaches the SPL move and one probe of the
/// recipient's token account (`account_info`: lamports and token-program owner). Nothing is
/// remembered per recipient, so a closed or pre-funded account is handled on every call.
/// `mint_info` is read per transfer only by a fee-capable wrapper.
///
/// Traps (see `HotPathMocks.sol`) are armed between two calls under test: the second call
/// succeeding while a trap is armed is the proof the path is gone.
describe("SPL_ERC20 — transfer path", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const CPI = CPI_PROGRAM_ADDRESS;
    const MINT = `0x${"a1".repeat(32)}` as `0x${string}`;
    const FEE_MINT = `0x${"a2".repeat(32)}` as `0x${string}`;
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
    const as = (i: number, c: any) => viem.getContractAt("SPL_ERC20", c.address, { client: { wallet: wallets[i] } });

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
        const client = await viem.getPublicClient();
        const code = await client.getCode({ address: mock.address });
        assert.ok(code && code !== "0x");
        for (const a of [HELPER, CPI]) {
            await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
        }
        // Fee-incapable mint (no extensions) — the common case.
        await ledger.write.setMint([0, 0]);
        wrapper = await viem.deployContract("SPL_ERC20", [MINT, CPI, "Wrapped", "WRAP"]);
        // Fee-capable mint: TransferFeeConfig present, 30 bps armed.
        await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
        feeWrapper = await viem.deployContract("SPL_ERC20", [FEE_MINT, CPI, "Fee", "FEE"]);
        await ledger.write.setMint([0, 0]);
    });

    it("fee capability is a constructor fact", async () => {
        assert.equal(await wrapper.read.fee_capable(), false);
        assert.equal(await feeWrapper.read.fee_capable(), true);
    });

    it("a cold transfer creates the recipient ATA", async () => {
        const w = await as(0, wrapper);
        await w.write.transfer([addr(1), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(1), MINT)]), true, "recipient ATA must be created on first sight");
    });

    it("a warm transfer neither reads the mint nor creates, but probes the recipient", async () => {
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        assert.ok(await w.write.transfer([addr(1), 5n]), "warm transfer must succeed with the mint and create traps armed");
        await ledger.write.setAccountReadTrap([true]);
        await assert.rejects(w.write.transfer([addr(1), 5n]), /account_info fired/, "the recipient is probed on every transfer");
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

    it("a fresh recipient is created", async () => {
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        await assert.rejects(w.write.transfer([addr(3), 5n]), /create must not run/);
        await disarmAll();
        await w.write.transfer([addr(3), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(3), MINT)]), true);
    });

    it("a closed recipient ATA is created again", async () => {
        const w = await as(0, wrapper);
        await w.write.transfer([addr(4), 5n]);
        const ata = deriveAta(addr(4), MINT);
        await ledger.write.close([ata]);
        assert.equal(await ledger.read.created([ata]), false);
        await w.write.transfer([addr(4), 5n]);
        assert.equal(await ledger.read.created([ata]), true, "a closed ATA must be re-created, not remembered as existing");
    });

    it("a pre-funded recipient address that no token program owns is created", async () => {
        const ata = deriveAta(addr(5), MINT);
        await ledger.write.prefund([ata]);
        const w = await as(0, wrapper);
        await w.write.transfer([addr(5), 5n]);
        assert.equal(await ledger.read.created([ata]), true, "lamports alone must not count as an existing token account");
    });

    it("ensure_token_account probes, creates only when missing and answers the ATA", async () => {
        const ata = deriveAta(addr(6), MINT);
        await wrapper.write.ensure_token_account([addr(6)]);
        assert.equal(await ledger.read.created([ata]), true);
        await ledger.write.setCreateTrap([true]);
        const { result } = await wrapper.simulate.ensure_token_account([addr(6)]);
        assert.equal(result, ata, "an existing ATA is answered without a create");
        await ledger.write.setAccountReadTrap([true]);
        await assert.rejects(wrapper.simulate.ensure_token_account([addr(6)]), /account_info fired/);
        await disarmAll();
    });

    it("ensure_token_account and create_token_account refuse the zero address", async () => {
        await assert.rejects(wrapper.write.ensure_token_account([zeroAddress]), /ERC20InvalidReceiver/);
        await assert.rejects(wrapper.write.create_token_account([zeroAddress, `0x${"00".repeat(32)}`]), /ERC20InvalidReceiver/);
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

    it("a fee-capable wrapper still reads the live fee on every transfer", async () => {
        await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
        const f = await as(0, feeWrapper);
        await f.write.transfer([addr(1), 5n]);
        await ledger.write.setMintInfoTrap([true]);
        await assert.rejects(f.write.transfer([addr(1), 5n]), /mint_info fired/, "fee-capable mints must keep measuring the fee");
        await disarmAll();
        await ledger.write.setMint([0, 0]);
    });
});
