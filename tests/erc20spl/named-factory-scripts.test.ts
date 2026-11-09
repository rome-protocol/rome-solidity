import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import hardhat, { network } from "hardhat";
import { encodeAbiParameters, keccak256, zeroAddress, type Hex } from "viem";
import {
    DirectWrapperDeployRetiredError,
    NoLiveNamedFactoryError,
    NotLiveNamedFactoryError,
    assertDirectWrapperDeployAllowed,
    resolveLiveNamedFactory,
} from "../../scripts/lib/wrapper-factory";
import { planEntry, previewOutcome, recordKey } from "../../scripts/bridge/lib/bootstrap-plan";
import { registerOnNamedFactory } from "../../scripts/erc20spl/lib/register-named";
import {
    assertListAllowed,
    buildDeploy,
    gateSend,
    grandfatherHash,
    parseGrandfatherList,
    planDeploy,
} from "../../scripts/erc20spl/lib/named-factory-deploy";
import { base58ToBytes32 } from "../../scripts/lib/pubkey";
import { MINT_FOR_SCRIPTS, plantMetaplex } from "./naming-script-helpers";
import { mockPda, vectors } from "./naming-helpers";

const root = fileURLToPath(new URL("../../", import.meta.url));
const src = (p: string) => readFileSync(join(root, p), "utf8");

const NAMED = "0x00000000000000000000000000000000000000c9" as const;
const LEGACY = "0x00000000000000000000000000000000000000a0" as const;

// This repository's callers make wrappers through the named factory's metadata path, and its direct wrapper deploys
// (and a second legacy factory) stop where the named factory is live.
describe("the live named factory record", () => {
    it("a chain with no live named factory has none to resolve", () => {
        assert.throws(() => resolveLiveNamedFactory("x", {}), NoLiveNamedFactoryError);
        assert.throws(() => resolveLiveNamedFactory("x", { ERC20SPLFactory: { address: LEGACY } }), NoLiveNamedFactoryError);
        // deployed but not yet recorded live
        assert.throws(
            () => resolveLiveNamedFactory("x", { ERC20SPLNamedFactory: { address: NAMED, live: false } } as any),
            NoLiveNamedFactoryError,
        );
    });

    it("a live record resolves; a different requested factory, a deprecated legacy one among them, is refused", () => {
        const dep = {
            ERC20SPLFactory: { address: LEGACY, deprecated: true },
            ERC20SPLNamedFactory: { address: NAMED, live: true },
        } as any;
        assert.equal(resolveLiveNamedFactory("x", dep).toLowerCase(), NAMED);
        assert.equal(resolveLiveNamedFactory("x", dep, NAMED).toLowerCase(), NAMED);
        assert.throws(() => resolveLiveNamedFactory("x", dep, LEGACY), NotLiveNamedFactoryError);
        assert.throws(() => resolveLiveNamedFactory("x", dep, "0x00000000000000000000000000000000000000f1"), NotLiveNamedFactoryError);
    });

    it("direct wrapper deploys and a second legacy factory stop on a chain where the named factory is live", () => {
        assert.doesNotThrow(() => assertDirectWrapperDeployAllowed("x", "deploy a wrapper", {}));
        assert.doesNotThrow(() =>
            assertDirectWrapperDeployAllowed("x", "deploy a wrapper", { ERC20SPLNamedFactory: { address: NAMED, live: false } } as any),
        );
        assert.throws(
            () => assertDirectWrapperDeployAllowed("x", "deploy a wrapper", { ERC20SPLNamedFactory: { address: NAMED, live: true } } as any),
            DirectWrapperDeployRetiredError,
        );
    });
});

