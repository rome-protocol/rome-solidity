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
