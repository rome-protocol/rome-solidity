// Direct test: feed the 1227-byte vault A buffer to the parser harness and
// see what comes back. If outputs differ from the on-chain bytes, parse_vault
// is buggy. Otherwise update_state stored stale data.
import hardhat from "hardhat";
import { parseAbi } from "viem";

const A_VAULT = "0x7ddd69be7e8ccb013532108994bf543de518d8128d918648af8ee02f8d37965a" as `0x${string}`;
const CPI = "0xff00000000000000000000000000000000000008" as `0x${string}`;

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();

    // Deploy fresh harness
    const harness = await viem.deployContract("DAMMv1VaultParserHarness", []);
    const harnessAddr = harness.address;
    console.log(`harness: ${harnessAddr}`);

    // Pull the full 1227-byte slice via cpi precompile
    const cpiAbi = parseAbi([
        "function account_data_at(bytes32 pubkey, uint16 offset, uint16 length) external view returns (bytes)",
    ]);
    const data = await pc.readContract({
        address: CPI, abi: cpiAbi, functionName: "account_data_at",
        args: [A_VAULT, 0, 1227],
    }) as `0x${string}`;
    console.log(`data length: ${(data.length - 2) / 2} bytes`);

    // Hand-decoded expectations
    console.log(`\nExpected (per parse_vault offset spec):`);
    console.log(`  enabled = 0x${data.slice(2 + 16, 2 + 18)}`);
    console.log(`  vault_bump = 0x${data.slice(2 + 18, 2 + 20)}`);
    console.log(`  token_vault_bump = 0x${data.slice(2 + 20, 2 + 22)}`);
    console.log(`  total_amount LE = 0x${data.slice(2 + 22, 2 + 38)}`);
    console.log(`  token_vault = 0x${data.slice(2 + 38, 2 + 102)}`);
    console.log(`  fee_vault = 0x${data.slice(2 + 102, 2 + 166)}`);
    console.log(`  token_mint = 0x${data.slice(2 + 166, 2 + 230)}`);
    console.log(`  lp_mint = 0x${data.slice(2 + 230, 2 + 294)}`);

    // Call harness.parseVault with the data
    console.log(`\nCalling harness.parseVault on the slice...`);
    const harnessAbi = parseAbi([
        "function parseVault(bytes) external pure returns (uint8 enabled, uint8 vaultBump, uint8 tokenVaultBump, uint64 totalAmount, bytes32 tokenVault, bytes32 feeVault, bytes32 tokenMint, bytes32 lpMint)",
    ]);
    const result = await pc.readContract({
        address: harnessAddr, abi: harnessAbi, functionName: "parseVault",
        args: [data],
    }) as any;
    console.log(`\nActual parse_vault output:`);
    console.log(`  enabled = ${result[0]}`);
    console.log(`  vault_bump = ${result[1]}`);
    console.log(`  token_vault_bump = ${result[2]}`);
    console.log(`  total_amount = ${result[3]}`);
    console.log(`  token_vault = ${result[4]}`);
    console.log(`  fee_vault = ${result[5]}`);
    console.log(`  token_mint = ${result[6]}`);
    console.log(`  lp_mint = ${result[7]}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
