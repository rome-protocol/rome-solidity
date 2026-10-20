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
  wormholeWrappedMeta: `0x${string}`;
}

export type WormholeGlobalPdas = Omit<WormholePdas, "wormholeCustody" | "wormholeWrappedMeta">;

type WormholeOpts = { tokenBridgeProgramId?: string; coreProgramId?: string };

/**
 * The Wormhole accounts that do not depend on any mint: exactly what
 * RomeBridgeWithdraw's constructor takes (v13). Per-mint accounts (custody,
 * wrapped_meta) are derived on chain at call time.
 */
export function deriveWormholeGlobalAccounts(opts: WormholeOpts = {}): WormholeGlobalPdas {
  const tokenBridgeId = new PublicKey(
    opts.tokenBridgeProgramId ?? SOLANA_PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE
  );
  const coreId = new PublicKey(
    opts.coreProgramId ?? SOLANA_PROGRAM_IDS.WORMHOLE_CORE
  );
  const config = pda([Buffer.from("config")], tokenBridgeId);
  const authoritySigner = pda([Buffer.from("authority_signer")], tokenBridgeId);
  const custodySigner = pda([Buffer.from("custody_signer")], tokenBridgeId);
  // bridgeConfig and feeCollector are under the Core bridge program
  const bridgeConfig = pda([Buffer.from("Bridge")], coreId);
  const feeCollector = pda([Buffer.from("fee_collector")], coreId);
  // emitter is under the Token Bridge; sequence is under Core indexed by emitter
  const emitter = pda([Buffer.from("emitter")], tokenBridgeId);
  const sequence = pda([Buffer.from("Sequence"), emitter.toBuffer()], coreId);
  return {
    wormholeConfig: base58ToBytes32(config.toBase58()),
    wormholeAuthoritySigner: base58ToBytes32(authoritySigner.toBase58()),
    wormholeCustodySigner: base58ToBytes32(custodySigner.toBase58()),
    wormholeBridgeConfig: base58ToBytes32(bridgeConfig.toBase58()),
    wormholeFeeCollector: base58ToBytes32(feeCollector.toBase58()),
    wormholeEmitter: base58ToBytes32(emitter.toBase58()),
    wormholeSequence: base58ToBytes32(sequence.toBase58()),
  };
}

/** Global accounts plus the two per-mint ones for `wethMint` (kept for tooling and tests). */
export function deriveWormholeAccounts(wethMint: PublicKey, opts: WormholeOpts = {}): WormholePdas {
  const tokenBridgeId = new PublicKey(
    opts.tokenBridgeProgramId ?? SOLANA_PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE
  );
  // custody PDA is per-mint; wrapped_meta PDA: seeds = [b"meta", mint], program = Token Bridge
  const custody = pda([wethMint.toBuffer()], tokenBridgeId);
  const wrappedMeta = pda([Buffer.from("meta"), wethMint.toBuffer()], tokenBridgeId);
  return {
    ...deriveWormholeGlobalAccounts(opts),
    wormholeCustody: base58ToBytes32(custody.toBase58()),
    wormholeWrappedMeta: base58ToBytes32(wrappedMeta.toBase58()),
  };
}
