import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isHardhatOrNodeEntry(importMetaUrl: string): boolean {
    const thisFile = resolve(fileURLToPath(importMetaUrl));
    const runIdx = process.argv.indexOf("run");
    if (runIdx !== -1) {
        const script = process.argv[runIdx + 1];
        if (script && !script.startsWith("-")) {
            return resolve(script) === thisFile;
        }
    }
    const a1 = process.argv[1];
    if (a1 && !a1.includes("hardhat")) {
        return resolve(a1) === thisFile;
    }
    return false;
}

export function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