describe("each retired script exits before any send on a chain where the named factory is live", () => {
    const retired = [
        "scripts/bridge/deploy-weth-v9.ts",
        "scripts/bridge/deploy-wsol-v9.ts",
        "scripts/erc20spl/deploy_cached.ts",
        "scripts/fb2d-smoke.ts",
        "scripts/bench-spl-erc20-rewrite.ts",
        "scripts/deploy_erc20spl_factory.ts",
        "scripts/deploy-ledger.ts",
    ];
    const sends = /deployContract\(|\.write\.|writeContract\(|deployer\.deploy\(|sendTransaction\(|deployer\.send/;
    for (const p of retired) {
        it(`${p} calls the guard before its first send`, () => {
            // comments are not sends: only code counts
            const text = src(p)
                .split("\n")
                .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
                .join("\n");
            const guard = text.indexOf("assertDirectWrapperDeployAllowed(");
            assert.ok(guard >= 0, "calls assertDirectWrapperDeployAllowed");
            // the import line also names it; the call is the one with an opening parenthesis after the import
            const calls = [...text.matchAll(/assertDirectWrapperDeployAllowed\(/g)].map((m) => m.index!);
            const firstSend = text.search(sends);
            assert.ok(firstSend < 0 || calls[0] < firstSend, "the guard comes before the first send");
        });
    }
});

describe("the callers use the metadata path of the live named factory", () => {
    for (const p of [
        "scripts/bridge/bootstrap-bridged-wrappers.ts",
        "scripts/token2022/smoke-hooked-wrapper-hadrian.ts",
        "scripts/erc20spl/lib/register-named.ts",
    ]) {
        it(`${p} resolves the live named factory and calls add_spl_token_with_metadata`, () => {
            const text = src(p);
            if (!p.endsWith("register-named.ts")) assert.match(text, /resolveLiveNamedFactory\(/);
            assert.match(text, /add_spl_token_with_metadata/);
            assert.doesNotMatch(text, /add_spl_token_no_metadata/);
        });
    }

    it("the bench resolves the live factory, reads the factory's own ABI, and registers through the shared helper", () => {
        const text = src("scripts/erc20spl/bench_cached_vs_cpi_wrapper.ts");
        assert.match(text, /resolveLiveNamedFactory\(/);
        assert.match(text, /registerOnNamedFactory\(/);
        assert.match(text, /readArtifact\("ERC20SPLNamedFactory"\)/, "the artifact ABI carries the error items");
    });

    it("no script encodes add_spl_token_no_metadata, which no factory but a legacy one has", () => {
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(join(root, dir))) {
                const rel = `${dir}/${e}`;
                if (statSync(join(root, rel)).isDirectory()) walk(rel);
                else if (/\.(ts|mts|js|mjs|cjs|sh)$/.test(e) && src(rel).includes("add_spl_token_no_metadata")) hits.push(rel);
            }
        };
        walk("scripts");
        assert.deepEqual(hits, []);
    });
});

describe("the bootstrap's names are the named factory's", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const { f, store } = await MINT_FOR_SCRIPTS(conn);

    it("an unregistered mint is registered under the strings preview gives, never a name from a table", async () => {
        await plantMetaplex(store, "Wrapped SOL", "SOL");
        const out = await previewOutcome(() => f.read.preview([MINT_FOR_SCRIPTS.mint]));
        assert.deepEqual(out, { kind: "ok", name: "Wrapped SOL (Rome)", symbol: "roSOL" });
        assert.deepEqual(planEntry(zeroAddress, out), { kind: "register", name: "Wrapped SOL (Rome)", symbol: "roSOL" });
    });

    it("a mint the named factory refuses is skipped with its reason, not registered, and does not stop the run", async () => {
        await plantMetaplex(store, "NO_NAME", "SOL");
        const out = await previewOutcome(() => f.read.preview([MINT_FOR_SCRIPTS.mint]));
        assert.deepEqual(out, { kind: "refused", error: "BadName" });
        const act = planEntry(zeroAddress, out);
        assert.equal(act.kind, "skip");
    });

    it("a registered mint is recorded as it is, and an unknown failure is not read as a refusal", async () => {
        const w = "0x00000000000000000000000000000000000000c1" as const;
        assert.deepEqual(planEntry(w, { kind: "refused", error: "AlreadyRegistered" }), { kind: "existing", wrapper: w });
        await assert.rejects(previewOutcome(() => Promise.reject(new Error("rpc down"))));
        void viem;
    });
});

describe("the named factory deploy command", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const MINT_A = "11111111111111111111111111111112"; // base58 of 0x00..01
    const list = parseGrandfatherList([
        { network: 74, mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", wrapper: "0x00000000000000000000000000000000000000a1" },
        { network: 74, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", wrapper: "0x00000000000000000000000000000000000000a2" },
    ]);

    it("reads a grandfather list of base58 mints and EVM wrappers, and refuses a malformed one", () => {
        assert.equal(list[0].mint, base58ToBytes32("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"));
        assert.throws(() => parseGrandfatherList([{ network: 74, mint: "not-base58!", wrapper: zeroAddress }]));
        assert.throws(() => parseGrandfatherList([{ network: 74, mint: MINT_A, wrapper: "0x1234" }]));
        assert.throws(() => parseGrandfatherList({} as any));
        assert.throws(() => parseGrandfatherList([list[0], list[0]].map((e) => ({ ...e, mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }))));
    });

    it("its hash is the factory's, from the same preimage as other tools that take the list", async () => {
        const store = await viem.deployContract("AccountStoreMock");
        const f = await viem.deployContract("ERC20SPLNamedFactory", [store.address, list]);
        const want = keccak256(
            encodeAbiParameters([{ type: "tuple[]", components: [{ type: "uint32" }, { type: "bytes32" }, { type: "address" }] }], [
                list.map((e) => [e.network, e.mint, e.wrapper] as const),
            ]),
        );
        assert.equal(grandfatherHash(list), want);
        assert.equal(await f.read.grandfatherHash(), want);
    });

    it("prints the decoded constructor call and the hash, and does nothing else without --send", async () => {
        const plan = planDeploy({ cpiProgram: "0xff00000000000000000000000000000000000008", list });
        assert.ok(plan.lines.join("\n").includes(grandfatherHash(list)));
        assert.equal(plan.args.length, 2);
        const artifact = await hardhat.artifacts.readArtifact("ERC20SPLNamedFactory");
        const built = buildDeploy({ abi: artifact.abi as any, bytecode: artifact.bytecode as Hex, args: plan.args });
        const text = built.lines.join("\n");
        // decoded back from the encoded data, not echoed from the inputs
        assert.match(text, /0xff00000000000000000000000000000000000008/i);
        assert.ok(text.includes(built.digest), "the digest of the deploy data is printed");
        assert.ok(text.includes(grandfatherHash(list)));
        for (const e of list) assert.ok(text.includes(e.mint) && text.toLowerCase().includes(e.wrapper.toLowerCase()));
        assert.ok(built.data.startsWith(artifact.bytecode as string), "the data is the bytecode and the encoded arguments");
        assert.equal(built.digest, keccak256(built.data));
    });

    it("--send needs the deployer's current nonce, stated by the caller", () => {
        const h = grandfatherHash(list);
        const g = { grandfatherHash: h, expectGrandfatherHash: h };
        assert.throws(() => gateSend({ send: true, expectNonce: undefined, nonce: 7, ...g }), /--expect-nonce/);
        assert.throws(() => gateSend({ send: true, expectNonce: 6, nonce: 7, ...g }), /nonce/);
        assert.doesNotThrow(() => gateSend({ send: true, expectNonce: 7, nonce: 7, ...g }));
        // a dry run never needs one, and never sends
        assert.equal(gateSend({ send: false, expectNonce: undefined, nonce: 7 }), "dry-run");
        assert.equal(gateSend({ send: true, expectNonce: 7, nonce: 7, ...g }), "send");
    });

    it("--send needs the grandfather hash the caller expects, and it must be the list's", () => {
        const h = grandfatherHash(list);
        const base = { send: true, expectNonce: 7, nonce: 7, grandfatherHash: h };
        assert.throws(() => gateSend(base), /--expect-grandfather-hash/);
        assert.throws(() => gateSend({ ...base, expectGrandfatherHash: grandfatherHash([]) }), /grandfather gate/);
        assert.equal(gateSend({ ...base, expectGrandfatherHash: h.toUpperCase().replace("0X", "0x") }), "send");
    });

    it("--no-grandfather is refused on a mainnet chain and allowed elsewhere", () => {
        assert.throws(() => assertListAllowed({ noGrandfather: true, mainnet: true }), /--no-grandfather/);
        assert.doesNotThrow(() => assertListAllowed({ noGrandfather: true, mainnet: false }));
        assert.doesNotThrow(() => assertListAllowed({ noGrandfather: false, mainnet: true }));
    });

    it("a send on a mainnet chain also needs its own acknowledgement", () => {
        const h = grandfatherHash(list);
        const base = { send: true, expectNonce: 3, nonce: 3, mainnet: true, grandfatherHash: h, expectGrandfatherHash: h };
        assert.throws(() => gateSend(base), /i-understand-mainnet/);
        assert.equal(gateSend({ ...base, acknowledgeMainnet: true }), "send");
        // and the dry run on a mainnet chain still sends nothing
        assert.equal(gateSend({ ...base, send: false }), "dry-run");
    });

    it("the command writes the deployments record as not live, right after the receipt and before the readback", () => {
        const text = src("scripts/erc20spl/deploy-named-factory.ts");
        assert.match(text, /live: false/);
        assert.doesNotMatch(text, /live: true/);
        assert.match(text, /--send/);
        assert.match(text, /expect-nonce/);
        const code = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
        const send = code.indexOf("sendTransaction(");
        const record = code.indexOf("writeDeployments(networkName, dep)");
        const after = code.indexOf("await readBack(", record);
        assert.ok(send > 0 && record > send && after > record, "send, then the record, then the readback");
    });

    it("the send carries the nonce the gate checked (pending count), and the dry run simulates the deploy", () => {
        const text = src("scripts/erc20spl/deploy-named-factory.ts");
        assert.match(text, /blockTag: "pending"/);
        assert.match(text, /sendTransaction\([^)]*nonce/);
        assert.match(text, /estimateGas\(/);
        const code = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
        assert.ok(code.indexOf("estimateGas(") < code.indexOf("gateSend("), "estimated before the gate, so the dry run simulates too");
    });
});

describe("registering a mint the script made", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const { f, store } = await MINT_FOR_SCRIPTS(conn);
    const factoryAbi = (await hardhat.artifacts.readArtifact("ERC20SPLNamedFactory")).abi;
    const mint = MINT_FOR_SCRIPTS.mint;
    // 82 bytes: COption authority (the caller's PDA), supply, decimals 9, initialised, no freeze authority
    const ownMint = `0x01000000${mockPda(wallet.account.address).slice(2)}${"00".repeat(8)}0901${"00000000"}${"00".repeat(32)}` as Hex;
    const classic = vectors.constants.classicProgram as Hex;

    it("a no-name mint, whose authority is the caller, reaches the authority path (the bench's choice)", async () => {
        await store.write.set([mint, classic, ownMint]);
        // with the factory's own ABI the refusal decodes to a name, so this is read and not thrown
        const out = await previewOutcome(() =>
            publicClient.readContract({ address: f.address, abi: factoryAbi, functionName: "preview", args: [mint] }),
        );
        assert.deepEqual(out, { kind: "refused", error: "NoName" });
        const done = await registerOnNamedFactory({
            publicClient: publicClient as any,
            wallet: wallet as any,
            factory: f.address,
            abi: factoryAbi,
            mint,
            authorityName: "CPI Test Token",
            authoritySymbol: "TESTcpi",
        });
        assert.equal(done.path, "authority");
        await publicClient.waitForTransactionReceipt({ hash: done.hash });
        const w = await viem.getContractAt("SPL_ERC20_cached", (await f.read.token_by_mint([mint])) as `0x${string}`);
        assert.equal(await w.read.name(), "CPI Test Token (Rome)");
        assert.equal(await w.read.symbol(), "roTESTcpi");
    });

    it("a mint with a name of its own takes the metadata path", async () => {
        const g = await viem.deployContract("ERC20SPLNamedFactory", [store.address, []]);
        await plantMetaplex(store, "Wrapped SOL", "SOL");
        const done = await registerOnNamedFactory({
            publicClient: publicClient as any,
            wallet: wallet as any,
            factory: g.address,
            abi: factoryAbi,
            mint,
            authorityName: "unused",
            authoritySymbol: "unused",
        });
        assert.equal(done.path, "metadata");
        await publicClient.waitForTransactionReceipt({ hash: done.hash });
        const w = await viem.getContractAt("SPL_ERC20_cached", (await g.read.token_by_mint([mint])) as `0x${string}`);
        assert.equal(await w.read.name(), "Wrapped SOL (Rome)");
    });

    it("any other refusal stops the run instead of trying the authority path", async () => {
        const g = await viem.deployContract("ERC20SPLNamedFactory", [store.address, []]);
        await plantMetaplex(store, "NO_NAME", "SOL");
        await assert.rejects(
            registerOnNamedFactory({
                publicClient: publicClient as any,
                wallet: wallet as any,
                factory: g.address,
                abi: factoryAbi,
                mint,
                authorityName: "x",
                authoritySymbol: "y",
            }),
            /BadName/,
        );
    });
});

describe("recording a wrapper in the deployments file", () => {
    const legacy = "0x00000000000000000000000000000000000000a0";
    const named = "0x00000000000000000000000000000000000000b1";

    it("never overwrites a slot that holds a different wrapper: the named one goes under its own key", () => {
        const dep = { SPL_ERC20_USDC: { address: legacy, mintId: "x" } };
        assert.equal(recordKey(dep, "SPL_ERC20_USDC", named), "SPL_ERC20_USDC_NAMED");
        assert.equal(dep.SPL_ERC20_USDC.address, legacy);
    });

    it("an empty slot, or one that already holds this wrapper, is recorded in place", () => {
        assert.equal(recordKey({}, "SPL_ERC20_USDC", named), "SPL_ERC20_USDC");
        assert.equal(recordKey({ SPL_ERC20_USDC: { address: named.toUpperCase().replace("0X", "0x") } }, "SPL_ERC20_USDC", named), "SPL_ERC20_USDC");
    });

    it("the bootstrap records through recordKey, never straight into the slot", () => {
        const text = src("scripts/bridge/bootstrap-bridged-wrappers.ts");
        assert.doesNotMatch(text, /deployments\[slot\]\s*=/);
        assert.match(text, /recordKey\(deployments, slot,/);
    });
});
