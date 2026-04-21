// One-shot manual completion for inbound Wormhole — bypasses the relayer's
// completeTransfer.ts builder (which has a known to/to_owner bug) and submits
// the post_vaa + complete_transfer_wrapped instructions directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { keccak256 } from "ethers";

const VAA_BASE64 = "AQAAAAABAH//Dnc/Ckj3wotIPaeG74M2BOPZq1J4qEaYuviF5/fBZxsovZ865yhXYeprG91Abw66pfYgAjizO5cnk515ajMBaeb/cBmg6BAnEgAAAAAAAAAAAAAAANtUkiZfYDiDHon0lWcP+Qmt6UvZAAAAAAAFP2sBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYagAAAAAAAAAAAAAAAA7vEqg+5bcWHThzMXyODnt24LXZwnEreqqFggb5aY8MLMGgqBUIiEYIfztgBuIll6SzF4iGVPAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const USER_PDA = new PublicKey("DDheSm1Q2bJMFw5yDqEekmbzjLjLTRiE2dqsKU4Pep81");

function pda(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

// Parse VAA
function parseVaa(b64) {
  const buf = Buffer.from(b64, "base64");
  const sigCount = buf.readUInt8(5);
  const bodyOffset = 6 + sigCount * 66;
  const emitterChain = buf.readUInt16BE(bodyOffset + 8);
  const emitterAddressHex = buf.subarray(bodyOffset + 10, bodyOffset + 42).toString("hex");
  const sequence = buf.readBigUInt64BE(bodyOffset + 42);
  const bodyHex = buf.subarray(bodyOffset).toString("hex");
  const body = Buffer.from(bodyHex, "hex");
  return { emitterChain, emitterAddressHex, sequence, bodyHex, body, raw: buf };
}

async function main() {
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? path.join(os.homedir(), ".config/solana/devnet-registration-authority.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Buffer.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  // Use public Solana devnet for post_vaa (Rome RPC lacks WS); Rome RPC for complete_transfer
  const vaaConn = new Connection("https://api.devnet.solana.com", "confirmed");
  const solConn = new Connection("https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz", "confirmed");

  const parsed = parseVaa(VAA_BASE64);
  console.log("VAA parsed: chain=", parsed.emitterChain, "seq=", parsed.sequence.toString());

  const emitterAddr = Buffer.from(parsed.emitterAddressHex, "hex");

  // Token Bridge + Core PDAs
  const config = pda([Buffer.from("config")], TOKEN_BRIDGE);
  const chainBuf = Buffer.alloc(2);
  chainBuf.writeUInt16BE(parsed.emitterChain);
  const endpoint = pda([chainBuf, emitterAddr], TOKEN_BRIDGE);
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64BE(parsed.sequence);
  const claim = pda([emitterAddr, chainBuf, seqBuf], TOKEN_BRIDGE);

  // PostedVAA derivation — Wormhole double-keccak of body
  const hashOnce = Buffer.from(keccak256("0x" + parsed.bodyHex).slice(2), "hex");
  const hashTwice = Buffer.from(keccak256("0x" + hashOnce.toString("hex")).slice(2), "hex");
  const postedVaaSingle = pda([Buffer.from("PostedVAA"), hashOnce], WORMHOLE_CORE);
  const postedVaaDouble = pda([Buffer.from("PostedVAA"), hashTwice], WORMHOLE_CORE);
  console.log("PostedVAA (1x keccak):", postedVaaSingle.toBase58());
  console.log("PostedVAA (2x keccak):", postedVaaDouble.toBase58());
  // Check which actually exists on-chain
  const infoSingle = await vaaConn.getAccountInfo(postedVaaSingle);
  const infoDouble = await vaaConn.getAccountInfo(postedVaaDouble);
  console.log("  single exists on public devnet:", !!infoSingle);
  console.log("  double exists on public devnet:", !!infoDouble);
  const infoSingleRome = await solConn.getAccountInfo(postedVaaSingle);
  const infoDoubleRome = await solConn.getAccountInfo(postedVaaDouble);
  console.log("  single exists on rome rpc:", !!infoSingleRome);
  console.log("  double exists on rome rpc:", !!infoDoubleRome);

  // We'll use the existing one. Also need to check if the VAA was posted at all.
  let postedVaa = infoSingleRome ? postedVaaSingle : (infoDoubleRome ? postedVaaDouble : postedVaaSingle);

  if (!infoSingleRome && !infoDoubleRome && !infoSingle && !infoDouble) {
    console.log("⚠ PostedVAA not found anywhere — need to post it first");
    // For now, exit. Posting VAA needs the wormhole SDK helpers.
    console.log("Sorry, VAA needs to be posted first via a tool that speaks the Core Bridge signature-verification protocol.");
    process.exit(1);
  }

  // Parse transfer payload
  const payload = parsed.body.subarray(51);
  const payloadType = payload.readUInt8(0);
  console.log("payload type:", payloadType);
  const amount = BigInt("0x" + payload.subarray(1, 33).toString("hex"));
  const tokenAddress = payload.subarray(33, 65);
  const tokenChainFromPayload = payload.readUInt16BE(65);
  const recipientBytes = payload.subarray(67, 99);
  const recipientPk = new PublicKey(recipientBytes);
  console.log("transfer:", { amount: amount.toString(), tokenChainFromPayload, recipient: recipientPk.toBase58() });

  // The recipient in the VAA IS the ATA (because the sender put an ATA there).
  // So:
  //   to        = recipientPk (the ATA)
  //   to_owner  = USER_PDA (the wallet that owns the ATA)
  const tokenAccount = recipientPk;
  const tokenAccountOwner = USER_PDA;

  // Derive wrapped mint + meta + mint_signer
  const wrappedMint = pda(
    [Buffer.from("wrapped"), chainBuf, tokenAddress],
    TOKEN_BRIDGE,
  );
  const wrappedMeta = pda([Buffer.from("meta"), wrappedMint.toBuffer()], TOKEN_BRIDGE);
  const mintAuthority = pda([Buffer.from("mint_signer")], TOKEN_BRIDGE);

  console.log("wrappedMint:", wrappedMint.toBase58());
  console.log("token account (VAA to):", tokenAccount.toBase58());
  console.log("token account owner:   ", tokenAccountOwner.toBase58());

  // Check if the ATA exists
  const ataInfo = await solConn.getAccountInfo(tokenAccount);
  console.log("ATA exists on Rome RPC:", !!ataInfo);
  if (!ataInfo) {
    console.log("⚠ ATA doesn't exist — must be created first. Skipping.");
    process.exit(1);
  }

  // Build complete_transfer_wrapped instruction
  // Tag byte = 0x03
  const data = Buffer.from([0x03]);
  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: postedVaa, isSigner: false, isWritable: false },
    { pubkey: claim, isSigner: false, isWritable: true },
    { pubkey: endpoint, isSigner: false, isWritable: false },
    { pubkey: tokenAccount, isSigner: false, isWritable: true },
    { pubkey: tokenAccountOwner, isSigner: false, isWritable: true },
    { pubkey: tokenAccount, isSigner: false, isWritable: true }, // to_fees = same
    { pubkey: wrappedMint, isSigner: false, isWritable: true },
    { pubkey: wrappedMeta, isSigner: false, isWritable: false },
    { pubkey: mintAuthority, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN, isSigner: false, isWritable: false },
    { pubkey: WORMHOLE_CORE, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: TOKEN_BRIDGE, keys, data });
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const tx = new Transaction().add(cuIx).add(ix);
  const { blockhash } = await solConn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  console.log("\nSubmitting complete_transfer_wrapped...");
  try {
    const sig = await solConn.sendRawTransaction(tx.serialize(), {
      preflightCommitment: "confirmed",
      skipPreflight: false,
    });
    console.log("tx:", sig);
    // HTTP-only confirm
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const { value } = await solConn.getSignatureStatuses([sig], { searchTransactionHistory: false });
      const st = value[0];
      if (st?.err) {
        console.error("tx errored:", JSON.stringify(st.err));
        break;
      }
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
        console.log("✓ confirmed at slot", st.slot);
        return;
      }
      await new Promise(r => setTimeout(r, 3_000));
    }
  } catch (e) {
    console.error("submit failed:", e.message);
    if (e.logs) for (const l of e.logs) console.error(" ", l);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
