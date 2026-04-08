```
TypeScript SDK (wormhole-sdk-ts)
  │
  │  1. Resolves all Solana PDAs and accounts
  │  2. Builds AccountMeta[] arrays
  │  3. Calls RomeWormholeBridge.sendTransferNative(...)
  │
  ▼
RomeWormholeBridge (EVM contract)
  │
  │  1. Calls _encodeSplApprove() → 9-byte SPL approve payload
  │  2. Calls WormholeTokenBridgeEncoding.encodeTransferNative() → 55-byte payload
  │  3. Two sequential _invoke() calls → CpiProgram.invoke()
  │
  ▼
Rome-EVM CPI Precompile (0xff..08)
  │
  │  Translates EVM calls into real Solana CPI
  │
  ▼
Solana Runtime
  ├─ SPL Token Program: Approve(delegate=authority_signer, amount)
  └─ Wormhole Token Bridge: TransferNative(nonce, amount, fee, target, chain)

```
