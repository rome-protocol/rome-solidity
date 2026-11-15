import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { toHex, type Hex } from "viem";
import { CPI_PROGRAM_ADDRESS, HELPER_PROGRAM_ADDRESS, SPL_CACHED_ADDRESS, SYSTEM_PROGRAM_ADDRESS } from "../precompile-addresses";
import { METAPLEX_PROGRAM, mockMetadataPda, vectors, type MintVector } from "./naming-helpers";

const SOURCE = { None: 0, ExternalPointer: 1, Token2022: 2, Metaplex: 3 } as const;

// The mint name reader on its own: every shared vector's `read`, the single-fetch authority read against
// the plain read, the padding words of a Token-2022 mint, little-endian words, and the Metaplex zero strip.
describe("MintNameReader", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const publicClient = await viem.getPublicClient();

    const mock = await viem.deployContract("MintInfoMock");
    const mockCode = await publicClient.getCode({ address: mock.address });
    for (const a of [CPI_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, HELPER_PROGRAM_ADDRESS, SPL_CACHED_ADDRESS]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [a, mockCode] });
    }
    const store = await viem.deployContract("AccountStoreMock");
    const reader = await viem.deployContract("MintNameReaderHarness");

    const K = vectors.constants;
    const MINT = K.mint;
    const PROGRAM = { classic: K.classicProgram, p2022: K.program2022, metaplex: K.metaplexProgram, other: K.otherProgram } as const;
    const hexOf = (b: Uint8Array | number[]) => `0x${Buffer.from(b).toString("hex")}` as Hex;
    const bytesOf = (h: Hex) => Buffer.from(h.slice(2), "hex");

    async function plant(v: MintVector) {
        const mpl = mockMetadataPda(v.mint);
        for (const k of [v.mint, mpl, K.otherAccount]) await store.write.clear([k]);
        const key = { mint: v.mint, metaplex: mpl, other: K.otherAccount } as const;
        for (const a of v.accounts) {
            let data = a.data;
            for (const p of a.patch ?? []) {
                const at = 2 + p.offset * 2;
                data = (data.slice(0, at) + mpl.slice(2) + data.slice(at + 64)) as Hex;
            }
            await store.write.set([key[a.at], PROGRAM[a.owner], data]);
        }
    }

    it("reads every vector as its `read` says", async () => {
        const bad: string[] = [];
        for (const v of vectors.mints) {
            await plant(v);
            const [source, name, symbol] = (await reader.read.read([store.address, v.mint])) as [number, Hex, Hex];
            const want = v.read;
            if (source !== SOURCE[want.source as keyof typeof SOURCE]) bad.push(`${v.id}: source ${source}, want ${want.source}`);
            else if (want.name !== undefined && (name !== want.name || symbol !== want.symbol)) bad.push(`${v.id}: strings ${name}/${symbol}`);
        }
        assert.deepEqual(bad, []);
    });

    it("the single-fetch authority read answers the plain read, and reads nothing for any other authority", async () => {
        const bad: string[] = [];
        for (const v of vectors.mints) {
            await plant(v);
            const plain = (await reader.read.read([store.address, v.mint])) as [number, Hex, Hex];
            const [isAuthority, source, name, symbol] = (await reader.read.readAsAuthority([store.address, v.mint, K.mintAuthority])) as [boolean, number, Hex, Hex];
            if (isAuthority) {
                if (source !== plain[0] || name !== plain[1] || symbol !== plain[2]) bad.push(`${v.id}: differs from read`);
            } else if (source !== SOURCE.None || name !== "0x" || symbol !== "0x") {
                bad.push(`${v.id}: not the authority yet read something`);
            }
            const [other, osource] = (await reader.read.readAsAuthority([store.address, v.mint, `0x${"33".repeat(32)}`])) as [boolean, number];
            if (other || osource !== SOURCE.None) bad.push(`${v.id}: another authority accepted`);
        }
        assert.deepEqual(bad, []);
    });

    it("a mint without an authority is nobody's, even for the zero key", async () => {
        const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
        await plant(v);
        const d = bytesOf(v.accounts.find((a) => a.at === "mint")!.data);
        d.fill(0, 0, 36);
        await store.write.set([v.mint, PROGRAM.classic, hexOf(d)]);
        const [isAuthority] = (await reader.read.readAsAuthority([store.address, v.mint, `0x${"00".repeat(32)}`])) as [boolean];
        assert.equal(isAuthority, false);
    });

    describe("a Token-2022 mint's padding, bytes 82 to 164, is zero", () => {
        const base = () => bytesOf(vectors.mints.find((m) => m.id === "t2022/no-pointer/no-metaplex")!.accounts[0].data);
        const parse = async (d: Buffer) => (await reader.read.parse([K.program2022, hexOf(d)])) as [boolean, Hex, Hex, bigint];

        it("every position refuses any non-zero byte, and the bytes around it are not part of the padding", async () => {
            assert.equal((await parse(base()))[0], true);
            for (let i = 82; i <= 164; i++) {
                for (const v of [1, 0x80, 0xff]) {
                    const d = base();
                    d[i] = v;
                    assert.equal((await parse(d))[0], false, `byte ${i} = ${v}`);
                }
            }
            const d = base();
            d[81] = 0xff; // supply bytes, free
            assert.equal((await parse(d))[0], true);
        });

        it("the account type at 165 must be 1", async () => {
            for (const v of [0, 2, 0xff]) {
                const d = base();
                d[165] = v;
                assert.equal((await parse(d))[0], false, `type ${v}`);
            }
        });
    });

    describe("little-endian words", () => {
        const base = () => bytesOf(vectors.mints.find((m) => m.id === "t2022/no-pointer/no-metaplex")!.accounts[0].data);
        const parse = async (d: Buffer) => (await reader.read.parse([K.program2022, hexOf(d)])) as [boolean, Hex, Hex, bigint];

        it("an authority or freeze tag is 0 or 1 as a u32, whichever byte carries the 1", async () => {
            for (const at of [0, 46]) {
                const ok = base();
                ok.set([1, 0, 0, 0], at);
                assert.equal((await parse(ok))[0], true, `tag 1 at ${at}`);
                for (const tag of [[0, 0, 0, 1], [0, 0, 1, 0], [0, 1, 0, 0], [2, 0, 0, 0], [1, 0, 0, 0x80], [1, 1, 0, 0]]) {
                    const d = base();
                    d.set(tag, at);
                    assert.equal((await parse(d))[0], false, `tag ${tag} at ${at}`);
                }
            }
        });

        it("an entry's type and length are u16: 18 with length 64 is a pointer, a length of 0x4000 or 0x0140 is not", async () => {
            const entry = (t: number[], len: number[]) =>
                Buffer.concat([base(), Buffer.from([...t, ...len]), Buffer.alloc(64)]);
            const good = await parse(entry([18, 0], [64, 0]));
            assert.equal(good[0], true);
            assert.equal(good[2], `0x${"00".repeat(32)}`);
            assert.equal((await parse(entry([18, 0], [0, 64])))[0], false);
            assert.equal((await parse(entry([18, 0], [64, 1])))[0], false);
            assert.equal((await parse(entry([0, 18], [64, 0])))[0], false, "type 0x1200 is unknown");
        });

        it("a pointer's address and an entry's offset come back as stored", async () => {
            const v = vectors.mints.find((m) => m.id === "t2022/self/plain")!;
            const [ok, authority, pointer, off] = await parse(bytesOf(v.accounts[0].data));
            assert.equal(ok, true);
            assert.equal(authority, K.mintAuthority);
            assert.equal(pointer, MINT);
            assert.equal(off, 238n);
        });
    });

    describe("the Metaplex zero strip", () => {
        // key 4, update authority (32), mint (32), name (u32 length + bytes), symbol (u32 length + bytes), uri
        const metaplex = (name: number[], symbol: number[], nameField: number, symbolField: number) => {
            const u32 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
            const pad = (b: number[], n: number) => Buffer.concat([Buffer.from(b), Buffer.alloc(n - b.length)]);
            return hexOf(
                Buffer.concat([
                    Buffer.from([4]), Buffer.alloc(32, 0x33), bytesOf(MINT),
                    u32(nameField), pad(name, nameField), u32(symbolField), pad(symbol, symbolField),
                    u32(0), Buffer.from([0, 0, 0, 1, 0]),
                ]),
            );
        };
        const classic = (): Hex => hexOf(bytesOf(vectors.mints.find((m) => m.id === "metaplex/plain")!.accounts.find((a) => a.at === "mint")!.data));

        async function readMetaplex(data: Hex) {
            const pda = mockMetadataPda(MINT);
            await store.write.set([MINT, PROGRAM.classic, classic()]);
            await store.write.set([pda, METAPLEX_PROGRAM, data]);
            return (await reader.read.read([store.address, MINT])) as [number, Hex, Hex];
        }

        it("every name length 0 to 32 and symbol length 0 to 10, padded as Metaplex pads, reads back exactly", async () => {
            for (let n = 0; n <= 32; n++) {
                const s = n % 11;
                const name = Array.from({ length: n }, (_, i) => 0x41 + (i % 26));
                const symbol = Array.from({ length: s }, (_, i) => 0x61 + (i % 26));
                const [source, rn, rs] = await readMetaplex(metaplex(name, symbol, 32, 10));
                assert.equal(source, SOURCE.Metaplex);
                assert.equal(rn, hexOf(name), `name length ${n}`);
                assert.equal(rs, hexOf(symbol), `symbol length ${s}`);
            }
        });

        it("only trailing zeros go: an embedded zero stays, and a field with no padding is whole", async () => {
            const [, rn, rs] = await readMetaplex(metaplex([0x41, 0, 0x42, 0, 0, 0x43], [0x53, 0, 0x59], 32, 10));
            assert.equal(rn, "0x410042000043");
            assert.equal(rs, "0x530059");
            const [, wn, ws] = await readMetaplex(metaplex(Array(32).fill(0x4e), Array(10).fill(0x53), 32, 10));
            assert.equal(wn, hexOf(Array(32).fill(0x4e)));
            assert.equal(ws, hexOf(Array(10).fill(0x53)));
            const [, sn, ss] = await readMetaplex(metaplex([0x4e, 0x61, 0x6d, 0x65], [0x53, 0x59, 0x4d], 4, 3));
            assert.equal(sn, toHex("Name"));
            assert.equal(ss, toHex("SYM"));
            const [, zn, zs] = await readMetaplex(metaplex([], [], 32, 10));
            assert.equal(zn, "0x");
            assert.equal(zs, "0x");
        });

        it("a zero in the last padded position of a full-width field is stripped like any other", async () => {
            const [, rn] = await readMetaplex(metaplex(Array(31).fill(0x4e), [0x53], 32, 10));
            assert.equal(rn, hexOf(Array(31).fill(0x4e)));
        });
    });

    it("an unanswered find_program_address stops the read instead of using a stale address", async () => {
        const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
        await plant(v);
        await conn.provider.request({ method: "hardhat_setCode", params: [SYSTEM_PROGRAM_ADDRESS, "0x"] });
        try {
            await assert.rejects(reader.read.read([store.address, v.mint]), /PdaUnavailable/);
        } finally {
            await conn.provider.request({ method: "hardhat_setCode", params: [SYSTEM_PROGRAM_ADDRESS, mockCode as Hex] });
        }
        await reader.read.read([store.address, v.mint]);
    });

    it("a mint whose pointer is the mint itself derives no Metaplex address", async () => {
        const v = vectors.mints.find((m) => m.id === "t2022/self/plain")!;
        await plant(v);
        await conn.provider.request({ method: "hardhat_setCode", params: [SYSTEM_PROGRAM_ADDRESS, "0x"] });
        try {
            const [source] = (await reader.read.read([store.address, v.mint])) as [number];
            assert.equal(source, SOURCE.Token2022);
        } finally {
            await conn.provider.request({ method: "hardhat_setCode", params: [SYSTEM_PROGRAM_ADDRESS, mockCode as Hex] });
        }
    });
});

