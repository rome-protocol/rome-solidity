// Cold-Ledger signer for Rome mainnet deploys (Hardhat 3 + viem).
//
// Builds a viem LocalAccount backed by a hardware Ledger (Ethereum app),
// so the existing viem deploy scripts can sign with the device instead of a
// hot configVariable key. The deployer is the contract admin on mainnet, so
// it must be hardware-secured.
//
// Pre-flight: the Ledger Ethereum app MUST have Blind signing ENABLED — an
// unknown chain id otherwise returns APDU 6a80 INVALID_DATA on every deploy.
//
// Verified mechanism: `cast send --ledger` deployed a contract on trajan
// (chain 121302) end-to-end (2026-06-16); this is the programmatic equivalent.

import { toAccount } from "viem/accounts";
import {
    createWalletClient,
    createPublicClient,
    http,
    serializeTransaction,
    type Address,
    type Chain,
    type Hex,
    type LocalAccount,
} from "viem";

// @ledgerhq packages are ESM-only and trip a require-cycle under Hardhat's CJS
// script runner if imported statically — load them lazily at call time, and
// unwrap the CJS/ESM `.default` interop shim.
async function loadLedger() {
    const EthMod = await import("@ledgerhq/hw-app-eth");
    const TransportMod = await import("@ledgerhq/hw-transport-node-hid");
    const Eth = ((EthMod as { default?: unknown }).default ?? EthMod) as typeof import("@ledgerhq/hw-app-eth").default;
    const Transport = ((TransportMod as { default?: unknown }).default ?? TransportMod) as { create: () => Promise<unknown> };
    return { Eth, Transport };
}

export const DEFAULT_LEDGER_PATH = "44'/60'/0'/0/0";

/** Build a viem LocalAccount that signs via a connected Ledger (Ethereum app). */
export async function makeLedgerAccount(path: string = DEFAULT_LEDGER_PATH): Promise<LocalAccount> {
    const { Eth, Transport } = await loadLedger();
    const transport = await Transport.create();
    const eth = new Eth(transport as never);
    const { address } = await eth.getAddress(path);

    return toAccount({
        address: address as Address,
        async signTransaction(transaction, options) {
            const serializer = options?.serializer ?? serializeTransaction;
            const unsigned = await serializer(transaction as never);
            // hw-app-eth wants the serialized tx hex WITHOUT the 0x prefix.
            const { r, s, v } = await eth.signTransaction(path, unsigned.slice(2), null);
            // EIP-1559 (type-2): v is the y-parity (0/1).
            return await serializer(transaction as never, {
                r: `0x${r}` as Hex,
                s: `0x${s}` as Hex,
                yParity: parseInt(v, 16) & 1,
            });
        },
        async signMessage() {
            throw new Error("Ledger signMessage not implemented — deploy flow does not need it");
        },
        async signTypedData() {
            throw new Error("Ledger signTypedData not implemented — deploy flow does not need it");
        },
    });
}

/** Minimal viem Chain for a Rome chain (id + RPC URL is all viem needs to send). */
export function romeChain(id: number, rpcUrl: string): Chain {
    return {
        id,
        name: `rome-${id}`,
        nativeCurrency: { name: "Rome Gas", symbol: "GAS", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    };
}

export interface LedgerDeployer {
    address: Address;
    getBalance: () => Promise<bigint>;
    deploy: (abi: readonly unknown[], bytecode: Hex, args?: readonly unknown[]) => Promise<{ address: Address }>;
}

/** A Ledger-backed deployer bound to one Rome chain (id + RPC URL). */
export async function makeLedgerDeployer(
    chainId: number,
    rpcUrl: string,
    path: string = DEFAULT_LEDGER_PATH,
): Promise<LedgerDeployer> {
    const account = await makeLedgerAccount(path);
    const chain = romeChain(chainId, rpcUrl);
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    return {
        address: account.address,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        async deploy(abi, bytecode, args = []) {
            const hash = await wallet.deployContract({ abi, bytecode, args } as never);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success" || !receipt.contractAddress) {
                throw new Error(`Deploy failed (status=${receipt.status}, tx=${hash})`);
            }
            return { address: receipt.contractAddress as Address };
        },
    };
}
