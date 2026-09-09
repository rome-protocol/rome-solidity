import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, encodePacked } from "viem";
import {
    HELPER_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
    ASSOCIATED_SPL_CACHED_ADDRESS,
} from "../precompile-addresses";

/// SPL_ERC20_cached (the canonical wrapper) — same three hot-path costs as the
/// CPI-track sibling, plus one of its own: `_transfer` probed
/// `SplCached.account(to)` on EVERY transfer, BEFORE consulting `_ataCreated`,
/// and never set the flag when the probe found the account — so a recipient
/// whose ATA pre-existed paid the probe forever. Flag first; a successful probe
/// records the flag; the create path records it too.
describe("SPL_ERC20_cached — warm transfer hot path", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const SPL_CACHED = SPL_CACHED_ADDRESS;
    const ASSOC = ASSOCIATED_SPL_CACHED_ADDRESS;
    const MINT = `0x${"c1".repeat(32)}` as `0x${string}`;
    const FEE_MINT = `0x${"c2".repeat(32)}` as `0x${string}`;
    const TRANSFER_FEE_CONFIG_BIT = 1 << 1;

    let viem: any;
    let conn: any;
    let ledger: any;
    let users: any;
    let wrapper: any;
    let feeWrapper: any;
    let wallets: any[];

    const deriveAta = (user: `0x${string}`, mint: `0x${string}`) =>
        keccak256(encodePacked(["string", "address", "bytes32"], ["mock-ata", user, mint]));
    const addr = (i: number) => wallets[i].account.address as `0x${string}`;
    const as = (i: number, c: any) =>
        viem.getContractAt("SPL_ERC20_cached", c.address, { client: { wallet: wallets[i] } });

    async function armAll() {
        await users.write.setArmed([true]);
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setAccountReadTrap([true]);
        await ledger.write.setCreateTrap([true]);
    }
    async function disarmAll() {
        await users.write.setArmed([false]);
        await ledger.write.setMintInfoTrap([false]);
        await ledger.write.setAccountReadTrap([false]);
        await ledger.write.setCreateTrap([false]);
    }

    before(async () => {
        conn = await hardhat.network.connect();
        viem = conn.viem;
        wallets = await viem.getWalletClients();
        ledger = await viem.deployContract("HotPathLedger", []);
        users = await viem.deployContract("TrappingUsers", []);
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
        wrapper = await viem.deployContract("SPL_ERC20_cached", [MINT, ASSOC, "Wrapped", "WRAP", users.address]);
        await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
        feeWrapper = await viem.deployContract("SPL_ERC20_cached", [FEE_MINT, ASSOC, "Fee", "FEE", users.address]);
        await ledger.write.setMint([0, 0]);
    });

    it("fee capability is a constructor fact", async () => {
        assert.equal(await wrapper.read.fee_capable(), false);
        assert.equal(await feeWrapper.read.fee_capable(), true);
    });

    it("a cold transfer creates the recipient ATA but never registers the caller", async () => {
        await users.write.setArmed([true]);
        const w = await as(0, wrapper);
        await w.write.transfer([addr(1), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(1), MINT)]), true);
        await disarmAll();
    });

    it("a warm transfer reads neither the registry, nor the mint, nor the recipient account", async () => {
        await armAll();
        const w = await as(0, wrapper);
        const tx = await w.write.transfer([addr(1), 5n]);
        assert.ok(tx, "warm transfer must succeed with every hot-path trap armed");
        await disarmAll();
    });

    it("transferFrom takes the same warm path", async () => {
        const w0 = await as(0, wrapper);
        await w0.write.approve([addr(2), 100n]);
        await armAll();
        const w2 = await as(2, wrapper);
        assert.ok(await w2.write.transferFrom([addr(0), addr(1), 5n]));
        assert.equal(await wrapper.read.allowance([addr(0), addr(2)]), 95n);
        await disarmAll();
    });

    it("a recipient whose ATA pre-exists is probed once, then never again", async () => {
        // ATA exists on chain but this wrapper has never seen it.
        await ledger.write.recordCreated([deriveAta(addr(3), MINT)]);
        await ledger.write.setCreateTrap([true]); // exists → must not create
        const w = await as(0, wrapper);
        await w.write.transfer([addr(3), 5n]); // probe fires, learns the flag
        await ledger.write.setAccountReadTrap([true]);
        const tx = await w.write.transfer([addr(3), 5n]);
        assert.ok(tx, "second transfer must not re-probe an ATA the first one found");
        await disarmAll();
    });

    it("a fresh recipient still creates — the flag is per-user", async () => {
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        await assert.rejects(w.write.transfer([addr(4), 5n]), /create_ata fired/);
        await disarmAll();
        await w.write.transfer([addr(4), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(4), MINT)]), true);
    });

    it("public ensure_token_account still answers the ATA on the fast path, without probing", async () => {
        await ledger.write.setAccountReadTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const { result } = await wrapper.simulate.ensure_token_account([addr(1)]);
        assert.equal(result, deriveAta(addr(1), MINT));
        await disarmAll();
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
