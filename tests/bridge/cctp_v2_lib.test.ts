import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import bs58 from "bs58";

/**
 * CCTPV2Lib unit tests — network-independent (hardhat simulated EVM).
 *
 * Ground truth is a LANDED Solana-devnet CCTP v2 deposit_for_burn
 * (tx 4L4D7Qo7DNFfdGXY4AhYYiFfbdhxwSZruteaxVTUaSkXBpVrNBoyTmU47mZSuo6YUwNUWQNqneks9QWcyzNbLoPY,
 * inner ix on CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe): the encode test
 * asserts byte-for-byte against that tx's instruction data, and the account
 * test against its account ordering — not against offsets we derived.
 */

// The landed instruction data (base58, 96 bytes decoded).
const LANDED_IX_DATA_B58 =
  "2H9Ja8XuEQY8ycNjJZ4xK1QjEjiR9QzTodq9C2WbB282pgdjxpiiMi7cj1BimHrQfdeUw2ywFgkZhNxFKZV4Xs8WMPu6KFRuUrCVoaFMikqntxjXrPZkNWGsp3Tr9ZbazEE3";
// Its decoded fields (verified 2026-07-04): amount=9002533, destDomain=0,
// mintRecipient=EVM 0x6fb09783940b0e9a313531bd5c7e81810a70f919 (left-padded),
// destCaller=0, maxFee=0, minFinality=2000.
const LANDED = {
  amount: 9002533n,
  destDomain: 0,
  mintRecipient:
    "0x0000000000000000000000006fb09783940b0e9a313531bd5c7e81810a70f919",
  destCaller: "0x" + "00".repeat(32),
  maxFee: 0n,
  minFinality: 2000,
};

const b58ToHex = (s: string) => ("0x" + Buffer.from(bs58.decode(s)).toString("hex")) as `0x${string}`;

// Landed outer account list for the same instruction, in order.
const LANDED_ACCOUNTS = [
  "HMHYnCqtHDztNDfSX2EXi4aU1sqX2b4iRdBF3ZBUShmX", // 0 owner (signer, writable)
  "HMHYnCqtHDztNDfSX2EXi4aU1sqX2b4iRdBF3ZBUShmX", // 1 event_rent_payer (signer, writable)
  "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE", // 2 sender_authority_pda
  "4KMJDFRjjfn1tdLtAEsYMMM43EAQyTHodvzBk6JaXBtS", // 3 burn_token_account (writable)
  "8HSsasTtHT3zwjmwU8HcnFhgPm8KoLA4UmF98RLo1wQv", // 4 denylist_account (v2-only, per-owner PDA)
  "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU",  // 5 message_transmitter (writable)
  "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W", // 6 token_messenger
  "3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9", // 7 remote_token_messenger (PER destination domain)
  "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux", // 8 token_minter (writable)
  "7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU", // 9 local_token (writable)
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // 10 burn_token_mint (writable)
  "Gx45kV7rcvCYXaFqmUwVca2aaxFcZat3TuMn4fGmrbgp", // 11 message_sent_event_data (signer, writable)
  "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", // 12 message_transmitter_program
  "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", // 13 token_messenger_minter_program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // 14 token_program
  "11111111111111111111111111111111",             // 15 system_program
  "6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd", // 16 event_authority (TMM __event_authority)
  "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", // 17 program
];
// 18 (trailing, NOT in the landed native tx): MessageTransmitter v2's
// __event_authority — the Rome-emulator ix_store workaround inherited from
// v1 (see CCTPLib struct comment). Harmless on-chain (trailing accounts
// ignored by Anchor), required for Mollusk inner-CPI account resolution.
const MT_V2_EVENT_AUTHORITY = "2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV";

const pk = (b58: string) => ("0x" + Buffer.from(bs58.decode(b58)).toString("hex")) as `0x${string}`;

describe("CCTPV2Lib", function () {
  let harness: any;

  before(async function () {
    const { viem } = await hardhat.network.connect();
    harness = await viem.deployContract("CCTPV2LibHarness", []);
  });

  it("encodeDepositForBurn reproduces the landed devnet v2 instruction byte-for-byte", async function () {
    const out = await harness.read.encode([
      LANDED.amount,
      LANDED.destDomain,
      LANDED.mintRecipient,
      LANDED.destCaller,
      LANDED.maxFee,
      LANDED.minFinality,
    ]);
    assert.equal(out.toLowerCase(), b58ToHex(LANDED_IX_DATA_B58).toLowerCase());
  });

  it("buildDepositForBurnAccounts reproduces the landed ordering + the emulator trailing meta", async function () {
    const a = {
      owner: pk(LANDED_ACCOUNTS[0]),
      eventRentPayer: pk(LANDED_ACCOUNTS[1]),
      senderAuthorityPda: pk(LANDED_ACCOUNTS[2]),
      burnTokenAccount: pk(LANDED_ACCOUNTS[3]),
      denylistAccount: pk(LANDED_ACCOUNTS[4]),
      messageTransmitter: pk(LANDED_ACCOUNTS[5]),
      tokenMessenger: pk(LANDED_ACCOUNTS[6]),
      remoteTokenMessenger: pk(LANDED_ACCOUNTS[7]),
      tokenMinter: pk(LANDED_ACCOUNTS[8]),
      localToken: pk(LANDED_ACCOUNTS[9]),
      burnTokenMint: pk(LANDED_ACCOUNTS[10]),
      messageSentEventData: pk(LANDED_ACCOUNTS[11]),
      messageTransmitterProgram: pk(LANDED_ACCOUNTS[12]),
      tokenMessengerMinterProgram: pk(LANDED_ACCOUNTS[13]),
      tokenProgram: pk(LANDED_ACCOUNTS[14]),
      systemProgram: pk(LANDED_ACCOUNTS[15]),
      eventAuthority: pk(LANDED_ACCOUNTS[16]),
      program: pk(LANDED_ACCOUNTS[17]),
      messageTransmitterEventAuthority: pk(MT_V2_EVENT_AUTHORITY),
    };
    const metas = await harness.read.build([a]);
    assert.equal(metas.length, 19);
    for (let i = 0; i < 18; i++) {
      assert.equal(
        metas[i].pubkey.toLowerCase(),
        pk(LANDED_ACCOUNTS[i]).toLowerCase(),
        `account[${i}] mismatch`,
      );
    }
    assert.equal(metas[18].pubkey.toLowerCase(), pk(MT_V2_EVENT_AUTHORITY).toLowerCase());
    // Flag spot-checks: signers are owner, event_rent_payer, message_sent_event_data.
    const signers = metas.map((m: any, i: number) => (m.is_signer ? i : -1)).filter((i: number) => i >= 0);
    assert.deepEqual(signers, [0, 1, 11]);
    // denylist is read-only; message_transmitter config is writable (v2 keeps v1's flag).
    assert.equal(metas[4].is_writable, false);
    assert.equal(metas[5].is_writable, true);
  });
});
