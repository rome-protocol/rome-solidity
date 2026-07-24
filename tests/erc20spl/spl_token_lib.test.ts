import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import hardhat from "hardhat";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * SplTokenLib.parseMint boundary — executed with REAL mint bytes.
 *
 * Fixtures are captured devnet accounts:
 *  - usdc_legacy_mint.bin : 82-byte legacy SPL mint (the classic layout)
 *  - pyusd_mint.bin       : 869-byte Token-2022 PYUSD mint (8 extensions)
 *
 * The base 82-byte field layout is identical across both token programs, so
 * a Token-2022 mint parses with the same reader once the length gate admits
 * it: exactly 82 (legacy / extensionless) or >= 166 (base + 165-padding +
 * account-type byte + TLV). 83..165 can never be a mint — 165 is a TOKEN
 * ACCOUNT length; rejecting the range is the anti-confusion boundary.
 */

const hex = (p: string): `0x${string}` =>
  `0x${readFileSync(p).toString("hex")}` as `0x${string}`;

const PYUSD = hex(join(__dirname, "../fixtures/pyusd_mint.bin"));
const LEGACY = hex(join(__dirname, "../fixtures/usdc_legacy_mint.bin"));
const TOKEN = `0x${"11".repeat(32)}` as `0x${string}`;

// Token program ids as bytes32 (base58-decoded).
const TOKENKEG =
  "0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9" as const;
const TOKENZ22 =
  "0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc" as const;

let harness: any;

before(async () => {
  const { viem } = await hardhat.network.connect();
  harness = await viem.deployContract("SplTokenLibHarness");
});

describe("SplTokenLib.parseMint length boundary", () => {
  it("parses the 82-byte legacy mint (unchanged fast path)", async () => {
    const [decimals, initialized] = await harness.read.parseMint([LEGACY, TOKEN]);
    assert.equal(decimals, 6);
    assert.equal(initialized, true);
  });

  it("parses the real 869-byte Token-2022 PYUSD mint", async () => {
    const [decimals, initialized] = await harness.read.parseMint([PYUSD, TOKEN]);
    assert.equal(decimals, 6);
    assert.equal(initialized, true);
  });

  it("rejects lengths between 83 and 165 (a 165-byte token ACCOUNT is not a mint)", async () => {
    for (const len of [83, 100, 165]) {
      const data = `0x${"00".repeat(len)}` as `0x${string}`;
      await assert.rejects(
        harness.read.parseMint([data, TOKEN]),
        /InvalidMintDataLength/
      );
    }
  });

  it("rejects short garbage", async () => {
    await assert.rejects(
      harness.read.parseMint([`0x${"00".repeat(10)}`, TOKEN]),
      /InvalidMintDataLength/
    );
  });
});

describe("SplTokenLib.check_mint_owner", () => {
  it("accepts both token programs", async () => {
    await harness.read.checkMintOwner([TOKENKEG, TOKEN]);
    await harness.read.checkMintOwner([TOKENZ22, TOKEN]);
  });

  it("rejects a non-token-program owner (the previously discarded field)", async () => {
    const random = `0x${"22".repeat(32)}` as `0x${string}`;
    await assert.rejects(
      harness.read.checkMintOwner([random, TOKEN]),
      /InvalidMintOwner/
    );
  });
});
