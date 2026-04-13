import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      // viaIR is required on the default profile because RomeWormholeBridge's
      // sendTransferNative/sendTransferWrapped functions accept 10 parameters
      // (including two dynamic arrays), which exceeds the EVM's 16-slot stack
      // limit and causes "stack too deep" compilation errors without IR codegen.
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
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    monti_spl: {
      type: "http",
      chainType: "l1",
      url: "https://montispl-i.devnet.romeprotocol.xyz/",
      accounts: [configVariable("MONTI_SPL_PRIVATE_KEY")],
    },
    // Env-var variants for non-interactive use (E2E scripts, CI)
    sepolia_env: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org",
      accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
    },
    monti_spl_env: {
      type: "http",
      chainType: "l1",
      url: "https://montispl-i.devnet.romeprotocol.xyz/",
      accounts: process.env.MONTI_SPL_PRIVATE_KEY ? [process.env.MONTI_SPL_PRIVATE_KEY] : [],
    },
    monti_spl_iterative: {
      type: "http",
      chainType: "l1",
      url: "https://montispl-i.devnet.romeprotocol.xyz/",
      accounts: process.env.MONTI_SPL_PRIVATE_KEY ? [process.env.MONTI_SPL_PRIVATE_KEY] : [configVariable("MONTI_SPL_PRIVATE_KEY")],
    },
    local: {
      type: "http",
      chainType: "l1",
      url: "http://localhost:9090",
      accounts: [configVariable("LOCAL_PRIVATE_KEY")],
    }
  },
});
