import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
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
      url: "https://sepolia.gateway.tenderly.co/1WaYWPMXChhNxZn22C0r27",
      accounts: ["0xfff86a5d88cc029df8c309c0bc77144ce8f21dfdcc85fc965b16dd1cba442ad8"],
    },
    monti_spl: {
      type: "http",
      chainType: "l1",
      url: "https://montispl-i.devnet.romeprotocol.xyz/",
      accounts: [configVariable("MONTI_SPL_PRIVATE_KEY")]
    },
    local: {
      type: "http",
      chainType: "l1",
      url: "http://localhost:9090",
      accounts: [configVariable("LOCAL_PRIVATE_KEY")],
    }
  },
});
