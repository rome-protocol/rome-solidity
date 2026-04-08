import hardhat from "hardhat";
import { keccak256, encodePacked, getAddress } from "viem";
import fs from "node:fs";
import path from "node:path";

/**
 * Derive the EVM msg.sender for DoEvmCallback from a Solana program ID.
 * Formula: keccak256(program_id_bytes ++ "callback_authority")[12..]
 *
 * @param programIdBase58 - The Meta-Hook Router program ID (base58)
 * @returns The derived EVM address (checksummed)
 */
function deriveCallbackSender(programIdBytes: Uint8Array): `0x${string}` {
    const hash = keccak256(
        encodePacked(
            ["bytes", "bytes"],
            [
                `0x${Buffer.from(programIdBytes).toString("hex")}`,
                `0x${Buffer.from("callback_authority").toString("hex")}`,
            ],
        ),
    );
    // Take last 20 bytes (bytes 12..32 of the 32-byte hash)
    return getAddress(`0x${hash.slice(26)}`);
}

async function main() {
    // Router address can be provided directly or derived from program ID.
    // If ROUTER_ADDRESS is set, use it directly. Otherwise derive from
    // META_HOOK_PROGRAM_ID using the callback_authority derivation.
    let routerAddress: `0x${string}`;
    const metaHookProgramIdBase58 =
        process.env.META_HOOK_PROGRAM_ID || "MetaHk1111111111111111111111111111111111111";

    if (process.env.ROUTER_ADDRESS) {
        routerAddress = getAddress(process.env.ROUTER_ADDRESS);
        console.log("Using provided router address:", routerAddress);
    } else {
        // Minimal base58 decoder (no external dependency)
        const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        function decodeBase58(str: string): Uint8Array {
            const bytes: number[] = [0];
            for (const char of str) {
                const value = BASE58_ALPHABET.indexOf(char);
                if (value < 0) throw new Error(`Invalid base58 character: ${char}`);
                for (let j = 0; j < bytes.length; j++) {
                    bytes[j] = bytes[j] * 58 + value;
                    if (bytes[j] > 255) {
                        if (j + 1 >= bytes.length) bytes.push(0);
                        bytes[j + 1] += (bytes[j] >> 8);
                        bytes[j] &= 0xff;
                    }
                }
            }
            // Handle leading 1s
            let leadingZeros = 0;
            for (const char of str) {
                if (char === "1") leadingZeros++;
                else break;
            }
            const result = new Uint8Array(leadingZeros + bytes.length);
            for (let i = 0; i < bytes.length; i++) {
                result[leadingZeros + bytes.length - 1 - i] = bytes[i];
            }
            return result;
        }

        const programIdBytes = decodeBase58(metaHookProgramIdBase58);
        routerAddress = deriveCallbackSender(programIdBytes);
        console.log("Meta-Hook Router program ID:", metaHookProgramIdBase58);
        console.log("Derived router EVM address (msg.sender):", routerAddress);
    }

    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();

    console.log("Deploying KYCHook with account:", deployer.account.address);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    const kycHook = await viem.deployContract("KYCHook", [routerAddress]);
    console.log("KYCHook deployed to:", kycHook.address);

    // Verify router address
    const storedRouter = await publicClient.readContract({
        address: kycHook.address,
        abi: kycHook.abi,
        functionName: "router",
    });
    console.log("Stored router address:", storedRouter);

    // Save deployment
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    existing.KYCHook = {
        address: kycHook.address,
        routerAddress,
        metaHookProgramId: metaHookProgramIdBase58,
    };

    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log("Saved deployment to:", filePath);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
