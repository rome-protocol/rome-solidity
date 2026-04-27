import { base58 } from "@scure/base";
import { toHex } from "viem";

export function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export function base58ToBytes32Hex(value: string, name: string): `0x${string}` {
    const decoded = base58.decode(value);
    if (decoded.length !== 32) {
        throw new Error(`Invalid ${name}: expected 32-byte base58 public key, received ${value}`);
    }

    return toHex(decoded) as `0x${string}`;
}
