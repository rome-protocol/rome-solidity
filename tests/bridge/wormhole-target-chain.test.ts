/**
 * Wormhole destination chain for a Rome network is a function of the Solana
 * cluster it settles on — never a second hand-maintained list.
 *
 * Every Rome chain on Solana DEVNET bridges to Sepolia (Wormhole chain 10002);
 * a chain on mainnet-beta bridges to Ethereum (2). The old inline list in
 * deploy.ts named marcus/local/trajan/hadrian and silently sent Martius and
 * Nerva to chain 2 (live `wormholeTargetChain()` read 2 on both, 2026-09-21).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SOLANA_DEVNET_NETWORKS,
  WORMHOLE_CHAIN_ETHEREUM,
  WORMHOLE_CHAIN_SEPOLIA,
  wormholeTargetChainFor,
} from "../../scripts/bridge/lib/wormhole-target-chain.js";

describe("wormholeTargetChainFor", () => {
  it("every Solana-devnet Rome network targets Sepolia (10002)", () => {
    for (const n of SOLANA_DEVNET_NETWORKS) {
      assert.equal(wormholeTargetChainFor(n), WORMHOLE_CHAIN_SEPOLIA, n);
    }
  });

  it("martius and nerva are devnet networks and therefore target Sepolia", () => {
    assert.equal(wormholeTargetChainFor("martius"), 10002);
    assert.equal(wormholeTargetChainFor("nerva"), 10002);
  });

  it("rubicon (mainnet-beta) targets Ethereum (2)", () => {
    assert.equal(wormholeTargetChainFor("rubicon"), WORMHOLE_CHAIN_ETHEREUM);
    assert.equal(WORMHOLE_CHAIN_ETHEREUM, 2);
  });

  it("deploy.ts derives targetChain from the shared resolver — no inline network list remains", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/bridge/deploy.ts"),
      "utf8",
    );
    assert.match(src, /wormholeTargetChainFor\(networkName\)/);
    assert.doesNotMatch(src, /\["marcus", "local", "trajan", "hadrian"\]/);
    assert.doesNotMatch(src, /const SOLANA_DEVNET_NETWORKS = new Set/);
  });
});
