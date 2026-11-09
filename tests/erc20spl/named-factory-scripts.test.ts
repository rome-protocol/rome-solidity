import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, zeroAddress, type Hex } from "viem";
import {
    DirectWrapperDeployRetiredError,
    NoLiveNamedFactoryError,
    NotLiveNamedFactoryError,
    assertDirectWrapperDeployAllowed,
    resolveLiveNamedFactory,
} from "../../scripts/lib/wrapper-factory";
import { planEntry, previewOutcome } from "../../scripts/bridge/lib/bootstrap-plan";
import {
    gateSend,
    grandfatherHash,
    parseGrandfatherList,
    planDeploy,
} from "../../scripts/erc20spl/lib/named-factory-deploy";
import { base58ToBytes32 } from "../../scripts/lib/pubkey";
import { MINT_FOR_SCRIPTS, plantMetaplex } from "./naming-script-helpers";

const root = fileURLToPath(new URL("../../", import.meta.url));
const src = (p: string) => readFileSync(join(root, p), "utf8");

const E1 = "0x00000000000000000000000000000000000000e1" as const;
const LEGACY = "0x00000000000000000000000000000000000000a0" as const;

// RB21 / section 6, rows 7 and 8: this repository's callers make wrappers through E1's metadata path, and its
// direct wrapper deploys (and a second legacy factory) stop where E1 is live.
describe("the live-E1 record", () => {
    it("a chain with no live E1 has none to resolve", () => {
        assert.throws(() => resolveLiveNamedFactory("x", {}), NoLiveNamedFactoryError);
        assert.throws(() => resolveLiveNamedFactory("x", { ERC20SPLFactory: { address: LEGACY } }), NoLiveNamedFactoryError);
        // deployed but not yet recorded live
        assert.throws(
            () => resolveLiveNamedFactory("x", { ERC20SPLNamedFactory: { address: E1, live: false } } as any),
            NoLiveNamedFactoryError,
        );
    });

    it("a live record resolves; a different requested factory, a deprecated legacy one among them, is refused", () => {
        const dep = {
            ERC20SPLFactory: { address: LEGACY, deprecated: true },
            ERC20SPLNamedFactory: { address: E1, live: true },
        } as any;
        assert.equal(resolveLiveNamedFactory("x", dep).toLowerCase(), E1);
        assert.equal(resolveLiveNamedFactory("x", dep, E1).toLowerCase(), E1);
        assert.throws(() => resolveLiveNamedFactory("x", dep, LEGACY), NotLiveNamedFactoryError);
        assert.throws(() => resolveLiveNamedFactory("x", dep, "0x00000000000000000000000000000000000000f1"), NotLiveNamedFactoryError);
    });

    it("direct wrapper deploys and a second legacy factory stop on a chain where E1 is live", () => {
        assert.doesNotThrow(() => assertDirectWrapperDeployAllowed("x", "deploy a wrapper", {}));
        assert.doesNotThrow(() =>
            assertDirectWrapperDeployAllowed("x", "deploy a wrapper", { ERC20SPLNamedFactory: { address: E1, live: false } } as any),
        );
        assert.throws(
            () => assertDirectWrapperDeployAllowed("x", "deploy a wrapper", { ERC20SPLNamedFactory: { address: E1, live: true } } as any),
            DirectWrapperDeployRetiredError,
        );
    });
});

describe("row 8: each retired script exits before any send on a chain where E1 is live", () => {
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

describe("row 7: the callers use E1's metadata path on the live E1", () => {
    for (const p of [
        "scripts/bridge/bootstrap-bridged-wrappers.ts",
        "scripts/token2022/smoke-hooked-wrapper-hadrian.ts",
        "scripts/erc20spl/bench_cached_vs_cpi_wrapper.ts",
    ]) {
        it(`${p} resolves the live E1 and calls add_spl_token_with_metadata`, () => {
            const text = src(p);
            assert.match(text, /resolveLiveNamedFactory\(/);
            assert.match(text, /add_spl_token_with_metadata/);
            assert.doesNotMatch(text, /add_spl_token_no_metadata/);
        });
    }

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

describe("the bootstrap's names are E1's", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const { f, store } = await MINT_FOR_SCRIPTS(conn);

    it("an unregistered mint is registered under the strings preview gives, never a name from a table", async () => {
        await plantMetaplex(store, "Wrapped SOL", "SOL");
        const out = await previewOutcome(() => f.read.preview([MINT_FOR_SCRIPTS.mint]));
        assert.deepEqual(out, { kind: "ok", name: "Wrapped SOL (Rome)", symbol: "roSOL" });
        assert.deepEqual(planEntry(zeroAddress, out), { kind: "register", name: "Wrapped SOL (Rome)", symbol: "roSOL" });
    });

    it("a mint E1 refuses is skipped with its reason, not registered, and does not stop the run", async () => {
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

describe("the E1 deploy command", async () => {
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

    it("its hash is the factory's, from the same preimage the book uses", async () => {
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

    it("prints the decoded constructor call and the hash, and does nothing else without --send", () => {
        const plan = planDeploy({ cpiProgram: "0xff00000000000000000000000000000000000008", list });
        const text = plan.lines.join("\n");
        assert.match(text, /ERC20SPLNamedFactory/);
        assert.match(text, /0xff00000000000000000000000000000000000008/);
        assert.ok(text.includes(grandfatherHash(list)));
        assert.equal(plan.args.length, 2);
    });

    it("--send needs the deployer's current nonce, stated by the operator", () => {
        assert.throws(() => gateSend({ send: true, expectNonce: undefined, nonce: 7 }), /--expect-nonce/);
        assert.throws(() => gateSend({ send: true, expectNonce: 6, nonce: 7 }), /nonce/);
        assert.doesNotThrow(() => gateSend({ send: true, expectNonce: 7, nonce: 7 }));
        // a dry run never needs one, and never sends
        assert.equal(gateSend({ send: false, expectNonce: undefined, nonce: 7 }), "dry-run");
        assert.equal(gateSend({ send: true, expectNonce: 7, nonce: 7 }), "send");
    });

    it("a send on a mainnet chain also needs its own acknowledgement", () => {
        const base = { send: true, expectNonce: 3, nonce: 3, mainnet: true };
        assert.throws(() => gateSend(base), /i-understand-mainnet/);
        assert.equal(gateSend({ ...base, acknowledgeMainnet: true }), "send");
        // and the dry run on a mainnet chain still sends nothing
        assert.equal(gateSend({ ...base, send: false }), "dry-run");
    });

    it("the command writes the deployments record as not live: the live mark is set at the registry's record", () => {
        const text = src("scripts/erc20spl/deploy-named-factory.ts");
        assert.match(text, /live: false/);
        assert.doesNotMatch(text, /live: true/);
        assert.match(text, /--send/);
        assert.match(text, /expect-nonce/);
        void ([] as Hex[]);
    });
});
