import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeFunctionData, toFunctionSelector } from "viem";
import hardhat from "hardhat";
import {
  CCTP_ADMIN_ABI, KIND_EVM, KIND_RAW32, encodeDisable, encodeEnable, parseDomainSpec, planDomainChanges,
} from "../../scripts/bridge/lib/cctp-domain-plan.js";
import { deriveRemoteTokenMessenger } from "../../scripts/bridge/derive/cctp-accounts.js";

/**
 * scripts/bridge/enable-cctp-domains.ts: the pure parts. The script itself talks
 * to a chain; what it decides and what it prints is tested here.
 */

describe("parseDomainSpec", () => {
  it("a bare number is an EVM destination; :raw32 marks a non-EVM one", () => {
    assert.deepEqual(parseDomainSpec("0,1,6:evm,8:RAW32"), [
      { domain: 0, kind: KIND_EVM }, { domain: 1, kind: KIND_EVM },
      { domain: 6, kind: KIND_EVM }, { domain: 8, kind: KIND_RAW32 },
    ]);
  });
  it("tolerates spaces and a trailing comma", () => {
    assert.deepEqual(parseDomainSpec(" 3 , 7 ,"), [{ domain: 3, kind: KIND_EVM }, { domain: 7, kind: KIND_EVM }]);
  });
  it("refuses an empty list, duplicates, non-numbers, a bad kind and a value over uint32", () => {
    assert.throws(() => parseDomainSpec(""), /empty/);
    assert.throws(() => parseDomainSpec(" , "), /empty/);
    assert.throws(() => parseDomainSpec("1,1"), /twice/);
    assert.throws(() => parseDomainSpec("a"), /not a whole number/);
    assert.throws(() => parseDomainSpec("-1"), /not a whole number/);
    assert.throws(() => parseDomainSpec("1.5"), /not a whole number/);
    assert.throws(() => parseDomainSpec("6:sui"), /bad recipient kind/);
    assert.throws(() => parseDomainSpec("6:evm:x"), /bad domain entry/);
    assert.throws(() => parseDomainSpec("4294967296"), /uint32/);
  });
  it("refuses domain 5 (Solana) up front, as the contract does", () => {
    assert.throws(() => parseDomainSpec("0,5"), /Solana/);
  });
});

describe("planDomainChanges", () => {
  const evm = (domain: number) => ({ domain, kind: KIND_EVM as 1 });
  const raw = (domain: number) => ({ domain, kind: KIND_RAW32 as 2 });

  it("is empty when the chain already matches, whatever the order", () => {
    const plan = planDomainChanges([evm(6), evm(0)], [evm(0), evm(6)]);
    assert.equal(plan.calls.length, 0);
    assert.deepEqual(plan.unchanged.map((e) => e.domain).sort(), [0, 6]);
  });

  it("enables what is wanted and missing: the 7th domain is one call", () => {
    const six = [0, 1, 3, 6, 7, 15].map(evm);
    const plan = planDomainChanges([...six, evm(16)], six);
    assert.equal(plan.calls.length, 1);
    assert.equal(plan.calls[0].fn, "enableCctpDomain");
    assert.equal(plan.calls[0].domain, 16);
    assert.equal(plan.calls[0].reason, "missing on chain");
    assert.equal(plan.calls[0].data, encodeEnable(16, KIND_EVM));
  });

  it("disables what is on chain and no longer wanted, after the enables", () => {
    const plan = planDomainChanges([evm(0), evm(9)], [evm(0), evm(3), evm(1)]);
    assert.deepEqual(plan.calls.map((c) => `${c.fn}:${c.domain}`), [
      "enableCctpDomain:9", "disableCctpDomain:1", "disableCctpDomain:3",
    ]);
    assert.equal(plan.calls[1].data, encodeDisable(1));
  });

  it("re-enables a domain whose recipient kind differs", () => {
    const plan = planDomainChanges([raw(8)], [evm(8)]);
    assert.equal(plan.calls.length, 1);
    assert.equal(plan.calls[0].reason, "kind differs");
    assert.equal(plan.calls[0].data, encodeEnable(8, KIND_RAW32));
  });

  it("an empty chain gets every wanted domain, sorted", () => {
    const plan = planDomainChanges([evm(15), evm(0), evm(3)], []);
    assert.deepEqual(plan.calls.map((c) => c.domain), [0, 3, 15]);
  });
});

