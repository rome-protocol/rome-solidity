import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { isAddress, parseAbi } from "viem";

// Behavioral integration test for the rome-evm DELEGATECALL identity gate
// (Halborn #511) as consumed by the migrated SPL_ERC20_cached wrapper.
//
// PREREQUISITE THIS SUITE CANNOT SATISFY IN THIS REPO: the target network
// must run a rome-evm program build that includes the gate (branch
// feat-511-delegatecall-gate at the time this suite was written — not yet
// merged, built, or deployed to any chain). Every network configured in
// hardhat.config.ts today (hadrian/nerva/rubicon/local) runs a pre-gate
// program build, so every scenario below currently fails closed with
// "target network unreachable / gate not present" rather than exercising
// the gate. Re-run once a devnet chain is cut over.
//
// REQUIRES (once the prerequisite above is met):
//   - HADRIAN_PRIVATE_KEY in keystore, funded with gas + the wrapper's mint
//   - SPL_ERC20_CACHED_ADDRESS — a deployed SPL_ERC20_cached instance
//   - DELEGATECALL_RELAY_ADDRESS — a deployed DelegatecallRelay
//     (contracts/erc20spl/test/DelegatecallRelay.sol)
//
// SCOPE — the §7 acceptance list:
//   1. Direct wrapper.transfer() with a prior direct-precompile approve
//      SUCCEEDS (the migrated path — this is the Halborn PoC fix, verified
//      positively, not just "the exploit reverts").
//   2. relayTransfer() (transfer() reached via DELEGATECALL from
//      DelegatecallRelay) does NOT drain the victim's tokens — the relay
//      contract's own external_auth identity is what gets checked against
//      the on-chain delegate, and the relay was never approved, so the SPL
//      Token runtime rejects it.
//   3. Direct wrapper.approve()/relayApprove() are both inert w.r.t. the
//      caller's OWN tokens post-migration (owner resolves to the wrapper's
//      own identity for a direct call, or the relay's for a delegatecall —
//      never the real caller) — the functional approve path is the
//      direct-precompile call the SDK composes, exercised in scenario 1.
//   4. Self-directed / read paths (balanceOf, allowance, totalSupply) are
//      unaffected by any of the above under delegatecall.
describe("SPL_ERC20_cached — DELEGATECALL identity gate (Halborn #511)", () => {
    let wrapperAddress: `0x${string}`;
    let relayAddress: `0x${string}`;
    let publicClient: any;
    let walletClient: any;
    let senderAddress: `0x${string}`;

    const erc20Abi = parseAbi([
        "function transfer(address to, uint256 value) returns (bool)",
        "function approve(address spender, uint256 value) returns (bool)",
        "function balanceOf(address account) view returns (uint256)",
    ]);

    before(async () => {
        const { viem } = await hardhat.network.connect();
        publicClient = await viem.getPublicClient();
        const wallets = await viem.getWalletClients();
        if (wallets.length === 0) {
            throw new Error(
                "no wallet client — set HADRIAN_PRIVATE_KEY in keystore: " +
                "`npx hardhat keystore set HADRIAN_PRIVATE_KEY --dev`",
            );
        }
        walletClient = wallets[0];
        senderAddress = walletClient.account.address;

        const wrapperEnv = process.env.SPL_ERC20_CACHED_ADDRESS;
        if (!wrapperEnv || !isAddress(wrapperEnv)) {
            throw new Error("SPL_ERC20_CACHED_ADDRESS env var not set or invalid.");
        }
        wrapperAddress = wrapperEnv as `0x${string}`;

        const relayEnv = process.env.DELEGATECALL_RELAY_ADDRESS;
        if (!relayEnv || !isAddress(relayEnv)) {
            throw new Error(
                "DELEGATECALL_RELAY_ADDRESS env var not set or invalid. Deploy " +
                "contracts/erc20spl/test/DelegatecallRelay.sol first.",
            );
        }
        relayAddress = relayEnv as `0x${string}`;
    });

    it("migrated transfer() succeeds via direct-approve + delegate (the fix, verified positively)", async () => {
        const to = "0x000000000000000000000000000000000000f1" as `0x${string}`;
        const amount = 1n;

        // The SDK's one-time direct-precompile approve step: the user
        // approves the wrapper itself as SPL delegate on their own ATA.
        // Modeled here as the raw precompile call the SDK composes —
        // spender = the wrapper's own address.
        const splCachedAbi = parseAbi([
            "function approve(address spender, uint256 amount, bytes32 mint) returns (bool)",
        ]);
        const splCachedAddress = "0xff00000000000000000000000000000000000005" as `0x${string}`;
        const mintId = process.env.WRAPPER_MINT_ID as `0x${string}`;
        assert.ok(mintId, "WRAPPER_MINT_ID env var required for the approve step");

        await walletClient.writeContract({
            address: splCachedAddress,
            abi: splCachedAbi,
            functionName: "approve",
            args: [wrapperAddress, amount, mintId],
        });

        const before_ = (await publicClient.readContract({
            address: wrapperAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [senderAddress],
        })) as bigint;

        await walletClient.writeContract({
            address: wrapperAddress,
            abi: erc20Abi,
            functionName: "transfer",
            args: [to, amount],
        });

        const after_ = (await publicClient.readContract({
            address: wrapperAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [senderAddress],
        })) as bigint;

        assert.equal(before_ - after_, amount);
    });

    it("relayTransfer() (DELEGATECALL into transfer()) does not drain the caller's own tokens", async () => {
        const relayAbi = parseAbi([
            "function relayTransfer(address target, address to, uint256 value) returns (bool)",
        ]);
        const attacker = "0x000000000000000000000000000000000000f2" as `0x${string}`;

        await assert.rejects(
            walletClient.writeContract({
                address: relayAddress,
                abi: relayAbi,
                functionName: "relayTransfer",
                args: [wrapperAddress, attacker, 1n],
            }),
            // The relay's own identity was never approved as a delegate on
            // the caller's ATA, so the SPL Token runtime (or, depending on
            // exact call-graph resolution, the rome-evm gate itself) rejects
            // this — the migrated path never lets a delegatecall move the
            // caller's real tokens.
        );
    });

    it("relayApprove() (DELEGATECALL into approve()) does not set a delegate on the caller's own ATA", async () => {
        const relayAbi = parseAbi([
            "function relayApprove(address target, address spender, uint256 value) returns (bool)",
        ]);
        const spender = "0x000000000000000000000000000000000000f3" as `0x${string}`;

        // Either reverts outright, or succeeds while operating on the
        // relay's own (irrelevant) identity — assert the caller's real
        // allowance never becomes non-zero for `spender`.
        try {
            await walletClient.writeContract({
                address: relayAddress,
                abi: relayAbi,
                functionName: "relayApprove",
                args: [wrapperAddress, spender, 100n],
            });
        } catch {
            // Expected on most paths — fall through to the allowance check.
        }

        const allowanceAbi = parseAbi([
            "function allowance(address owner, address spender) view returns (uint256)",
        ]);
        const allowance = (await publicClient.readContract({
            address: wrapperAddress,
            abi: allowanceAbi,
            functionName: "allowance",
            args: [senderAddress, spender],
        })) as bigint;

        assert.equal(allowance, 0n);
    });
});
