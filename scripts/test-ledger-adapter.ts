// Standalone validation of the viem Ledger adapter (scripts/lib/ledger.ts).
// Deploys a minimal contract (runtime 0x00) to a Rome chain, signed by the
// connected Ledger. Proves transport + getAddress + signTransaction + broadcast
// independent of the full deploy-script machinery.
//
//   ROME_RPC_URL=... ROME_CHAIN_ID=... LEDGER_PATH=... npx hardhat run scripts/test-ledger-adapter.ts
//
// Defaults target trajan (devnet, chain 121302). Ethereum app open + Blind signing ON.

import { makeLedgerDeployer, DEFAULT_LEDGER_PATH } from "./lib/ledger.js";

const RPC = process.env.ROME_RPC_URL ?? "https://trajan.devnet.romeprotocol.xyz/";
const CHAIN_ID = Number(process.env.ROME_CHAIN_ID ?? "121302");
const LEDGER_PATH = process.env.LEDGER_PATH ?? DEFAULT_LEDGER_PATH;

async function main() {
    console.log(`Connecting Ledger (path ${LEDGER_PATH})...`);
    const deployer = await makeLedgerDeployer(CHAIN_ID, RPC, LEDGER_PATH);
    console.log("Ledger address:", deployer.address);
    console.log("Gas balance (wei):", (await deployer.getBalance()).toString());
    console.log("Deploying minimal contract (runtime 0x00) — APPROVE ON THE DEVICE...");
    const { address } = await deployer.deploy([], "0x600060005360016000f3");
    console.log("✓ Deployed at:", address);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
