// Side-by-side CU bench: v1 SPL_ERC20 wUSDC wrapper vs freshly-deployed
// v2 (this PR). For each method, submit one real EVM tx against each
// wrapper and read Solana `computeUnitsConsumed` from the tx receipt.
//
// Spec: the Rome design specs
// Hadrian addresses from rome-solidity/deployments/hadrian.json.

import hardhat from "hardhat";

const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";
const SOLANA_RPC = "https://api.devnet.solana.com";

// v1 contracts already on Hadrian:
const V1_WUSDC = "0x94AC3E5e998d72088045853C1CfB910F6CE90E56" as const;
const ERC20_USERS = "0xad2518145a7a95f2ca8a468499e4c33e10fb5dcc" as const;
const WUSDC_MINT_B32 =
    "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7" as const;
const CPI_PROGRAM = "0xFF00000000000000000000000000000000000008" as const;

// Targets — any addresses; we don't need real on-chain accounts behind them.
// approve(spender, value): spender doesn't need to exist on Solana.
// transfer(to, value): "to" needs an EVM mapping but the recipient ATA gets
// auto-created (ensure_token_account fast-path). Use the deployer's own
// address as recipient for simplicity (self-transfer is a valid SPL op).
const SPENDER = "0x000000000000000000000000000000000000ddee" as const;

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const data = (await resp.json()) as RpcResponse<T>;
    if (data.error) throw new Error(`${method}: ${data.error.message}`);
    return data.result as T;
}

async function getSolanaCU(evmTxHash: `0x${string}`): Promise<number | null> {
    // rome_solanaTxForEvmTx returns the Solana signature(s) for an EVM tx.
    // Response shape: a single base58 sig string, OR an array, OR null if
    // the indexer hasn't seen it yet. Handle all three.
    const sig = await rpc<string | string[] | null>(
        HADRIAN_RPC,
        "rome_solanaTxForEvmTx",
        [evmTxHash],
    );
    if (!sig) return null;
    const solanaSig = Array.isArray(sig) ? sig[sig.length - 1] : sig;
    if (!solanaSig) return null;

    const tx = await rpc<{ meta?: { computeUnitsConsumed?: number } } | null>(
        SOLANA_RPC,
        "getTransaction",
        [solanaSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
    );
    return tx?.meta?.computeUnitsConsumed ?? null;
}

async function pollForCU(evmTxHash: `0x${string}`): Promise<number | null> {
    // Solana indexer + RPC may lag — poll up to 30s.
    for (let i = 0; i < 30; i++) {
        const cu = await getSolanaCU(evmTxHash);
        if (cu !== null) return cu;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
}

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    if (networkName !== "hadrian") {
        throw new Error(`Expected --network hadrian, got ${networkName}`);
    }

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) throw new Error("No deployer wallet — set HADRIAN_PRIVATE_KEY");
    const me = deployer.account.address;
    const publicClient = await viem.getPublicClient();

    console.log("Network:        ", networkName);
    console.log("Deployer:       ", me);
    console.log(
        "Gas balance:    ",
        (await publicClient.getBalance({ address: me })).toString(),
    );

    // Deploy a throwaway wrapper just to measure CU side-by-side against
    // the v1 wrapper at V1_WUSDC. NOT the canonical replacement — the
    // production cutover (post-#163 merge) deploys with plain
    // name="Rome USDC" / symbol="wUSDC", no version suffix.
    console.log("\n=== Deploying SPL_ERC20 (bench artifact) ===");
    const v2 = await viem.deployContract("SPL_ERC20", [
        WUSDC_MINT_B32,
        CPI_PROGRAM,
        "Rome USDC (rewrite bench)",
        "wUSDCbench",
        ERC20_USERS,
    ]);
    console.log("bench wrapper:  ", v2.address);

    const erc20Abi = [
        { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
        { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
        { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
        { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
    ] as const;

    type Run = { label: string; address: `0x${string}`; method: "approve" | "transfer"; args: readonly [string, bigint] };
    const runs: Run[] = [
        { label: "v1 approve  ", address: V1_WUSDC, method: "approve",  args: [SPENDER, 1000n] },
        { label: "v2 approve  ", address: v2.address, method: "approve",  args: [SPENDER, 1000n] },
        { label: "v1 transfer ", address: V1_WUSDC, method: "transfer", args: [me, 1n] },
        { label: "v2 transfer ", address: v2.address, method: "transfer", args: [me, 1n] },
    ];

    const results: Array<{ label: string; tx: `0x${string}`; cu: number | null }> = [];

    for (const run of runs) {
        console.log(`\n=== ${run.label} ===`);
        const hash = await deployer.writeContract({
            address: run.address,
            abi: erc20Abi,
            functionName: run.method,
            args: run.args as readonly [`0x${string}`, bigint],
        });
        console.log("  tx hash: ", hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("  status:  ", receipt.status);
        const cu = await pollForCU(hash);
        console.log("  Solana CU:", cu ?? "(not found within 30s)");
        results.push({ label: run.label, tx: hash, cu });
    }

    console.log("\n=== Summary ===");
    console.log("label         | tx hash                                                            | Solana CU");
    console.log("--------------+--------------------------------------------------------------------+----------");
    for (const r of results) {
        console.log(`${r.label} | ${r.tx} | ${r.cu ?? "?"}`);
    }

    const v1Approve = results[0]?.cu;
    const v2Approve = results[1]?.cu;
    const v1Transfer = results[2]?.cu;
    const v2Transfer = results[3]?.cu;

    console.log("\n=== Deltas ===");
    if (v1Approve && v2Approve) {
        const delta = v1Approve - v2Approve;
        const pct = ((delta / v1Approve) * 100).toFixed(1);
        console.log(`approve  : v1=${v1Approve}  v2=${v2Approve}  Δ=${delta > 0 ? "−" : "+"}${Math.abs(delta)} (${pct}%)`);
    }
    if (v1Transfer && v2Transfer) {
        const delta = v1Transfer - v2Transfer;
        const pct = ((delta / v1Transfer) * 100).toFixed(1);
        console.log(`transfer : v1=${v1Transfer}  v2=${v2Transfer}  Δ=${delta > 0 ? "−" : "+"}${Math.abs(delta)} (${pct}%)  [control — both paths same selector]`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
