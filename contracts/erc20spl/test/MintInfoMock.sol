// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MintInfoMock
/// @notice Stands in for the `mint_info` precompile so wrapper constructors can
///         be *executed* in a local test, not merely read as source.
///
/// @dev Installed at the precompile address with `hardhat_setCode`, which copies
///      code and not storage, so this must be stateless: the answer is derived
///      from the mint id itself. That also means one instance serves every case.
///      Also answers `rome_evm_program_id()` (Halborn #511 follow-up — the
///      wrapper constructor reads it to compute the permit EIP-712 domain).
///
///      Layout of the mint id, most-significant byte first:
///
///        byte 0  decimals
///        byte 1  non-zero arms the transfer hook
///        bytes 2-3  transfer fee, basis points, big-endian
///        byte 4  non-zero marks the mint legacy rather than Token-2022
///        byte 5  non-zero marks the hook PRESENT in the extension bitmap
///
///      The remaining bytes are free, so a test can keep mint ids distinct while
///      asking for the same facts.
///
///      Presence is deliberately separate from arming. A mint can carry the
///      TransferHook extension with a zero program_id — present, inert — and that
///      is the case the wrappers must accept. A mock that derived the bitmap from
///      the armed state could not express it, and so could not catch a wrapper
///      that refused on presence. Arming implies presence; the reverse does not
///      hold.
///
///      Only the shape the wrappers consume is modelled. It is deliberately not
///      a Token-2022 implementation: `mint_info` is the whole surface either
///      constructor touches, which is why this is one function.
interface ISeed {
    struct Seed {
        bytes item;
    }
}

contract MintInfoMock {
    bytes32 public constant TOKEN_2022 =
        0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc;
    bytes32 public constant TOKEN_LEGACY =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    /// The one real mint this mock knows: ai16z, dumped from mainnet and committed
    /// as a CI fixture. Its identity lives in the mint itself — MetadataPointer
    /// self-referential, TokenMetadata carrying name and symbol "ai16z" — which is
    /// the shape the factory has to read and today does not.
    bytes32 public constant FIXTURE_MINT =
        0xf74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f87;
    bytes public constant FIXTURE_MINT_DATA = hex"010000008e266e49fd037319a0710185b369e0be018bbb2b1baa2b240e6b84f1837b01efb6c4322896b0430f0901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001120040000000000000000000000000000000000000000000000000000000000000000000f74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f871300aa008e266e49fd037319a0710185b369e0be018bbb2b1baa2b240e6b84f1837b01eff74be1d76ab9a6c2be4999663fc6a0e19974000e836ef30c5b6286f42c020f8705000000616931367a05000000616931367a5000000068747470733a2f2f697066732e696f2f697066732f6261666b726569676166346d6d69626b6d6a6d7a346d6e346f7073767a62637037346b3265646c6475693268787465636f666c616c746f6737783400000000";

    /// Only the fixture mint exists; everything else reads as absent, so the
    /// Metaplex fallback finds nothing and the native path is what is under test.
    function account_info(bytes32 pubkey)
        external
        pure
        returns (uint64, bytes32, bool, bool, bool, bytes memory)
    {
        if (pubkey == FIXTURE_MINT) {
            return (1, TOKEN_2022, false, false, false, FIXTURE_MINT_DATA);
        }
        return (0, bytes32(0), false, false, false, "");
    }

    /// The factory's constructor converts a program name before any mint is in
    /// play, so installing this at the System precompile too is what makes the
    /// factory deployable here. The value is irrelevant to the gate under test.
    function base58_to_bytes32(bytes calldata) external pure returns (bytes32) {
        return keccak256("mint_info.mock.base58");
    }

    /// Halborn #511 follow-up — `SPL_ERC20Base`'s constructor now also reads
    /// this (to fold into the EIP-712 permit `DOMAIN_SEPARATOR`), so it must
    /// be installed here too for the wrapper to be constructible in these
    /// tests. The value is irrelevant to every gate under test in this file
    /// — none of them assert on `DOMAIN_SEPARATOR` or `permit()`; those are
    /// covered against a real Rome program id in
    /// `tests/erc20spl/permit-domain.test.ts`.
    function rome_evm_program_id() external pure returns (bytes32) {
        return keccak256("mint_info.mock.rome_evm_program_id");
    }

    /// Enough of `find_program_address` to make ATA derivation observable: the
    /// answer is a hash of everything that went in, so two derivations differ
    /// exactly when their seeds do. That is the property under test — an ATA's
    /// seeds include the token program, so resolving it from the mint rather than
    /// hardcoding it has to change the address.
    function find_program_address(bytes32 program, ISeed.Seed[] calldata seeds)
        external
        pure
        returns (bytes32, uint8)
    {
        bytes memory acc;
        for (uint256 i = 0; i < seeds.length; ++i) {
            acc = abi.encodePacked(acc, seeds[i].item);
        }
        return (keccak256(abi.encodePacked(program, acc)), uint8(255));
    }

    function mint_info(bytes32 mint)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
        // The fixture is a real mint, so report what it actually is rather than
        // deriving from its pubkey — byte 1 of a real pubkey is arbitrary and would
        // otherwise trip the armed-hook gate.
        if (mint == FIXTURE_MINT) {
            return (TOKEN_2022, 9, bytes32(0), 0, (uint32(1) << 18) | (uint32(1) << 19));
        }
        decimals = uint8(mint[0]);

        // Unarmed reads as zero, exactly as the program encodes it — a hook can
        // be present and inert, and the wrappers must not refuse that.
        hookProgram = mint[1] == 0
            ? bytes32(0)
            : keccak256(abi.encodePacked("mint_info.mock.hook", mint));

        feeBps = (uint16(uint8(mint[2])) << 8) | uint16(uint8(mint[3]));
        tokenProgram = mint[4] == 0 ? TOKEN_2022 : TOKEN_LEGACY;

        // Presence bitmap. Independent of arming, because that is the whole
        // point: bit 14 set with a zero hookProgram is a present-but-inert hook.
        extensions = 0;
        if (hookProgram != bytes32(0) || mint[5] != 0) extensions |= uint32(1) << 14; // TransferHook
        if (feeBps != 0) extensions |= uint32(1) << 1;                               // TransferFeeConfig
    }
}
