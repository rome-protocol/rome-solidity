import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
    CPI_PROGRAM_ADDRESS,
    HELPER_PROGRAM_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
} from "./precompile-addresses";

/// `RomeEVMAccount.create_payer` tops a PDA up to the target: it sends the shortfall, never the
/// whole target, and the balance after must meet the rent minimum (890,880 lamports for 0 bytes).
describe("RomeEVMAccount.create_payer", () => {
    const RENT = 890_880n;
    let ledger: any;
    let harness: any;
    let user: `0x${string}`;

    before(async () => {
        const conn = await hardhat.network.connect();
        const { viem } = conn;
        ledger = await viem.deployContract("CreatePayerLedger", []);
        const mock = await viem.deployContract("CreatePayerPrecompileMock", [ledger.address]);
        const code = await (await viem.getPublicClient()).getCode({ address: mock.address });
        assert.ok(code && code !== "0x");
        for (const a of [HELPER_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS]) {
            await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
        }
        harness = await viem.deployContract("RomeEvmAccountHarness", []);
        user = (await viem.getWalletClients())[0].account.address as `0x${string}`;
    });

    async function run(balance: bigint, target: bigint) {
        const before = await ledger.read.transfers();
        await ledger.write.setBalance([balance]);
        await harness.write.createPayer([user, target]);
        const after = await ledger.read.transfers();
        return { sent: after - before, amount: await ledger.read.lastTransfer() };
    }

    it("an empty PDA is funded with the target", async () => {
        const r = await run(0n, RENT + 10n);
        assert.deepEqual(r, { sent: 1n, amount: RENT + 10n });
    });

    it("an empty PDA below the rent minimum reverts", async () => {
        await ledger.write.setBalance([0n]);
        await assert.rejects(harness.write.createPayer([user, RENT - 1n]), /insufficient lamports/);
    });

    it("a partially funded PDA is topped up by the shortfall only", async () => {
        const r = await run(1_000_000n, 1_500_000n);
        assert.deepEqual(r, { sent: 1n, amount: 500_000n });
    });

    it("a PDA already at or above the target is left alone", async () => {
        assert.equal((await run(2_000_000n, 1_500_000n)).sent, 0n);
        assert.equal((await run(1_500_000n, 1_500_000n)).sent, 0n);
    });

    it("a non-empty PDA whose balance after the top-up would stay below the rent minimum reverts", async () => {
        await ledger.write.setBalance([100n]);
        await assert.rejects(harness.write.createPayer([user, 200n]), /insufficient lamports/);
    });
});
