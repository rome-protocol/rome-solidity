/**
 * RomeBridgeWithdraw — the per-transfer message-account rent is billed to the user.
 *
 * Every outbound CPI (CCTP deposit_for_burn, Wormhole transfer_wrapped /
 * transfer_native) creates a message account on Solana whose rent-exempt
 * deposit is paid by the bridge's own PDA (post-#339: eventRentPayer / payer =
 * bridgePda). Nothing billed the user for it, and nothing refilled the PDA.
 *
 * The fix: right before each outbound CPI the bridge calls
 * `HelperProgram.swap_gas_to_lamports(rent)`. In the rome-evm program that is
 * a System transfer from the OPERATOR's payer to the caller's PDA, executed
 * with refund_to_signer = true — so the operator fronts exactly `rent` onto
 * the bridge PDA and the user is billed exactly that in gas, atomically.
 *
 * Two layers, as in the direct-call test:
 *   - structural: in the real source, each outbound path calls
 *     swap_gas_to_lamports BEFORE its `address(CpiProgram).call(`.
 *   - behavioral: drive the real contract through BridgePrecompileMock and
 *     assert the swap is made AS THE BRIDGE, for the configured rent, and
 *     before the CPI invoke_signed lands.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import hardhat from "hardhat";

const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009" as const;
const CPI_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000008" as const;
const SYSTEM_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000007" as const;

const ZERO = "0x" + "00".repeat(32);
const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
const ADDR = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
const ETH_RECIPIENT = ADDR(0xaaa);
const FORWARDER = "0x0000000000000000000000000000000000000000" as const;

// Measured on Hadrian (Solana devnet), 2026-09-21: CCTP messageSentEventData
// rent per burn; Wormhole message rent (2,477,770) + the 10-lamport core fee.
const CCTP_RENT = 2_824_480n;
const WORMHOLE_RENT = 2_477_780n;

const CCTP = {
  tokenMessengerProgram: PK(1),
  messageTransmitterProgram: PK(2),
  splTokenProgram: PK(3),
  systemProgram: ZERO,
  messageTransmitterConfig: PK(4),
  tokenMessengerConfig: PK(5),
  tokenMinter: PK(6),
  localTokenUsdc: PK(7),
  domains: [0],
  remoteTokenMessengers: [PK(8)],
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

const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/bridge/RomeBridgeWithdraw.sol"),
  "utf8",
);

/** Body of the named function up to (and including) its first `address(CpiProgram).call(`. */
function bodyUpToCpi(fnSignaturePrefix: string): string {
  const start = SOURCE.indexOf(fnSignaturePrefix);
  assert.ok(start >= 0, `source must define ${fnSignaturePrefix}`);
  const cpi = SOURCE.indexOf("address(CpiProgram).call(", start);
  assert.ok(cpi > start, `${fnSignaturePrefix} must reach an address(CpiProgram).call(`);
  return SOURCE.slice(start, cpi);
}

