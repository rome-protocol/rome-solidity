// Step 2 of CCTP inbound demo: poll Circle IRIS sandbox for the attestation
// corresponding to the message burned in step 1. On Sepolia → Solana devnet,
// typical wait is ~13-19 minutes (Sepolia soft-finality).
//
// Reads .secrets/last-deposit.json, writes .secrets/last-attestation.json.

import fs from "node:fs";

const main = async () => {
  const dep = JSON.parse(fs.readFileSync(".secrets/last-deposit.json", "utf8"));
  console.log("Polling attestation for messageHash:", dep.messageHash);

  const url = `https://iris-api-sandbox.circle.com/attestations/${dep.messageHash}`;
  const start = Date.now();
  while (true) {
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.json();
      if (body.status === "complete" && body.attestation) {
        console.log(`\n✓ Attestation complete after ${Math.round((Date.now() - start) / 1000)}s`);
        const out = { ...dep, attestation: body.attestation };
        fs.writeFileSync(".secrets/last-attestation.json", JSON.stringify(out, null, 2));
        console.log("Saved .secrets/last-attestation.json");
        console.log("Next: node scripts/bridge/inbound/03-submit-receive.mjs");
        return;
      }
      process.stdout.write(`\r[${Math.round((Date.now() - start) / 1000)}s] status=${body.status ?? "pending"}  `);
    } else if (res.status === 404) {
      process.stdout.write(`\r[${Math.round((Date.now() - start) / 1000)}s] 404 (not yet indexed)  `);
    } else {
      process.stdout.write(`\r[${Math.round((Date.now() - start) / 1000)}s] HTTP ${res.status}  `);
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
