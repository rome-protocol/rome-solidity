// scripts/bridge/derive/wormhole-accounts.ts
//
// Derives the 8 Wormhole PDAs required for WormholeParams in RomeBridgeWithdraw.
//
// Seeds are per Wormhole Token Bridge IDL:
// https://github.com/wormhole-foundation/wormhole/blob/main/solana/modules/token_bridge/program/src/api/mod.rs
//
// All 8 PDAs are deterministic given the canonical program IDs in constants.ts.
// No network access is required — pure @solana/web3.js PDA derivation.

import { PublicKey } from "@solana/web3.js";
import { base58ToBytes32 } from "../../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS } from "../constants.js";

const WORMHOLE_TOKEN_BRIDGE_ID = new PublicKey(SOLANA_PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE);
const WORMHOLE_CORE_ID = new PublicKey(SOLANA_PROGRAM_IDS.WORMHOLE_CORE);

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export interface WormholePdas {
  wormholeConfig: `0x${string}`;
  wormholeCustody: `0x${string}`;
  wormholeAuthoritySigner: `0x${string}`;
  wormholeCustodySigner: `0x${string}`;
  wormholeBridgeConfig: `0x${string}`;
  wormholeFeeCollector: `0x${string}`;
  wormholeEmitter: `0x${string}`;
  wormholeSequence: `0x${string}`;
}

export function deriveWormholeAccounts(wethMint: PublicKey): WormholePdas {
  const config = pda([Buffer.from("config")], WORMHOLE_TOKEN_BRIDGE_ID);
  // custody PDA is per-mint (the wETH mint on Solana)
  const custody = pda([wethMint.toBuffer()], WORMHOLE_TOKEN_BRIDGE_ID);
  const authoritySigner = pda([Buffer.from("authority_signer")], WORMHOLE_TOKEN_BRIDGE_ID);
  const custodySigner = pda([Buffer.from("custody_signer")], WORMHOLE_TOKEN_BRIDGE_ID);
  // bridgeConfig and feeCollector are under the Core bridge program
  const bridgeConfig = pda([Buffer.from("Bridge")], WORMHOLE_CORE_ID);
  const feeCollector = pda([Buffer.from("fee_collector")], WORMHOLE_CORE_ID);
  // emitter is under the Token Bridge; sequence is under Core indexed by emitter
  const emitter = pda([Buffer.from("emitter")], WORMHOLE_TOKEN_BRIDGE_ID);
  const sequence = pda([Buffer.from("Sequence"), emitter.toBuffer()], WORMHOLE_CORE_ID);

  return {
    wormholeConfig: base58ToBytes32(config.toBase58()),
    wormholeCustody: base58ToBytes32(custody.toBase58()),
    wormholeAuthoritySigner: base58ToBytes32(authoritySigner.toBase58()),
    wormholeCustodySigner: base58ToBytes32(custodySigner.toBase58()),
    wormholeBridgeConfig: base58ToBytes32(bridgeConfig.toBase58()),
    wormholeFeeCollector: base58ToBytes32(feeCollector.toBase58()),
    wormholeEmitter: base58ToBytes32(emitter.toBase58()),
    wormholeSequence: base58ToBytes32(sequence.toBase58()),
  };
}
