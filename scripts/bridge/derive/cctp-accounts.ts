// scripts/bridge/derive/cctp-accounts.ts
//
// Derives the 6 CCTP PDAs required for CctpParams in RomeBridgeWithdraw.
//
// Seeds are per Circle's CCTP Solana program IDL:
// https://developers.circle.com/stablecoins/docs/cctp-on-solana
// https://github.com/circlefin/solana-cctp-contracts
//
// All 6 PDAs are deterministic given the canonical program IDs in constants.ts.
// No network access is required — pure @solana/web3.js PDA derivation.

import { PublicKey } from "@solana/web3.js";
import { base58ToBytes32 } from "../../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS } from "../constants.js";

const CCTP_TOKEN_MESSENGER_ID = new PublicKey(SOLANA_PROGRAM_IDS.CCTP_TOKEN_MESSENGER);
const CCTP_MESSAGE_TRANSMITTER_ID = new PublicKey(SOLANA_PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER);

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function u32Le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

export interface CctpPdas {
  cctpMessageTransmitterConfig: `0x${string}`;
  cctpTokenMessengerConfig: `0x${string}`;
  cctpRemoteTokenMessenger: `0x${string}`;
  cctpTokenMinter: `0x${string}`;
  cctpLocalTokenUsdc: `0x${string}`;
  cctpEventAuthority: `0x${string}`;
}

export function deriveCctpAccounts(usdcMint: PublicKey): CctpPdas {
  const messageTransmitterConfig = pda(
    [Buffer.from("message_transmitter")],
    CCTP_MESSAGE_TRANSMITTER_ID
  );
  const tokenMessengerConfig = pda(
    [Buffer.from("token_messenger")],
    CCTP_TOKEN_MESSENGER_ID
  );
  // domain 0 = Ethereum (little-endian u32)
  const remoteTokenMessenger = pda(
    [Buffer.from("remote_token_messenger"), u32Le(0)],
    CCTP_TOKEN_MESSENGER_ID
  );
  const tokenMinter = pda([Buffer.from("token_minter")], CCTP_TOKEN_MESSENGER_ID);
  const localTokenUsdc = pda(
    [Buffer.from("local_token"), usdcMint.toBuffer()],
    CCTP_TOKEN_MESSENGER_ID
  );
  const eventAuthority = pda(
    [Buffer.from("__event_authority")],
    CCTP_TOKEN_MESSENGER_ID
  );

  return {
    cctpMessageTransmitterConfig: base58ToBytes32(messageTransmitterConfig.toBase58()),
    cctpTokenMessengerConfig: base58ToBytes32(tokenMessengerConfig.toBase58()),
    cctpRemoteTokenMessenger: base58ToBytes32(remoteTokenMessenger.toBase58()),
    cctpTokenMinter: base58ToBytes32(tokenMinter.toBase58()),
    cctpLocalTokenUsdc: base58ToBytes32(localTokenUsdc.toBase58()),
    cctpEventAuthority: base58ToBytes32(eventAuthority.toBase58()),
  };
}
