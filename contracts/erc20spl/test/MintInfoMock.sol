// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MintInfoMock
/// @notice Stands in for the `mint_info` precompile so wrapper constructors can
///         be *executed* in a local test, not merely read as source.
///
/// @dev Installed at the precompile address with `hardhat_setCode`, which copies
///      code and not storage, so this must be stateless: the answer is derived
///      from the mint id itself. That also means one instance serves every case.
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
contract MintInfoMock {
    bytes32 public constant TOKEN_2022 =
        0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc;
    bytes32 public constant TOKEN_LEGACY =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    function mint_info(bytes32 mint)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
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
