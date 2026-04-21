# Oracle Gateway V2

Chainlink-compatible adapters for **Pyth Pull** and **Switchboard V2** price feeds on **Rome EVM**, readable from Solidity contracts via a single atomic CPI call.

## What this solves

EVM lending / DeFi protocols expect Chainlink's `AggregatorV3Interface`. Solana has Pyth and Switchboard, which are first-party oracles (publishers push directly, no relay). Running EVM contracts on Rome means you can consume Solana's oracles **natively** — no bridge, no off-chain relay, no price push, no stale VAA. One `latestRoundData()` call reads the live Solana account state in the same transaction.

## Contracts

| Contract | Purpose |
|----------|---------|
| `OracleAdapterFactory.sol` | Deploys per-pubkey EIP-1167 minimal-proxy clones of the adapters. Enforces one adapter per Solana account. Owner-controlled pause/unpause. |
| `PythPullAdapter.sol` | Clone target. Reads a Pyth Pull `PriceUpdateV2` account via the CPI precompile, parses it, normalizes to 8-decimal Chainlink format, checks staleness and confidence. |
| `SwitchboardV3Adapter.sol` | Clone target. Reads a Switchboard V2 `AggregatorAccountData` account. (Name retained for back-compat; the program ID and layout target V2.) |
| `PythPullParser.sol` | Borsh-offset decoder for Pyth `PriceUpdateV2` accounts. |
| `SwitchboardParser.sol` | Borsh-offset decoder for Switchboard V2 `AggregatorAccountData`. |
| `BatchReader.sol` | Read N feeds in one call. `getLatestPrices(address[])` + `getFeedHealth(address[])` with per-feed try/catch isolation. |
| `IAggregatorV3Interface.sol` | Standard Chainlink aggregator interface. |
| `IExtendedOracleAdapter.sol` | Extension: raw price data, confidence, EMA, status. |
| `IAdapterMetadata.sol` | `OracleSource` enum (Pyth=0, Switchboard=1) + `AdapterMetadata` struct. |
| `IAdapterFactory.sol` | Minimal interface the adapter calls on its factory (for pause state). |

### Test-only helpers (`contracts/oracle/test/`)

| Contract | Purpose |
|----------|---------|
| `AdapterCloneFactory.sol` | Exposes `Clones.clone(impl)` so tests can instantiate clones without going through the CPI-dependent factory path. |
| `StalenessHarness.sol` | Exposes internal `_checkStaleness` / `_checkConfidence` helpers for unit tests. |
| `AccountOwnerHarness.sol` | Overrides `_fetchAccount()` to mock CPI responses in the simulated network. |
| `PythPullParserHarness.sol`, `SwitchboardParserHarness.sol` | Expose internal parser functions. |
| `examples/SampleLendingOracle.sol` | Example consumer — **not** production code. |

## Consumer usage

```solidity
// Same shape as Chainlink on Ethereum — drop-in.
IAggregatorV3Interface priceFeed = IAggregatorV3Interface(ROME_SOL_USD_ADAPTER);
(, int256 price, , uint256 updatedAt, ) = priceFeed.latestRoundData();

require(block.timestamp - updatedAt < 60, "stale");
// price is normalized to 8 decimals (Chainlink convention).
```

