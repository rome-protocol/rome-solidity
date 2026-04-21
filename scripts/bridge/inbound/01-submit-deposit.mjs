// Step 1 of CCTP inbound demo: burn USDC on Sepolia, targeting the Rome user's
// PDA USDC ATA on Solana devnet as the mintRecipient.
//
// Prereqs:
//   - .secrets/sepolia-key.txt exists with a funded Sepolia private key
//   - That address has Sepolia ETH (gas) + testnet USDC (to burn)
//
// Writes the message + messageHash to .secrets/last-deposit.json for step 2.

import { Wallet, JsonRpcProvider, Contract, getAddress, keccak256 } from "ethers";
import fs from "node:fs";

// Sepolia CCTP V1 (Circle)
const USDC_SEPOLIA           = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TOKEN_MESSENGER_SEPOLIA = "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5";
const MESSAGE_TRANSMITTER_SEPOLIA = "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD";

// Destination domain: Solana = 5
const DOMAIN_SOLANA = 5;

// mintRecipient — the Rome-user PDA USDC ATA on Solana (CkwEb4FHu…)
// Read from rUSDC.get_token_account(deployer) on marcus.
const MINT_RECIPIENT_BYTES32 =
  "0xaeb1da9640c012e56d973efd21a2bc76384d059250b2c1895ca926d27241f493";

const BURN_AMOUNT = 1_000_000n; // 1 USDC (6dp)

const RPC = "https://sepolia.drpc.org";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) external returns (uint64 nonce)",
  "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
];
const MESSAGE_TRANSMITTER_ABI = [
  "event MessageSent(bytes message)",
];

const main = async () => {
  const key = fs.readFileSync(".secrets/sepolia-key.txt", "utf8").trim();
  const prov = new JsonRpcProvider(RPC);
  const signer = new Wallet(key, prov);
  console.log("Signer:", signer.address);

  const ethBal = await prov.getBalance(signer.address);
  const usdc = new Contract(USDC_SEPOLIA, ERC20_ABI, signer);
  const usdcBal = await usdc.balanceOf(signer.address);
  console.log(`  Sepolia ETH:  ${Number(ethBal) / 1e18}`);
  console.log(`  Sepolia USDC: ${Number(usdcBal) / 1e6}`);
  if (ethBal === 0n || usdcBal < BURN_AMOUNT) {
    console.error("❌ Insufficient balance. Fund the signer address and retry.");
    process.exit(1);
  }

  const allow = await usdc.allowance(signer.address, TOKEN_MESSENGER_SEPOLIA);
  if (allow < BURN_AMOUNT) {
    console.log(`Approving ${BURN_AMOUNT} USDC to TokenMessenger...`);
    const tx = await usdc.approve(TOKEN_MESSENGER_SEPOLIA, BURN_AMOUNT);
    console.log("  approve tx:", tx.hash);
    await tx.wait();
  } else {
    console.log(`Allowance already ≥ ${BURN_AMOUNT}`);
  }

  const tm = new Contract(TOKEN_MESSENGER_SEPOLIA, TOKEN_MESSENGER_ABI, signer);
  console.log(`\nSubmitting depositForBurn(${BURN_AMOUNT}, domain=${DOMAIN_SOLANA}, recipient=${MINT_RECIPIENT_BYTES32.slice(0,10)}…, USDC)`);
  const tx = await tm.depositForBurn(BURN_AMOUNT, DOMAIN_SOLANA, MINT_RECIPIENT_BYTES32, USDC_SEPOLIA);
  console.log("  depositForBurn tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("  mined block:", rcpt.blockNumber, "status:", rcpt.status);

  // Extract MessageSent.message from the tx receipt logs (emitted by MessageTransmitter)
  const iface = new Contract(MESSAGE_TRANSMITTER_SEPOLIA, MESSAGE_TRANSMITTER_ABI).interface;
  let message;
  for (const log of rcpt.logs) {
    if (getAddress(log.address) !== getAddress(MESSAGE_TRANSMITTER_SEPOLIA)) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "MessageSent") {
        message = parsed.args.message;
        break;
      }
    } catch { /* not our event */ }
  }
  if (!message) {
    console.error("❌ Could not find MessageSent event — unexpected.");
    process.exit(1);
  }
  const messageHash = keccak256(message);
  console.log("\nMessage bytes: ", message.length / 2 - 1, "bytes");
  console.log("Message hash:  ", messageHash);

  const out = {
    txHash: tx.hash,
    block: rcpt.blockNumber,
    sender: signer.address,
    amount: BURN_AMOUNT.toString(),
    mintRecipient: MINT_RECIPIENT_BYTES32,
    message,
    messageHash,
  };
  fs.writeFileSync(".secrets/last-deposit.json", JSON.stringify(out, null, 2));
  console.log("\n✓ Saved to .secrets/last-deposit.json");
  console.log("Next: node scripts/bridge/inbound/02-poll-attestation.mjs");
};
main().catch((e) => { console.error(e); process.exit(1); });
