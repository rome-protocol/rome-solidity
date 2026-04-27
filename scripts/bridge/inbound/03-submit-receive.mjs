// Step 3 of CCTP inbound demo: submit receive_message to Solana devnet CCTP
// Message Transmitter, which CPIs into TokenMessenger.handle_receive_message
// and mints USDC to the Rome user's PDA USDC ATA.
//
// Pays gas with ~/.config/solana/devnet-registration-authority.json (or whatever
// solana CLI keypair path the user configured via SOLANA_KEYPAIR env).
//
// Reads .secrets/last-attestation.json, prints tx signature on success.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";

// Program IDs — Circle CCTP v1 on Solana (same pubkeys mainnet + devnet)
const MESSAGE_TRANSMITTER_PID      = new PublicKey("CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd");
const TOKEN_MESSENGER_MINTER_PID   = new PublicKey("CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3");
const SPL_TOKEN_PROGRAM_ID         = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const USDC_MINT_DEVNET             = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const SOL_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";
const MAX_NONCES_PER_PDA = 6400n;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

// Instruction discriminator = sha256("global:<name>")[0..8]
const anchorDiscriminator = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

// Borsh-encode Vec<u8>: [u32 LE length][bytes]
const encodeVecU8 = (buf) => {
  const len = Buffer.alloc(4); len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
};

// CCTP message layout (big-endian):
//   0..4   version (u32)
//   4..8   source_domain (u32)
//   8..12  dest_domain (u32)
//   12..20 nonce (u64)
//   20..52 sender (32)
//   52..84 recipient (32)  ← destination caller
//   84..116 dest_caller (32)
//   116..  body (BurnMessage, 132 bytes for v1)
//
// BurnMessage body:
//   0..4   version (u32)
//   4..36  burn_token (32)       ← Ethereum USDC padded to bytes32
//   36..68 mint_recipient (32)   ← our Rome PDA USDC ATA
//   68..100 amount (32)
//   100..132 message_sender (32)
const parseMessage = (msgHex) => {
  const m = Buffer.from(msgHex.replace(/^0x/, ""), "hex");
  const sourceDomain = m.readUInt32BE(4);
  const nonce = m.readBigUInt64BE(12);
  const body = m.subarray(116);
  const burnTokenBytes = body.subarray(4, 36);
  const mintRecipientBytes = body.subarray(36, 68);
  const amount = BigInt("0x" + body.subarray(68, 100).toString("hex"));
  return {
    sourceDomain,
    nonce,
    burnTokenBytes,
    mintRecipientBytes,
    amount,
  };
};

// Derive used_nonces PDA (matches Circle's UsedNonces::first_nonce + seeds)
const deriveUsedNonces = (sourceDomain, nonce) => {
  const firstNonce = ((nonce - 1n) / MAX_NONCES_PER_PDA) * MAX_NONCES_PER_PDA + 1n;
  const delimiter = sourceDomain < 11 ? Buffer.alloc(0) : Buffer.from("-");
  return pda(
    [
      Buffer.from("used_nonces"),
      Buffer.from(String(sourceDomain)),
      delimiter,
      Buffer.from(firstNonce.toString()),
    ],
    MESSAGE_TRANSMITTER_PID,
  );
};

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

