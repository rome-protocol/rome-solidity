import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, toBytes } from "viem";

/**
 * Assert that CpiError selectors match their canonical keccak256-of-signature
 * values AND that reverting with each error propagates the expected data.
 *
 * Selector formula: `bytes4(keccak256("ErrorName(argTypes)"))`.
 */

function selector(signature: string): `0x${string}` {
    const full = keccak256(toBytes(signature));
    return full.slice(0, 10) as `0x${string}`;
}

describe("CpiError", () => {
    let harness: any;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        harness = await viem.deployContract("CpiErrorHarness", []);
    });

    it("AmountTooLarge selector matches keccak256", async () => {
        const expected = selector("AmountTooLarge(uint256)");
        const actual = await harness.read.selectorAmountTooLarge();
        assert.equal(
            (actual as string).toLowerCase(),
            expected.toLowerCase(),
        );
    });

    it("SignerMismatch selector matches keccak256", async () => {
        const expected = selector("SignerMismatch(address,address)");
        const actual = await harness.read.selectorSignerMismatch();
        assert.equal(
            (actual as string).toLowerCase(),
            expected.toLowerCase(),
        );
    });

    it("InvalidAccountCount selector matches keccak256", async () => {
        const expected = selector("InvalidAccountCount(uint256,uint256)");
        const actual = await harness.read.selectorInvalidAccountCount();
        assert.equal(
            (actual as string).toLowerCase(),
            expected.toLowerCase(),
        );
    });

    it("CpiUnauthorized selector matches keccak256", async () => {
        const expected = selector("CpiUnauthorized()");
        const actual = await harness.read.selectorCpiUnauthorized();
        assert.equal(
            (actual as string).toLowerCase(),
            expected.toLowerCase(),
        );
    });

    it("revert with AmountTooLarge propagates value", async () => {
        await assert.rejects(
            async () => harness.read.revertAmountTooLarge([1234n]),
            (err: any) => {
                const msg = String(err?.message ?? "");
                return msg.includes("AmountTooLarge") && msg.includes("1234");
            },
        );
    });

    it("revert with CpiUnauthorized matches", async () => {
        await assert.rejects(
            async () => harness.read.revertCpiUnauthorized(),
            (err: any) => String(err?.message ?? "").includes("CpiUnauthorized"),
        );
    });
});
