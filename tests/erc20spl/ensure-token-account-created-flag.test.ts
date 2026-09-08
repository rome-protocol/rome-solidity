import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, encodePacked } from "viem";
import { HELPER_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS } from "../precompile-addresses";

/// Behavioral regression for the "immutable-ATA + created-flag" CU
/// optimization: `SPL_ERC20.ensure_token_account(user)` must probe
/// `AccountReader.lamportsOf` (-> CpiProgram.account_lamports, the account
/// read that pulls the account into Rome's tighter tx account-set) at most
/// ONCE per user, then skip it forever after — ATAs are never closed on
/// Rome, so existence is monotone once confirmed.
///
/// This deploys the REAL `SPL_ERC20` (not a mirror helper) with
/// `MintInfoMock`-style precompile stand-ins installed via `hardhat_setCode`
/// at the fixed HELPER (0xff..09) and CPI (0xff..08) precompile addresses,
/// so the actual production `ensure_token_account` executes on
/// hardhat-network. See `contracts/erc20spl/test/AtaCreatedFlagMocks.sol`
/// for why a REVERTING TRAP (armed by an ordinary tx between the two calls
/// under test), not a call counter, is the only way to observe "was the
/// STATICCALL'd lamportsOf probe reached" from a mock.
describe("SPL_ERC20.ensure_token_account — created-flag fast path", () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const CPI = CPI_PROGRAM_ADDRESS;

    let viem: any;
    let ledger: any;
    let wrapper: any;

    const MINT_ID = `0x${"aa".repeat(32)}` as `0x${string}`;

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;

        ledger = await viem.deployContract("AtaCreatedFlagLedger", []);

        const helperMock = await viem.deployContract("AtaCreatedFlagHelperMock", [ledger.address]);
        const cpiMock = await viem.deployContract("AtaCreatedFlagCpiMock", [ledger.address]);

        const client = await viem.getPublicClient();
        const helperCode = await client.getCode({ address: helperMock.address });
        const cpiCode = await client.getCode({ address: cpiMock.address });
        assert.ok(helperCode && helperCode !== "0x");
        assert.ok(cpiCode && cpiCode !== "0x");

        await conn.provider.request({ method: "hardhat_setCode", params: [HELPER, helperCode] });
        await conn.provider.request({ method: "hardhat_setCode", params: [CPI, cpiCode] });

        const users = await viem.deployContract("ERC20Users", []);
        wrapper = await viem.deployContract("SPL_ERC20", [
            MINT_ID,
            CPI,
            "Wrapped",
            "WRAP",
            users.address,
        ]);
    });

    function deriveAta(user: `0x${string}`): `0x${string}` {
        // Must match AtaCreatedFlagHelperMock.ata's derivation exactly.
        return keccak256(encodePacked(["string", "address", "bytes32"], ["mock-ata", user, MINT_ID]));
    }

    it("first call to a fresh recipient runs the probe and creates the ATA", async () => {
        const [walletA] = await viem.getWalletClients();
        const userA = walletA.account.address as `0x${string}`;

        await wrapper.write.ensure_token_account([userA]);

        const ata = deriveAta(userA);
        assert.equal(await ledger.read.created([ata]), true, "create_ata must have run for a fresh user");
    });

    it("second call to the SAME recipient takes the fast path — no lamportsOf probe, no create", async () => {
        const [walletA] = await viem.getWalletClients();
        const userA = walletA.account.address as `0x${string}`;

        // Arm BOTH traps via ordinary (non-view) txs between the two calls
        // under test. If ensure_token_account still reaches either
        // lamportsOf or create_ata on this second call, the call reverts.
        await ledger.write.setLamportsTrap([true]);
        await ledger.write.setCreateTrap([true]);

        const txHash = await wrapper.write.ensure_token_account([userA]);
        assert.ok(txHash, "fast path must succeed without touching either trapped precompile call");

        await ledger.write.setLamportsTrap([false]);
        await ledger.write.setCreateTrap([false]);
    });

    it("a DIFFERENT, never-touched user still runs the probe (per-user flag, not global)", async () => {
        const [, walletB] = await viem.getWalletClients();
        const userB = walletB.account.address as `0x${string}`;

        // Arm the lamports trap again. userB's flag was never set (only
        // userA's was, in the previous test) — if the flag were wrongly
        // global instead of per-user, this call would incorrectly succeed.
        await ledger.write.setLamportsTrap([true]);
        await assert.rejects(
            wrapper.write.ensure_token_account([userB]),
            /account_lamports \(lamportsOf\) fired/,
            "a fresh user's first call must still probe — the flag is per-user, never global",
        );
        await ledger.write.setLamportsTrap([false]);

        // Un-trapped, the same call must succeed and create userB's ATA.
        await wrapper.write.ensure_token_account([userB]);
        const ataB = deriveAta(userB);
        assert.equal(await ledger.read.created([ataB]), true);
    });

    it("an ATA that exists on-chain but was never confirmed by THIS wrapper is still probed once, then fast-pathed (invariant b)", async () => {
        const wallets = await viem.getWalletClients();
        const userC = wallets[2].account.address as `0x${string}`;
        const ataC = deriveAta(userC);

        // Simulate an externally-created ATA (bridge-in, pre-deploy, etc.):
        // recorded in the ledger directly, WITHOUT ever going through this
        // wrapper's create_ata path.
        await ledger.write.recordCreated([ataC]);

        // First call: flag[userC] is false, so the probe must still run
        // (safety invariant b). Arm the CREATE trap only — if the wrapper
        // incorrectly always creates, this reverts; the probe hitting
        // lamports=1 must short-circuit before create is ever reached.
        await ledger.write.setCreateTrap([true]);
        await wrapper.write.ensure_token_account([userC]);
        await ledger.write.setCreateTrap([false]);

        // Second call: the probe-hit branch must have set the flag too,
        // not just the freshly-created branch. Arm the lamports trap and
        // confirm the fast path now fires for userC as well.
        await ledger.write.setLamportsTrap([true]);
        await wrapper.write.ensure_token_account([userC]);
        await ledger.write.setLamportsTrap([false]);
    });
});
