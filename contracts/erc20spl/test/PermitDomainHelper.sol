// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Mirror of the EIP-712 domain + digest construction `SPL_ERC20Base`'s
/// constructor (`DOMAIN_SEPARATOR`) and `permit()` use. Pure functions so
/// the byte-exact match against the Rome EVM program's permit digest
/// (`non_evm::permit::permit_digest`) is testable on hardhat-network without a live chain's
/// `SystemProgram.rome_evm_program_id()` precompile call (out of scope
/// here — the real domain separator is computed in the real constructor
/// against the real precompile; this only re-derives the SAME formula
/// against caller-supplied program-id/chain-id so the two languages can be
/// compared against one golden vector).
contract PermitDomainHelper {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)");
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @notice Same formula as `SPL_ERC20Base`'s constructor.
    function domainSeparator(bytes32 romeProgramId, uint256 chainId) public pure returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("Rome SPL ERC20")),
            keccak256(bytes("1")),
            chainId,
            keccak256(abi.encodePacked(romeProgramId))
        ));
    }

    /// @notice Same formula as the EIP-712 digest a `permit()` signer signs over.
    function permitDigest(
        bytes32 romeProgramId,
        uint256 chainId,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) external pure returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            PERMIT_TYPEHASH, owner, spender, value, nonce, deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(romeProgramId, chainId), structHash));
    }
}
