// Cold-Ledger deploy entrypoint for the rome-solidity stack.
//
//   npx hardhat compile
//   DEPLOY_VIA_LEDGER=1 ROME_RPC_URL=https://<chain>.romeprotocol.xyz/ ROME_CHAIN_ID=<id> \
//     npx tsx scripts/deploy-ledger.ts
//
// Signs every deploy with a connected Ledger (Ethereum app, Blind signing ON).
// Currently deploys ERC20SPLFactory (the foundational Phase-6 contract); the
// remaining stack contracts are added here as `deployer.deploy(<name>, [args])`
// calls in the same order as scripts/deploy-solidity.sh Phase 6.

import { getDeployer } from "./lib/deployer.js";

const RPC = process.env.ROME_RPC_URL ?? "https://trajan.devnet.romeprotocol.xyz/";
const CHAIN_ID = Number(process.env.ROME_CHAIN_ID ?? "121302");
const CPI = (process.env.CPI_CONTRACT_ADDRESS ?? "0xFF00000000000000000000000000000000000008") as `0x${string}`;

async function main() {
    const deployer = await getDeployer(CHAIN_ID, RPC);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance (wei): ${(await deployer.getBalance()).toString()}`);

    console.log("Deploying ERC20SPLFactory — APPROVE ON THE DEVICE...");
    const factory = await deployer.deploy("ERC20SPLFactory", [CPI]);
    console.log("✓ ERC20SPLFactory:", factory.address);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
