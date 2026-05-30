# Cached Oracle Feeds (OG-V2)

EVM-side price cache for Oracle Gateway V2. A keeper parses the source once and
SSTOREs the price; consumers read a cheap SLOAD. Lets multi-collateral Compound
borrows (which read every in-collateral feed atomically) fit Solana's 1.4M
per-tx CU cap.

## Why

The Pyth-Pull Borsh parse costs **~509K Solana CU per feed read**. A Compound
borrow's collateralization check reads every in-collateral feed in one atomic tx,
so ~3 distinct feeds ≈ 1.5M CU — over the 1.4M cap. Caching drops each read to a
**~134K SLOAD** and moves the parse onto the keeper's own `refresh()` tx, off the
borrow path.

Measured on Hadrian (EVM lane): a 2-distinct-feed borrow with raw Pyth hit
**1,399,494 CU (capped/failed)**; the same borrow on cached feeds = **1,067,667**,
and an 8-collateral / 9-distinct-feed borrow = **1,025,390** (fits, ~375K spare).
Marginal per added cached feed ≈ **15K CU** — so feeds stop being the constraint.

## Two adapters — choose per consumer

| | `CachedPythAdapter` | `CachedFeedAdapter` |
|---|---|---|
| Kind | Pyth-specific | Generic |
| Reads | re-parses the Pyth account directly (reuses `PythPullParser`) | wraps **any** `AggregatorV3` feed (a `PythPullAdapter`, `SwitchboardV3Adapter`, Chainlink, …) |
| Use when | you want to read Pyth directly and not trust a wrapper over another source | you want one cache that composes with any source ("cached" ∘ "pyth"/"switchboard"/…) |
| Caveat | Pyth only | caches the price only (not Pyth confidence/EMA) |

Both: `refresh()` (keeper, state-changing — parses + SSTOREs) and
`latestRoundData()` (view, pure SLOAD). Both are `AggregatorV3Interface`
drop-ins, deployed as EIP-1167 clones by the factory. A fresh clone reverts
`UninitializedPriceFeed` until its first `refresh()`, and `StalePriceFeed` once
the cached price ages past `maxStaleness` (default 3600s) — fails loud rather
than serving a frozen price.

## Where each piece lives