const main = async () => {
  const att = JSON.parse(fs.readFileSync(".secrets/last-attestation.json", "utf8"));

  // Load Solana payer — reuse the devnet registration authority (same key that
  // minted the test rETH).
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? path.join(os.homedir(), ".config/solana/devnet-registration-authority.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Buffer.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  const conn = new Connection(SOL_RPC, "confirmed");

  const parsed = parseMessage(att.message);
  console.log("Parsed message:");
  console.log("  source_domain:", parsed.sourceDomain);
  console.log("  nonce:        ", parsed.nonce.toString());
  console.log("  burn_token:   ", "0x" + parsed.burnTokenBytes.toString("hex"));
  console.log("  mint_recipient:", "0x" + parsed.mintRecipientBytes.toString("hex"));
  console.log("  amount:       ", parsed.amount.toString());

  // Derive all PDAs
  const messageTransmitter = pda([Buffer.from("message_transmitter")], MESSAGE_TRANSMITTER_PID);
  const authorityPda       = pda([Buffer.from("message_transmitter_authority"), TOKEN_MESSENGER_MINTER_PID.toBuffer()], MESSAGE_TRANSMITTER_PID);
  const mtEventAuthority   = pda([Buffer.from("__event_authority")], MESSAGE_TRANSMITTER_PID);
  const usedNonces         = deriveUsedNonces(parsed.sourceDomain, parsed.nonce);

  const tokenMessenger     = pda([Buffer.from("token_messenger")], TOKEN_MESSENGER_MINTER_PID);
  const remoteTokenMsgr    = pda([Buffer.from("remote_token_messenger"), Buffer.from(String(parsed.sourceDomain))], TOKEN_MESSENGER_MINTER_PID);
  const tokenMinter        = pda([Buffer.from("token_minter")], TOKEN_MESSENGER_MINTER_PID);
  const localToken         = pda([Buffer.from("local_token"), USDC_MINT_DEVNET.toBuffer()], TOKEN_MESSENGER_MINTER_PID);
  const tokenPair          = pda(
    [Buffer.from("token_pair"), Buffer.from(String(parsed.sourceDomain)), parsed.burnTokenBytes],
    TOKEN_MESSENGER_MINTER_PID,
  );
  const custodyTokenAccount = pda([Buffer.from("custody"), USDC_MINT_DEVNET.toBuffer()], TOKEN_MESSENGER_MINTER_PID);
  const tmEventAuthority   = pda([Buffer.from("__event_authority")], TOKEN_MESSENGER_MINTER_PID);

  const recipientTokenAccount = new PublicKey(parsed.mintRecipientBytes);

  console.log("\nPDAs:");
  console.log("  messageTransmitter:   ", messageTransmitter.toBase58());
  console.log("  authorityPda:         ", authorityPda.toBase58());
  console.log("  usedNonces:           ", usedNonces.toBase58());
  console.log("  tokenMessenger:       ", tokenMessenger.toBase58());
  console.log("  remoteTokenMessenger: ", remoteTokenMsgr.toBase58());
  console.log("  tokenMinter:          ", tokenMinter.toBase58());
  console.log("  localToken:           ", localToken.toBase58());
  console.log("  tokenPair:            ", tokenPair.toBase58());
  console.log("  custodyTokenAccount:  ", custodyTokenAccount.toBase58());
  console.log("  recipientTokenAccount:", recipientTokenAccount.toBase58());

  // Instruction data
  const msgBytes   = Buffer.from(att.message.replace(/^0x/, ""), "hex");
  const attBytes   = Buffer.from(att.attestation.replace(/^0x/, ""), "hex");
  const disc       = anchorDiscriminator("receive_message");
  const ixData = Buffer.concat([disc, encodeVecU8(msgBytes), encodeVecU8(attBytes)]);
  console.log(`\nInstruction data: ${ixData.length} bytes (disc + message(${msgBytes.length}) + attestation(${attBytes.length}))`);

  // Accounts — fixed (receive_message in MessageTransmitter) + event_cpi + remaining (handle_receive_message in TokenMessengerMinter)
  const keys = [
    // Fixed accounts for receive_message
    { pubkey: payer.publicKey,         isSigner: true,  isWritable: true  },  // payer
    { pubkey: payer.publicKey,         isSigner: true,  isWritable: false },  // caller (same keypair; anyone can be caller)
    { pubkey: authorityPda,            isSigner: false, isWritable: false },  // authority_pda
    { pubkey: messageTransmitter,      isSigner: false, isWritable: false },  // message_transmitter
    { pubkey: usedNonces,              isSigner: false, isWritable: true  },  // used_nonces
    { pubkey: TOKEN_MESSENGER_MINTER_PID, isSigner: false, isWritable: false }, // receiver
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // system_program
    // event_cpi macro-added accounts for MessageTransmitter
    { pubkey: mtEventAuthority,        isSigner: false, isWritable: false },  // event_authority
    { pubkey: MESSAGE_TRANSMITTER_PID, isSigner: false, isWritable: false },  // program
    // Remaining accounts forwarded to handle_receive_message in TokenMessengerMinter
    { pubkey: tokenMessenger,          isSigner: false, isWritable: false },
    { pubkey: remoteTokenMsgr,         isSigner: false, isWritable: false },
    { pubkey: tokenMinter,             isSigner: false, isWritable: true  },
    { pubkey: localToken,              isSigner: false, isWritable: true  },
    { pubkey: tokenPair,               isSigner: false, isWritable: false },
    { pubkey: recipientTokenAccount,   isSigner: false, isWritable: true  },
    { pubkey: custodyTokenAccount,     isSigner: false, isWritable: true  },
    { pubkey: SPL_TOKEN_PROGRAM_ID,    isSigner: false, isWritable: false },
    { pubkey: tmEventAuthority,        isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER_PID, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: MESSAGE_TRANSMITTER_PID, keys, data: ixData });

  // Bump CU limit — receive_message with CPI into token minter + SPL mint uses ~300k CUs
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const tx = new Transaction().add(cuIx).add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const raw = tx.serialize();
  console.log("\nSubmitting receive_message tx (HTTP only — no WS subscription)...");
  const sig = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", skipPreflight: false });
  console.log("  tx:", sig);

  // HTTP-only confirmation loop (our Rome RPC doesn't support WS)
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const st = value[0];
    if (st?.err) {
      console.error("  tx failed on-chain:", JSON.stringify(st.err));
      process.exit(1);
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      console.log(`  ✓ ${st.confirmationStatus} at slot ${st.slot}`);
      return;
    }
    process.stdout.write(`\r  waiting… status=${st?.confirmationStatus ?? "unsubmitted"}  `);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.error("\n  timed out waiting for confirmation (but tx may still land — check signature later)");
};
main().catch((e) => { console.error(e); process.exit(1); });
