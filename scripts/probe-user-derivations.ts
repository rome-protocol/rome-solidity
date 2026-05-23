import hardhat from "hardhat";
import { encodeFunctionData, decodeAbiParameters } from "viem";
import bs58 from "bs58";

const USER = "0x1f4946be340f06c46a50e65084790968abcc48f6";
const WUSDC_MINT_BYTES32 = "0x" + bs58.decode("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
const WSOL_MINT_BYTES32  = "0x" + bs58.decode("So11111111111111111111111111111111111111112").reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");

// HelperProgram precompile at 0xFF...08; selectors
//   derive_user_ata(address user, bytes32 mint) -> bytes32 ata pubkey
//   derive_user_pda(address user) -> bytes32 pda pubkey
// from CLAUDE.md: derive_user_ata one of the CPI shortcut selectors

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();

    // Try several known selectors / shapes for the helper precompile
    const CPI_HELPER = "0xFF00000000000000000000000000000000000008" as const;

    // derive_user_ata: selector probably keccak("derive_user_ata(address,bytes32)") truncated
    // From rome-evm-private docs (CPI_PRECOMPILE_SHORTCUTS_V2): the selector is 4-byte tag at start of calldata
    // The exact bytes are hard to guess. Try via the HelperProgram lib in rome-solidity:
    
    // Easier: deploy a tiny probe contract that calls HelperProgram.ata / .pda and emits result
    const src = `
        // SPDX-License-Identifier: MIT
        pragma solidity 0.8.28;
        interface IHelper {
            function ata(address user, bytes32 mint) external view returns (bytes32);
            function pda(address user) external view returns (bytes32);
        }
    `;
    
    // We'll use the actual HelperProgram library which is in rome-solidity/contracts/lib
    // by deploying a probe that exposes its methods
    const probe = await viem.deployContract("HelperProgramProbe");
    const wUsdcAta = await pc.readContract({ address: probe.address, abi: probe.abi, functionName: "ata", args: [USER, WUSDC_MINT_BYTES32] }) as `0x${string}`;
    const wSolAta = await pc.readContract({ address: probe.address, abi: probe.abi, functionName: "ata", args: [USER, WSOL_MINT_BYTES32] }) as `0x${string}`;
    const userPda = await pc.readContract({ address: probe.address, abi: probe.abi, functionName: "pda", args: [USER] }) as `0x${string}`;
    
    function toB58(h: string) { return bs58.encode(Buffer.from(h.slice(2), 'hex')); }
    const TGT = "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm";
    function mark(b58: string) { return b58 === TGT ? " <-- BctLf2Q!" : ""; }
    console.log(`user_pda:         ${toB58(userPda)}${mark(toB58(userPda))}`);
    console.log(`user wUSDC ATA:   ${toB58(wUsdcAta)}${mark(toB58(wUsdcAta))}`);
    console.log(`user wSOL ATA:    ${toB58(wSolAta)}${mark(toB58(wSolAta))}`);
}
main().catch(e => { console.error(e.shortMessage || e); process.exit(1); });
