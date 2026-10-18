import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { readFileSync } from "node:fs";
import { configVariable, defineConfig } from "hardhat/config";

// Rome runs one Sourcify per environment: verify.testnet serves the testnets and
// devnets, verify.mainnet serves Rubicon (chain 7531). Each rejects the other's
// chains ("Chain 7531 not found" on verify.testnet), so the verifier follows the
// network. The map lives in sourcify-urls.json so scripts/verify-deployments.sh
// reads the same one. SOURCIFY_API_URL overrides it for a one-off run.
const sourcifyUrls: { default: string; networks: Record<string, string> } = JSON.parse(
  readFileSync(new URL("./sourcify-urls.json", import.meta.url), "utf8"),
);

// The network the CLI was asked for: `--network x` or `--network=x`.
function requestedNetwork(): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--network") return argv[i + 1];
    if (argv[i].startsWith("--network=")) return argv[i].slice("--network=".length);
  }
  return undefined;
}

const net = requestedNetwork() ?? process.env.HARDHAT_NETWORK;
const sourcifyApiUrl =
  process.env.SOURCIFY_API_URL ||
  ((net === undefined ? undefined : sourcifyUrls.networks[net]) ?? sourcifyUrls.default);

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],

  // Source verification. Rome runs its own Sourcify instances (see sourcifyApiUrl
  // above); without apiUrl the plugin submits to sourcify.dev, which answers
  // "Chain 200010 not found" because it has never heard of these chains. Etherscan
  // and Blockscout are switched off rather than left to fail on every run — no
  // Rome chain is listed on either.
  verify: {
    sourcify: {
      enabled: true,
      apiUrl: sourcifyApiUrl,
    },
    etherscan: { enabled: false },
    blockscout: { enabled: false },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    martius: {
      type: "http",
      chainType: "l1",
      chainId: 121214,
      url: "https://martius.testnet.romeprotocol.xyz/",
      accounts: [configVariable("MARTIUS_PRIVATE_KEY")],
    },

    subura: {
      type: "http",
      chainType: "l1",
      chainId: 121213,
      url: "https://subura.devnet.romeprotocol.xyz/",
      accounts: [configVariable("SUBURA_PRIVATE_KEY")],
    },

    trajan: {
      type: "http",
      chainType: "l1",
      chainId: 121302,
      url: "https://trajan.devnet.romeprotocol.xyz/",
      accounts: [configVariable("TRAJAN_PRIVATE_KEY")],
    },
    nerva: {
      type: "http",
      chainType: "l1",
      chainId: 210000,
      url: "https://nerva.testnet.romeprotocol.xyz/",
      accounts: [configVariable("NERVA_PRIVATE_KEY")],
    },
    hadrian: {
      type: "http",
      chainType: "l1",
      chainId: 200010,
      url: "https://hadrian.testnet.romeprotocol.xyz/",
      accounts: [configVariable("HADRIAN_PRIVATE_KEY")],
    },
    // Mainnet. URL kept out of source so deploys can target a non-public
    // endpoint; the key is injected transiently for one-shot runs.
    rubicon: {
      type: "http",
      chainType: "l1",
      chainId: 7531,
      url: configVariable("RUBICON_RPC_URL"),
      accounts: [configVariable("RUBICON_PRIVATE_KEY")],
      // The proxy enforces a pool-derived minimum gas price but serves stub
      // eth_feeHistory values, so Hardhat's automatic fee estimation
      // underprices every tx (rejected with "Gas_price is less than the
      // minimum value"). Pin a legacy gasPrice for the run:
      //   export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 ))
      gasPrice: process.env.RUBICON_GAS_PRICE
        ? BigInt(process.env.RUBICON_GAS_PRICE)
        : "auto",
    },
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    local: {
      type: "http",
      chainType: "l1",
      url: "http://localhost:9090",
      accounts: [configVariable("LOCAL_PRIVATE_KEY")],
    },
  },
});
