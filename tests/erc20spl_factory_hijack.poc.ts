// S6-F1 FIXED — hijack closed
// =============================================================================
// Prior claim (audit finding S6-F1): ERC20SPLFactory split mint provisioning into
// two PERMISSIONLESS calls — create_token_mint() (created an uninitialized mint
// PDA derived from the CALLER's address+nonce) and init_token_mint(bytes32 mint)
// (initialized an ARBITRARY mint, stamping mint_authority = HelperProgram.pda
// (msg.sender), with no check that msg.sender created `mint`). An attacker could
// init the VICTIM's created-but-uninitialized mint, become its authority, and
// mint the victim's token while the victim was permanently locked out.
//
// Fix (#326): the create dispatch (HelperProgram.create_and_init_mint) creates
// AND initializes the mint atomically in one dispatch — there is never a
// created-but-uninitialized window. init_token_mint(bytes32) is a view-only
// backward-compat shim: it reverts unless `mint` is already initialized, and
// never performs any initialization itself, so it can no longer be used to
// seize authority over anyone's mint.
//
// Updated (Halborn #511, delegatecall identity gate): the atomic create dispatch
// used to be factory-mediated (create_token_mint() delegatecalled into
// HelperProgram). The gate now rejects that — DELEGATECALL fails
// owner_authenticated outright, and a direct CALL would rebind context.caller to
// the factory instead of the victim, corrupting the salt-derived mint PDA and
// rent payer. So the create step is now user-direct: the VICTIM calls
// HelperProgram.create_and_init_mint directly, then factory.confirm_created_mint
// advances their nonce. The #326 fix is unaffected — the atomicity that closes
// the front-run window lives in create_and_init_mint's single dispatch, not in
// who calls it, so this POC still proves the same property against the new
// call path.
//
//   VICTIM   = walletClients[0]  (the funded HADRIAN_PRIVATE_KEY account)
//   ATTACKER = a fresh keypair, funded by the victim in-test
//
// RUN:  npx hardhat test tests/erc20spl_factory_hijack.poc.ts --network hadrian
//
// This test only passes once the fixed factory AND a rome-evm program build
// including the Halborn #511 gate are both deployed — it is the acceptance test
// for both fixes, not a standalone unit test (see
// tests/erc20spl/delegatecall-gate.integration.ts for the gate-deployment
// caveat, which applies here too). Every state-changing tx carries an explicit
// gas price above the proxy minimum so reverts revert for the RIGHT reason,
// never for gas.
// =============================================================================

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { createWalletClient, custom, getAddress, isAddress, parseUnits, slice } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readDeployments } from "../scripts/lib/deployments.js";

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009" as const; // pda(address)
const CPI_PROGRAM = "0xff00000000000000000000000000000000000008" as const;    // account_info(bytes32)

const HELPER_ABI = [
    { type: "function", name: "pda", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "bytes32" }] },
    { type: "function", name: "create_and_init_mint", stateMutability: "nonpayable",
      inputs: [
        { name: "decimals", type: "uint8" }, { name: "mint_authority", type: "bytes32" },
        { name: "has_freeze_authority", type: "bool" }, { name: "freeze_authority", type: "bytes32" },
        { name: "salt", type: "bytes32" },
      ], outputs: [] },
] as const;
const CPI_ABI = [
    { type: "function", name: "account_info", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }],
      outputs: [
        { name: "lamports", type: "uint64" }, { name: "owner", type: "bytes32" },
        { name: "executable", type: "bool" }, { name: "rentEpoch", type: "uint64" },
        { name: "space", type: "uint64" }, { name: "data", type: "bytes" },
      ] },
] as const;

function resolveFactoryAddress(networkName: string): `0x${string}` {
    const address = readDeployments(networkName).ERC20SPLFactory?.address;
    if (!address || !isAddress(address)) throw new Error(`ERC20SPLFactory not deployed for ${networkName}`);
    return getAddress(address);
}

async function assertSuccess(publicClient: any, hash: `0x${string}`, label: string) {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(r.status, "success", `${label} should succeed`);
    console.log(`   [ok] ${label} — tx ${hash}`);
    return r;
}

// init_token_mint is now `view` (no state mutation on either branch), so exercising it
// is a plain eth_call via `.read` — a revert surfaces as a thrown error, not a receipt.
async function assertReadReverts(promise: Promise<unknown>, label: string) {
    let reverted = false;
    try { await promise; } catch { reverted = true; }
    console.log(`   [ok] ${label} reverted = ${reverted}`);
    assert.ok(reverted, `${label} MUST revert`);
}

