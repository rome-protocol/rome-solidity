// Validates the hot-deploy + cold-Ledger admin-handover pattern end-to-end:
//   1. deploy OracleAdapterFactory with a hot key (owner = hot key)
//   2. transferOwnership(LEDGER) signed by the hot key (tap-free)
//   3. assert owner() == LEDGER
//
//   DEPLOY_PRIVATE_KEY=0x<hot> LEDGER_ADDRESS=0x<ledger> npx tsx scripts/test-handover.ts
//
// Constructor placeholders are fine — only `defaultMaxStaleness` is validated;
// impl addresses are merely stored (we exercise ownership, not feed creation).

import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDeployer } from "./lib/deployer.js";
import { handOverOwner } from "./transfer-admin-to-ledger.js";
import { romeChain } from "./lib/ledger.js";

const RPC = process.env.ROME_RPC_URL ?? "https://trajan.devnet.romeprotocol.xyz/";
const CHAIN_ID = Number(process.env.ROME_CHAIN_ID ?? "121302");
const LEDGER = getAddress(process.env.LEDGER_ADDRESS ?? "0x3D60F9B3E11CBe57516351F18FD9D6c3Fd4B8F96");
const PH: Address = "0x0000000000000000000000000000000000000001";
const Z32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
    const deployer = await getDeployer(CHAIN_ID, RPC); // hot key (DEPLOY_PRIVATE_KEY)
    console.log("Hot deployer:", deployer.address);

    const factory = await deployer.deploy("OracleAdapterFactory", [PH, PH, Z32, Z32, 3600n, PH, PH]);
    console.log("OracleAdapterFactory (hot-owned):", factory.address);

    const pk = process.env.DEPLOY_PRIVATE_KEY as string;
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
    const chain = romeChain(CHAIN_ID, RPC);
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });
    const pub = createPublicClient({ chain, transport: http(RPC) });

    console.log(`Handing owner -> cold Ledger ${LEDGER} (signed by hot key, tap-free)...`);
    await handOverOwner(wallet, pub, factory.address, LEDGER);
    console.log("✓ hot-deploy + cold-Ledger admin handover validated (owner == Ledger).");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
