// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ISystemProgram,
    SystemProgram,
    ICrossProgramInvocation,
    CpiProgram,
    IHelperProgram,
    HelperProgram,
    IWithdraw,
    Withdraw
} from "../../interface.sol";
import {SplTokenLib} from "../../spl_token/spl_token.sol";

/// @title BenchProbe — comprehensive primitive CU measurement
/// @notice Each external function exercises EXACTLY ONE primitive so a
///         caller measuring `computeUnitsConsumed` via the Solana tx
///         receipt attributes the cost to one operation. Paired old/new
///         variants enable direct before/after comparison.
contract BenchProbe {
    /// State for Tier 2 (mutation) probes. Set via setup().
    bool public setupDone;
    address public dest;

    // ─────────────────────────────────────────────────────────────────
    // PDA / ATA derivation (Tier 1 — no state setup)
    // ─────────────────────────────────────────────────────────────────

    /// Solana PDA seeds are 32 bytes max each — use bytes32-packed second seed.
    function _seedsFor(uint256 idx) internal pure returns (ISystemProgram.Seed[] memory) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("benchmark"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(idx));
        return seeds;
    }

    function probe_findPda_single(uint256 idx) external view returns (bytes32) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        (bytes32 pda, ) = SystemProgram.find_program_address(programId, _seedsFor(idx));
        return pda;
    }

    function probe_findPda_twoHop(uint256 idx) external view returns (bytes32) {
        bytes32 romeProgram = SystemProgram.rome_evm_program_id();

        ISystemProgram.Seed[] memory pdaSeeds = new ISystemProgram.Seed[](2);
        pdaSeeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        pdaSeeds[1] = ISystemProgram.Seed(abi.encodePacked(bytes32(idx)));
        (bytes32 userPda, ) = SystemProgram.find_program_address(romeProgram, pdaSeeds);

        bytes32 mintId = SystemProgram.mint_id();
        bytes32 splTokenProgram = bytes32(uint256(uint160(0)) | uint256(0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9));
        bytes32 ataProgram = bytes32(uint256(uint160(0)) | uint256(0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859));

        ISystemProgram.Seed[] memory ataSeeds = new ISystemProgram.Seed[](3);
        ataSeeds[0] = ISystemProgram.Seed(abi.encodePacked(userPda));
        ataSeeds[1] = ISystemProgram.Seed(abi.encodePacked(splTokenProgram));
        ataSeeds[2] = ISystemProgram.Seed(abi.encodePacked(mintId));
        (bytes32 ataAddr, ) = SystemProgram.find_program_address(ataProgram, ataSeeds);
        return ataAddr;
    }

    function probe_helperPda(address user) external view returns (bytes32) {
        return HelperProgram.pda(user);
    }

    function probe_helperAta(address user, bytes32 mint) external view returns (bytes32) {
        return HelperProgram.ata(user, mint);
    }

    // NOTE: `probe_createPdaWithBump` (calls SystemProgram.create_program_address)
    // omitted — that interface declaration lives on the pda-cost-probe branch
    // and was not merged to master. Re-add once the selector decl ships.

    // ─────────────────────────────────────────────────────────────────
    // Batch derive (Tier 1 — no state setup)
    // ─────────────────────────────────────────────────────────────────

    /// 7× sequential find_program_address. Baseline for the batch comparison.
    function probe_findPda_7sequential(uint256 baseIdx) external view returns (bytes32[] memory) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        bytes32[] memory pdas = new bytes32[](7);
        for (uint256 i = 0; i < 7; i++) {
            ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
            seeds[0] = ISystemProgram.Seed(bytes("benchmark"));
            seeds[1] = ISystemProgram.Seed(abi.encodePacked(baseIdx + i));
            (bytes32 pda, ) = SystemProgram.find_program_address(programId, seeds);
            pdas[i] = pda;
        }
        return pdas;
    }

    /// 7× via pdas_batch_derive — one dispatch.
    function probe_pdasBatch_7(uint256 baseIdx) external view returns (ICrossProgramInvocation.PdaWithBump[] memory) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        bytes[][] memory seedGroups = new bytes[][](7);
        for (uint256 i = 0; i < 7; i++) {
            seedGroups[i] = new bytes[](2);
            seedGroups[i][0] = bytes("benchmark");
            seedGroups[i][1] = abi.encodePacked(baseIdx + i);
        }
        return CpiProgram.pdas_batch_derive(seedGroups, programId);
    }

    // ─────────────────────────────────────────────────────────────────
    // Account reads (Tier 1 — no state setup)
    // ─────────────────────────────────────────────────────────────────

    function probe_accountInfo(bytes32 pubkey) external view returns (uint64 lamports, bytes32 owner, bool isSigner, bool isWritable, bool executable, uint256 dataLen) {
        bytes memory data;
        (lamports, owner, isSigner, isWritable, executable, data) = CpiProgram.account_info(pubkey);
        dataLen = data.length;
    }

    function probe_accountDataAt(bytes32 pubkey, uint16 offset, uint16 length) external view returns (bytes memory) {
        return CpiProgram.account_data_at(pubkey, offset, length);
    }

    function probe_accountU64At(bytes32 pubkey, uint16 offset) external view returns (uint64) {
        return CpiProgram.account_u64_at(pubkey, offset);
    }

    function probe_accountLamports(bytes32 pubkey) external view returns (uint64) {
        return CpiProgram.account_lamports(pubkey);
    }

    function probe_mintId() external view returns (bytes32) {
        return SystemProgram.mint_id();
    }

    function probe_operator() external view returns (bytes32) {
        return SystemProgram.operator();
    }

    // ─────────────────────────────────────────────────────────────────
    // Tier 2 — Mutations (require setup)
    // ─────────────────────────────────────────────────────────────────

    /// Accept native gas from EOA — needed before setup().
    receive() external payable {}

    /// One-time state init. Funded via msg.value on this call (deployer
    /// sends enough gas for the initial wrap). Activates probe's PDA,
    /// creates probe's gas-mint ATA, creates destination's ATA so transfer
    /// probes don't pay create cost, and wraps a starter balance.
    ///
    /// CU spent here is NOT measured as a probe — this is one-time setup.
    function setup(address _dest, uint256 initialWrapWei) external payable {
        require(!setupDone, "already setup");
        require(msg.value >= initialWrapWei, "send wei >= initialWrapWei");
        dest = _dest;

        // Activate probe's PDA + create probe's gas-mint ATA.
        HelperProgram.create_pda(address(this));
        HelperProgram.create_ata(address(this));

        // Pre-create dest ATA so transfer probes measure transfer-only cost.
        HelperProgram.create_ata(_dest);

        // Wrap a starter amount into probe's wUSDC ATA so unwrap/transfer
        // probes have balance to work against.
        Withdraw.withdraw_to_ata(initialWrapWei);

        setupDone = true;
    }

    /// Wrap (NEW): gas → wrapper ATA via Withdraw.withdraw_to_ata.
    /// Single Solana CPI (composed): mint wrapper SPL + credit to ATA.
    function probe_wrap_new(uint64 amount) external {
        Withdraw.withdraw_to_ata(amount);
    }

    /// Unwrap (NEW): wrapper ATA → gas via HelperProgram.deposit_from_ata.
    /// Single Solana CPI (composed): burn wrapper SPL + credit gas.
    function probe_unwrap_new(uint256 wei_) external {
        HelperProgram.deposit_from_ata(wei_);
    }

    /// SPL transfer NEW 3-arg: HelperProgram.transfer_spl(addr, N, mint).
    /// Source = probe's PDA-owned ATA (derived implicitly). Dest = address-keyed.
    function probe_transfer_spl_helper_3arg() external {
        bytes32 mintId = SystemProgram.mint_id();
        HelperProgram.transfer_spl(dest, uint64(1), mintId);
    }

    /// SPL transfer NEW 4-arg delegate: explicit src_ata + dest_ata.
    /// This is the B1 migration candidate for SPL_ERC20._transfer.
    function probe_transfer_spl_helper_4arg() external {
        bytes32 mintId = SystemProgram.mint_id();
        bytes32 srcAta = HelperProgram.ata(address(this), mintId);
        bytes32 destAta = HelperProgram.ata(dest, mintId);
        HelperProgram.transfer_spl(srcAta, destAta, uint64(1), mintId);
    }

    /// SPL transfer LEGACY fallback: SplTokenLib.transfer_checked +
    /// CpiProgram.invoke_signed. This is what SPL_ERC20._transfer does
    /// today (see erc20spl.sol:290).
    function probe_transfer_spl_legacy() external {
        bytes32 mintId = SystemProgram.mint_id();
        bytes32 srcAta = HelperProgram.ata(address(this), mintId);
        bytes32 destAta = HelperProgram.ata(dest, mintId);
        bytes32 ownerPda = HelperProgram.pda(address(this));

        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(mintId, address(CpiProgram));

        ICrossProgramInvocation.AccountMeta[] memory accts = new ICrossProgramInvocation.AccountMeta[](4);
        accts[0] = ICrossProgramInvocation.AccountMeta(srcAta, false, true);    // source (writable)
        accts[1] = ICrossProgramInvocation.AccountMeta(mintId, false, false);   // mint
        accts[2] = ICrossProgramInvocation.AccountMeta(destAta, false, true);   // destination (writable)
        accts[3] = ICrossProgramInvocation.AccountMeta(ownerPda, true, false);  // authority (signer)
        bytes memory data = abi.encodePacked(uint8(12), _u64le(uint64(1)), mint.decimals);

        bytes32[] memory emptySeeds = new bytes32[](0);
        CpiProgram.invoke_signed(SplTokenLib.SPL_TOKEN_PROGRAM, accts, data, emptySeeds);
    }

    // ─────────────────────────────────────────────────────────────────
    // Tier 3 — Universal-delegation (A1-A6 from the Rome EVM program #364)
    //           Paired old/new for benchmark side-by-side
    // ─────────────────────────────────────────────────────────────────

    /// A3 OLD: salted PDA derivation via 2 syscalls
    ///   (1) SystemProgram.rome_evm_program_id() + (2) find_program_address.
    /// This is the v1 path consumed by `RomeEVMAccount.pda_with_salt`
    /// pre-#165 (now collapsed to A3).
    function probe_a3_pdaWithSalt_OLD(address user, bytes32 salt) external view returns (bytes32) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(user));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(salt));
        (bytes32 pda, ) = SystemProgram.find_program_address(programId, seeds);
        return pda;
    }

    /// A3 NEW: HelperProgram.pda_with_salt — single dispatch (selector 0x5c6d04b3).
    /// Shipped in the Rome EVM program #364, consumed by RomeEVMAccount.pda_with_salt
    /// in rome-solidity #165.
    function probe_a3_pdaWithSalt_NEW(address user, bytes32 salt) external view returns (bytes32) {
        return HelperProgram.pda_with_salt(user, salt);
    }

    /// A2 OLD: SPL approve via SplTokenLib.approve + CpiProgram.invoke_signed.
    /// This is the v1 path consumed by RomeBridgeWithdraw.approveBurnETH
    /// pre-#165. The OLD SPL instruction is the 3-account `approve` (tag 4)
    /// — no on-chain decimals enforcement. Caller pays mint-read cost
    /// separately if `approve_checked` semantics are wanted.
    function probe_a2_approveSplRawDelegate_OLD(bytes32 delegate, uint64 amount) external {
        bytes32 mintId = SystemProgram.mint_id();
        bytes32 srcAta = HelperProgram.ata(address(this), mintId);
        bytes32 ownerPda = HelperProgram.pda(address(this));

        ICrossProgramInvocation.AccountMeta[] memory accts = new ICrossProgramInvocation.AccountMeta[](3);
        accts[0] = ICrossProgramInvocation.AccountMeta(srcAta, false, true);    // source (writable)
        accts[1] = ICrossProgramInvocation.AccountMeta(delegate, false, false); // delegate
        accts[2] = ICrossProgramInvocation.AccountMeta(ownerPda, true, false);  // owner (signer)
        bytes memory data = abi.encodePacked(uint8(4), _u64le(amount));

        bytes32[] memory emptySeeds = new bytes32[](0);
        CpiProgram.invoke_signed(SplTokenLib.SPL_TOKEN_PROGRAM, accts, data, emptySeeds);
    }

    /// A2 NEW: HelperProgram.approve_spl_raw_delegate — single dispatch
    /// (selector 0x7881d453). Caller passes `decimals` to skip on-chain
    /// mint read (~30-50K CU saving over a decimals-fetching variant).
    /// Shipped in the Rome EVM program #364, consumed by
    /// RomeBridgeWithdraw.approveBurnETH in rome-solidity #165.
    function probe_a2_approveSplRawDelegate_NEW(bytes32 delegate, uint64 amount, uint8 decimals) external {
        bytes32 mintId = SystemProgram.mint_id();
        bytes32 srcAta = HelperProgram.ata(address(this), mintId);
        HelperProgram.approve_spl_raw_delegate(srcAta, delegate, amount, mintId, decimals);
    }

    /// Inline LE-u64 encoder — used by the OLD probes that encode raw SPL
    /// instructions. Replaces the prior `SplTokenLib._le_u64` (pruned in #169).
    function _u64le(uint64 v) private pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(v),
            uint8(v >> 8),
            uint8(v >> 16),
            uint8(v >> 24),
            uint8(v >> 32),
            uint8(v >> 40),
            uint8(v >> 48),
            uint8(v >> 56)
        );
    }
}
