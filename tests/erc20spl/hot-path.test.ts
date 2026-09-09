import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, encodePacked } from "viem";
import { HELPER_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS } from "../precompile-addresses";

/// SPL_ERC20 (CPI-track wrapper) — the warm transfer path reaches exactly one
/// precompile write. Three per-transfer costs that bought nothing are gone:
///
///   1. `ERC20Users.ensure_user(msg.sender)` — a CALL into the registry (SLOAD,
///      SSTORE the first time) whose result the transfer discarded; nothing
///      reads `get_user` any more.
///   2. `HelperProgram.mint_info(mint)` — a mint load + parse on EVERY transfer
///      just to learn `feeBps`. A Tokenkeg mint can never carry a fee and a
///      Token-2022 mint's TransferFeeConfig is fixed at InitializeMint, so fee
///      CAPABILITY is a constructor fact (`fee_capable`); only fee-capable
///      wrappers read the live bps per transfer.
///   3. `HelperProgram.ata(to)` + `lamportsOf` — derivation and existence probe
///      of the recipient ATA after the wrapper already recorded it exists.
///
/// Traps (see `HotPathMocks.sol`) are armed between two calls under test: the
/// second call succeeding while a trap is armed is the proof the path is gone.
describe("SPL_ERC20 — warm transfer hot path", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const CPI = CPI_PROGRAM_ADDRESS;
    const MINT = `0x${"a1".repeat(32)}` as `0x${string}`;
    const FEE_MINT = `0x${"a2".repeat(32)}` as `0x${string}`;
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
    const as = (i: number, c: any) => viem.getContractAt("SPL_ERC20", c.address, { client: { wallet: wallets[i] } });

    async function disarmAll() {
        await ledger.write.setMintInfoTrap([false]);
        await ledger.write.setAccountReadTrap([false]);
        await ledger.write.setCreateTrap([false]);
        await users.write.setArmed([false]);
    }

    before(async () => {
        conn = await hardhat.network.connect();
        viem = conn.viem;
        wallets = await viem.getWalletClients();
        ledger = await viem.deployContract("HotPathLedger", []);
        users = await viem.deployContract("TrappingUsers", []);
        const mock = await viem.deployContract("HotPathPrecompileMock", [ledger.address]);
        const client = await viem.getPublicClient();
        const code = await client.getCode({ address: mock.address });
        assert.ok(code && code !== "0x");
        for (const a of [HELPER, CPI]) {
            await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
        }
        // Fee-incapable mint (no extensions) — the common case.
        await ledger.write.setMint([0, 0]);
        wrapper = await viem.deployContract("SPL_ERC20", [MINT, CPI, "Wrapped", "WRAP", users.address]);
        // Fee-capable mint: TransferFeeConfig present, 30 bps armed.
        await ledger.write.setMint([TRANSFER_FEE_CONFIG_BIT, 30]);
        feeWrapper = await viem.deployContract("SPL_ERC20", [FEE_MINT, CPI, "Fee", "FEE", users.address]);
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
        assert.equal(await ledger.read.created([deriveAta(addr(1), MINT)]), true, "recipient ATA must be created on first sight");
        await disarmAll();
    });

    it("a warm transfer reads neither the registry, nor the mint, nor the recipient ATA", async () => {
        await users.write.setArmed([true]);
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setAccountReadTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        const tx = await w.write.transfer([addr(1), 5n]);
        assert.ok(tx, "warm transfer must succeed with every hot-path trap armed");
        await disarmAll();
    });

    it("transferFrom takes the same warm path", async () => {
        const w0 = await as(0, wrapper);
        await w0.write.approve([addr(2), 100n]);
        await users.write.setArmed([true]);
        await ledger.write.setMintInfoTrap([true]);
        await ledger.write.setAccountReadTrap([true]);
        await ledger.write.setCreateTrap([true]);
        const w2 = await as(2, wrapper);
        const tx = await w2.write.transferFrom([addr(0), addr(1), 5n]);
        assert.ok(tx);
        assert.equal(await wrapper.read.allowance([addr(0), addr(2)]), 95n);
        await disarmAll();
    });

    it("a fresh recipient still probes and creates — the flag is per-user", async () => {
        await ledger.write.setCreateTrap([true]);
        const w = await as(0, wrapper);
        await assert.rejects(w.write.transfer([addr(3), 5n]), /create_ata fired/);
        await disarmAll();
        await w.write.transfer([addr(3), 5n]);
        assert.equal(await ledger.read.created([deriveAta(addr(3), MINT)]), true);
    });

    it("public ensure_token_account still answers the ATA on the fast path, without probing", async () => {
        await ledger.write.setAccountReadTrap([true]);
        const { result } = await wrapper.simulate.ensure_token_account([addr(1)]);
        assert.equal(result, deriveAta(addr(1), MINT));
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
