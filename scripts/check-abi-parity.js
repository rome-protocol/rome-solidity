#!/usr/bin/env node
/**
 * ABI parity gate — a discovery interface must not lie about its implementation.
 *
 * Two directions, because inheritance only enforces one:
 *   SUBSET   every interface member exists in the implementation.
 *            (Solidity's `is IFoo` already gives this.)
 *   COVERAGE every externally callable state-mutating function in the
 *            implementation appears in the interface.
 *            (Nothing in the language enforces this — it is why
 *            IRomeBridgeWithdraw shipped missing three live egress rails.)
 *
 * Reads compiled artifacts only. No RPC, no chain, no transaction.
 * Run after `hardhat compile`:  node scripts/check-abi-parity.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// interface -> implementation. Add a pair when a new discovery interface lands.
const PAIRS = [{ iface: 'IRomeBridgeWithdraw', impl: 'RomeBridgeWithdraw' }];

// Views excluded from COVERAGE by the admission rule: per-chain config
// addresses are registry data, not call surface. State-mutating functions are
// never exemptible — that is the whole point of the gate.
const ARTIFACTS = path.join(__dirname, '..', 'artifacts', 'contracts');

function findArtifact(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findArtifact(p, name);
      if (hit) return hit;
    } else if (entry.name === `${name}.json`) {
      return p;
    }
  }
  return null;
}

function abiOf(name) {
  const file = findArtifact(ARTIFACTS, name);
  if (!file) {
    console.error(`FATAL: no compiled artifact for ${name}. Run \`npx hardhat compile\` first.`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).abi;
}

const sig = (e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
const members = (abi, type, filter = () => true) =>
  new Set(abi.filter((e) => e.type === type && filter(e)).map(sig));
const mutating = (e) => !['view', 'pure'].includes(e.stateMutability);

let failures = 0;

for (const { iface, impl } of PAIRS) {
  const ifaceAbi = abiOf(iface);
  const implAbi = abiOf(impl);
  console.log(`\n${iface} vs ${impl}`);

  for (const type of ['function', 'event', 'error']) {
    const orphaned = [...members(ifaceAbi, type)].filter((m) => !members(implAbi, type).has(m));
    if (orphaned.length) {
      failures++;
      console.log(`  SUBSET FAIL [${type}] — declared in ${iface}, absent from ${impl}:`);
      orphaned.forEach((m) => console.log(`     + ${m}`));
    }
  }

  const uncovered = [...members(implAbi, 'function', mutating)].filter(
    (m) => !members(ifaceAbi, 'function').has(m),
  );
  if (uncovered.length) {
    failures++;
    console.log(`  COVERAGE FAIL — state-mutating in ${impl}, absent from ${iface}:`);
    uncovered.forEach((m) => console.log(`     - ${m}`));
    console.log(`  Add them to ${iface}, or narrow the admission rule in its header and say why.`);
  }

  if (!failures) console.log('  ok — subset and coverage both hold');
}

if (failures) {
  console.log(`\nABI parity FAILED (${failures} check group(s)).`);
  process.exit(1);
}
console.log('\nABI parity passed.');
