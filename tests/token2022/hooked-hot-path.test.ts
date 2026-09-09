import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
    HELPER_PROGRAM_ADDRESS,
    CPI_PROGRAM_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
} from "../precompile-addresses";

/// SPL_ERC20_Token2022Hooked — the hook-aware wrapper's transfer path derived
/// `RomeEVMAccount.pda(address(this))` (a HelperProgram precompile call) on
/// EVERY transfer for a value that never changes, and registered the caller in
/// `ERC20Users` for nothing. The wrapper PDA is now an immutable (`self_pda`)
/// and the registry call is gone. `mint_info` per transfer STAYS: it is the
/// check that the hook program was not rotated under the wrapper.
describe("SPL_ERC20_Token2022Hooked — warm transfer hot path", async () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const CPI = CPI_PROGRAM_ADDRESS;
    const SYSTEM = SYSTEM_PROGRAM_ADDRESS;
    const conn = await network.connect();
    const { viem } = conn;
    // decimals 6, hook armed, no fee, Token-2022 (PrecompileMock layout).
    const MINT: `0x${string}` = "0x0601000000000000000000000000000000000000000000000000000000000077";

    let helper: any;
    let users: any;
    let hooked: any;
    let wallets: any[];
    const addr = (i: number) => wallets[i].account.address as `0x${string}`;

    before(async () => {
        wallets = await viem.getWalletClients();
        const mockProto = await viem.deployContract("PrecompileMock");
        const client = await viem.getPublicClient();
        const code = await client.getCode({ address: mockProto.address });
        assert.ok(code && code !== "0x");
        for (const a of [HELPER, CPI, SYSTEM]) {
            await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
        }
        helper = await viem.getContractAt("PrecompileMock", HELPER as `0x${string}`);
        users = await viem.deployContract("TrappingUsers");
        hooked = await viem.deployContract("SPL_ERC20_Token2022Hooked", [MINT, CPI, "Wrapped", "WRAP", users.address]);
    });

    const metas = async () => [
        { pubkey: await hooked.read.hook_program(), is_signer: false, is_writable: false },
        { pubkey: await hooked.read.validation_account(), is_signer: false, is_writable: false },
    ];

    it("the wrapper PDA is fixed at construction", async () => {
        assert.equal(await hooked.read.self_pda(), await helper.read.pda([hooked.address]));
    });

    it("a warm hooked transfer re-derives no PDA and registers no caller", async () => {
        const w = await viem.getContractAt("SPL_ERC20_Token2022Hooked", hooked.address, { client: { wallet: wallets[0] } });
        await w.write.transferWithHookAccounts([addr(1), 5n, await metas()]);
        await helper.write.setPdaTrap([true]);
        await users.write.setArmed([true]);
        const tx = await w.write.transferWithHookAccounts([addr(1), 5n, await metas()]);
        assert.ok(tx, "warm hooked transfer must succeed with the PDA and registry traps armed");
        await helper.write.setPdaTrap([false]);
        await users.write.setArmed([false]);
    });

    it("transferFromWithHookAccounts takes the same path", async () => {
        const w0 = await viem.getContractAt("SPL_ERC20_Token2022Hooked", hooked.address, { client: { wallet: wallets[0] } });
        await w0.write.approve([addr(2), 100n]);
        await helper.write.setPdaTrap([true]);
        await users.write.setArmed([true]);
        const w2 = await viem.getContractAt("SPL_ERC20_Token2022Hooked", hooked.address, { client: { wallet: wallets[2] } });
        assert.ok(await w2.write.transferFromWithHookAccounts([addr(0), addr(1), 5n, await metas()]));
        assert.equal(await hooked.read.allowance([addr(0), addr(2)]), 95n);
        await helper.write.setPdaTrap([false]);
        await users.write.setArmed([false]);
    });
});