| Piece | Home | Status |
|---|---|---|
| Adapter contracts | `rome-solidity/contracts/oracle/{CachedPythAdapter,CachedFeedAdapter}.sol` | ✅ done (PR #224) |
| Factory wiring | `rome-solidity/contracts/oracle/OracleAdapterFactory.sol` — `cachedPythImplementation` + `cachedFeedImplementation` (constructor), `createCachedPythFeed(bytes32 pythAccount,…)` + `createCachedFeed(address underlying,…)` | ✅ done (PR #224) |
| Unit tests | `rome-solidity/tests/oracle/{CachedPythAdapter,CachedFeedAdapter,FactoryCachedPyth}.test.ts` | ✅ done (81 oracle tests) |
| Deploy impls + factory | `rome-solidity/scripts/oracle/deploy-v2-polish.ts` — deploy both cached impls, pass to the factory constructor | ⏳ to wire |
| Seed feeds | `rome-solidity/scripts/oracle/deploy-seed-feeds.ts` — `createCachedPythFeed` / `createCachedFeed` per feed | ⏳ to wire |
| Emit → registry | `rome-solidity/scripts/oracle/lib/emit-registry-update.ts` — emit cached feeds as `source: "cached-pyth"` / `"cached-feed"`, keyed `"<PAIR>-CACHED"` | ⏳ to wire |
| Registry feed entries | `registry/chains/<id>-<slug>/oracle.json` (auto-PR'd from `deployments/<chain>.json`; never hand-edited) | ⏳ via deploy |
| Consumer wiring (Compound) | `registry/apps/compound/<id>-<slug>.json` — `baseTokenPriceFeed` + `collateralAssets[].priceFeed` → cached adapter addresses | ⏳ via deploy |
| **Keeper (refresh)** | **`rome-ops`** — periodic `refresh()` per cached adapter (EVM-side analog of the existing Pyth-Pull `oracle-keeper`) | ⏳ **required, ops infra** |
| Consumers | Compound comet (EVM + Solana-native lanes), any `AggregatorV3` reader | — |

## Setup steps (to make it work end-to-end)

1. **Deploy.** New chains: `deploy-v2-polish.ts` stands up the OG-V2 stack with the
   cached impls (standard). Existing chains (e.g. Hadrian): additive — deploy a new
   factory + the two cached impls, **leave the live Pyth/Switchboard adapters
   untouched** so current consumers are unaffected.
2. **Seed.** `createCachedPythFeed(pythAccount,…)` and/or
   `createCachedFeed(underlyingAdapter,…)` per feed (`deploy-seed-feeds.ts`).
3. **Refresh once.** Each new clone reverts `UninitializedPriceFeed` until its
   first `refresh()`.
4. **Run the keeper.** Periodic `refresh()` (rome-ops). **Required** — without it,
   cached prices age past `maxStaleness` and `latestRoundData()` reverts
   `StalePriceFeed`, so consumer reads/borrows revert. Refresh interval must be
   < `maxStaleness`.
5. **Wire consumers.** Point the Compound comet's feeds (`apps/compound`) at the
   cached adapter addresses. One canonical cache-fed comet serves both the EVM
   (MetaMask) and Solana-native (Phantom/`DoTxUnsigned`) lanes — feeds are baked
   per-Comet, so both lanes read the same cached SLOADs.

## Trust model

Unchanged from the underlying source: a cached read returns the price the keeper
snapshotted from the **verified** on-chain Pyth/Switchboard account (staleness +
confidence checks run in `refresh()`), not a keeper-supplied number. The keeper
controls only *freshness*, not the value — a stalled keeper fails loud.

## Deploy runbook (parameterized — no hardcoded addresses)

Everything is env / config-driven; changing a param and re-running re-provisions.

**New chain (cached is standard):**
```bash
# 1. OG-V2 stack incl. both cached impls + the 7-arg factory
ETH_PK=<deployer> npx hardhat run scripts/oracle/deploy-v2-polish.ts --network <chain>
# 2. Seed feeds — pyth/switchboard + cached (cached auto-seeded when the
#    deployment has the cached impls; Switchboard skippable per chain)
ETH_PK=<deployer> npx hardhat run scripts/oracle/deploy-seed-feeds.ts --network <chain>
# 3. emit-registry-update (run by the contract-deploys oracle-deploy workflow)
#    writes oracle.json (cached feeds keyed "<PAIR>-CACHEDPYTH" / "<PAIR>-CACHED")
#    + contracts.json, and auto-PRs them to the registry. Don't hand-edit oracle.json.
```

**Existing chain (additive — keep the live Pyth/Switchboard feeds):** deploy a new
cached-capable `OracleAdapterFactory` reusing the chain's existing pyth/switchboard
impls (constructor args), then per feed call `createCachedPythFeed(pythAccount, desc,
staleness)` and/or `createCachedFeed(underlyingAdapter, desc, staleness)`. Both are
permissionless. The existing factory + adapters are untouched.

**Comet (config-driven, in `compound-on-rome-comet`):**
```bash
CHAIN_ID=<id> REGISTRY_ROOT=<registry-checkout> ETH_PK=<deployer> \
  npx hardhat run scripts/registry-driven-deploy/deploy.ts --network <chain>
```
The comet's feeds come from `apps/compound/<chainId>-<slug>.json` — set each
`priceFeed` to the cached adapter address with `priceFeedKind: "cached-pyth"` (or
`"cached-feed"`). One canonical comet serves both lanes.

## Keeper (required — `scripts/oracle/refresh-cached-feeds.ts`)

Refresh the cached adapters on a cron at an interval **< `maxStaleness`** (default
3600s). Without it, `latestRoundData()` reverts `StalePriceFeed` and consumer
reads/borrows revert.
```bash
# adapters sourced from deployments/<network>.json feeds.cachedPyth + .cachedFeed:
npx hardhat run scripts/oracle/refresh-cached-feeds.ts --network <chain>
# or an explicit list (ad-hoc / cast-deployed feeds not yet in the deployments file):
CACHED_FEEDS=0x..,0x.. npx hardhat run scripts/oracle/refresh-cached-feeds.ts --network <chain>
```
Wire this into rome-ops (the EVM-side analog of the Pyth-Pull `oracle-keeper`).
