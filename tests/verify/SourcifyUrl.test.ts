// The verifier follows the network: Rubicon is on verify.mainnet, every testnet on
// verify.testnet, and scripts/verify-deployments.sh must resolve the same URL the
// hardhat config does. A regression here sends a mainnet verify to a Sourcify that
// answers "Chain 7531 not found".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;
const MAINNET = "https://verify.mainnet.romeprotocol.xyz";
const TESTNET = "https://verify.testnet.romeprotocol.xyz";

function resolved(network: string): string {
  const out = execFileSync(`${ROOT}scripts/verify-deployments.sh`, [network, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, SOURCIFY_API_URL: "" },
  });
  const m = out.match(/→ (\S+)/);
  assert.ok(m, `no verifier in output: ${out}`);
  return m[1];
}

describe("sourcify verifier per network", () => {
  it("rubicon resolves to verify.mainnet", () => {
    assert.equal(resolved("rubicon"), MAINNET);
  });

  it("hadrian and the other testnets resolve to verify.testnet", () => {
    for (const n of ["hadrian", "martius", "nerva"]) assert.equal(resolved(n), TESTNET);
  });

  it("sourcify-urls.json keeps testnet as the default and only rubicon on mainnet", () => {
    const m = JSON.parse(readFileSync(`${ROOT}sourcify-urls.json`, "utf8"));
    assert.equal(m.default, TESTNET);
    assert.deepEqual(m.networks, { rubicon: MAINNET });
  });
});
