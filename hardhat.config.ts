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
    monti_spl: {
      type: "http",
      chainType: "l1",
      url: "https://montispl-i.devnet.romeprotocol.xyz/",
      accounts: [configVariable("MONTI_SPL_PRIVATE_KEY")]
    },
    marcus: {
      type: "http",
      chainType: "l1",
      chainId: 121226,
      url: "https://marcus.devnet.romeprotocol.xyz/",
      accounts: [configVariable("MARCUS_PRIVATE_KEY")],
    },
    subura: {
      type: "http",
      chainType: "l1",
      chainId: 121222,
      url: "https://subura.devnet.romeprotocol.xyz/",
      accounts: [configVariable("SUBURA_PRIVATE_KEY")],
    },
    esquiline: {
      type: "http",
      chainType: "l1",
      chainId: 121225,
      url: "https://esquiline.devnet.romeprotocol.xyz/",
      accounts: [configVariable("ESQUILINE_PRIVATE_KEY")],
    },
    local: {
      type: "http",
      chainType: "l1",
      url: "http://localhost:9090",
      accounts: [configVariable("LOCAL_PRIVATE_KEY")],
    },
  },
});
