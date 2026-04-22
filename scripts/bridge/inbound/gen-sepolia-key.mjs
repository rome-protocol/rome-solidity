// Generates a fresh Sepolia signer key for the CCTP inbound demo.
// Writes the key to .secrets/sepolia-key.txt (chmod 600, gitignored).
// Prints only the address — private key never surfaces in the console.
import { Wallet } from "ethers";
import fs from "node:fs";
import path from "node:path";

const w = Wallet.createRandom();
const secretsDir = path.resolve(".secrets");
fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
const keyPath = path.join(secretsDir, "sepolia-key.txt");
fs.writeFileSync(keyPath, w.privateKey, { mode: 0o600 });
fs.writeFileSync(path.join(secretsDir, "sepolia-address.txt"), w.address);
console.log("Generated Sepolia signer");
console.log("  Address: ", w.address);
console.log("  Key path:", keyPath, "(gitignored, chmod 600)");
