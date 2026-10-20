// scripts/bridge/enable-cctp-domains.ts
//
// Brings the LIVE RomeBridgeWithdraw (13.0.0+) CCTP destination list in line
// with a wanted list, WITHOUT a redeploy. It reads the contract's own
// cctpDomains() / cctpRecipientKind() and diffs them against --domains, in both
// directions, then:
//
//   - PRINTS, for every needed call, the target address and the exact calldata
//     of enableCctpDomain / disableCctpDomain, plus a dry run of each call from
//     the owner's address. Someone signs that calldata (the cold Ledger on
//     Rubicon). This is the default, and the ONLY mode for Rubicon.
//   - SENDS the calls only when ALL of these hold: --send is given, the network
//     is a testnet (never Rubicon / chain 7531), a signer key for the network is
//     in the environment, and that signer IS the contract's owner(). Otherwise it
//     falls back to printing.
//
// The key is read from <NETWORK>_PRIVATE_KEY (e.g. HADRIAN_PRIVATE_KEY) and is
// never printed; only the signer's address is.
//
//   npx tsx scripts/bridge/enable-cctp-domains.ts --network hadrian \
//       --domains 0,1,3,6,7,15                 # print what would change
//   npx tsx scripts/bridge/enable-cctp-domains.ts --network hadrian \
//       --domains 0,1,3,6,7,15,16 --send       # testnet only, owner key in env
//   npx tsx scripts/bridge/enable-cctp-domains.ts --network rubicon \
//       --domains 0,6 --check                  # exit 1 if chain differs (drift check)
//
// Domain list syntax: "0,1,6" (EVM recipients) or "0,6,8:raw32" (a non-EVM chain).
// Other flags: --address 0x... (override the bridge address from
// deployments/<network>.json), --rpc <url> (override the RPC).

import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { deriveRemoteTokenMessenger } from "./derive/cctp-accounts.js";
import {
  CCTP_ADMIN_ABI, KIND_EVM, KIND_NAME, KIND_RAW32, parseDomainSpec, planDomainChanges,
  type DomainEntry, type PlannedCall, type RecipientKind,
} from "./lib/cctp-domain-plan.js";

/** The project contact goes into every outside request. */
const USER_AGENT = "Rome Protocol rome@romeprotocol.com";

interface NetworkInfo { chainId: number; rpc: string; mainnet: boolean }
const NETWORKS: Record<string, NetworkInfo> = {
  hadrian: { chainId: 200010, rpc: "https://hadrian.testnet.romeprotocol.xyz/", mainnet: false },
  rubicon: { chainId: 7531, rpc: "https://rubicon.mainnet.romeprotocol.xyz/", mainnet: true },
};