describe("S6-F1 FIXED — hijack closed", () => {
    let publicClient: any, factory: any, viemApi: any, networkName: string;
    let victim: any, attacker: any;
    let gasPrice: bigint;
    let mintId: `0x${string}`;
    let victimPda: `0x${string}`;
    let attackerPda: `0x${string}`;

    before(async () => {
        const conn = await hardhat.network.connect() as any;
        viemApi = conn.viem;
        networkName = conn.networkName;
        publicClient = await viemApi.getPublicClient();

        victim = (await viemApi.getWalletClients())[0];
        assert.ok(victim?.account, "no funded wallet (set HADRIAN_PRIVATE_KEY)");

        // Rome's proxy enforces a pool-derived minimum gas price; viem's auto-estimate
        // is a stub far below it. Fetch and buffer generously, floor at 15 gwei.
        const fetched = await publicClient.getGasPrice().catch(() => 0n);
        gasPrice = fetched * 2n > 15_000_000_000n ? fetched * 2n : 15_000_000_000n;
        console.log(`\n=== S6-F1 fixed-behavior test on ${networkName} · gasPrice ${gasPrice} ===`);

        // S6F1_FACTORY lets this run against a freshly-deployed (fixed) factory without
        // clobbering the canonical deployments/<network>.json record.
        const factoryAddress = process.env.S6F1_FACTORY && isAddress(process.env.S6F1_FACTORY)
            ? getAddress(process.env.S6F1_FACTORY)
            : resolveFactoryAddress(networkName);
        factory = await viemApi.getContractAt("ERC20SPLFactory", factoryAddress);
        const code = await publicClient.getCode({ address: factoryAddress });
        assert.ok(code && code !== "0x", `no factory code at ${factoryAddress}`);
        console.log(`   factory  = ${factoryAddress}`);

        attacker = createWalletClient({
            account: privateKeyToAccount(generatePrivateKey()),
            transport: custom((await hardhat.network.connect()).provider),
        });
        const bal = await publicClient.getBalance({ address: attacker.account.address });
        const target = parseUnits("2", 18);
        if (bal < target / 2n) {
            const fund = await victim.sendTransaction({ account: victim.account, to: attacker.account.address, value: target, gasPrice });
            await assertSuccess(publicClient, fund, "fund attacker");
        }
        console.log(`   victim   = ${victim.account.address}`);
        console.log(`   attacker = ${attacker.account.address}`);

        victimPda = await publicClient.readContract({
            address: HELPER_PROGRAM, abi: HELPER_ABI, functionName: "pda", args: [victim.account.address] }) as `0x${string}`;
        attackerPda = await publicClient.readContract({
            address: HELPER_PROGRAM, abi: HELPER_ABI, functionName: "pda", args: [attacker.account.address] }) as `0x${string}`;
    });

    it("closes the front-run window and the after-init hijack, without breaking the two-step callers", async () => {
        // [1] mintId + mintSeed are deterministic from (victim, nonce) and PUBLICLY
        //     predictable via get_current_mint — before the victim ever creates.
        let mintSeed: `0x${string}`;
        [mintId, mintSeed] = await factory.read.get_current_mint([victim.account.address]);
        console.log(`\n[1] victim-derived mint (not yet created) = ${mintId}`);

        // [2] FRONT-RUN ATTEMPT: attacker tries to init a mint that doesn't exist yet.
        //     Previously create_token_mint left a created-but-uninitialized window to
        //     race into; now there is no window at all — the account itself doesn't
        //     exist, so even a same-block init attempt has nothing to act on and reverts.
        await assertReadReverts(
            factory.read.init_token_mint([mintId], { account: attacker.account.address }),
            "ATTACKER init_token_mint(not-yet-created victim mint)");

        // [3] VICTIM creates its mint — user-direct HelperProgram.create_and_init_mint
        //     creates AND initializes atomically in the same call (the #326 fix's
        //     atomicity is unchanged; only who calls it moved off the factory).
        await assertSuccess(publicClient,
            await victim.writeContract({
                address: HELPER_PROGRAM, abi: HELPER_ABI, functionName: "create_and_init_mint",
                args: [9, victimPda, false, `0x${"0".repeat(64)}` as `0x${string}`, mintSeed],
                account: victim.account, gasPrice,
            }),
            "VICTIM create_and_init_mint (direct)");

        let info: any = await publicClient.readContract({
            address: CPI_PROGRAM, abi: CPI_ABI, functionName: "account_info", args: [mintId] });
        let data: `0x${string}` = info[5];
        assert.ok((data.length - 2) / 2 >= 82, "mint account data must be at least 82 bytes");
        assert.equal(slice(data, 45, 46), "0x01", "mint must already be initialized right after create_and_init_mint");
        let onchainAuthority = slice(data, 4, 36);
        console.log(`[3] mint_authority on-chain = ${onchainAuthority}`);
        console.log(`    victim PDA              = ${victimPda}`);
        assert.equal(onchainAuthority.toLowerCase(), victimPda.toLowerCase(), "authority MUST be the victim's PDA");

        // [4] POST-INIT HIJACK ATTEMPT: attacker calls init_token_mint on the now-
        //     initialized mint. The already-initialized branch is a no-op — it does NOT
        //     revert, but it also does NOT touch mint_authority or perform any init CPI.
        await factory.read.init_token_mint([mintId], { account: attacker.account.address });
        info = await publicClient.readContract({
            address: CPI_PROGRAM, abi: CPI_ABI, functionName: "account_info", args: [mintId] });
        onchainAuthority = slice(info[5] as `0x${string}`, 4, 36);
        console.log(`[4] mint_authority after attacker's no-op call = ${onchainAuthority}`);
        assert.equal(onchainAuthority.toLowerCase(), victimPda.toLowerCase(), "authority MUST still be the victim's PDA");
        assert.notEqual(onchainAuthority.toLowerCase(), attackerPda.toLowerCase(), "authority MUST NOT be the attacker's PDA");

        // [4b] confirm_created_mint is not front-runnable: it checks the mint against
        //      the CALLER's own predicted mint, so the attacker's attempt (checked
        //      against the attacker's own, different, predicted mint) simply does not
        //      match and reverts — it never touches the victim's nonce.
        const nonceBefore = await factory.read.creator_nonce([victim.account.address]);
        await assert.rejects(
            factory.simulate.confirm_created_mint([mintId], { account: attacker.account }),
            "ATTACKER confirm_created_mint(victim's mint) MUST revert");
        assert.equal(
            await factory.read.creator_nonce([victim.account.address]), nonceBefore,
            "attacker's failed confirm MUST NOT advance the victim's nonce");

        await assertSuccess(publicClient,
            await factory.write.confirm_created_mint([mintId], { account: victim.account, gasPrice }),
            "VICTIM confirm_created_mint");
        assert.equal(
            await factory.read.creator_nonce([victim.account.address]), nonceBefore + 1n,
            "VICTIM's own confirm_created_mint MUST advance their nonce by exactly one");

        // [5] VICTIM can use the mint normally: register the wrapper and mint to self.
        const sym = `FIX${Date.now().toString().slice(-6)}`;
        const wrapperAddress = (await factory.simulate.add_spl_token_no_metadata(
            [mintId, `Fixed ${sym}`, sym], { account: victim.account })).result as `0x${string}`;
        await assertSuccess(publicClient,
            await factory.write.add_spl_token_no_metadata([mintId, `Fixed ${sym}`, sym], { account: victim.account, gasPrice }),
            "VICTIM add wrapper");
        const wrapper = await viemApi.getContractAt("SPL_ERC20_cached", wrapperAddress);

        const amount = parseUnits("1000000", 9);
        await assertSuccess(publicClient,
            await wrapper.write.mint_to([victim.account.address, amount], { account: victim.account, gasPrice }),
            "VICTIM mint_to(self)");
        const victimBal: bigint = await wrapper.read.balanceOf([victim.account.address]);
        console.log(`[5] victim minted balance = ${victimBal}`);
        assert.equal(victimBal, amount, "victim must hold the freshly-minted supply");

        // [6] Backward-compat: the VICTIM's OWN init_token_mint on its already-
        //     initialized mint is also a no-op, not a revert — existing two-step
        //     callers (create then init) keep working unmodified.
        await factory.read.init_token_mint([mintId], { account: victim.account.address });
        console.log(`[6] VICTIM init_token_mint(ownMint) — backward-compat no-op, no revert`);

        console.log(`\n=== S6-F1 FIXED: attacker ${attacker.account.address} could not touch victim ${victim.account.address}'s mint ${mintId} ===\n`);
    });
});
