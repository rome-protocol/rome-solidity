# `rome-solidity/contracts` — discovery map

This is the **discovery surface** for Rome's Solidity contracts. It answers "where is the interface for X, and where does its address come from?" — because that is a *map*, and a map is documentation + registry, not a `.sol` file.

## Two kinds of thing, one rule

**Type from code, address from data.**

| | Precompiles | Application contracts |
|---|---|---|
| Examples | `SplCached`, `HelperProgram`, `Withdraw`, CPI, System | SPL-ERC20 wrappers, bridge, oracle adapters, wrap facade |
| Address | **fixed** protocol constant (`0xFF…`, `0x42…`), same on every Rome chain | **per-chain**, deployed |
| Where the address lives | `interface.sol` (the one file allowed to hardcode) | **`rome-protocol/registry`** — never hardcoded in-repo |
| Where the interface lives | `interface.sol` | that contract's own area file |
| Reason to change | a rome-evm program upgrade | the app team |

**Admission rule for `interface.sol`:** an interface belongs there **iff its address is a fixed constant burned into the rome-evm program dispatch.** Everything else is an application contract and lives in its area, with its address in the registry.

**Boundary:** this map covers `rome-solidity`'s own contracts. Downstream repos (`rome-uniswap-v2/3/4`, `rome-arc` with its own ERC20) **import** from here — they are consumers, not entries.

## The map

| Area | Canonical interface(s) | Deployed address | Notes |
|---|---|---|---|
| **Precompiles** | `interface.sol` — `ISystemProgram`, `IWithdraw`, `IWithdrawCached`, `ISystemCached`, `ISplCached`, `IAssociatedSplCached`, `ICrossProgramInvocation`, `IHelperProgram` | fixed constants **in `interface.sol`** | Chain-ABI header; version-tracks the program dispatch. `mint_info` + Token-2022 cached ops live here. |
| **erc20spl** | `IERC20` / `IERC20Metadata` (via `SPL_ERC20Base`) | registry | 3 wrapper kinds: legacy `SPL_ERC20`, `SPL_ERC20_cached`, `SPL_ERC20_Token2022Hooked` (`ERC20SPLFactory.WrapperKind`). Composers type against `IERC20`. |
| **bridge** | `IRomeBridgeWithdraw`, `IWormholeTokenBridge`, `ICCTP` / `ICCTPV2`, `RomeBridgeEvents` | registry | On-chain egress (CCTP + Wormhole). |
| **oracle** | `IExtendedOracleAdapter`, `IAggregatorV3Interface`, `IAdapterFactory`, `IAdapterMetadata` | registry | Oracle Gateway V2: Pyth Pull / Switchboard V3 / cached adapters + parsers. |
| **wrap** | `WrappedGasFacade` | registry | Native-gas ⇄ SPL wrap facade. |
| **spl_token** | `spl_token.sol`, `associated_spl_token.sol`, `token2022_hooked_transfer.sol` | n/a (libs) | Solidity-side SPL helpers. |
| **cpi** | `PdaDeriver`, `CpiError`, `CostEstimate` | n/a (libs) | CPI marshaling helpers. |
| **mpl_token_metadata** | `lib.sol` | registry / n/a | Metaplex metadata helpers. |
| **activation** | `SimpleActivator` | registry | Account-activation helper. |
| **system_program**, **convert**, **borsch**, **rome_evm_account** | libs | n/a | Internal utilities. |

> Registry keys resolve per chain under `rome-protocol/registry` (`chains/<id>/…`). This table names *where the interface is* and *that the address is registry-sourced* — it deliberately contains no addresses.
