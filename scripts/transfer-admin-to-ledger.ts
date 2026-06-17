// Cold-Ledger admin handover for the Rome Phase-6 stack.
//
// Most Phase-6 contracts have NO transferable admin (factories/wrappers/bridge-
// withdraw/activator/router/WETH are permissionless or fully immutable). Only
// two carry a transferable privileged role, both single-step:
//   - OracleAdapterFactory.owner          via transferOwnership(address)
//   - UniswapV2Factory.feeToSetter (Romeswap) via setFeeToSetter(address)
//
// So the cold-ledger flow is: hot-deploy the stack (fast, tap-free), then run
// this to hand those two roles to the cold Ledger address. The transfers are
// signed by the CURRENT owner (the hot deployer) — the Ledger only receives, so
// the handover itself is tap-free; the Ledger taps only when it later exercises
// a role. Idempotent (skips a role already held by the target).
//
//   DEPLOY_PRIVATE_KEY=0x<hot owner>  LEDGER_ADDRESS=0x<cold ledger> \
//   ORACLE_FACTORY=0x... [ROMESWAP_FACTORY=0x...] \
//   ROME_RPC_URL=... ROME_CHAIN_ID=... npx tsx scripts/transfer-admin-to-ledger.ts

import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { romeChain } from "./lib/ledger.js";

const OWNABLE_ABI = [
    { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ type: "address", name: "newOwner" }], outputs: [] },
] as const;

const FEESETTER_ABI = [
    { type: "function", name: "feeToSetter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "setFeeToSetter", stateMutability: "nonpayable", inputs: [{ type: "address", name: "_feeToSetter" }], outputs: [] },
] as const;

/** Transfer an Ownable-style `owner` (OracleAdapterFactory) to `target`, signed by the current owner. */
export async function handOverOwner(wallet: WalletClient, pub: PublicClient, contract: Address, target: Address): Promise<void> {
    const current = getAddress((await pub.readContract({ address: contract, abi: OWNABLE_ABI, functionName: "owner" })) as Address);
    if (current === target) { console.log(`  owner already ${target} — skip`); return; }
    const hash = await wallet.writeContract({ address: contract, abi: OWNABLE_ABI, functionName: "transferOwnership", args: [target], account: wallet.account!, chain: wallet.chain });
    await pub.waitForTransactionReceipt({ hash });
    const after = getAddress((await pub.readContract({ address: contract, abi: OWNABLE_ABI, functionName: "owner" })) as Address);
    if (after !== target) throw new Error(`transferOwnership failed: owner=${after}, expected ${target}`);
    console.log(`  ✓ owner -> ${after}`);
}

/** Transfer a UniswapV2Factory `feeToSetter` (Romeswap) to `target`, signed by the current feeToSetter. */
export async function handOverFeeToSetter(wallet: WalletClient, pub: PublicClient, contract: Address, target: Address): Promise<void> {
    const current = getAddress((await pub.readContract({ address: contract, abi: FEESETTER_ABI, functionName: "feeToSetter" })) as Address);
    if (current === target) { console.log(`  feeToSetter already ${target} — skip`); return; }
    const hash = await wallet.writeContract({ address: contract, abi: FEESETTER_ABI, functionName: "setFeeToSetter", args: [target], account: wallet.account!, chain: wallet.chain });
    await pub.waitForTransactionReceipt({ hash });
    const after = getAddress((await pub.readContract({ address: contract, abi: FEESETTER_ABI, functionName: "feeToSetter" })) as Address);
    if (after !== target) throw new Error(`setFeeToSetter failed: feeToSetter=${after}, expected ${target}`);
    console.log(`  ✓ feeToSetter -> ${after}`);
}

async function main() {
    const RPC = process.env.ROME_RPC_URL ?? "https://trajan.devnet.romeprotocol.xyz/";
    const CHAIN_ID = Number(process.env.ROME_CHAIN_ID ?? "121302");
    const TARGET = getAddress(process.env.LEDGER_ADDRESS as string);
    const pk = process.env.DEPLOY_PRIVATE_KEY;
    if (!pk) throw new Error("DEPLOY_PRIVATE_KEY (the current owner) is required to sign the handover");

    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
    const chain = romeChain(CHAIN_ID, RPC);
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });
    const pub = createPublicClient({ chain, transport: http(RPC) });
    console.log(`Signer (current owner): ${account.address}\nTarget (cold Ledger):  ${TARGET}`);

    if (process.env.ORACLE_FACTORY) {
        console.log("OracleAdapterFactory:");
        await handOverOwner(wallet, pub, getAddress(process.env.ORACLE_FACTORY), TARGET);
    }
    if (process.env.ROMESWAP_FACTORY) {
        console.log("UniswapV2Factory (Romeswap):");
        await handOverFeeToSetter(wallet, pub, getAddress(process.env.ROMESWAP_FACTORY), TARGET);
    }
    console.log("Admin handover complete.");
}

if (process.argv[1]?.endsWith("transfer-admin-to-ledger.ts")) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
