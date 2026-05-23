import hardhat from "hardhat";
import { parseAbi, getAddress } from "viem";

const POOL_WRAPPER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";
const USER = "0x1f4946be340f06c46a50e65084790968abcc48f6";

const abi = parseAbi([
    "function make_swap_accounts_from_pool(address user_addr, uint8 in_token) view returns ((bytes32 pool, bytes32 user_source_token, bytes32 user_destination_token, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 a_vault, bytes32 b_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 user, bytes32 vault_program, bytes32 token_program, bytes32 protocol_token_fee))",
    "function pool_address() view returns (bytes32)",
    "function token_a_mint() view returns (bytes32)",
    "function token_b_mint() view returns (bytes32)",
    "function protocol_token_a_fee() view returns (bytes32)",
    "function protocol_token_b_fee() view returns (bytes32)",
    "function lp_mint() view returns (bytes32)",
    "function a_vault() view returns (bytes32)",
    "function b_vault() view returns (bytes32)",
]);

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();

    // Token A = wUSDC swap = in_token=0
    const swap_in_A = await pc.readContract({ address: POOL_WRAPPER, abi, functionName: "make_swap_accounts_from_pool", args: [USER, 0] }) as any;
    console.log("\nSwap accounts (wUSDC → wSOL):");
    const labels = ["pool", "user_source_token (wUSDC ATA)", "user_destination_token (wSOL ATA)", "a_vault_lp", "b_vault_lp", "a_vault", "b_vault", "a_vault_lp_mint", "b_vault_lp_mint", "a_token_vault", "b_token_vault", "user", "vault_program", "token_program", "protocol_token_fee"];
    const bs58 = await import("bs58");
    for (const [i, lbl] of labels.entries()) {
        const hex = swap_in_A[i];
        const bytes = Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
        const b58 = bs58.default.encode(bytes);
        const mark = b58 === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
        console.log(`  metas[${i.toString().padStart(2)}]  ${lbl.padEnd(38)} ${b58}${mark}`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
