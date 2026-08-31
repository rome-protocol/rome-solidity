import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256, stringToBytes } from "viem";

/// Halborn #511 follow-up — EIP-2612 permit (Deliverable B2).
///
/// `SPL_ERC20Base`'s constructor computes `DOMAIN_SEPARATOR` against a live
/// `SystemProgram.rome_evm_program_id()` precompile call, which is out of
/// scope on hardhat-network (same constraint documented in
/// `approve-saturation.test.ts` / `bridge-out-collapse.test.ts`) — so this
/// suite exercises `PermitDomainHelper`, a pure-Solidity mirror of the SAME
/// formula, against the EXACT SAME golden fixture the Rome EVM program's
/// `non_evm::permit` unit tests use (program id, chain id, owner, spender,
/// value, nonce, deadline, digest). A match here is a real cross-language
/// (Rust <-> Solidity/EVM) proof that the two sides recompute byte-identical
/// digests — not just an eyeballed formula comparison.
///
/// What needs a live chain (out of scope here, tracked against Halborn
/// #511 for the chain-side smoke suite once the Rome EVM program's permit
/// selector is deployed):
///   - permit() sets the delegate from a signature with no owner tx —
///     a relayer submits, allowance_of(owner,spender,mint) becomes value.
///   - wrong/expired signature is refused, surfacing the program error.
///   - a DelegatecallRelay delegatecalling permit() with a victim caller
///     still only approves the recovered owner's ATA (the #511 regression
///     stays fixed under Solidity-side delegatecall too).
describe("SPL_ERC20 permit domain (Halborn #511 follow-up)", function () {
    let helper: any;

    // Same fixture as the Rome EVM program's non_evm::permit unit tests —
    // signer = well-known Hardhat account #0.
    const FIX_PROGRAM_ID_BYTES32 =
        "0x063f54f28bb4a78ab425ef0fd1bd70c91124059a38150ce5765d4bcad916b62c" as `0x${string}`;
    const FIX_CHAIN_ID = 200_011n;
    const FIX_OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as `0x${string}`;
    const FIX_SPENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as `0x${string}`;
    const FIX_VALUE = 1_000_000n;
    const FIX_NONCE = 0n;
    const FIX_DEADLINE = 1_751_630_000n;
    const FIX_DIGEST =
        "0xa370e05aaa5627bd56bced2acef6ba21fe6f93a69d0c633fe6538b04ce15650f" as `0x${string}`;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        helper = await viem.deployContract("PermitDomainHelper", []);
    });

    it("PERMIT_TYPEHASH matches the canonical EIP-2612 type string", async function () {
        const expected = keccak256(
            stringToBytes(
                "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
            ),
        );
        const actual = await helper.read.PERMIT_TYPEHASH();
        assert.equal(actual, expected);
    });

    it("permitDigest(golden fixture) matches the Rome EVM program's golden vector", async function () {
        const digest = await helper.read.permitDigest([
            FIX_PROGRAM_ID_BYTES32,
            FIX_CHAIN_ID,
            FIX_OWNER,
            FIX_SPENDER,
            FIX_VALUE,
            FIX_NONCE,
            FIX_DEADLINE,
        ]);
        assert.equal(
            digest,
            FIX_DIGEST,
            "Solidity digest must byte-match the Rust permit_digest golden vector",
        );
    });

    it("permitDigest changes when any signed field is tampered (control-varies-the-world)", async function () {
        const base = await helper.read.permitDigest([
            FIX_PROGRAM_ID_BYTES32,
            FIX_CHAIN_ID,
            FIX_OWNER,
            FIX_SPENDER,
            FIX_VALUE,
            FIX_NONCE,
            FIX_DEADLINE,
        ]);
        const tamperedValue = await helper.read.permitDigest([
            FIX_PROGRAM_ID_BYTES32,
            FIX_CHAIN_ID,
            FIX_OWNER,
            FIX_SPENDER,
            FIX_VALUE + 1n,
            FIX_NONCE,
            FIX_DEADLINE,
        ]);
        assert.notEqual(tamperedValue, base);

        const tamperedChain = await helper.read.permitDigest([
            FIX_PROGRAM_ID_BYTES32,
            FIX_CHAIN_ID + 1n,
            FIX_OWNER,
            FIX_SPENDER,
            FIX_VALUE,
            FIX_NONCE,
            FIX_DEADLINE,
        ]);
        assert.notEqual(tamperedChain, base);
    });
});

/// Selector locks for the two new precompile selectors `erc20spl.sol`
/// dispatches — companion to `delegatecall-gate.selectors.test.ts`. If
/// either signature string drifts from the on-chain dispatcher's const in
/// the Rome EVM program's non_evm/helper.rs, this fails loudly instead of
/// every permit() call reverting with an opaque precompile error.
describe("HelperProgram permit selectors (Halborn #511 follow-up)", () => {
    function selectorOf(signature: string): `0x${string}` {
        return keccak256(stringToBytes(signature)).slice(0, 10) as `0x${string}`;
    }

    it("permit_approve_spl_raw_delegate(bytes32,address,address,uint64,bytes32,uint8,uint64,uint8,bytes32,bytes32) = 0x3a2cef1b", () => {
        assert.equal(
            selectorOf(
                "permit_approve_spl_raw_delegate(bytes32,address,address,uint64,bytes32,uint8,uint64,uint8,bytes32,bytes32)",
            ),
            "0x3a2cef1b",
        );
    });

    it("permit_nonce(address) = 0xf08c1556", () => {
        assert.equal(selectorOf("permit_nonce(address)"), "0xf08c1556");
    });
});
