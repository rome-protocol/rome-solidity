// Smoke test: rome_emulateTx each bridge entrypoint. Does not send real txs.
import hardhat from "hardhat";
import fs from "node:fs";
import { Wallet, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";

async function emulate(label: string, signed: string) {
  const res = await fetch("https://marcus.devnet.romeprotocol.xyz/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_emulateTx", params: [signed] }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  const ok = body.error === undefined;
  console.log(`  ${label.padEnd(22)} ${ok ? "OK" : "FAIL: " + body.error?.message}`);
  return ok;
}

async function main() {
  const { networkConfig } = await hardhat.network.connect();
  const pk = await (networkConfig as any).accounts[0].get();
  const dep = JSON.parse(fs.readFileSync("deployments/marcus.json", "utf8"));
  const WITHDRAW = dep.RomeBridgeWithdraw.address as `0x${string}`;

  const provider = new JsonRpcProvider("https://marcus.devnet.romeprotocol.xyz/");
  const wallet = new Wallet(pk, provider);
  const { chainId } = await provider.getNetwork();
  const gasPrice = await provider.getFeeData().then(f => f.gasPrice || 5000000000n);

  const sel = (sig: string) => "0x" + keccak256(toUtf8Bytes(sig)).slice(2, 10);
  const burnUsdcSel = sel("burnUSDC(uint256,address)");
  const approveSel  = sel("approveBurnETH(uint256)");
  const burnEthSel  = sel("burnETH(uint256,address)");

  const recipient = wallet.address.slice(2).toLowerCase().padStart(64, "0");
  const amountHex = (1000n).toString(16).padStart(64, "0");

  // Each emulate runs independently — use the on-chain nonce every time.
  const mk = async (data: string) => {
    const nonce = await provider.getTransactionCount(wallet.address);
    return wallet.signTransaction({
      chainId: Number(chainId), nonce, gasPrice,
      gasLimit: 3_000_000n, to: WITHDRAW, value: 0n, data, type: 0,
    });
  };

  console.log("Smoke-emulating bridge paths against", WITHDRAW);
  console.log("Signer:", wallet.address);
  await emulate("burnUSDC (CCTP out)",  await mk(burnUsdcSel + amountHex + recipient));
  await emulate("approveBurnETH (Wh)",  await mk(approveSel + amountHex));
  // burnETH cannot be emulated standalone: Wormhole transfer_wrapped requires
  // a prior on-chain approve delegating authority_signer as the ATA burn
  // delegate. Real E2E: scripts/bridge/submit-burnETH.ts (sends both txs).
  console.log(`  burnETH (Wh out)       SKIP — requires prior approve, see submit-burnETH.ts`);
}
main().catch(e => console.error(e.message || e));
