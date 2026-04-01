import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";

export type PoolDeployment = {
    pubkey: string;
    address: string;
    txHash: string;
    blockNumber: string;
};

export type FactoryDeployment = {
    address?: string;
};

export type AssociatedSplTokenDeployment = {
    address?: string;
    cpiContractAddress?: string;
    systemProgramId?: string;
    tokenProgramId?: string;
    associatedTokenProgramId?: string;
};

export type DeploymentsFile = {
    MeteoraDAMMv1Factory?: FactoryDeployment;
    MeteoraDAMMv1Pools?: PoolDeployment[];
    AssociatedSplToken?: AssociatedSplTokenDeployment;
};

export function deploymentsFilePath(networkName: string): string {
    return path.resolve(process.cwd(), "deployments", `${networkName}.json`);
}

export function readDeployments(networkName: string): DeploymentsFile {
    const filePath = deploymentsFilePath(networkName);
    if (!fs.existsSync(filePath)) {
        return {};
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8")) as DeploymentsFile;
}

export function writeDeployments(networkName: string, data: DeploymentsFile): void {
    const dirPath = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(dirPath, { recursive: true });

    fs.writeFileSync(
        deploymentsFilePath(networkName),
        JSON.stringify(data, null, 2) + "\n",
        "utf8",
    );
}

export function readFactoryAddressFromDeployments(networkName: string): `0x${string}` | null {
    const parsed = readDeployments(networkName);
    const address = parsed.MeteoraDAMMv1Factory?.address;

    if (!address) {
        return null;
    }

    if (!isAddress(address)) {
        throw new Error(
            `Invalid MeteoraDAMMv1Factory.address in deployments/${networkName}.json: ${address}`,
        );
    }

    return getAddress(address);
}

export function resolveFactoryAddress(networkName: string): `0x${string}` {
    const envAddress = process.env.FACTORY_ADDRESS;
    if (envAddress) {
        if (!isAddress(envAddress)) {
            throw new Error(`Invalid FACTORY_ADDRESS: ${envAddress}`);
        }
        return getAddress(envAddress);
    }

    const fromFile = readFactoryAddressFromDeployments(networkName);
    if (fromFile) {
        return fromFile;
    }

    throw new Error(
        `Factory address not found. Set FACTORY_ADDRESS env var or create deployments/${networkName}.json`,
    );
}

export function saveFactoryDeployment(networkName: string, address: string): void {
    const deployments = readDeployments(networkName);

    deployments.MeteoraDAMMv1Factory = {
        address,
    };

    writeDeployments(networkName, deployments);
}

export function savePoolDeployment(args: {
    networkName: string;
    pubkey: string;
    address: `0x${string}`;
    txHash: `0x${string}`;
    blockNumber: bigint;
}): void {
    const deployments = readDeployments(args.networkName);

    const pools = deployments.MeteoraDAMMv1Pools ?? [];

    const alreadyExists = pools.some(
        (pool) =>
            pool.pubkey.toLowerCase() === args.pubkey.toLowerCase() ||
            pool.address.toLowerCase() === args.address.toLowerCase(),
    );

    if (!alreadyExists) {
        pools.push({
            pubkey: args.pubkey,
            address: args.address,
            txHash: args.txHash,
            blockNumber: args.blockNumber.toString(),
        });
    } else {
        for (const pool of pools) {
            if (
                pool.pubkey.toLowerCase() === args.pubkey.toLowerCase() ||
                pool.address.toLowerCase() === args.address.toLowerCase()
            ) {
                pool.pubkey = args.pubkey;
                pool.address = args.address;
                pool.txHash = args.txHash;
                pool.blockNumber = args.blockNumber.toString();
            }
        }
    }

    deployments.MeteoraDAMMv1Pools = pools;
    writeDeployments(args.networkName, deployments);
}

export function saveAssociatedSplTokenDeployment(args: {
    networkName: string;
    address: `0x${string}`;
    cpiContractAddress: `0x${string}`;
    systemProgramId: `0x${string}`;
    tokenProgramId: `0x${string}`;
    associatedTokenProgramId: `0x${string}`;
}): void {
    const deployments = readDeployments(args.networkName);

    deployments.AssociatedSplToken = {
        address: args.address,
        cpiContractAddress: args.cpiContractAddress,
        systemProgramId: args.systemProgramId,
        tokenProgramId: args.tokenProgramId,
        associatedTokenProgramId: args.associatedTokenProgramId,
    };

    writeDeployments(args.networkName, deployments);
}
