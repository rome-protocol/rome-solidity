import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * RomeBridgeWithdraw — generic Wormhole burn (burnToWormhole).
 *
 * Generalizes the ETH-only/Sepolia-only Wormhole burn to per-call asset +
 * per-call target chain, mirroring burnUSDC's per-domain model. The asset +
 * target-chain allowlist guards + zero-recipient + amount-bound checks fire
 * BEFORE any Rome precompile touch (like _burnUSDC), so their exact reverts are
 * assertable on the simulated EVM with MockSplErc20 wrappers. The happy-path
 * transfer_tokens CPI needs a live Rome node → covered by the integration suite.
 */

const ZERO = "0x" + "00".repeat(32);
const ZERO_ADDR = "0x" + "00".repeat(20); // 20-byte zero (address), for transferOwnership guard
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
  let ownerAddr: `0x${string}`, otherAddr: `0x${string}`;

  before(async function () {
    ({ viem } = await hardhat.network.connect());
    const wallets = await viem.getWalletClients();
    ownerAddr = wallets[0].account.address;   // deployer = admin (see WHG.admin)
    otherAddr = wallets[1].account.address;    // non-owner, used for access-control tests
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    weth = await viem.deployContract("MockSplErc20", [PK(41)]);
    jitosol = await viem.deployContract("MockSplErc20", [PK(42)]);
    unregistered = await viem.deployContract("MockSplErc20", [PK(43)]);
    // New generic-Wormhole config: per-call target-chain allowlist + registered
    // asset wrappers. Sepolia (10002) + Ethereum (2) allowed; weth + jitosol
    // registered — proving the path is multi-asset, not ETH-only. `admin` owns
    // the post-deploy setters so new assets/chains are enabled WITHOUT a redeploy.
    const WHG = {
      admin: ownerAddr,
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

  it("allowlist is mint-keyed: any wrapper over an allowed mint is accepted", async function () {
    // `weth` (mint PK(41)) is ctor-seeded. Deploy a SECOND, distinct wrapper
    // CONTRACT over the SAME mint. Wrapper-instance-keyed (old) would reject it
    // (different address); mint-keyed (new) accepts it, because all wrappers over
    // one mint are fungible views of the same on-chain ATA. This is exactly the
    // registry/deployments/v8 wrapper drift (3 wrappers, 1 mint) made harmless.
    const wethAlt = await viem.deployContract("MockSplErc20", [PK(41)]);
    assert.notEqual(wethAlt.address.toLowerCase(), weth.address.toLowerCase());
    assert.equal(await bridge.read.wormholeAssetAllowed([wethAlt.address]), true);
    // And it must clear the burnToWormhole asset guard — reverting on a LATER
    // guard (ZeroRecipient), not UnsupportedAssetWrapper.
    await assert.rejects(
      bridge.write.burnToWormhole([wethAlt.address, 1000n, ZERO, 10002]),
      /ZeroRecipient/,
    );
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

  it("constructor rejects mismatched wormhole config (fail-closed)", async function () {
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    // Duplicate/empty allowlists must not silently succeed — keep parity with
    // CCTP's DomainConfigLengthMismatch guard family (asserts the ctor validates).
    const emptyWhg = { admin: ownerAddr, targetChains: [] as number[], assetWrappers: [] as `0x${string}`[] };
    const b = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, weth.address, CCTP, WH, emptyWhg,
    ]);
    // With no chains allowlisted, every burnToWormhole target is rejected.
    await assert.rejects(
      b.write.burnToWormhole([weth.address, 1000n, RECIPIENT, 10002]),
      /UnsupportedTargetChain|UnsupportedAssetWrapper/,
    );
  });

  // ── Post-deploy admin: enable new assets/chains WITHOUT a redeploy ──────────
  // The whole point of v8: the ctor allowlist is a seed, not a cage. An owner can
  // list wmSOL/arb/avax + Arbitrum/Avalanche on the LIVE contract via setters.

  it("constructor records the configured admin as owner", async function () {
    assert.equal((await bridge.read.owner()).toLowerCase(), ownerAddr.toLowerCase());
  });

  it("owner enables a previously-unregistered asset via setWormholeAssetAllowed", async function () {
    assert.equal(await bridge.read.wormholeAssetAllowed([unregistered.address]), false);
    await bridge.write.setWormholeAssetAllowed([unregistered.address, true]);
    assert.equal(await bridge.read.wormholeAssetAllowed([unregistered.address]), true);
    // ...and can revoke it again (setter is a real toggle, not one-way).
    await bridge.write.setWormholeAssetAllowed([unregistered.address, false]);
    assert.equal(await bridge.read.wormholeAssetAllowed([unregistered.address]), false);
  });

  it("owner enables a new target chain via setWormholeTargetChainAllowed (e.g. Arbitrum 23)", async function () {
    assert.equal(await bridge.read.wormholeTargetChainAllowed([23]), false);
    await bridge.write.setWormholeTargetChainAllowed([23, true]);
    assert.equal(await bridge.read.wormholeTargetChainAllowed([23]), true);
  });

  it("non-owner cannot toggle the asset allowlist (reverts NotOwner)", async function () {
    await assert.rejects(
      bridge.write.setWormholeAssetAllowed([unregistered.address, true], { account: otherAddr }),
      /NotOwner/,
    );
  });

  it("non-owner cannot toggle the target-chain allowlist (reverts NotOwner)", async function () {
    await assert.rejects(
      bridge.write.setWormholeTargetChainAllowed([6, true], { account: otherAddr }),
      /NotOwner/,
    );
  });

  it("transferOwnership hands admin to a new owner; old owner loses rights", async function () {
    // Fresh instance so the transfer doesn't bleed into the shared `bridge`.
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    const b = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, weth.address, CCTP, WH,
      { admin: ownerAddr, targetChains: [10002], assetWrappers: [weth.address] },
    ]);
    await b.write.transferOwnership([otherAddr]);
    assert.equal((await b.read.owner()).toLowerCase(), otherAddr.toLowerCase());
    // Old owner is now powerless; new owner can administer.
    await assert.rejects(b.write.setWormholeTargetChainAllowed([23, true]), /NotOwner/);
    await b.write.setWormholeTargetChainAllowed([23, true], { account: otherAddr });
    assert.equal(await b.read.wormholeTargetChainAllowed([23]), true);
  });

  it("transferOwnership to the zero address reverts (no accidental burn of admin)", async function () {
    await assert.rejects(bridge.write.transferOwnership([ZERO_ADDR]), /ZeroOwner|NotOwner/);
  });
});