function arg(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function describe(c: PlannedCall): string {
  return c.fn === "enableCctpDomain"
    ? `enableCctpDomain(${c.domain}, ${c.kind} /* ${KIND_NAME[c.kind!]} */)`
    : `disableCctpDomain(${c.domain})`;
}

async function main() {
  const network = arg("network") ?? fail("--network is required (hadrian or rubicon)");
  const spec = arg("domains") ?? fail("--domains is required, e.g. --domains 0,1,3,6,7,15");
  const info = NETWORKS[network];
  const rpc = arg("rpc") ?? info?.rpc ?? fail(`unknown network "${network}": pass --rpc`);
  const mainnet = info?.mainnet ?? false;
  const wantSend = flag("send");
  const wanted = (() => { try { return parseDomainSpec(spec); } catch (e) { return fail((e as Error).message); } })();

  let bridgeRaw = arg("address");
  if (!bridgeRaw) {
    const d = readDeployments(network) as Record<string, { address?: string }>;
    bridgeRaw = d["RomeBridgeWithdraw"]?.address;
  }
  if (!bridgeRaw || !isAddress(bridgeRaw)) fail(`no RomeBridgeWithdraw address for ${network}: pass --address 0x...`);
  const bridge = getAddress(bridgeRaw) as Address;

  const chain = defineChain({
    id: info?.chainId ?? 0,
    name: network,
    nativeCurrency: { name: "gas", symbol: "gas", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const transport = http(rpc, { fetchOptions: { headers: { "User-Agent": USER_AGENT } } });
  const pub = createPublicClient({ chain, transport });

  // ── Read the chain ───────────────────────────────────────────────────────
  const chainId = await pub.getChainId();
  if (info && chainId !== info.chainId) fail(`RPC reports chain ${chainId}, expected ${info.chainId} for ${network}`);
  const read = <F extends "owner" | "guardian" | "VERSION" | "cctpDomains">(fn: F) =>
    pub.readContract({ address: bridge, abi: CCTP_ADMIN_ABI, functionName: fn });
  const version = await read("VERSION").catch(() => undefined);
  if (version === undefined) fail(`${bridge} has no VERSION(): it is not a 13.x RomeBridgeWithdraw`);
  const owner = getAddress((await read("owner")) as Address);
  const guardian = getAddress((await read("guardian")) as Address);
  const domainIds = ((await read("cctpDomains")) as readonly number[]).map(Number);
  const onChain: DomainEntry[] = [];
  for (const d of domainIds) {
    const kind = Number(await pub.readContract({ address: bridge, abi: CCTP_ADMIN_ABI, functionName: "cctpRecipientKind", args: [d] }));
    onChain.push({ domain: d, kind: kind as RecipientKind });
  }

  console.log(`network   ${network} (chain ${chainId})`);
  console.log(`bridge    ${bridge}  version ${version}`);
  console.log(`owner     ${owner}`);
  console.log(`guardian  ${guardian}`);
  console.log(`on chain  ${onChain.length ? onChain.map((e) => `${e.domain}:${KIND_NAME[e.kind]}`).sort().join(", ") : "(none)"}`);
  console.log(`wanted    ${wanted.map((e) => `${e.domain}:${KIND_NAME[e.kind]}`).join(", ")}`);

  const plan = planDomainChanges(wanted, onChain);
  if (plan.calls.length === 0) {
    console.log("\nIn sync: nothing to do.");
    return;
  }

  // ── Print every call ─────────────────────────────────────────────────────
  console.log(`\n${plan.calls.length} call(s) needed. Each is sent by the OWNER (${owner}) to ${bridge}.`);
  for (const [i, c] of plan.calls.entries()) {
    console.log(`\n[${i + 1}] ${describe(c)}   (${c.reason})`);
    console.log(`    to:   ${bridge}`);
    console.log(`    data: ${c.data}`);
    if (c.fn === "enableCctpDomain") {
      const pda = deriveRemoteTokenMessenger(c.domain);
      console.log(`    the contract will derive Circle's account ${pda.toBase58()} (${base58ToBytes32(pda.toBase58())})`);
    }
    // Dry run as the owner. On Rome this proves the call decodes and passes the
    // contract's checks in eth_call; it does not prove the account read inside a
    // mined transaction, which has to be seen on the first real call.
    try {
      await pub.call({ account: owner, to: bridge, data: c.data });
      console.log("    dry run as owner: ok");
    } catch (e) {
      const m = (e as Error).message.split("\n")[0];
      console.log(`    dry run as owner: REVERTS (${m})`);
    }
  }

  // ── Send, or stop at printing ────────────────────────────────────────────
  if (flag("check")) {
    console.log("\nDrift: the chain differs from --domains.");
    process.exit(1);
  }
  if (!wantSend) {
    console.log("\nNothing sent (print mode). Sign the calldata above with the owner key.");
    return;
  }
  if (mainnet) {
    console.log("\nNothing sent: Rubicon is print-only. Sign the calldata above with the cold Ledger.");
    return;
  }
  const keyVar = `${network.toUpperCase()}_PRIVATE_KEY`;
  const key = (process.env[keyVar] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.log(`\nNothing sent: ${keyVar} is not set in the environment. Print mode only.`);
    return;
  }
  const account = privateKeyToAccount(key as Hex);
  if (getAddress(account.address) !== owner) {
    console.log(`\nNothing sent: the signer ${account.address} is not the owner ${owner}. Print mode only.`);
    return;
  }
  const wallet = createWalletClient({ account, chain, transport });
  console.log(`\nSending ${plan.calls.length} call(s) as the owner ${account.address} on ${network} (testnet).`);
  for (const [i, c] of plan.calls.entries()) {
    const hash = await wallet.sendTransaction({ to: bridge, data: c.data, account, chain });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`[${i + 1}] ${describe(c)} -> ${hash} (${receipt.status})`);
    if (receipt.status !== "success") fail(`call ${i + 1} reverted: stopping`);
  }
  const after = ((await read("cctpDomains")) as readonly number[]).map(Number).sort((a, b) => a - b);
  console.log(`on chain now: ${after.join(", ") || "(none)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