Available live on `marcus` devnet — see [Deployments](#deployments-marcus-devnet).

## Architecture

```
Consumer Solidity ──(EVM call)──► PythPullAdapter / SwitchboardV3Adapter
                                        │
                                        ├─ checks adapter pause (via factory)
                                        ├─ checks stored account owner matches expected program
                                        │
                                        └─(CPI precompile 0xFF…08)──► Solana
                                                                        │
                                                                        └─ Pyth / Switchboard price account
```

- Pyth Pull program on Solana devnet: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`.
- Switchboard V2 program on Solana devnet: `SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f`.
- Rome EVM CPI precompile: `0xFF…08` — exposes `account_info(bytes32 pubkey) returns (owner, data, lamports, …)`. Returns live Solana account state inside a single EVM transaction.

## Security model

- **Adapter** validates: account exists, account owner matches stored `expectedProgramId`, parser discriminator + verification variant match, price > 0, confidence / price ≤ 2% (Pyth), publishTime within `maxStaleness` window.
- **Factory** validates: account owner at `createFeed` time; caller-passed staleness in `[1 s, 24 h]`; unique pubkey per adapter; EOA or contract at any arbitrary address is **not** pausable — only registered adapters.
- **Clone** implementation contracts are locked via constructor (`initialized = true`) so they cannot be directly initialized. Clones can only be initialized once.
- **Factory owner** (single EOA today) can pause any registered adapter and update default staleness. Cannot transfer ownership to `address(0)`.

See [`SECURITY.md`](../../../rome-oracle-portal/SECURITY.md) in the portal repo for the full posture, open items, and mainnet blockers.

## Build & test

```bash
npm install
npx hardhat compile

# Run the full oracle unit-test suite (70 tests currently):
npx hardhat test nodejs tests/oracle/*.test.ts

# Live offset validation against devnet Pyth / Switchboard accounts:
npx hardhat run scripts/oracle/validate-pyth-pull-offsets.ts --network marcus
npx hardhat run scripts/oracle/validate-switchboard-offsets.ts --network marcus
```

> **CI note.** `.github/workflows/ci.yml` currently invokes bare `npx hardhat test` which runs only the Solidity test runner — i.e., **zero** oracle tests run in CI today. Fix tracked in [portal TODO.md](../../../rome-oracle-portal/TODO.md#ci-restore).

## Deploy

```bash
# One-time: deploy implementations, factory, BatchReader.
DEFAULT_MAX_STALENESS=86400 \
  npx hardhat run scripts/oracle/deploy-v2-polish.ts --network marcus

# Deploy per-pubkey adapter clones from the seed list.
npx hardhat run scripts/oracle/deploy-seed-feeds.ts --network marcus
```

Both scripts write addresses to `deployments/<network>.json` under the `OracleGatewayV2Polished` key. Idempotent — existing adapters are skipped.

## Deployments (marcus devnet)

Chain ID `121226`. RPC `https://marcus.devnet.romeprotocol.xyz`. Default staleness: `86400 s` (24 h).

| Contract | Address |
|----------|---------|
| `OracleAdapterFactory` | `0x454f0cde265ecf530a01c5c1bfd1f40d9e0672af` |
| `PythPullAdapter` impl | `0x23f27d84c5fd53a32baaa52270a22f7b13f241da` |
| `SwitchboardV3Adapter` impl | `0x827a045a8fd1973859ac57df8e801e658e9ed78b` |
| `BatchReader` | `0x0796e4cfdba2acb9aab32abd1722e7845c87acf1` |

### Active feeds

| Pair | Source | Adapter |
|------|--------|---------|
| SOL/USD | Pyth | `0xa9158A5B3964910656416a16C0De161143a89592` |
| BTC/USD | Pyth | `0x3dB406f5e7e55a6d875452BbeA0C35F96e172C49` |
| ETH/USD | Pyth | `0xd61796eFF9e6D044C182aDa82049DC2930B58962` |
| USDC/USD | Pyth | `0xEFc29b15069835b844d35505832636890FBEF6b3` |
| USDT/USD | Pyth | `0xd66f47f8E4CE5DEB509e1a665dD30AA0CD117e0E` |
| SOL/USD | Switchboard | `0xa79fd13A0fBB3D395Bf84a02ba30227dB7311000` |

## Related

- Portal: [rome-oracle-portal](https://github.com/rome-protocol/rome-oracle-portal) — Next.js developer portal for browsing and deploying feeds.
- Security: [`rome-oracle-portal/SECURITY.md`](https://github.com/rome-protocol/rome-oracle-portal/blob/main/SECURITY.md) — audit status, known issues, mainnet blockers.
- Product: [`rome-product/catalog/PRODUCT_CATALOG.md`](../../../rome-product/catalog/PRODUCT_CATALOG.md) — Tower 6.
