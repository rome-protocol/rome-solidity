import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// regression suite: SPL_ERC20's approve/allowance/
/// transferFrom-decrement move from an SPL CPI (`approve_spl`/
/// `allowance_of`, refused under the delegatecall gate) to a plain
/// EVM mapping. `EvmAllowanceHelper` is the real logic — no precompile
/// call anywhere in this path, so (unlike the rest of SPL_ERC20) this is
/// fully exercisable on hardhat-network without a mirror-arithmetic
/// substitute.
describe("SPL_ERC20 EVM-only allowance", function () {
    let viem: any;
    let publicClient: any;
    let ownerAccount: any;
    let spenderAccount: any;
    let otherAccount: any;

    const U256_MAX = (1n << 256n) - 1n;
    const ZERO = "0x0000000000000000000000000000000000000000";

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        publicClient = await viem.getPublicClient();
        [ownerAccount, spenderAccount, otherAccount] = await viem.getWalletClients();
    });

    async function deploy() {
        return viem.deployContract("EvmAllowanceHelper", []);
    }

    it("allowance defaults to 0 for an unapproved pair", async function () {
        const helper = await deploy();
        const result = await helper.read.allowance([ownerAccount.account.address, spenderAccount.account.address]);
        assert.equal(result, 0n);
    });

    it("approve stores the exact uint256 value — no u64 saturation", async function () {
        const helper = await deploy();
        const bigValue = 1n << 200n; // far beyond u64::max, must NOT saturate
        const hash = await helper.write.approve([spenderAccount.account.address, bigValue], { account: ownerAccount.account });
        await publicClient.waitForTransactionReceipt({ hash });
        const result = await helper.read.allowance([ownerAccount.account.address, spenderAccount.account.address]);
        assert.equal(result, bigValue, "allowance is EVM uint256 storage — must not saturate at u64::max");
    });

    it("approve emits Approval with the exact stored value (no sentinel remap)", async function () {
        const helper = await deploy();
        const hash = await helper.write.approve([spenderAccount.account.address, U256_MAX], { account: ownerAccount.account });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        assert.equal(receipt.status, "success");
        const result = await helper.read.allowance([ownerAccount.account.address, spenderAccount.account.address]);
        assert.equal(result, U256_MAX);
    });

    it("approve reverts ERC20InvalidSpender for the zero address", async function () {
        const helper = await deploy();
        await assert.rejects(
            helper.write.approve([ZERO, 1n], { account: ownerAccount.account })
        );
    });

    it("transferFrom decrements a finite allowance by exactly the transferred value", async function () {
        const helper = await deploy();
        await helper.write.setBalance([ownerAccount.account.address, 1000n]);
        await helper.write.approve([spenderAccount.account.address, 300n], { account: ownerAccount.account });
        await helper.write.transferFrom(
            [ownerAccount.account.address, otherAccount.account.address, 100n],
            { account: spenderAccount.account }
        );
        const result = await helper.read.allowance([ownerAccount.account.address, spenderAccount.account.address]);
        assert.equal(result, 200n);
    });

    it("transferFrom does NOT decrement an infinite (type(uint256).max) approval", async function () {
        const helper = await deploy();
        await helper.write.setBalance([ownerAccount.account.address, 1000n]);
        await helper.write.approve([spenderAccount.account.address, U256_MAX], { account: ownerAccount.account });
        await helper.write.transferFrom(
            [ownerAccount.account.address, otherAccount.account.address, 999n],
            { account: spenderAccount.account }
        );
        const result = await helper.read.allowance([ownerAccount.account.address, spenderAccount.account.address]);
        assert.equal(result, U256_MAX, "infinite approval must stay type(uint256).max after spend");
    });

    it("transferFrom reverts ERC20InsufficientAllowance when spend exceeds the finite allowance", async function () {
        const helper = await deploy();
        await helper.write.setBalance([ownerAccount.account.address, 1000n]);
        await helper.write.approve([spenderAccount.account.address, 50n], { account: ownerAccount.account });
        await assert.rejects(
            helper.write.transferFrom(
                [ownerAccount.account.address, otherAccount.account.address, 51n],
                { account: spenderAccount.account }
            )
        );
    });

    it("transferFrom moves the balance even at the exact allowance boundary", async function () {
        const helper = await deploy();
        await helper.write.setBalance([ownerAccount.account.address, 1000n]);
        await helper.write.approve([spenderAccount.account.address, 100n], { account: ownerAccount.account });
        await helper.write.transferFrom(
            [ownerAccount.account.address, otherAccount.account.address, 100n],
            { account: spenderAccount.account }
        );
        assert.equal(await helper.read.allowance([ownerAccount.account.address, spenderAccount.account.address]), 0n);
        assert.equal(await helper.read.balanceOf([otherAccount.account.address]), 100n);
    });
});
