import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
    concatHex,
    decodeEventLog,
    encodeAbiParameters,
    encodeFunctionData,
    keccak256,
    parseAbi,
    toFunctionSelector,
    toHex,
    zeroAddress,
    type Hex,
} from "viem";
import {
    CPI_PROGRAM_ADDRESS,
    HELPER_PROGRAM_ADDRESS,
    SPL_CACHED_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
} from "../precompile-addresses";
import { METAPLEX_PROGRAM, mockMetadataPda, mockPda, revertName, utf8, vectors, type MintVector } from "./naming-helpers";

// the named factory: the wrapper factory that names every wrapper by rule. Its name is "<origin name cut to 25 bytes> (Rome)"
// and its symbol "ro" + the origin symbol cut to 8 bytes; it reads the origin's name from the mint's own
// accounts and fails closed; no caller picks a name; there is no symbol table. Every mint vector of the shared
// file is planted in a store of Solana accounts and run through the factory.
describe("the named wrapper factory", async () => {
    const conn = await network.connect();
    const { viem } = conn;
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();

    // The wrappers the factory deploys read mint_info / ata / pda from the precompiles; the stateless mock
    // answers for them. The mint accounts themselves come from the store, which is the factory's cpi_program.
    const mock = await viem.deployContract("MintInfoMock");
    const mockCode = await publicClient.getCode({ address: mock.address });
    for (const a of [CPI_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, HELPER_PROGRAM_ADDRESS, SPL_CACHED_ADDRESS]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [a, mockCode] });
    }
    const store = await viem.deployContract("AccountStoreMock");

    const K = vectors.constants;
    const MINT = K.mint;
    const PROGRAM = { classic: K.classicProgram, p2022: K.program2022, metaplex: K.metaplexProgram, other: K.otherProgram } as const;
    const grandfatherAbi = [{ type: "tuple[]", components: [{ type: "uint32" }, { type: "bytes32" }, { type: "address" }] }] as const;
    type Entry = { network: number; mint: Hex; wrapper: `0x${string}` };

    const newFactory = (list: Entry[] = []) => viem.deployContract("ERC20SPLNamedFactory", [store.address, list]);

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

    it("has the interface it documents: no caller picks a name, no symbol table, its own lookups", async () => {
        const f = await newFactory();
        const names = new Set(f.abi.filter((x: any) => x.type === "function").map((x: any) => x.name));
        for (const gone of ["add_spl_token_no_metadata", "token_by_symbol_hash", "mint_by_symbol_hash"]) {
            assert.ok(!names.has(gone), `${gone} is gone`);
        }
        for (const kept of [
            "add_spl_token_with_metadata", "add_spl_token_by_authority", "preview", "token_by_mint", "wrapper_kind_by_mint",
            "users", "grandfathered", "grandfatherHash", "create_token_mint", "get_current_mint", "init_token_mint", "creator_nonce",
        ]) {
            assert.ok(names.has(kept), `${kept} is there`);
        }
        const preview = f.abi.find((x: any) => x.name === "preview") as any;
        assert.equal(preview.stateMutability, "view", "preview writes nothing");
        const ev = f.abi.find((x: any) => x.type === "event" && x.name === "TokenCreated") as any;
        assert.deepEqual(ev.inputs.map((i: any) => `${i.type} ${i.name}${i.indexed ? " indexed" : ""}`), [
            "address creator indexed", "bytes32 mint indexed", "address wrapper indexed", "string name", "string symbol", "uint64 nonce",
        ]);
    });

    it("its runtime code fits a contract (24,576 bytes)", async () => {
        const f = await newFactory();
        const code = (await publicClient.getCode({ address: f.address })) as Hex;
        assert.ok((code.length - 2) / 2 <= 24576, `${(code.length - 2) / 2} bytes`);
    });

    it("preview answers every mint vector as the reference does, and the add does the same", async () => {
        const bad: string[] = [];
        for (const v of vectors.mints) {
            await plant(v);
            const f = await newFactory();
            // preview: the two strings or the add's error, from the same function
            const pv = await revertName(f.read.preview([v.mint]));
            if (v.expect.ok) {
                const [n, s] = (await f.read.preview([v.mint])) as [string, string];
                if (toHex(n) !== v.expect.name || toHex(s) !== v.expect.symbol) bad.push(`${v.id}: preview ${n}/${s}`);
            } else if (pv !== v.expect.error) {
                bad.push(`${v.id}: preview reverted with ${pv}, want ${v.expect.error}`);
            }
            // the add
            const add = await revertName(f.write.add_spl_token_with_metadata([v.mint]));
            const wrapper = await f.read.token_by_mint([v.mint]);
            if (v.expect.ok) {
                if (add !== null) { bad.push(`${v.id}: add reverted with ${add}`); continue; }
                const w = await viem.getContractAt("SPL_ERC20_cached", wrapper as `0x${string}`);
                if (toHex(await w.read.name()) !== v.expect.name || toHex(await w.read.symbol()) !== v.expect.symbol) {
                    bad.push(`${v.id}: wrapper is ${await w.read.name()}/${await w.read.symbol()}`);
                }
            } else {
                if (add !== v.expect.error) bad.push(`${v.id}: add reverted with ${add}, want ${v.expect.error}`);
                if (wrapper !== zeroAddress) bad.push(`${v.id}: a wrapper exists after a refusal`);
            }
        }
        assert.deepEqual(bad, []);
    });

    it("a mint with an armed transfer hook gets the hook-aware wrapper, named by the same rule", async () => {
        const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
        // byte 1 of the mint id arms the hook in the precompile mock
        const hookedMint = `0x${v.mint.slice(2, 4)}01${v.mint.slice(6)}` as Hex;
        // the Metaplex account names its mint, so the copy of the vector carries the new id inside the data too
        const accounts = v.accounts.map((a) => ({ ...a, data: a.data.split(v.mint.slice(2)).join(hookedMint.slice(2)) as Hex }));
        await plant({ ...v, mint: hookedMint, accounts });
        const f = await newFactory();
        await f.write.add_spl_token_with_metadata([hookedMint]);
        assert.equal(await f.read.wrapper_kind_by_mint([hookedMint]), 2, "the Token-2022 hooked wrapper");
        const w = await viem.getContractAt("SPL_ERC20_Token2022Hooked", (await f.read.token_by_mint([hookedMint])) as `0x${string}`);
        assert.equal(await w.read.name(), "Wrapped SOL (Rome)");
        assert.equal(await w.read.symbol(), "roSOL");
    });

    it("a real Token-2022 mint (ai16z, dumped from mainnet) is named from its own metadata", async () => {
        const fixtureMint = await mock.read.FIXTURE_MINT();
        const data = (await mock.read.FIXTURE_MINT_DATA()) as Hex;
        for (const k of [fixtureMint, mockMetadataPda(fixtureMint), K.otherAccount]) await store.write.clear([k]);
        await store.write.set([fixtureMint, PROGRAM.p2022, data]);
        const f = await newFactory();
        const [name, symbol] = (await f.read.preview([fixtureMint])) as [string, string];
        assert.equal(name, "ai16z (Rome)");
        assert.equal(symbol, "roai16z");
        await f.write.add_spl_token_with_metadata([fixtureMint]);
        const w = await viem.getContractAt("SPL_ERC20_cached", (await f.read.token_by_mint([fixtureMint])) as `0x${string}`);
        assert.equal(await w.read.name(), "ai16z (Rome)");
    });

    it("TokenCreated carries the creator, the mint, the wrapper, both strings and the creator's nonce", async () => {
        const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
        await plant(v);
        const f = await newFactory();
        const hash = await f.write.add_spl_token_with_metadata([v.mint]);
        const receipt = await publicClient.getTransactionReceipt({ hash });
        const log = receipt.logs.find((l) => l.address.toLowerCase() === f.address.toLowerCase())!;
        const ev = decodeEventLog({ abi: f.abi, data: log.data, topics: log.topics }) as any;
        assert.equal(ev.eventName, "TokenCreated");
        assert.equal(ev.args.creator.toLowerCase(), wallet.account.address.toLowerCase());
        assert.equal(ev.args.mint, v.mint);
        assert.equal(ev.args.wrapper, await f.read.token_by_mint([v.mint]));
        assert.equal(ev.args.name, "Wrapped SOL (Rome)");
        assert.equal(ev.args.symbol, "roSOL");
        assert.equal(ev.args.nonce, 0n);
        assert.equal(await f.read.wrapper_kind_by_mint([v.mint]), 1, "the cached wrapper");
    });

    it("a mint already registered here is refused, by the add and by preview, before any read", async () => {
        const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
        await plant(v);
        const f = await newFactory();
        await f.write.add_spl_token_with_metadata([v.mint]);
        assert.equal(await revertName(f.write.add_spl_token_with_metadata([v.mint])), "AlreadyRegistered");
        assert.equal(await revertName(f.read.preview([v.mint])), "AlreadyRegistered");
        // even when its metadata has since gone bad
        await store.write.clear([mockMetadataPda(v.mint)]);
        assert.equal(await revertName(f.read.preview([v.mint])), "AlreadyRegistered");
    });

    it("the name is read once: renaming the metadata later changes no wrapper and allows no second one", async () => {
        const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
        await plant(v);
        const f = await newFactory();
        await f.write.add_spl_token_with_metadata([v.mint]);
        const w = await viem.getContractAt("SPL_ERC20_cached", (await f.read.token_by_mint([v.mint])) as `0x${string}`);
        assert.equal(await w.read.name(), "Wrapped SOL (Rome)");
        // the issuer renames: a new Metaplex account for the same mint
        const other = vectors.mints.find((m) => m.id === "metaplex/cut-name-25")!;
        await plant({ ...other, mint: v.mint });
        assert.equal(await w.read.name(), "Wrapped SOL (Rome)");
        assert.equal(await w.read.symbol(), "roSOL");
        assert.equal(await revertName(f.write.add_spl_token_with_metadata([v.mint])), "AlreadyRegistered");
        assert.equal(await f.read.token_by_mint([v.mint]), w.address);
    });

    describe("the grandfather list", () => {
        const list: Entry[] = [
            { network: 74, mint: MINT, wrapper: "0x00000000000000000000000000000000000000a1" },
            { network: 74, mint: K.otherMint, wrapper: "0x00000000000000000000000000000000000000a2" },
        ];

        it("stores the hash of abi.encode(list), the preimage other tools that take the list use", async () => {
            const f = await newFactory(list);
            const want = keccak256(encodeAbiParameters(grandfatherAbi, [list.map((e) => [e.network, e.mint, e.wrapper] as const)]));
            assert.equal(await f.read.grandfatherHash(), want);
            const empty = await newFactory([]);
            assert.equal(await empty.read.grandfatherHash(), keccak256(encodeAbiParameters(grandfatherAbi, [[]])));
        });

        it("refuses each listed mint on both paths, before it reads anything, and says so in preview", async () => {
            const f = await newFactory(list);
            assert.equal((await f.read.grandfathered([MINT])).toLowerCase(), list[0].wrapper);
            assert.equal((await f.read.grandfathered([K.otherMint])).toLowerCase(), list[1].wrapper);
            assert.equal(await f.read.grandfathered([`0x${"07".repeat(32)}`]), zeroAddress);
            // no accounts at all: the list is checked before any read
            await store.write.clear([MINT]);
            await store.write.clear([mockMetadataPda(MINT)]);
            assert.equal(await revertName(f.write.add_spl_token_with_metadata([MINT])), "Grandfathered");
            assert.equal(await revertName(f.read.preview([MINT])), "Grandfathered");
            const cd = encodeFunctionData({
                abi: parseAbi(["function add_spl_token_by_authority(bytes32,string,string)"]),
                functionName: "add_spl_token_by_authority",
                args: [K.otherMint, "Name", "SYM"],
            });
            assert.equal(await revertName(wallet.sendTransaction({ to: f.address, data: cd, gas: 5_000_000n })), "Grandfathered");
        });

        it("a listed mint with good metadata gets no wrapper, and an unlisted one still does", async () => {
            const v = vectors.mints.find((m) => m.id === "metaplex/plain")!;
            await plant(v);
            const f = await newFactory(list);
            assert.equal(await revertName(f.write.add_spl_token_with_metadata([MINT])), "Grandfathered");
            assert.equal(await f.read.token_by_mint([MINT]), zeroAddress);
            const g = await newFactory([list[1]]);
            await g.write.add_spl_token_with_metadata([MINT]);
            assert.notEqual(await g.read.token_by_mint([MINT]), zeroAddress);
        });

        it("refuses a list with a zero mint, a zero wrapper or a repeated mint", async () => {
            const w = "0x00000000000000000000000000000000000000a1" as const;
            for (const bad of [
                [{ network: 74, mint: `0x${"00".repeat(32)}` as Hex, wrapper: w }],
                [{ network: 74, mint: MINT, wrapper: zeroAddress }],
                [{ network: 74, mint: MINT, wrapper: w }, { network: 74, mint: MINT, wrapper: w }],
            ] as Entry[][]) {
                assert.equal(await revertName(newFactory(bad)), "BadGrandfatherList");
            }
        });
    });

    describe("the authority path", () => {
        const me = wallet.account.address;
        const classicMint = (authority: Hex | null) => {
            // 82 bytes: COption authority, supply, decimals 9, initialised, no freeze authority
            const tag = authority ? "01000000" : "00000000";
            return `0x${tag}${(authority ?? `0x${"00".repeat(32)}`).slice(2)}${"00".repeat(8)}0901${"00000000"}${"00".repeat(32)}` as Hex;
        };
        const sel = toFunctionSelector("add_spl_token_by_authority(bytes32,string,string)");
        // The strings go in as raw bytes (the same ABI encoding as `string`), so invalid UTF-8 can be sent.
        const calldata = (mint: Hex, name: Hex, symbol: Hex) =>
            concatHex([sel, encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }], [mint, name, symbol])]);
        const send = (f: { address: `0x${string}` }, data: Hex, from?: `0x${string}`) =>
            wallet.sendTransaction({ to: f.address, data, gas: 8_000_000n, ...(from ? { account: from } : {}) });

        async function plantAuthorityMint(authority: Hex | null = mockPda(me)) {
            for (const k of [MINT, mockMetadataPda(MINT), K.otherAccount]) await store.write.clear([k]);
            await store.write.set([MINT, PROGRAM.classic, classicMint(authority)]);
        }

        it("names a caller's mint with the same rule: every authority vector", async () => {
            const bad: string[] = [];
            for (const v of vectors.authority) {
                await plantAuthorityMint();
                const f = await newFactory();
                const err = await revertName(send(f, calldata(MINT, v.originName, v.originSymbol)));
                const wrapper = await f.read.token_by_mint([MINT]);
                if (v.expect.ok) {
                    if (err !== null) { bad.push(`${v.id}: reverted with ${err}`); continue; }
                    const w = await viem.getContractAt("SPL_ERC20_cached", wrapper as `0x${string}`);
                    if (toHex(await w.read.name()) !== v.expect.name || toHex(await w.read.symbol()) !== v.expect.symbol) {
                        bad.push(`${v.id}: wrapper is ${await w.read.name()}/${await w.read.symbol()}`);
                    }
                } else {
                    if (err !== v.expect.error) bad.push(`${v.id}: reverted with ${err}, want ${v.expect.error}`);
                    if (wrapper !== zeroAddress) bad.push(`${v.id}: a wrapper exists after a refusal`);
                }
            }
            assert.deepEqual(bad, []);
        });

        it("only the mint's own authority may: the caller's PDA must be the mint authority", async () => {
            const f = await newFactory();
            const data = calldata(MINT, toHex("My Token"), toHex("MYT"));
            await plantAuthorityMint(mockPda("0x00000000000000000000000000000000000000b0")); // someone else's PDA
            assert.equal(await revertName(send(f, data)), "NotMintAuthority");
            await plantAuthorityMint(null); // no authority at all
            assert.equal(await revertName(send(f, data)), "NotMintAuthority");
            for (const k of [MINT]) await store.write.clear([k]); // no such mint
            assert.equal(await revertName(send(f, data)), "NotMintAuthority");
            await store.write.set([MINT, PROGRAM.other, classicMint(mockPda(me))]); // not a token mint
            assert.equal(await revertName(send(f, data)), "NotMintAuthority");
            assert.equal(await f.read.token_by_mint([MINT]), zeroAddress);
            await plantAuthorityMint();
            assert.equal(await revertName(send(f, data)), null);
            assert.notEqual(await f.read.token_by_mint([MINT]), zeroAddress);
        });

        it("a mint that asserts a name takes the metadata path; an external pointer is refused too", async () => {
            const f = await newFactory();
            const data = calldata(MINT, toHex("My Token"), toHex("MYT"));
            await plantAuthorityMint();
            const named = vectors.mints.find((m) => m.id === "metaplex/plain")!;
            await store.write.set([mockMetadataPda(MINT), METAPLEX_PROGRAM, named.accounts[0].data]);
            assert.equal(await revertName(send(f, data)), "MintAssertsName");
            assert.equal(await f.read.token_by_mint([MINT]), zeroAddress);
            // a Token-2022 mint with a pointer to another account, authority the caller's PDA
            const ext = vectors.mints.find((m) => m.id === "t2022/external-pointer/absent-target")!;
            const base = ext.accounts[0].data;
            const withAuthority = (`0x01000000${mockPda(me).slice(2)}${base.slice(2 + 72)}`) as Hex;
            await store.write.clear([mockMetadataPda(MINT)]);
            await store.write.set([MINT, PROGRAM.p2022, withAuthority]);
            assert.equal(await revertName(send(f, data)), "ExternalPointer");
        });

        it("a registered mint is refused again, and a refused call leaves no wrapper", async () => {
            const f = await newFactory();
            await plantAuthorityMint();
            assert.equal(await revertName(send(f, calldata(MINT, toHex("My Token"), toHex("MYT")))), null);
            assert.equal(await revertName(send(f, calldata(MINT, toHex("My Token"), toHex("MYT")))), "AlreadyRegistered");
            const w = await viem.getContractAt("SPL_ERC20_cached", (await f.read.token_by_mint([MINT])) as `0x${string}`);
            assert.equal(await w.read.name(), "My Token (Rome)");
            assert.equal(await w.read.symbol(), "roMYT");
        });

        it("does not consult any other factory: a name taken elsewhere blocks nothing", async () => {
            // the factory has no factory to ask: its constructor takes only the CPI address and the list
            const f = await newFactory();
            const ctor = f.abi.find((x: any) => x.type === "constructor") as any;
            assert.deepEqual(ctor.inputs.map((i: any) => i.type), ["address", "tuple[]"]);
        });
    });
});
