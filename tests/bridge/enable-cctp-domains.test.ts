import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeFunctionData, toFunctionSelector } from "viem";
import hardhat from "hardhat";
import {
  CCTP_ADMIN_ABI, KIND_EVM, KIND_RAW32, REMOTE_TOKEN_MESSENGER_DISCRIMINATOR, canSend, checkCircleRecord,
  domainsFromRegistry, encodeDisable, encodeEnable, parseDomainSpec, planDomainChanges,
} from "../../scripts/bridge/lib/cctp-domain-plan.js";
import { resolveRoles } from "../../scripts/bridge/lib/deploy-roles.js";
import { SOLANA_PROGRAM_IDS } from "../../scripts/bridge/constants.js";
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

describe("canSend: when the script may send", () => {
  const OWNER = "0x00000000000000000000000000000000000000aa";
  const OTHER = "0x00000000000000000000000000000000000000bb";
  const base = { knownNetwork: true, declaredMainnet: false, chainId: 200010, wantSend: true, signer: OWNER, owner: OWNER };

  it("sends on a known testnet, with --send, as the owner (address case does not matter)", () => {
    assert.deepEqual(canSend(base), { send: true, reason: "ok" });
    assert.equal(canSend({ ...base, signer: OWNER.toUpperCase().replace("0X", "0x") }).send, true);
  });
  it("never sends without --send", () => {
    assert.equal(canSend({ ...base, wantSend: false }).send, false);
  });
  it("never sends on Rubicon, under any name, because the chain id decides", () => {
    // The table says mainnet:
    assert.equal(canSend({ ...base, declaredMainnet: true, chainId: 7531 }).send, false);
    // A made-up network name (so nothing is declared) pointing at Rubicon's RPC:
    assert.equal(canSend({ ...base, knownNetwork: false, declaredMainnet: false, chainId: 7531 }).send, false);
    // Even a name the table thinks is a testnet, if the RPC says 7531:
    assert.match(canSend({ ...base, chainId: 7531 }).reason, /mainnet/);
  });
  it("refuses --send on a network the script does not know", () => {
    const d = canSend({ ...base, knownNetwork: false });
    assert.equal(d.send, false);
    assert.match(d.reason, /not one this script knows/);
  });
  it("does not send without a key, or with a key that is not the owner", () => {
    assert.equal(canSend({ ...base, signer: undefined }).send, false);
    const d = canSend({ ...base, signer: OTHER });
    assert.equal(d.send, false);
    assert.match(d.reason, /not the owner/);
  });
});

describe("domainsFromRegistry", () => {
  const e = (cctpDomain: number, extra: object = {}) => ({ name: `chain${cctpDomain}`, cctpDomain, ...extra });
  it("takes live and preparing entries, no status meaning live, and leaves out other statuses and entries without a domain", () => {
    const got = domainsFromRegistry({
      sourceEvms: [e(0), e(6, { status: "preparing" }), e(1, { status: "live" }), e(3, { status: "retired" }), { name: "no-cctp" }],
    });
    assert.deepEqual(got, [
      { domain: 0, kind: KIND_EVM }, { domain: 6, kind: KIND_EVM }, { domain: 1, kind: KIND_EVM },
    ]);
  });
  it("reads cctpRecipientKind raw32 for a non-EVM chain", () => {
    assert.deepEqual(domainsFromRegistry({ sourceEvms: [e(8, { cctpRecipientKind: "RAW32" })] }), [{ domain: 8, kind: KIND_RAW32 }]);
  });
  it("reads the older single sourceEvm shape", () => {
    assert.deepEqual(domainsFromRegistry({ sourceEvm: { chainId: 1, cctpDomain: 0 } }), [{ domain: 0, kind: KIND_EVM }]);
  });
  it("refuses Solana's domain, a duplicate, a bad domain, a bad kind, and an empty result", () => {
    assert.throws(() => domainsFromRegistry({ sourceEvms: [e(5)] }), /Solana/);
    assert.throws(() => domainsFromRegistry({ sourceEvms: [e(6), e(6)] }), /twice/);
    assert.throws(() => domainsFromRegistry({ sourceEvms: [e(-1)] }), /bad cctpDomain/);
    assert.throws(() => domainsFromRegistry({ sourceEvms: [{ name: "x", cctpDomain: "6" }] }), /bad cctpDomain/);
    assert.throws(() => domainsFromRegistry({ sourceEvms: [e(6, { cctpRecipientKind: "sui" })] }), /bad cctpRecipientKind/);
    assert.throws(() => domainsFromRegistry({ sourceEvms: [e(6, { status: "retired" })] }), /no CCTP destination/);
    assert.throws(() => domainsFromRegistry({}), /no CCTP destination/);
  });
  it("feeds the planner: a preparing entry is a wanted domain, so its enable call is printed", () => {
    const wanted = domainsFromRegistry({ sourceEvms: [e(0), e(6, { status: "preparing" })] });
    const plan = planDomainChanges(wanted, [{ domain: 0, kind: KIND_EVM }]);
    assert.deepEqual(plan.calls.map((c) => `${c.fn}:${c.domain}`), ["enableCctpDomain:6"]);
  });
});