describe("calldata matches the compiled contract", () => {
  it("every ABI fragment the script uses has the same selector as the contract's", async () => {
    const hre: any = hardhat;
    const artifact = await hre.artifacts.readArtifact("RomeBridgeWithdraw");
    const real = new Map<string, string>(
      artifact.abi.filter((e: any) => e.type === "function").map((e: any) => [
        `${e.name}(${e.inputs.map((i: any) => i.type).join(",")})`,
        toFunctionSelector(`${e.name}(${e.inputs.map((i: any) => i.type).join(",")})`),
      ]),
    );
    for (const item of CCTP_ADMIN_ABI) {
      if (item.type !== "function") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      assert.ok(real.has(sig), `the contract has no ${sig}`);
    }
  });

  it("encoded calls decode with the contract's own ABI", async () => {
    const hre: any = hardhat;
    const artifact = await hre.artifacts.readArtifact("RomeBridgeWithdraw");
    const en = decodeFunctionData({ abi: artifact.abi, data: encodeEnable(6, KIND_EVM) });
    assert.equal(en.functionName, "enableCctpDomain");
    assert.deepEqual(en.args, [6, 1]);
    const dis = decodeFunctionData({ abi: artifact.abi, data: encodeDisable(6) });
    assert.equal(dis.functionName, "disableCctpDomain");
    assert.deepEqual(dis.args, [6]);
  });
});

describe("Circle's RemoteTokenMessenger PDA, as the script prints it", () => {
  // Read live from Solana mainnet (CCTP V2 TokenMessengerMinter) when the v13
  // design was checked; the contract derives the same seeds on chain.
  const live: Record<number, string> = {
    0: "3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9",
    1: "4b57QJUqvibhT5CoxwfNikZDd3xoYhUgknNNbJXtCtWh",
    3: "53NSDvEXmUixWSsCQF5rnTxcKdihq19WXNaZFXrX3ojf",
    6: "BwmDYtQ7jFj8ddaTmKa7fz9hyuK9n58mvc8G7DYNcKjM",
    7: "7d7hdxsH6YaDmh8iGMBF59yDDY5JfWB5soMaatfKgrWu",
    8: "2i8X8yeW6nwc8sM5TspYpeBrkQLDm16prZRxXgKuGf6w",
    15: "7MvQa5MrhMkWETGQSC4kG5Vi4nKLMphtfNxAcZsUYJMB",
    30: "4f4vuxrMTfMt7N3pRLHUSWmho1ZLQ9UEnaRGAe9WHAL4",
  };
  for (const [domain, expected] of Object.entries(live)) {
    it(`domain ${domain} -> ${expected}`, () => {
      assert.equal(deriveRemoteTokenMessenger(Number(domain)).toBase58(), expected);
    });
  }
});

describe("enable-cctp-domains.ts safety rails (source is ground truth)", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/bridge/enable-cctp-domains.ts"),
    "utf8",
  );
  it("only sends with an explicit --send, after the mainnet stop, and only as the owner", () => {
    const send = src.indexOf("wallet.sendTransaction(");
    assert.ok(send > 0);
    for (const needle of ["flag(\"send\")", "if (mainnet)", "is not the owner", "_PRIVATE_KEY"]) {
      const at = src.indexOf(needle);
      assert.ok(at > 0 && at < send, `${needle} must come before the send`);
    }
    assert.equal(src.split("sendTransaction(").length - 1, 1, "exactly one send site");
  });
  it("lists Rubicon as mainnet and never prints the key", () => {
    assert.match(src, /rubicon:\s*\{[^}]*mainnet:\s*true/);
    assert.doesNotMatch(src, /console\.(log|error)\([^)]*\bkey\b/);
  });
  it("identifies itself with the project contact", () => {
    assert.match(src, /Rome Protocol rome@romeprotocol\.com/);
  });
});