describe("RomeBridgeWithdraw — message-account rent billed to the user", () => {
  describe("structural — source is ground truth", () => {
    for (const fn of [
      "function _burnUSDC(",
      "function burnETH(",
      "function burnToWormhole(",
      "function transferNativeToWormhole(",
    ]) {
      it(`${fn} funds the message rent before its outbound CPI`, () => {
        assert.match(bodyUpToCpi(fn), /_fundMessageRent\(/);
      });
    }

    it("_fundMessageRent is a direct CALL to HelperProgram.swap_gas_to_lamports(uint64)", () => {
      const start = SOURCE.indexOf("function _fundMessageRent(");
      assert.ok(start >= 0);
      const body = SOURCE.slice(start, SOURCE.indexOf("\n    }", start));
      assert.match(body, /address\(HelperProgram\)\.call\(/);
      assert.match(body, /swap_gas_to_lamports\(uint64\)/);
      assert.doesNotMatch(body, /delegatecall/);
    });

    it("the stale '~13M lamports per burn' comment is gone", () => {
      assert.doesNotMatch(SOURCE, /13M lamports/);
    });
  });

  describe("behavioral — driven through BridgePrecompileMock", () => {
    let viem: any;
    let conn: any;
    let helper: any;
    let cpi: any;
    let usdc: any;
    let weth: any;
    let bridge: any;
    let userWallet: any;
    let ownerWallet: any;

    before(async function () {
      conn = await hardhat.network.connect();
      viem = conn.viem;
      const mockProto = await viem.deployContract("BridgePrecompileMock");
      const client = await viem.getPublicClient();
      const code = await client.getCode({ address: mockProto.address });
      for (const addr of [HELPER_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
      }
      helper = await viem.getContractAt("BridgePrecompileMock", HELPER_PROGRAM_ADDRESS);
      cpi = await viem.getContractAt("BridgePrecompileMock", CPI_PROGRAM_ADDRESS);
      const wallets = await viem.getWalletClients();
      ownerWallet = wallets[0];
      userWallet = wallets[1];
    });

    beforeEach(async function () {
      await helper.write.reset();
      await cpi.write.reset();
      usdc = await viem.deployContract("MockSplErc20", [PK(40)]);
      weth = await viem.deployContract("MockSplErc20", [PK(41)]);
      const whg = { admin: ownerWallet.account.address, targetChains: [10002], assetWrappers: [weth.address] };
      bridge = await viem.deployContract("RomeBridgeWithdraw", [FORWARDER, usdc.address, weth.address, CCTP, WH, whg]);
    });

    async function authorizePull(wrapper: any, mint: `0x${string}`, amount: bigint) {
      const user = userWallet.account.address;
      await wrapper.write.setBalance([user, amount]);
      const userAta = await helper.read.ata([user, mint]);
      await helper.write.setAuthorized([userAta, bridge.address, true]);
    }

    async function assertSwappedBeforeCpi(expectedRent: bigint) {
      assert.equal(await helper.read.swapCount(), 1n, "exactly one swap_gas_to_lamports per burn");
      assert.equal((await helper.read.lastSwapCaller()).toLowerCase(), bridge.address.toLowerCase(), "the BRIDGE is the swap caller — the lamports land on the bridge PDA");
      assert.equal(await helper.read.lastSwapLamports(), expectedRent, "swap covers exactly the configured rent");
      assert.equal(await helper.read.cpiInvokesAtSwap(), 0n, "swap happens BEFORE the outbound CPI");
      assert.equal(await cpi.read.invokeSignedCount(), 1n, "the outbound CPI still lands once");
    }

    it("defaults match the measured rents", async function () {
      assert.equal(await bridge.read.cctpMessageRentLamports(), CCTP_RENT);
      assert.equal(await bridge.read.wormholeMessageRentLamports(), WORMHOLE_RENT);
    });

    it("burnUSDC swaps the CCTP rent onto the bridge PDA before deposit_for_burn", async function () {
      await authorizePull(usdc, PK(40), 1_000_000n);
      await bridge.write.burnUSDC([1_000_000n, ETH_RECIPIENT], { account: userWallet.account });
      await assertSwappedBeforeCpi(CCTP_RENT);
    });

    it("burnETH swaps the Wormhole rent onto the bridge PDA before transfer_wrapped", async function () {
      await authorizePull(weth, PK(41), 5_000_000n);
      await bridge.write.burnETH([5_000_000n, ETH_RECIPIENT], { account: userWallet.account });
      await assertSwappedBeforeCpi(WORMHOLE_RENT);
    });

    it("burnToWormhole swaps the Wormhole rent onto the bridge PDA before the CPI", async function () {
      await authorizePull(weth, PK(41), 5_000_000n);
      const recipient = ("0x" + "00".repeat(12) + ETH_RECIPIENT.slice(2)) as `0x${string}`;
      await bridge.write.burnToWormhole([weth.address, 5_000_000n, recipient, 10002], { account: userWallet.account });
      await assertSwappedBeforeCpi(WORMHOLE_RENT);
    });

    it("setMessageRents is owner-only and takes effect on the next burn", async function () {
      await assert.rejects(
        bridge.write.setMessageRents([1n, 2n], { account: userWallet.account }),
        /NotOwner/,
      );
      await bridge.write.setMessageRents([3_000_000n, 2_600_000n], { account: ownerWallet.account });
      assert.equal(await bridge.read.cctpMessageRentLamports(), 3_000_000n);
      assert.equal(await bridge.read.wormholeMessageRentLamports(), 2_600_000n);
      await authorizePull(usdc, PK(40), 1_000_000n);
      await bridge.write.burnUSDC([1_000_000n, ETH_RECIPIENT], { account: userWallet.account });
      assert.equal(await helper.read.lastSwapLamports(), 3_000_000n);
    });

    it("setMessageRents rejects a zero rent (a zero would silently restore the drain)", async function () {
      await assert.rejects(
        bridge.write.setMessageRents([0n, 2_600_000n], { account: ownerWallet.account }),
        /ZeroRent/,
      );
    });
  });
});
