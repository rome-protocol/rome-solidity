import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
    HELPER_PROGRAM_ADDRESS,
    CPI_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
    ASSOCIATED_SPL_CACHED_ADDRESS,
} from "../precompile-addresses";

/// Behavioral regression for the "escrow ATA is a constructor-derived
/// immutable" optimization: a wrapper's OWN escrow ATA
/// (`ata(address(this), mint_id)`) is fixed for the life of the contract,
/// so it must be derived exactly ONCE (in the constructor) — never
/// recomputed via a precompile call from `_ensureWrapperAta` — and its
/// existence probe (`AccountReader.lamportsOf` on the legacy track,
/// `SplCached.account` on the cached track) must fire at most ONCE per
/// wrapper instance, same monotone-existence argument as
/// `ensure-token-account-created-flag.test.ts`'s per-user flag (ATAs are
/// never closed on Rome).
///
/// Deploys the REAL `SPL_ERC20` / `SPL_ERC20_cached` contracts (not mirror
/// helpers) with precompile stand-ins installed via `hardhat_setCode`, so
/// the actual production `_ensureWrapperAta` executes on hardhat-network.
/// See `contracts/erc20spl/test/EscrowAtaImmutableMocks.sol` for why a
/// REVERTING TRAP (armed by an ordinary tx between the calls under test),
/// not a call counter, is the only way to observe "was this STATICCALL'd
/// precompile reached".
describe("escrow ATA — constructor-derived immutable, created-once flag", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const CPI = CPI_PROGRAM_ADDRESS;
    const SPL_CACHED = SPL_CACHED_ADDRESS;
    const ASSOC_SPL_CACHED = ASSOCIATED_SPL_CACHED_ADDRESS;

    const MINT_ID = `0x${"bb".repeat(32)}` as `0x${string}`;

    let viem: any;
    let conn: any;

    before(async () => {
        conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    describe("SPL_ERC20 (legacy track)", () => {
        let ledger: any;
        let wrapper: any;
        let recipient: any; // any deployed contract — used only for its code.length > 0

        before(async () => {
            ledger = await viem.deployContract("EscrowAtaLedger", []);
            const helperMock = await viem.deployContract("EscrowAtaHelperMock", [ledger.address]);
            const cpiMock = await viem.deployContract("EscrowAtaCpiMock", [ledger.address]);

            const client = await viem.getPublicClient();
            const helperCode = await client.getCode({ address: helperMock.address });
            const cpiCode = await client.getCode({ address: cpiMock.address });
            await conn.provider.request({ method: "hardhat_setCode", params: [HELPER, helperCode] });
            await conn.provider.request({ method: "hardhat_setCode", params: [CPI, cpiCode] });

            const users = await viem.deployContract("ERC20Users", []);
            // Constructor derives `escrow_ata` here — the ONE legitimate
            // `HelperProgram.ata` call, before the trap below is armed.
            wrapper = await viem.deployContract("SPL_ERC20", [
                MINT_ID,
                CPI,
                "Wrapped",
                "WRAP",
                users.address,
            ]);

            recipient = ledger; // any contract address; never called into

            // Armed for the REST of this suite: `_ensureWrapperAta` must
            // never call `HelperProgram.ata` again after construction.
            await ledger.write.setAtaTrap([true]);
        });

        it("first contract-destined transfer probes existence once, then creates the escrow ATA", async () => {
            await wrapper.write.transfer([recipient.address, 100n]);
            // If the probe or the create had used a stale/wrong derivation,
            // the mock's own consistency would have reverted already —
            // reaching here means both ran, unarmed, exactly once.
        });

        it("a second contract-destined transfer takes the fast path — no lamportsOf probe, no create", async () => {
            await ledger.write.setLamportsTrap([true]);
            await ledger.write.setCreateTrap([true]);

            const txHash = await wrapper.write.transfer([recipient.address, 50n]);
            assert.ok(txHash, "fast path must succeed without touching either trapped precompile call");

            await ledger.write.setLamportsTrap([false]);
            await ledger.write.setCreateTrap([false]);
        });
    });

    describe("SPL_ERC20_cached (cached track)", () => {
        let ledger: any;
        let wrapper: any;
        let recipient: any;

        before(async () => {
            ledger = await viem.deployContract("EscrowAtaLedger", []);
            const helperMock = await viem.deployContract("EscrowAtaHelperMock", [ledger.address]);
            const splCachedMock = await viem.deployContract("EscrowAtaSplCachedMock", [ledger.address]);
            const assocMock = await viem.deployContract("EscrowAtaAssocSplCachedMock", [ledger.address]);

            const client = await viem.getPublicClient();
            const helperCode = await client.getCode({ address: helperMock.address });
            const splCachedCode = await client.getCode({ address: splCachedMock.address });
            const assocCode = await client.getCode({ address: assocMock.address });
            await conn.provider.request({ method: "hardhat_setCode", params: [HELPER, helperCode] });
            await conn.provider.request({ method: "hardhat_setCode", params: [SPL_CACHED, splCachedCode] });
            await conn.provider.request({ method: "hardhat_setCode", params: [ASSOC_SPL_CACHED, assocCode] });

            const users = await viem.deployContract("ERC20Users", []);
            wrapper = await viem.deployContract("SPL_ERC20_cached", [
                MINT_ID,
                ASSOC_SPL_CACHED,
                "Wrapped",
                "WRAP",
                users.address,
            ]);

            recipient = ledger;

            await ledger.write.setAtaTrap([true]);
        });

        it("first contract-destined transfer probes existence once, then creates the escrow ATA", async () => {
            await wrapper.write.transfer([recipient.address, 100n]);
        });

        it("a second contract-destined transfer takes the fast path — no SplCached.account probe, no create", async () => {
            await ledger.write.setAccountTrap([true]);
            await ledger.write.setCreateTrap([true]);

            const txHash = await wrapper.write.transfer([recipient.address, 50n]);
            assert.ok(txHash, "fast path must succeed without touching either trapped precompile call");

            await ledger.write.setAccountTrap([false]);
            await ledger.write.setCreateTrap([false]);
        });
    });
});
