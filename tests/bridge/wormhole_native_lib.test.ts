import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * WormholeTokenBridgeLib — transfer_native (v11) unit tests.
 * Network-independent (hardhat simulated EVM), mirroring cctp_v2_lib.test.ts.
 *
 * Ground truth is the Wormhole SDK IDL
 * (@wormhole-foundation/sdk-solana-tokenbridge tokenBridgeType.transferNative) —
 * the same authoritative source the deploy-side PDAs derive from. Its account
 * order (idx 0-14) is byte-identical to the on-chain-PROVEN transfer_wrapped
 * builder in this repo, which validates "IDL order == on-chain positional order".
 *
 * transfer_native differs from transfer_wrapped in three ways this test pins:
 *   1. tag byte 0x05 (TransferNative=5) vs 0x04 (TransferWrapped=4); payload
 *      otherwise identical.
 *   2. NO from_owner account (delegate-authorized via authority_signer).
 *   3. custody (idx4, per-mint) + custody_signer (idx6, global) replace
 *      wrapped_meta; trailing programs are tokenProgram(15), wormholeProgram(16)
 *      (native IDL order — the REVERSE of the wrapped builder's tail).
 *
 * idx17 token_bridge_program is the Rome-emulator #266 workaround (not in the
 * IDL; harmless trailing account, required for Mollusk inner-CPI resolution),
 * mirroring buildTransferWrappedAccounts.
 */

const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
const TAG_NATIVE = 0x05;
const TAG_WRAPPED = 0x04;

// Distinct named pubkeys so any ordering mistake is caught.
const A = {
  payer: PK(1),
  config: PK(2),
  from: PK(3),
  mint: PK(4),
  custody: PK(5),
  authority_signer: PK(6),
  custody_signer: PK(7),
  bridge_config: PK(8),
  message: PK(9),
  emitter: PK(10),
  sequence: PK(11),
  fee_collector: PK(12),
  clock: PK(13),
  rent: PK(14),
  system: PK(15),
  token: PK(16),
  wormhole_core: PK(17),
  token_bridge_program: PK(18),
};

// Canonical native layout: [name, is_signer, is_writable] per the SDK IDL
// (transferNative) + the #266 trailing account.
const EXPECTED: ReadonlyArray<readonly [keyof typeof A, boolean, boolean]> = [
  ["payer", true, true],
  ["config", false, false],
  ["from", false, true],
  ["mint", false, true],
  ["custody", false, true],
  ["authority_signer", false, false],
  ["custody_signer", false, false],
  ["bridge_config", false, true],
  ["message", true, true],
  ["emitter", false, false],
  ["sequence", false, true],
  ["fee_collector", false, true],
  ["clock", false, false],
  ["rent", false, false],
  ["system", false, false],
  ["token", false, false],
  ["wormhole_core", false, false],
  ["token_bridge_program", false, false],
];

describe("WormholeTokenBridgeLib — transfer_native", function () {
  let h: any;

  before(async function () {
    const { viem } = await hardhat.network.connect();
    h = await viem.deployContract("WormholeLibHarness", []);
  });

  it("encodeTransferNative emits tag 0x05 + [nonce4|amount8|fee8|target32|chain2] little-endian", async function () {
    const nonce = 0x11223344;
    const amount = 123456789n;
    const fee = 7n;
    const chain = 10002;
    const target = ("0x" + "ab".repeat(32)) as `0x${string}`;

    const out: string = await h.read.encodeNative([nonce, amount, fee, target, chain]);
    const b = Buffer.from(out.slice(2), "hex");

    assert.equal(b.length, 1 + 4 + 8 + 8 + 32 + 2, "encoded length");
    assert.equal(b[0], TAG_NATIVE, "tag byte");
    assert.equal(b.readUInt32LE(1), nonce, "nonce u32 LE");
    assert.equal(b.readBigUInt64LE(5), amount, "amount u64 LE");
    assert.equal(b.readBigUInt64LE(13), fee, "fee u64 LE");
    assert.equal("0x" + b.subarray(21, 53).toString("hex"), target, "targetAddress 32B");
    assert.equal(b.readUInt16LE(53), chain, "targetChain u16 LE");
  });

  it("encodeTransferNative == encodeTransferTokens with only the tag flipped 0x04->0x05", async function () {
    const args = [0xdeadbeef, 42n, 0n, ("0x" + "cd".repeat(32)) as `0x${string}`, 2] as const;
    const nat = Buffer.from(((await h.read.encodeNative(args)) as string).slice(2), "hex");
    const wrp = Buffer.from(((await h.read.encodeWrapped(args)) as string).slice(2), "hex");
    assert.equal(nat[0], TAG_NATIVE, "native tag");
    assert.equal(wrp[0], TAG_WRAPPED, "wrapped tag");
    assert.deepEqual(nat.subarray(1), wrp.subarray(1), "payload after tag is identical");
  });

  it("buildTransferNativeAccounts produces the canonical 18-meta native layout (order + flags)", async function () {
    const metas = await h.read.buildNative([A]);
    assert.equal(metas.length, EXPECTED.length, "meta count (17 IDL + #266 trailing)");

    for (let i = 0; i < EXPECTED.length; i++) {
      const [name, isSigner, isWritable] = EXPECTED[i];
      assert.equal(metas[i].pubkey.toLowerCase(), A[name].toLowerCase(), `account[${i}] pubkey (${name})`);
      assert.equal(metas[i].is_signer, isSigner, `account[${i}] is_signer (${name})`);
      assert.equal(metas[i].is_writable, isWritable, `account[${i}] is_writable (${name})`);
    }

    // Crux: custody per-mint (idx4, writable), custody_signer global (idx6, ro),
    // and there is NO from_owner (native is delegate-authorized).
    assert.equal(metas[4].pubkey.toLowerCase(), A.custody.toLowerCase(), "custody at idx4");
    assert.equal(metas[4].is_writable, true, "custody writable");
    assert.equal(metas[6].pubkey.toLowerCase(), A.custody_signer.toLowerCase(), "custody_signer at idx6");
    const signerIdxs = metas
      .map((m: any, i: number) => (m.is_signer ? i : -1))
      .filter((i: number) => i >= 0);
    assert.deepEqual(signerIdxs, [0, 8], "only payer + message sign (no from_owner)");
  });
});
