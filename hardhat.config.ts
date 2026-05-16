import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
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
    hadrian: {
      type: "http",
      chainType: "l1",
      chainId: 200010,
      url: "https://hadrian.testnet.romeprotocol.xyz/",
      accounts: [configVariable("HADRIAN_PRIVATE_KEY")],
    },

    aurelius: {
      type: "http",
      chainType: "l1",
      chainId: 30001,
      url: "https://aurelius.real-testnet.romeprotocol.xyz/",
      accounts: [configVariable("AURELIUS_PRIVATE_KEY")],
    },

    augustus: {
      type: "http",
      chainType: "l1",
      chainId: 200001,
      url: "https://augustus.testnet.romeprotocol.xyz/",
      accounts: [configVariable("AUGUSTUS_PRIVATE_KEY")],
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
    marcus: {
      type: "http",
      chainType: "l1",
      chainId: 121301,
      url: "https://marcus.devnet.romeprotocol.xyz/",
      accounts: [configVariable("MARCUS_PRIVATE_KEY")],
    },
  },
});
