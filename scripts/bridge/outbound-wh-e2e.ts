import hardhat from "hardhat";
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes, Contract, getBytes } from "ethers";
import { PublicKey, Connection } from "@solana/web3.js";
import fs from "node:fs";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const { networkConfig } = await hardhat.network.connect();
  const romePk = await (networkConfig as any).accounts[0].get();
  const sepKey = fs.readFileSync(".secrets/sepolia-key.txt", "utf8").trim();
  const dep = JSON.parse(fs.readFileSync("deployments/marcus.json", "utf8"));
  const WITHDRAW = dep.RomeBridgeWithdraw.address as `0x${string}`;

  const romeProv = new JsonRpcProvider("https://marcus.devnet.romeprotocol.xyz/");
  const sepProv = new JsonRpcProvider("https://sepolia.drpc.org");
  const romeWallet = new Wallet(romePk, romeProv);
  const sepWallet = new Wallet(sepKey, sepProv);
  const solConn = new Connection("https://api.devnet.solana.com", "confirmed");

  const sel = (s: string) => "0x" + keccak256(toUtf8Bytes(s)).slice(2, 10);
  const amount = (10_000n).toString(16).padStart(64, "0");
  const recipient = sepWallet.address.slice(2).toLowerCase().padStart(64, "0");

  // Use a low gasPrice (2 gwei instead of the proxy's default ~10 gwei).
  // The native-balance preflight check on marcus rejects tx's whose
  // gasLimit * gasPrice exceeds the Meteora-derived balance, which is often
  // under 0.01 ETH-equivalent even with many tens of rUSDC. At 2 gwei a
  // 1.5M-gas burn costs 3e15 wei (well within normal deployer balances).
  const GAS_PRICE = 2_000_000_000n;

  console.log("Submitting approveBurnETH…");
  const app = await romeWallet.sendTransaction({ to: WITHDRAW, data: sel("approveBurnETH(uint256)") + amount, gasLimit: 400_000n, gasPrice: GAS_PRICE });
  await app.wait();
  console.log("  approve:", app.hash);

  console.log("Submitting burnETH…");
  const burn = await romeWallet.sendTransaction({ to: WITHDRAW, data: sel("burnETH(uint256,address)") + amount + recipient, gasLimit: 1_500_000n, gasPrice: GAS_PRICE });
  const rcpt = await burn.wait();
  if (!rcpt || rcpt.status !== 1) throw new Error("burnETH reverted");
  console.log("  burn:", burn.hash);

  // Get Solana sigs — may return multiple (TransmitTx + DoTx). Pick the one
  // with Wormhole logs.
  await sleep(5000);
  const sigsRes = await fetch("https://marcus.devnet.romeprotocol.xyz/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_solanaTxForEvmTx", params: [burn.hash] }),
  });
  const sigs = (await sigsRes.json() as { result: string[] }).result;
  console.log("  Solana sigs:", sigs);

  let sequence: bigint | null = null;
  let doTxSig = "";
  for (const sig of sigs.reverse()) {
    const solTx = await solConn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const logs = solTx?.meta?.logMessages ?? [];
    const seqLine = logs.find(l => /Sequence: \d+/.test(l));
    if (seqLine) {
      sequence = BigInt(seqLine.match(/Sequence: (\d+)/)![1]);
      doTxSig = sig;
      break;
    }
  }
  if (sequence === null) throw new Error("no Wormhole Sequence in any Solana sig");
  console.log("  sequence:", sequence.toString(), "DoTx:", doTxSig);

  const [emitter] = PublicKey.findProgramAddressSync(
    [Buffer.from("emitter")],
    new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe"),
  );
  const emitterHex = Buffer.from(emitter.toBytes()).toString("hex");

  console.log("Polling Wormholescan for Solana VAA…");
  let vaaBase64 = "";
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`https://api.testnet.wormholescan.io/v1/signed_vaa/1/${emitterHex}/${sequence}`);
    if (r.ok) {
      const j = await r.json() as { vaaBytes?: string };
      if (j.vaaBytes) { vaaBase64 = j.vaaBytes; break; }
    }
    if (i % 4 === 0) console.log(`  (${i * 15}s)`);
    await sleep(15000);
  }
  if (!vaaBase64) throw new Error("VAA timeout");
  console.log("  VAA ready");

  console.log("Submitting completeTransferAndUnwrapETH on Sepolia…");
  const tb = new Contract(
    "0xDB5492265f6038831E89f495670FF909aDe94bd9",
    ["function completeTransferAndUnwrapETH(bytes) external"],
    sepWallet,
  );
  const vaaBytes = getBytes("0x" + Buffer.from(vaaBase64, "base64").toString("hex"));
  const tx = await tb.completeTransferAndUnwrapETH(vaaBytes);
  const r = await tx.wait();
  console.log("  Sepolia tx:", tx.hash, "status:", r?.status);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
