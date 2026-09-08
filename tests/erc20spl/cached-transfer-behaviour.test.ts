import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { HELPER_PROGRAM_ADDRESS, SPL_CACHED_ADDRESS } from "../precompile-addresses";

// Behavioural coverage of SPL_ERC20_cached.transferFrom's inline allowance
// check — a third copy of the same per-spender gate `_spendAllowance`
// implements on the legacy/hooked tracks (`erc20spl_cached.sol:230-242`),
// unpinned by any behavioural test. `cached-direct-call-escrow-shape.test.ts`
// asserts only `_allowances[from][spender]` and `currentAllowance - value`
// as source text — neither the `<` guard nor the `!= type(uint256).max`
// sentinel — so a mutation that opens the gate (e.g. `currentAllowance <
// value` -> `< value / 2`) ships green under it. This file drives the real
// deployed contract instead, using `PrecompileMock` to stand in for
// HelperProgram (0xff..09) and SplCached (0xff..05).
describe("SPL_ERC20_cached.transferFrom, executed", async () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const SPL_CACHED = SPL_CACHED_ADDRESS;

    const conn = await network.connect();
    const { viem } = conn;

    const mockProto = await viem.deployContract("PrecompileMock");
    const client = await viem.getPublicClient();
    const code = await client.getCode({ address: mockProto.address });
    assert.ok(code && code !== "0x", "mock must have deployed code to install");
    for (const addr of [HELPER, SPL_CACHED]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
    }

    // decimals=6, hook NOT armed (byte1=0 — the cached wrapper's constructor
    // refuses any armed hook outright), feeBps=0 so `_transfer` never takes
    // the balanceOf-measuring branch.
    const MINT: `0x${string}` =
        "0x0600000000000000000000000000000000000000000000000000000000000042";

    async function deployCached() {
        const users = await viem.deployContract("ERC20Users");
        return viem.deployContract("SPL_ERC20_cached", [
            MINT,
            SPL_CACHED,
            "Wrapped",
            "WRAP",
            users.address,
        ]);
    }

    function zeroAddr(tag: number): `0x${string}` {
        return `0x${"0".repeat(39)}${tag}` as `0x${string}`;
    }

    let cached: any;
    let deployer: any;
    let spender: any;

    before(async () => {
        cached = await deployCached();
        [deployer, spender] = await viem.getWalletClients();
    });

    it("transferFrom reverts with no approval", async () => {
        const from = zeroAddr(1);
        const to = zeroAddr(2);
        await assert.rejects(
            cached.write.transferFrom([from, to, 100n], { account: spender.account }),
            /ERC20InsufficientAllowance/,
            "a mutation that scales the allowance-guard threshold (e.g. halving it) must not touch this revert — zero allowance stays zero either way",
        );
    });

    it("transferFrom reverts when the spend exceeds a finite allowance, even under 2x", async () => {
        // A guard scaled by half (`currentAllowance < value` weakened to
        // `< value / 2`) still rejects a 0-allowance spend (this file's
        // first case) but waves through anything up to 2x the real
        // approval. 50 approved, 51 requested must still revert — 50 <
        // 51/2 (25) is false under that weakened guard, so it would
        // proceed and underflow `currentAllowance - value` in the
        // `unchecked` block instead.
        const from = deployer.account.address;
        const to = zeroAddr(7);
        await cached.write.approve([spender.account.address, 50n], { account: deployer.account });
        await assert.rejects(
            cached.write.transferFrom([from, to, 51n], { account: spender.account }),
            /ERC20InsufficientAllowance/,
        );
    });

    it("transferFrom succeeds and decrements the allowance exactly", async () => {
        const from = deployer.account.address;
        const to = zeroAddr(3);

        await cached.write.approve([spender.account.address, 250n], { account: deployer.account });
        await cached.write.transferFrom([from, to, 100n], { account: spender.account });

        const remaining = await cached.read.allowance([from, spender.account.address]);
        assert.equal(remaining, 150n, "the decrement must subtract exactly the spent value, not a scaled-up amount");
    });

    it("transferFrom does not decrement an infinite (type(uint256).max) approval", async () => {
        const from = deployer.account.address;
        const to = zeroAddr(4);
        const U256_MAX = (1n << 256n) - 1n;

        await cached.write.approve([spender.account.address, U256_MAX], { account: deployer.account });
        await cached.write.transferFrom([from, to, 999n], { account: spender.account });

        const remaining = await cached.read.allowance([from, spender.account.address]);
        assert.equal(remaining, U256_MAX, "infinite approval must stay type(uint256).max after spend");
    });
});
