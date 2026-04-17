/**
 * event-pda.integration.ts — Hardhat integration tests for RomeEvents + ring PDA.
 *
 * ALL tests in this file require RUN_EVENT_PDA_INTEGRATION=1 because fireTransfer
 * calls the EventLog precompile at 0xFF...09, which does not exist in the stock
 * Hardhat EDR simulator and will revert. The tests are skipped automatically when
 * the env var is absent — `npx hardhat test` passes without a local Rome stack.
 *
 * To run the full suite against a local Rome stack:
 *   RUN_EVENT_PDA_INTEGRATION=1 \
 *   SOLANA_RPC_URL=http://localhost:8899 \
 *   ROME_EVM_PROGRAM_ID=<base58> \
 *   ROME_CHAIN_ID=1001 \
 *   npx hardhat test tests/event-pda.integration.ts --network local
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { keccak256 } from "viem";
import { getSolanaEnv, getSolanaConnection } from "./helpers/solana.js";
import { deriveEventRingPda, parseRingHeader, parseEntry } from "./helpers/eventRing.js";

const INTEGRATION = process.env["RUN_EVENT_PDA_INTEGRATION"] === "1";

describe("RomeEvents", () => {
  /**
   * Test 1: emits a native LOG.
   *
   * Skipped when RUN_EVENT_PDA_INTEGRATION=1 is not set because fireTransfer
   * calls the EventLog precompile which reverts on stock Hardhat EDR.
   */
  it(
    "emits a native Transfer LOG (integration — RUN_EVENT_PDA_INTEGRATION=1 required)",
    { skip: !INTEGRATION ? "requires RUN_EVENT_PDA_INTEGRATION=1 and local Rome stack" : false },
    async () => {
      const { viem } = await hardhat.network.connect();
      // Local Rome chain only provides one signer (LOCAL_PRIVATE_KEY).
      // Use a stable dummy address as the transfer recipient.
      const recipientAddr = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

      // Local Rome chain rejects very low gas prices; force 1 gwei.
      const gasPrice = 1_000_000_000n;
      const emitter = await viem.deployContract("EventEmitter", [], { gasPrice });

      const txHash = await emitter.write.fireTransfer(
        [recipientAddr, 12345n],
        { gasPrice },
      );

      const publicClient = await viem.getPublicClient();
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      const transferSig = keccak256(
        new TextEncoder().encode("Transfer(address,address,uint256)"),
      ) as `0x${string}`;

      const transferLogs = (rcpt.logs ?? []).filter(
        (l) => l.topics[0] === transferSig,
      );

      assert.ok(
        transferLogs.length > 0,
        `expected at least one Transfer LOG, got ${transferLogs.length}`,
      );
    },
  );

  /**
   * Test 2: ring PDA check.
   *
   * Deploys EventEmitter, calls fireTransfer, then fetches the Solana ring PDA
   * and asserts the first entry matches the Transfer event.
   */
  it(
    "writes to the ring PDA [integration — RUN_EVENT_PDA_INTEGRATION=1 required]",
    { skip: !INTEGRATION ? "requires RUN_EVENT_PDA_INTEGRATION=1 and local Rome stack" : false },
    async () => {
      const env = await getSolanaEnv();
      // Should not reach here if INTEGRATION=false, but guard anyway.
      if (!env) return;

      const { viem } = await hardhat.network.connect();
      // Local Rome chain only provides one signer (LOCAL_PRIVATE_KEY).
      // Use a stable dummy address as the transfer recipient.
      const recipientAddr = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

      // Local Rome chain rejects very low gas prices; force 1 gwei.
      const gasPrice = 1_000_000_000n;
      const emitter = await viem.deployContract("EventEmitter", [], { gasPrice });
      const contractAddr = emitter.address;

      const txHash = await emitter.write.fireTransfer(
        [recipientAddr, 12345n],
        { gasPrice },
      );
      const publicClient = await viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Derive the ring PDA for the deployed contract address.
      const { pubkey } = await deriveEventRingPda(
        env.programId,
        env.chainId,
        contractAddr,
      );

      const conn = await getSolanaConnection(env);
      // @ts-ignore — @solana/web3.js is an integration-only dep; not in package.json by design
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { PublicKey } = (await import("@solana/web3.js")) as any;
      const info = await conn.getAccountInfo(new PublicKey(pubkey), "confirmed");

      assert.ok(info !== null, `ring PDA ${pubkey} must exist after first emit`);

      const accountData = new Uint8Array(info.data);
      const hdr = parseRingHeader(accountData);
      assert.ok(hdr !== null, "ring header must parse");
      assert.equal(hdr!.count, 1n, "ring must contain exactly 1 entry after one emit");
      assert.equal(hdr!.head, 1, "ring head must advance to 1");

      const entry = parseEntry(accountData, hdr!, 0);
      assert.ok(entry !== null, "entry at index 0 must parse");

      // topic[0] must equal keccak256("Transfer(address,address,uint256)")
      const expectedTopic0 = keccak256(
        new TextEncoder().encode("Transfer(address,address,uint256)"),
      ) as `0x${string}`;
      const actualTopic0 = "0x" + Buffer.from(entry!.topics[0]).toString("hex");
      assert.equal(actualTopic0, expectedTopic0, "topic[0] must be Transfer event signature");

      // topic[1] = msg.sender (deployer), topic[2] = recipient — 3 topics total
      assert.equal(entry!.topics.length, 3, "must have 3 topics: sig + 2 indexed");

      // data must ABI-decode to 12345n (uint256 is big-endian 32 bytes).
      const word = entry!.data;
      let decodedValue = 0n;
      for (let i = 0; i < 32 && i < word.length; i++) {
        decodedValue = (decodedValue << 8n) | BigInt(word[i]);
      }
      assert.equal(decodedValue, 12345n, "ABI-encoded value must decode to 12345");
    },
  );
});
