import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

describe("SPL_ERC20_Token2022Hooked account-plan boundary", async () => {
    const conn = await network.connect();
    const { viem } = conn;

    it("encodes TransferChecked and preserves the resolved account tail", async () => {
        const harness = await viem.deployContract("Token2022HookedTransferHarness");
        const hookProgram = key(5);
        const validation = key(6);
        const writableRule = key(7);

        const [data, metas] = await harness.read.plan([
            key(1), key(2), key(3), key(4), 0x0102_0304_0506_0708n, 6,
            [
                { pubkey: writableRule, is_signer: false, is_writable: true },
                { pubkey: hookProgram, is_signer: false, is_writable: false },
                { pubkey: validation, is_signer: false, is_writable: false },
            ],
        ]) as readonly [`0x${string}`, readonly { pubkey: `0x${string}`; is_signer: boolean; is_writable: boolean }[]];

        assert.equal(data, "0x0c080706050403020106");
        assert.deepEqual(metas.slice(0, 4), [
            { pubkey: key(1), is_signer: false, is_writable: true },
            { pubkey: key(2), is_signer: false, is_writable: false },
            { pubkey: key(3), is_signer: false, is_writable: true },
            { pubkey: key(4), is_signer: true, is_writable: false },
        ]);
        assert.deepEqual(metas.slice(4), [
            { pubkey: writableRule, is_signer: false, is_writable: true },
            { pubkey: hookProgram, is_signer: false, is_writable: false },
            { pubkey: validation, is_signer: false, is_writable: false },
        ]);
    });

    it("rejects an incomplete, substituted, writable or signer hook trailer", async () => {
        const harness = await viem.deployContract("Token2022HookedTransferHarness");
        const hook = key(20);
        const validation = key(21);
        const rule = { pubkey: key(19), is_signer: false, is_writable: true } as const;
        const valid = [
            rule,
            { pubkey: hook, is_signer: false, is_writable: false },
            { pubkey: validation, is_signer: false, is_writable: false },
        ] as const;

        await harness.read.validate([hook, validation, valid]);
        await assert.rejects(harness.read.validate([hook, validation, []]), /IncompleteHookAccountPlan/);
        await assert.rejects(harness.read.validate([hook, validation, [rule, { ...valid[1], pubkey: key(22) }, valid[2]]]), /InvalidHookProgramMeta/);
        await assert.rejects(harness.read.validate([hook, validation, [rule, valid[1], { ...valid[2], pubkey: key(23) }]]), /InvalidValidationMeta/);
        await assert.rejects(harness.read.validate([hook, validation, [rule, { ...valid[1], is_writable: true }, valid[2]]]), /InvalidHookProgramMeta/);
        await assert.rejects(harness.read.validate([hook, validation, [rule, valid[1], { ...valid[2], is_signer: true }]]), /InvalidValidationMeta/);
    });
});