describe("checkCircleRecord (--check re-reads Circle's account)", () => {
  const TMM = SOLANA_PROGRAM_IDS.CCTP_V2_TOKEN_MESSENGER;
  const record = (domain: number, messengerHex: string, disc = REMOTE_TOKEN_MESSENGER_DISCRIMINATOR) => {
    const d = new Uint8Array(8 + 4 + 32 + 8);
    d.set(Buffer.from(disc, "hex"), 0);
    new DataView(d.buffer).setUint32(8, domain, true);
    d.set(Buffer.from(messengerHex.padStart(64, "0"), "hex"), 12);
    return { owner: TMM, data: d };
  };
  const evm = "ab".repeat(20);
  const sui = "cd".repeat(32);

  it("passes a good EVM record and a RAW32 record", () => {
    assert.equal(checkCircleRecord(6, KIND_EVM, record(6, evm), TMM), null);
    assert.equal(checkCircleRecord(8, KIND_RAW32, record(8, sui), TMM), null);
  });
  it("flags a messenger that stopped being EVM-shaped on an EVM-kind domain, but not on RAW32", () => {
    assert.match(checkCircleRecord(6, KIND_EVM, record(6, sui), TMM)!, /no longer EVM-shaped/);
    assert.equal(checkCircleRecord(6, KIND_RAW32, record(6, sui), TMM), null);
  });
  it("flags a missing account, a wrong owner, a wrong discriminator, a domain mismatch and a short account", () => {
    assert.match(checkCircleRecord(6, KIND_EVM, null, TMM)!, /no RemoteTokenMessenger account/);
    assert.match(checkCircleRecord(6, KIND_EVM, { ...record(6, evm), owner: "11111111111111111111111111111111" }, TMM)!, /owned by/);
    assert.match(checkCircleRecord(6, KIND_EVM, record(6, evm, "0000000000000000"), TMM)!, /discriminator/);
    assert.match(checkCircleRecord(6, KIND_EVM, record(7, evm), TMM)!, /records domain 7/);
    assert.match(checkCircleRecord(6, KIND_EVM, { owner: TMM, data: new Uint8Array(10) }, TMM)!, /too short/);
  });
  it("agrees with the contract's discriminator constant", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/bridge/RomeBridgeWithdraw.sol"), "utf8");
    assert.ok(src.toLowerCase().includes(`0x${REMOTE_TOKEN_MESSENGER_DISCRIMINATOR}`));
  });
});

describe("resolveRoles (deploy.ts owner and guardian rules)", () => {
  const DEPLOYER = "0x00000000000000000000000000000000000000d0";
  const LEDGER = "0x00000000000000000000000000000000000001ed";
  const OPS = "0x00000000000000000000000000000000000000c5";
  const HOT = "0x00000000000000000000000000000000000000fa";
  const mainnet = { network: "rubicon", isMainnet: true, deployer: DEPLOYER };

  it("mainnet needs BRIDGE_OWNER itself: a leftover WORMHOLE_ADMIN does not stand in", () => {
    assert.throws(() => resolveRoles({ ...mainnet, wormholeAdmin: HOT, bridgeGuardian: OPS }), /BRIDGE_OWNER is required/);
  });
  it("mainnet needs BRIDGE_GUARDIAN", () => {
    assert.throws(() => resolveRoles({ ...mainnet, bridgeOwner: LEDGER }), /BRIDGE_GUARDIAN is required/);
  });
  it("mainnet: the owner is BRIDGE_OWNER even if WORMHOLE_ADMIN is set", () => {
    assert.deepEqual(resolveRoles({ ...mainnet, bridgeOwner: LEDGER, wormholeAdmin: HOT, bridgeGuardian: OPS }), { owner: LEDGER, guardian: OPS });
  });
  it("mainnet: the owner may not be the deploy key, and the guardian may not be the owner", () => {
    assert.throws(() => resolveRoles({ ...mainnet, bridgeOwner: DEPLOYER, bridgeGuardian: OPS }), /must not be the deploy key/);
    assert.throws(() => resolveRoles({ ...mainnet, bridgeOwner: LEDGER, bridgeGuardian: LEDGER.toUpperCase().replace("0X", "0x") }), /guardian must differ/);
  });
  it("testnet: falls back to WORMHOLE_ADMIN, then the deployer, with no guardian", () => {
    const t = { network: "hadrian", isMainnet: false, deployer: DEPLOYER };
    assert.deepEqual(resolveRoles({ ...t, wormholeAdmin: HOT }), { owner: HOT, guardian: "0x0000000000000000000000000000000000000000" });
    assert.deepEqual(resolveRoles(t).owner, DEPLOYER);
    assert.deepEqual(resolveRoles({ ...t, bridgeOwner: LEDGER, bridgeGuardian: OPS }), { owner: LEDGER, guardian: OPS });
    assert.throws(() => resolveRoles({ ...t, bridgeGuardian: DEPLOYER }), /guardian must differ/);
  });
});

describe("enable-cctp-domains.ts (source checks that remain)", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/bridge/enable-cctp-domains.ts"),
    "utf8",
  );
  it("has exactly one send site, and it is after the canSend decision", () => {
    assert.equal(src.split("sendTransaction(").length - 1, 1, "exactly one send site");
    assert.ok(src.indexOf("canSend(") > 0 && src.indexOf("canSend(") < src.indexOf("wallet.sendTransaction("));
    assert.doesNotMatch(src, /if \(mainnet\)/, "the old name-based mainnet flag must be gone");
  });
  it("never prints the key", () => {
    assert.doesNotMatch(src, /console\.(log|error)\([^)]*\bkey\b/);
  });
  it("identifies itself with the project contact, on the chain and the Solana requests", () => {
    assert.match(src, /Rome Protocol rome@romeprotocol\.com/);
    assert.match(src, /"user-agent": USER_AGENT/);
  });
});
