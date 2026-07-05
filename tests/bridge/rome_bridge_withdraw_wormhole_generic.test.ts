import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * RomeBridgeWithdraw — generic Wormhole burn (burnToWormhole / approveWormholeBurn).
 *
 * Generalizes the ETH-only/Sepolia-only Wormhole burn to per-call asset +
 * per-call target chain, mirroring burnUSDC's per-domain model. The asset +
 * target-chain allowlist guards + zero-recipient + amount-bound checks fire
 * BEFORE any Rome precompile touch (like _burnUSDC), so their exact reverts are
 * assertable on the simulated EVM with MockSplErc20 wrappers. The happy-path
 * transfer_tokens CPI needs a live Rome node → covered by the integration suite.
 */

const ZERO = "0x" + "00".repeat(32);
const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
const RECIPIENT = PK(0x99); // 32-byte recipient (Solana pubkey raw / EVM addr left-padded)

const CCTP = {
  tokenMessengerProgram: PK(1),
  messageTransmitterProgram: PK(2),
  splTokenProgram: PK(3),
  systemProgram: ZERO,
  messageTransmitterConfig: PK(4),
  tokenMessengerConfig: PK(5),
  tokenMinter: PK(6),
  localTokenUsdc: PK(7),
  domains: [0, 15],
  remoteTokenMessengers: [PK(8), PK(9)],
  senderAuthorityPda: PK(10),
  eventAuthority: PK(11),
  messageTransmitterEventAuthority: PK(12),
};
const WH = {
  tokenBridgeProgram: PK(20), coreProgram: PK(21), splTokenProgram: PK(3),
  systemProgram: ZERO, clockSysvar: PK(22), rentSysvar: PK(23),
  config: PK(24), custody: PK(25), authoritySigner: PK(26), custodySigner: PK(27),
  bridgeConfig: PK(28), feeCollector: PK(29), emitter: PK(30), sequence: PK(31),
  wrappedMeta: PK(32), targetChain: 10002,
};
const FORWARDER = "0x0000000000000000000000000000000000000000";

describe("RomeBridgeWithdraw — generic Wormhole burn", function () {
  let viem: any;
  let bridge: any;
  let weth: any, jitosol: any, unregistered: any;

  before(async function () {
    ({ viem } = await hardhat.network.connect());
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    weth = await viem.deployContract("MockSplErc20", [PK(41)]);
    jitosol = await viem.deployContract("MockSplErc20", [PK(42)]);
    unregistered = await viem.deployContract("MockSplErc20", [PK(43)]);
    // New generic-Wormhole config: per-call target-chain allowlist + registered
    // asset wrappers. Sepolia (10002) + Ethereum (2) allowed; weth + jitosol
    // registered — proving the path is multi-asset, not ETH-only.
    const WHG = {
      targetChains: [10002, 2],
      assetWrappers: [weth.address, jitosol.address],
    };
    bridge = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, weth.address, CCTP, WH, WHG,
    ]);
  });

  it("constructor populates the wormhole target-chain allowlist", async function () {
    assert.equal(await bridge.read.wormholeTargetChainAllowed([10002]), true);
    assert.equal(await bridge.read.wormholeTargetChainAllowed([2]), true);
    assert.equal(await bridge.read.wormholeTargetChainAllowed([5]), false);
  });

  it("constructor populates the wormhole asset allowlist", async function () {
    assert.equal(await bridge.read.wormholeAssetAllowed([weth.address]), true);
    assert.equal(await bridge.read.wormholeAssetAllowed([jitosol.address]), true);
    assert.equal(await bridge.read.wormholeAssetAllowed([unregistered.address]), false);
  });

  it("burnToWormhole to an unlisted target chain reverts UnsupportedTargetChain", async function () {
    await assert.rejects(
      bridge.write.burnToWormhole([weth.address, 1000n, RECIPIENT, 5]),
      /UnsupportedTargetChain/,
    );
  });

  it("burnToWormhole with an unregistered asset reverts UnsupportedAssetWrapper", async function () {
    await assert.rejects(
      bridge.write.burnToWormhole([unregistered.address, 1000n, RECIPIENT, 10002]),
      /UnsupportedAssetWrapper/,
    );
  });

  it("burnToWormhole to the zero recipient reverts ZeroRecipient", async function () {
    await assert.rejects(
      bridge.write.burnToWormhole([weth.address, 1000n, ZERO, 10002]),
      /ZeroRecipient/,
    );
  });

  it("burnToWormhole amount above uint64 max reverts AmountExceedsUint64", async function () {
    await assert.rejects(
      bridge.write.burnToWormhole([weth.address, 2n ** 64n, RECIPIENT, 10002]),
      /AmountExceedsUint64/,
    );
  });

  it("approveWormholeBurn with an unregistered asset reverts UnsupportedAssetWrapper", async function () {
    await assert.rejects(
      bridge.write.approveWormholeBurn([unregistered.address, 1000n]),
      /UnsupportedAssetWrapper/,
    );
  });

  it("constructor rejects mismatched wormhole config (fail-closed)", async function () {
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    // Duplicate/empty allowlists must not silently succeed — keep parity with
    // CCTP's DomainConfigLengthMismatch guard family (asserts the ctor validates).
    const emptyWhg = { targetChains: [] as number[], assetWrappers: [] as `0x${string}`[] };
    const b = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, weth.address, CCTP, WH, emptyWhg,
    ]);
    // With no chains allowlisted, every burnToWormhole target is rejected.
    await assert.rejects(
      b.write.burnToWormhole([weth.address, 1000n, RECIPIENT, 10002]),
      /UnsupportedTargetChain|UnsupportedAssetWrapper/,
    );
  });
});
