# `rome-solidity`

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.


- **Single state** — EVM contracts and Solana programs share one state; no bridging or sync delay.
- **Atomic CPI access** — Solidity calls any Solana program directly (SPL Token, Meteora, …) inside one atomic transaction.
- **App Sovereignty** — each app runs its own EVM chain with a custom gas token and captures its own fee revenue.

`rome-solidity` is the **Solidity SDK for Rome** — the interfaces, wrappers, and contracts a Solidity builder uses to reach Solana from an EVM contract: call any Solana program (CPI), treat any SPL token as an ERC-20, bridge assets out of Rome, and read Solana price feeds through the standard Chainlink interface.

**Full reference:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — every contract, what it's for, and where it's used.

## What's inside — ordered by importance

1. **Precompile interfaces** — [`contracts/interface.sol`](contracts/interface.sol). The ABI bindings to Rome's non-EVM precompiles: **CPI** (`0xff…08`), **Helper** (`0xff…09`), **System** (`0xff…07`), **Withdraw** (`0x42…16`), and the gas-optimised **cached** family (`0xff…04/05/06/0b`). Everything else builds on these.
2. **CPI toolkit** — [`contracts/cpi/`](contracts/cpi/). Call *any* Solana program from Solidity — account-meta builders, Anchor encoding, PDA derivation, cost quoting, and adapter templates. The differentiator. (Guide: [`contracts/cpi/README.md`](contracts/cpi/README.md).)
3. **SPL ↔ ERC-20 wrappers** — [`contracts/erc20spl/`](contracts/erc20spl/). Any SPL token *is* an ERC-20 on Rome. Two tracks (**cached** vs **CPI** — see below) plus `ERC20SPLFactory` to wrap existing mints or mint new SPL tokens.
4. **Bridge** — [`contracts/bridge/`](contracts/bridge/). The on-chain egress from Rome: `RomeBridgeWithdraw` (five rails) over Circle **CCTP v2** and **Wormhole**. (The off-chain orchestrator is the separate `rome-bridge-api`.)
5. **Oracle** — [`contracts/oracle/`](contracts/oracle/). Solana price feeds (Pyth, Switchboard) delivered to EVM contracts through the standard Chainlink `AggregatorV3Interface`; direct + cached adapters, a clone factory, and a batch reader.
6. **Account & token primitives** — `rome_evm_account.sol` (PDA derivation), `activation/SimpleActivator.sol` (one-tx user-paid activation), `wrap/WrappedGasFacade.sol`, and the `spl_token/` · `system_program/` · `convert.sol` low-level libraries.
7. **Examples** — [`contracts/examples/`](contracts/examples/). Worked references for the toolkit.

## The two SPL wrapper tracks — which to use

Both `SPL_ERC20_cached` and `SPL_ERC20` expose the identical `IERC20` surface over the same SPL mint. A contract uses **one track, never both** (a hard rule).

| Use **`SPL_ERC20_cached`** (the default) | Use **`SPL_ERC20`** (CPI-based) |
|---|---|
| Standard ERC-20 flows; multi-step / iterative-VM composition (DEX multi-hop, bulkers); anything needing the Solana side effect to **revert atomically** with the EVM tx. Cheaper CU. The factory deploys this. | Only when you need to push SPL out to an **arbitrary raw Solana wallet** (`bridgeOutToSolana` / `ensureRecipientAta`), which requires the permanently-CPI-only `create_ata_for_key`. |

Full explanation: [`docs/ARCHITECTURE.md` §3](docs/ARCHITECTURE.md#3-spl--erc-20-wrappers--contractserc20spl).

## Import paths

```solidity
import {ICrossProgramInvocation, IHelperProgram, CpiProgram, HelperProgram}
    from "@rome-protocol/rome-solidity/contracts/interface.sol";
import {SPL_ERC20_cached} from "@rome-protocol/rome-solidity/contracts/erc20spl/erc20spl_cached.sol";
import {IAggregatorV3Interface} from "@rome-protocol/rome-solidity/contracts/oracle/IAggregatorV3Interface.sol";
```

npm publish is pending — consume via a github-pinned git dependency or by copying files. (The CPI-precompile ABIs are also mirrored in [`@rome-protocol/sdk`](https://github.com/rome-protocol/rome-sdk-ts) for TypeScript.)

## Quick start

```bash
npm install
npx hardhat compile
# network-independent unit tests (oracle + bridge + CPI foundation):
npx hardhat test nodejs tests/oracle/*.test.ts tests/bridge/*.test.ts tests/cpi/*.test.ts
```

Solidity `0.8.28`. Integration tests under `tests/**/*.integration.ts` require a live Rome chain (`--network local`, or a devnet/testnet chain); see [`hardhat.config.ts`](hardhat.config.ts) for configured networks.

## Building on Rome with an agent

See [`AGENTS.md`](AGENTS.md) — the Rome-specific rules a coding agent needs — and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full contract map.

## License

MIT — see [`LICENSE`](LICENSE).
