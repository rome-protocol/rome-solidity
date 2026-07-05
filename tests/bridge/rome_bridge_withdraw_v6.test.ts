import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * RomeBridgeWithdraw v6 constructor + guard tests — network-independent.
 * The domain allowlist and zero-recipient guards fire BEFORE any Rome
 * precompile touch (deliberately, see _burnUSDC), so their exact reverts
 * are assertable on the simulated EVM with MockSplErc20 wrappers.
 */

const ZERO = "0x" + "00".repeat(32);
const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;

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

describe("RomeBridgeWithdraw v6 — domain allowlist", function () {
  let viem: any;
  let bridge: any;

  before(async function () {
    ({ viem } = await hardhat.network.connect());
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    const weth = await viem.deployContract("MockSplErc20", [PK(41)]);
    bridge = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, weth.address, CCTP, WH,
      { admin: "0x00000000000000000000000000000000000000a1", targetChains: [], assetWrappers: [] }, // generic-Wormhole config (unused by these CCTP guard tests)
    ]);
  });

  it("constructor populates the domain → remote_token_messenger allowlist", async function () {
    assert.equal((await bridge.read.cctpRemoteTokenMessengers([0])).toLowerCase(), PK(8));
    assert.equal((await bridge.read.cctpRemoteTokenMessengers([15])).toLowerCase(), PK(9));
    assert.equal(await bridge.read.cctpRemoteTokenMessengers([3]), ZERO);
  });

  it("burnUSDC to an unlisted domain reverts UnsupportedDestinationDomain", async function () {
    await assert.rejects(
      bridge.write.burnUSDC([1000n, "0x1111111111111111111111111111111111111111", 3]),
      /UnsupportedDestinationDomain/,
    );
  });

  it("burnUSDC to the zero recipient reverts ZeroRecipient", async function () {
    await assert.rejects(
      bridge.write.burnUSDC([1000n, "0x0000000000000000000000000000000000000000", 15]),
      /ZeroRecipient/,
    );
  });

  it("constructor rejects mismatched allowlist arrays", async function () {
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    const badCctp = { ...CCTP, domains: [0], remoteTokenMessengers: [PK(8), PK(9)] };
    await assert.rejects(
      viem.deployContract("RomeBridgeWithdraw", [FORWARDER, usdc.address, usdc.address, badCctp, WH, { admin: "0x00000000000000000000000000000000000000a1", targetChains: [], assetWrappers: [] }]),
      /DomainConfigLengthMismatch/,
    );
  });
});
