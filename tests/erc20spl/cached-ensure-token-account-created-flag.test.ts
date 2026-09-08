import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, encodePacked } from "viem";
import {
    HELPER_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
    ASSOCIATED_SPL_CACHED_ADDRESS,
} from "../precompile-addresses";

/// Cached-track parity fix for `tests/erc20spl/ensure-token-account-created-flag.test.ts`:
/// `SPL_ERC20_cached.ensure_token_account(user)` must reach
/// `AssociatedSplCached.create_ata` (the journaled ATA-create write) at
/// most ONCE per user, then skip it forever after — ATAs are never closed
/// on Rome, so existence is monotone once confirmed. Unlike the legacy
/// track there is no `lamportsOf`-style existence READ to skip (the cached
/// track deliberately has none — see `erc20spl_cached.sol`'s own comment on
/// `ensure_token_account`); the only cost worth skipping on repeat is the
/// create_ata WRITE itself, gated by pure EVM storage.
///
/// Deploys the REAL `SPL_ERC20_cached` (not a mirror helper) with precompile
/// stand-ins installed via `hardhat_setCode` at HELPER (0xff..09),
/// `SplCached` (0xff..05) and `AssociatedSplCached` (0xff..06), so the
/// actual production `ensure_token_account` executes on hardhat-network.
/// See `contracts/erc20spl/test/CachedAtaCreatedFlagMocks.sol` for why a
/// REVERTING TRAP (armed by an ordinary tx between the two calls under
/// test), not a call counter, is the only way to observe "was create_ata
/// reached".
describe("SPL_ERC20_cached.ensure_token_account — created-flag fast path", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const SPL_CACHED = SPL_CACHED_ADDRESS;
    const ASSOC_SPL_CACHED = ASSOCIATED_SPL_CACHED_ADDRESS;

    let viem: any;
    let ledger: any;
    let wrapper: any;

    const MINT_ID = `0x${"cc".repeat(32)}` as `0x${string}`;

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;

        ledger = await viem.deployContract("CachedAtaCreatedFlagLedger", []);

        const precompileMock = await viem.deployContract("CachedAtaCreatedFlagPrecompileMock", []);
        const assocMock = await viem.deployContract("CachedAtaCreatedFlagAssocMock", [ledger.address]);

        const client = await viem.getPublicClient();
        const precompileCode = await client.getCode({ address: precompileMock.address });
        const assocCode = await client.getCode({ address: assocMock.address });
        assert.ok(precompileCode && precompileCode !== "0x");
        assert.ok(assocCode && assocCode !== "0x");

        await conn.provider.request({ method: "hardhat_setCode", params: [HELPER, precompileCode] });
        await conn.provider.request({ method: "hardhat_setCode", params: [SPL_CACHED, precompileCode] });
        await conn.provider.request({ method: "hardhat_setCode", params: [ASSOC_SPL_CACHED, assocCode] });

        const users = await viem.deployContract("ERC20Users", []);
        wrapper = await viem.deployContract("SPL_ERC20_cached", [
            MINT_ID,
            ASSOC_SPL_CACHED,
            "Wrapped",
            "WRAP",
            users.address,
        ]);
    });

    function deriveAta(user: `0x${string}`): `0x${string}` {
        return keccak256(encodePacked(["string", "address", "bytes32"], ["mock-ata", user, MINT_ID]));
    }

    it("first call to a fresh recipient runs create_ata", async () => {
        const [walletA] = await viem.getWalletClients();
        const userA = walletA.account.address as `0x${string}`;

        await wrapper.write.ensure_token_account([userA]);

        const ata = deriveAta(userA);
        assert.equal(await ledger.read.created([ata]), true, "create_ata must have run for a fresh user");
    });

    it("second call to the SAME recipient takes the fast path — no create_ata", async () => {
        const [walletA] = await viem.getWalletClients();
        const userA = walletA.account.address as `0x${string}`;

        await ledger.write.setCreateTrap([true]);

        const txHash = await wrapper.write.ensure_token_account([userA]);
        assert.ok(txHash, "fast path must succeed without reaching the trapped create_ata");

        await ledger.write.setCreateTrap([false]);
    });

    it("a DIFFERENT, never-touched user still runs create_ata (per-user flag, not global)", async () => {
        const [, walletB] = await viem.getWalletClients();
        const userB = walletB.account.address as `0x${string}`;

        await ledger.write.setCreateTrap([true]);
        await assert.rejects(
            wrapper.write.ensure_token_account([userB]),
            /create_ata fired/,
            "a fresh user's first call must still create — the flag is per-user, never global",
        );
        await ledger.write.setCreateTrap([false]);

        await wrapper.write.ensure_token_account([userB]);
        const ataB = deriveAta(userB);
        assert.equal(await ledger.read.created([ataB]), true);
    });
});
