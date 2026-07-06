import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * RomeBridgeWithdraw — Wormhole transfer_native egress (v11,
 * transferNativeToWormhole). Mirrors rome_bridge_withdraw_wormhole_generic.test.ts.
 *
 * The asset + target-chain allowlist guards + zero-recipient + amount-bound
 * checks fire BEFORE any Rome precompile touch (parity with burnToWormhole), so
 * their exact reverts are assertable on the simulated EVM with MockSplErc20
 * wrappers. The happy-path transfer_native CPI (and the balanceOf gate, which
 * reads a precompile) need a live Rome node -> funded integration smoke.
 *
 * transferNativeToWormhole shares the wormholeMintAllowed / wormholeTargetChain
 * allowlists with burnToWormhole: a wrapper/chain enabled for one is enabled for
 * the other. These tests prove the guard wiring on the native entry point.
 */

const ZERO = "0x" + "00".repeat(32);
const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
const RECIPIENT = PK(0x99);

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

describe("RomeBridgeWithdraw — Wormhole transfer_native egress", function () {
  let viem: any;
  let bridge: any;
  let wsol: any, msol: any, unregistered: any, weth: any;
  let ownerAddr: `0x${string}`;

  before(async function () {
    ({ viem } = await hardhat.network.connect());
    const wallets = await viem.getWalletClients();
    ownerAddr = wallets[0].account.address;
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    weth = await viem.deployContract("MockSplErc20", [PK(41)]);
    wsol = await viem.deployContract("MockSplErc20", [PK(50)]); // native mint (e.g. So111..112)
    msol = await viem.deployContract("MockSplErc20", [PK(51)]); // native LST mint
    unregistered = await viem.deployContract("MockSplErc20", [PK(52)]);
    // wSOL + mSOL registered as native-egress assets; Sepolia (10002) + ETH (2) allowed.
    const WHG = {
      admin: ownerAddr,
      targetChains: [10002, 2],
      assetWrappers: [wsol.address, msol.address],
    };
    bridge = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, weth.address, CCTP, WH, WHG,
    ]);
  });

  it("both native wrappers (wSOL + mSOL) are registered for native egress", async function () {
    assert.equal(await bridge.read.wormholeAssetAllowed([wsol.address]), true);
    assert.equal(await bridge.read.wormholeAssetAllowed([msol.address]), true);
    assert.equal(await bridge.read.wormholeAssetAllowed([unregistered.address]), false);
  });

  it("transferNativeToWormhole with an unregistered asset reverts UnsupportedAssetWrapper", async function () {
    await assert.rejects(
      bridge.write.transferNativeToWormhole([unregistered.address, 1000n, RECIPIENT, 10002]),
      /UnsupportedAssetWrapper/,
    );
  });

  it("transferNativeToWormhole to an unlisted target chain reverts UnsupportedTargetChain", async function () {
    await assert.rejects(
      bridge.write.transferNativeToWormhole([wsol.address, 1000n, RECIPIENT, 5]),
      /UnsupportedTargetChain/,
    );
  });

  it("transferNativeToWormhole to the zero recipient reverts ZeroRecipient", async function () {
    await assert.rejects(
      bridge.write.transferNativeToWormhole([wsol.address, 1000n, ZERO, 10002]),
      /ZeroRecipient/,
    );
  });

  it("transferNativeToWormhole amount above uint64 max reverts AmountExceedsUint64", async function () {
    await assert.rejects(
      bridge.write.transferNativeToWormhole([wsol.address, 2n ** 64n, RECIPIENT, 10002]),
      /AmountExceedsUint64/,
    );
  });

  it("allowlist is mint-keyed: a second wrapper over an allowed native mint clears the asset guard", async function () {
    const wsolAlt = await viem.deployContract("MockSplErc20", [PK(50)]); // SAME mint as wsol
    assert.notEqual(wsolAlt.address.toLowerCase(), wsol.address.toLowerCase());
    // Mint-keyed allowlist accepts the alt wrapper -> reverts on a LATER guard
    // (ZeroRecipient), not UnsupportedAssetWrapper.
    await assert.rejects(
      bridge.write.transferNativeToWormhole([wsolAlt.address, 1000n, ZERO, 10002]),
      /ZeroRecipient/,
    );
  });
});
