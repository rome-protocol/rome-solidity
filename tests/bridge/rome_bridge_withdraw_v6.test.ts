import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { CCTP, FORWARDER, GUARDIAN, PK, WH, ZERO32, ADDR, enableDomain, installMock, remoteMessengerPda } from "./helpers/v13.js";

/**
 * RomeBridgeWithdraw destination-domain guard tests — network-independent.
 * The domain and zero-recipient guards fire BEFORE any Rome precompile touch
 * (deliberately, see _burnUSDC), so their exact reverts are assertable on the
 * simulated EVM with MockSplErc20 wrappers.
 *
 * Since v13 the destination list is not a constructor value: a fresh bridge has
 * no CCTP destination, and domains are switched on by `enableCctpDomain`.
 * The full admin surface is covered in rome_bridge_withdraw_v13.test.ts.
 */
describe("RomeBridgeWithdraw — CCTP domain guards", function () {
  let viem: any;
  let cpi: any;
  let bridge: any;
  let owner: `0x${string}`;

  before(async function () {
    const conn = await hardhat.network.connect();
    ({ viem } = conn);
    ({ cpi } = await installMock(conn));
    const wallets = await viem.getWalletClients();
    owner = wallets[0].account.address;
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    bridge = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, CCTP, WH,
      { admin: owner, targetChains: [], assetWrappers: [] },
      GUARDIAN,
    ]);
    await enableDomain(bridge, cpi, 0);
    await enableDomain(bridge, cpi, 15);
  });

  it("enabling a domain stores Circle's remote_token_messenger PDA for it", async function () {
    assert.equal((await bridge.read.cctpRemoteTokenMessengers([0])).toLowerCase(), remoteMessengerPda(0));
    assert.equal((await bridge.read.cctpRemoteTokenMessengers([15])).toLowerCase(), remoteMessengerPda(15));
    assert.equal(await bridge.read.cctpRemoteTokenMessengers([3]), ZERO32);
  });

  it("a fresh bridge has no CCTP destination until the owner enables one", async function () {
    const usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
    const fresh = await viem.deployContract("RomeBridgeWithdraw", [
      FORWARDER, usdc.address, CCTP, WH,
      { admin: owner, targetChains: [], assetWrappers: [] },
      GUARDIAN,
    ]);
    assert.deepEqual(await fresh.read.cctpDomains(), []);
    await assert.rejects(
      fresh.write.burnUSDC([1000n, ADDR(0x1111), 0]),
      /UnsupportedDestinationDomain/,
    );
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
});
