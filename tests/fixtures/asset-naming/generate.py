#!/usr/bin/env python3
"""Generates vectors.json, the shared test vectors for Rome's wrapper naming rule.

The vectors pin one rule: how a mint's name and symbol become a Rome token's name
("<name cut to 25 bytes> (Rome)") and symbol (the origin's symbol cut to 10 bytes, with no prefix), the
checks that run on the WHOLE text before the cut, and how a mint's name is read from
its accounts. Every implementation of the rule (the wrapper factory in this repository
and any other that applies the rule) runs its own code over this file and
must return the same strings or the same refusal on every entry.

The expected values come from the independent reference below, written with Python's
own strict UTF-8 decoder and Unicode 16.0.0's general categories (unicodedata), never
from the Solidity under test. Run it with Python 3.14 (Unicode 16.0.0):

    python3 tests/fixtures/asset-naming/generate.py > tests/fixtures/asset-naming/vectors.json
"""
import json
import struct
import sys
import unicodedata

assert unicodedata.unidata_version == "16.0.0", unicodedata.unidata_version

TOKEN = bytes.fromhex("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9")
TOKEN_2022 = bytes.fromhex("06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc")
METAPLEX = bytes.fromhex("0b7065b1e3d17c45389d527f6b04c3cd58b86c731aa0fdb549b6d1bc03f82946")
OTHER_PROGRAM = bytes.fromhex("11" * 32)

NAME_CUT, SYMBOL_CUT = 25, 10
NAME_SUFFIX = b" (Rome)"

# ---- the table: Unicode 16.0.0 general categories Cc and Cf --------------------------

def table():
    cps = [c for c in range(0x110000) if not (0xD800 <= c <= 0xDFFF) and unicodedata.category(chr(c)) in ("Cc", "Cf")]
    ranges = []
    for c in cps:
        if ranges and ranges[-1][1] == c - 1:
            ranges[-1][1] = c
        else:
            ranges.append([c, c])
    assert len(cps) == 235 and len(ranges) == 23, (len(cps), len(ranges))
    return ranges

RANGES = table()

def in_table(cp):
    return any(lo <= cp <= hi for lo, hi in RANGES)

# ---- the reference rule ----------------------------------------------------------------

def cut(b, n):
    if len(b) <= n:
        return b
    end = n
    while end != 0 and (b[end] & 0xC0) == 0x80:
        end -= 1
    return b[:end]

def refused(b, fallback):
    if len(b) == 0 or b == fallback or b == b"NOT_VALID_ENCODING":
        return True
    try:
        s = b.decode("utf-8")  # strict: no stray continuation, no overlong, no surrogate, nothing past U+10FFFF
    except UnicodeDecodeError:
        return True
    return any(in_table(ord(ch)) for ch in s)

def rome_name(b):
    if refused(b, b"NO_NAME"):
        return None
    kept = cut(b, NAME_CUT)
    assert kept
    return kept + NAME_SUFFIX

def rome_symbol(b):
    if refused(b, b"NO_SYMBOL"):
        return None
    kept = cut(b, SYMBOL_CUT)
    assert kept
    return kept

def hx(b):
    return "0x" + b.hex()

def expect(out, error):
    return {"ok": True, "output": hx(out)} if out is not None else {"ok": False, "error": error}

# ---- text vectors -------------------------------------------------------------------------

def text_inputs():
    v = []  # (id, bytes)
    def add(i, b):
        v.append((i, b))
    for s in ["SOL", "Wrapped SOL", "JitoSOL", "Bonk", "ETH", "Ether", "Dai Stablecoin", "wstETH", "roETH", "USDC", "Jito Staked SOL"]:
        add("plain/" + s, s.encode())
    add("case/mixed", b"jItOsOl")
    add("empty", b"")
    for s in ["NO_SYMBOL", "NO_NAME", "NOT_VALID_ENCODING", "NO_SYMBOLS", "NO_NAMES", "NO_SYMBO", "NOT_VALI", "no_symbol", "No_Name"]:
        add("fallback/" + s, s.encode())
    # control bytes and DEL, inside the cut and past it
    for b in (0x01, 0x09, 0x0A, 0x1F, 0x7F):
        add("ctl/%02x-inside" % b, b"AB" + bytes([b]) + b"CD")
        add("ctl/%02x-past-8" % b, b"ABCDEFGH" + bytes([b]))
        add("ctl/%02x-past-25" % b, b"A" * 25 + bytes([b]))
        add("ctl/%02x-only" % b, bytes([b]))
    add("ctl/zero-embedded", b"AB\x00CD")
    add("ctl/zero-trailing", b"ABCD\x00")
    add("cf/c1-0085-inside-sym", b"SO" + bytes.fromhex("c285") + b"L")
    add("cf/bidi-202e-past-8", b"ABCDEFGH" + bytes.fromhex("e280ae"))
    add("cf/c1-0085-inside-name", b"Wrapped" + bytes.fromhex("c285") + b" SOL")
    add("cf/bidi-202e-past-25", b"A" * 25 + bytes.fromhex("e280ae"))
    add("cf/zwsp-200b", "AB​CD".encode())
    add("cf/tag-e0041", "AB\U000e0041CD".encode())
    add("cf/zwj-emoji", "\U0001F468‍\U0001F469".encode())
    add("cf/zwnj-persian", "م‌ن".encode())
    add("cf/soft-hyphen", "AB­CD".encode())
    add("cf/bom", "﻿AB".encode())
    # bad UTF-8
    bad = {
        "stray-continuation": b"AB\x80CD",
        "stray-continuation-first": b"\x80",
        "cut-short-2": b"AB\xc3",
        "cut-short-3": b"AB\xe2\x82",
        "cut-short-4": b"AB\xf0\x9f\x98",
        "overlong-2": b"\xc0\x80",
        "overlong-2b": b"\xc1\xbf",
        "overlong-3": b"\xe0\x80\x80",
        "overlong-4": b"\xf0\x80\x80\x80",
        "surrogate": b"\xed\xa0\x80",
        "surrogate-end": b"\xed\xbf\xbf",
        "above-10ffff": b"\xf4\x90\x80\x80",
        "f5": b"\xf5\x80\x80\x80",
        "ff": b"A\xff",
        "fe": b"A\xfe",
        "bad-second": b"\xe2\x28\xa1",
        "bad-third": b"\xe2\x82\x28",
        "bad-fourth": b"\xf0\x9f\x98\x28",
    }
    for k, b in bad.items():
        add("utf8/" + k, b)
        add("utf8/" + k + "-past-8", b"ABCDEFGH" + b)
    # edge code points that are valid
    for cp in (0x80 + 0x20, 0xA0, 0xFF, 0x7FF, 0x800, 0xFFFD, 0x10000, 0x10FFFF, 0x1F600):
        add("ok/cp-%x" % cp, ("AB" + chr(cp) + "CD").encode())
    # the table, edge by edge: first, last, and each side
    for lo, hi in RANGES:
        for cp, tag in ((lo, "first"), (hi, "last"), (lo - 1, "before"), (hi + 1, "after")):
            if cp < 0 or 0xD800 <= cp <= 0xDFFF or cp > 0x10FFFF:
                continue
            add("table/%x-%s" % (lo, tag), ("A" + chr(cp) + "B").encode() if cp >= 0x20 else b"A" + bytes([cp]) + b"B")
            add("table-alone/%x-%s" % (lo, tag), chr(cp).encode())
    # the cut
    for n in (24, 25, 26, 32, 33, 40):
        add("cut/ascii-%d" % n, (b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"[:n]))
    add("cut/name-multibyte-across-25", b"A" * 24 + "é".encode() + b"Z")
    add("cut/name-3byte-across-25", b"A" * 23 + "€".encode() + b"Z")
    add("cut/name-4byte-across-25", b"A" * 22 + "\U0001F600".encode() + b"Z")
    add("cut/name-multibyte-ends-at-25", b"A" * 23 + "é".encode() + b"Z")
    for n in (9, 10, 11, 12):
        add("cut/symbol-ascii-%d" % n, b"ABCDEFGHIJKL"[:n])
    add("cut/symbol-multibyte-across-10", b"ABCDEFGHI" + "é".encode())
    add("cut/symbol-multibyte-ends-at-10", b"ABCDEFGH" + "é".encode() + b"Z")
    add("cut/symbol-4byte-across-10", b"ABCDEFGH" + "\U0001F600".encode() + b"Z")
    add("cut/symbol-4byte-before-10", b"ABCDEF" + "\U0001F600".encode())
    add("cut/symbol-cjk", "日本語です".encode())
    add("cut/symbol-two-byte-all", "ÅÄÖÅÄÖ".encode())
    # lengths for the cost record: ASCII, CJK (lead bytes e3..e9) and e2-led characters throughout
    for n in (10, 32, 64, 200):
        add("len/ascii-%d" % n, (b"ABCDEFGHIJ" * 30)[:n])
        cjk = ("日本語" * 100).encode()
        add("len/cjk-%d" % n, cjk[: n - n % 3])
        e2 = ("←" * 100).encode()  # U+2190, e2 86 90
        add("len/e2-%d" % n, e2[: n - n % 3])
    return v

def text_vectors():
    out = []
    for i, b in text_inputs():
        for kind in ("name", "symbol"):
            if kind == "name":
                out.append({"id": "name/" + i, "kind": "name", "input": hx(b), "expect": expect(rome_name(b), "BadName")})
            else:
                out.append({"id": "symbol/" + i, "kind": "symbol", "input": hx(b), "expect": expect(rome_symbol(b), "BadSymbol")})
    return out

# ---- mint accounts -----------------------------------------------------------------------

def coption(key):
    return struct.pack("<I", 1) + key if key is not None else struct.pack("<I", 0) + b"\x00" * 32

def base_mint(authority=b"\x22" * 32, decimals=9):
    d = coption(authority) + struct.pack("<Q", 0) + bytes([decimals, 1]) + coption(None)
    assert len(d) == 82
    return d

def t2022(entries, authority=b"\x22" * 32):
    d = base_mint(authority) + b"\x00" * (165 - 82) + b"\x01"
    for t, v in entries:
        d += struct.pack("<HH", t, len(v)) + v
    return d

def pointer_entry(address):
    return (18, b"\x00" * 32 + address)

def tm_value(mint, name, symbol, uri=b"", pairs=0):
    return (b"\x33" * 32) + mint + struct.pack("<I", len(name)) + name + struct.pack("<I", len(symbol)) + symbol + struct.pack("<I", len(uri)) + uri + struct.pack("<I", pairs)

def mpl(mint, name, symbol, key=4, name_pad=32, symbol_pad=10, raw_name_len=None, raw_symbol_len=None):
    n = name + b"\x00" * (name_pad - len(name))
    s = symbol + b"\x00" * (symbol_pad - len(symbol))
    d = bytes([key]) + b"\x33" * 32 + mint
    d += struct.pack("<I", len(n) if raw_name_len is None else raw_name_len) + n
    d += struct.pack("<I", len(s) if raw_symbol_len is None else raw_symbol_len) + s
    d += struct.pack("<I", 0) + struct.pack("<H", 0) + b"\x00\x01\x00"
    return d

MINT = bytes([0x09, 0, 0, 0, 0, 0] + [0x5A] * 26)
OTHER_MINT = bytes([0x09, 0, 0, 0, 0, 0] + [0x5B] * 26)
OTHER_ACCOUNT = bytes([0x09] + [0x5C] * 31)

def A(at, owner, data):
    return {"at": at, "owner": owner, "data": hx(data)}


# ---- the reference reader: how a mint's name is read from its accounts (fail closed) ----------

# Extension numbers that live on token accounts, never on a mint.
ACCOUNT_SIDE = {2, 5, 7, 8, 11, 13, 15, 17, 27}
FIXED_LEN = {1: 108, 3: 32, 6: 1, 9: 0, 12: 32, 14: 64, 18: 64, 20: 64, 21: 80, 22: 64, 23: 72, 26: 33, 28: 32}
PRESENCE_ONLY = {4, 10, 16, 24, 25}

def u32(d, o):
    return struct.unpack_from("<I", d, o)[0]

def u16(d, o):
    return struct.unpack_from("<H", d, o)[0]

def coption_ok(d, o):
    return u32(d, o) in (0, 1)

def metadata_fits(d, off, ln):
    end = off + ln
    if ln < 64 + 12 + 4:
        return False
    p = off + 64
    for _ in range(3):
        if end - p < 4:
            return False
        l = u32(d, p)
        p += 4
        if end - p < l:
            return False
        p += l
    if end - p < 4:
        return False
    pairs = u32(d, p)
    p += 4
    for _ in range(pairs):
        for _ in range(2):
            if end - p < 4:
                return False
            l = u32(d, p)
            p += 4
            if end - p < l:
                return False
            p += l
    return p == end

def parse_mint(owner, d):
    """(ok, metadataAddress, metadataOffset, mintAuthority). ok False: the mint was not walked clean."""
    if owner not in (TOKEN, TOKEN_2022):
        return False, None, 0, None
    t22 = owner == TOKEN_2022
    n = len(d)
    if n < 82 or d[45] == 0:
        return False, None, 0, None
    if d[45] != 1 or (not t22 and n != 82) or (t22 and 82 < n < 166):
        return False, None, 0, None
    if not coption_ok(d, 0) or not coption_ok(d, 46):
        return False, None, 0, None
    authority = d[4:36] if u32(d, 0) == 1 else b"\x00" * 32
    pointer, moff = b"\x00" * 32, 0
    if t22 and n > 82:
        if any(d[i] != 0 for i in range(82, 165)) or d[165] != 1:
            return False, None, 0, None
        off, seen = 166, set()
        while off < n:
            if off == 355 and n == 357 and d[off] == 0 and d[off + 1] == 0:
                break
            if n - off < 4:
                return False, None, 0, None
            t, ln = u16(d, off), u16(d, off + 2)
            off += 4
            if n - off < ln or t == 0:
                return False, None, 0, None
            if t >= 32 or t in seen:
                return False, None, 0, None
            seen.add(t)
            if t == 19:
                if not metadata_fits(d, off, ln):
                    return False, None, 0, None
                moff = off
            elif t in FIXED_LEN:
                if ln != FIXED_LEN[t]:
                    return False, None, 0, None
                if t == 6 and d[off] not in (1, 2):
                    return False, None, 0, None
                if t == 26 and d[off + 32] > 1:
                    return False, None, 0, None
                if t == 18:
                    pointer = d[off + 32: off + 64]
            elif t not in PRESENCE_ONLY:
                return False, None, 0, None  # account-side or unknown
            off += ln
    return True, pointer, moff, authority

def read_mint_name(accounts, derive):
    """(source, name, symbol): source in None, ExternalPointer, Token2022, Metaplex. derive: role -> pubkey."""
    by_key = {}
    for a in accounts:
        by_key[a["pubkey"]] = a
    mint_acc = by_key.get(MINT)
    if mint_acc is None:
        return "None", None, None
    ok, pointer, moff, _ = parse_mint(mint_acc["owner"], mint_acc["data"])
    if not ok:
        return "None", None, None
    mpl_key = derive["metaplex"]
    if pointer != b"\x00" * 32 and pointer != MINT and pointer != mpl_key:
        return "ExternalPointer", None, None
    d = mint_acc["data"]
    if pointer == MINT:
        if moff == 0 or d[moff + 32: moff + 64] != MINT:
            return "None", None, None
        nl = u32(d, moff + 64)
        name = d[moff + 68: moff + 68 + nl]
        sp = moff + 68 + nl
        sl = u32(d, sp)
        return "Token2022", name, d[sp + 4: sp + 4 + sl]
    m = by_key.get(mpl_key)
    if m is None or m["owner"] != METAPLEX:
        return "None", None, None
    md = m["data"]
    if len(md) < 69 or md[0] != 4 or md[33:65] != MINT:
        return "None", None, None
    rn = u32(md, 65)
    if rn > 32 or len(md) - 69 < rn:
        return "None", None, None
    sa = 69 + rn
    if len(md) - sa < 4:
        return "None", None, None
    rs = u32(md, sa)
    if rs > 10 or len(md) - sa - 4 < rs:
        return "None", None, None
    l = rn
    while l != 0 and md[68 + l] == 0:
        l -= 1
    sl = rs
    while sl != 0 and md[sa + 3 + sl] == 0:
        sl -= 1
    return "Metaplex", md[69:69 + l], md[sa + 4: sa + 4 + sl]


def read_expect(source, name=None, symbol=None):
    r = {"source": source}
    if name is not None:
        r["name"] = hx(name)
        r["symbol"] = hx(symbol)
    return r

def verdict(read_name, read_symbol, source):
    """What the named factory's metadata path gives for a mint whose name was read as (read_name, read_symbol)."""
    if source in ("None",):
        return {"ok": False, "error": "NoName"}, read_expect("None")
    if source == "ExternalPointer":
        return {"ok": False, "error": "ExternalPointer"}, read_expect("ExternalPointer")
    read = read_expect(source, read_name, read_symbol)
    if len(read_name) == 0:
        return {"ok": False, "error": "NoName"}, read
    n = rome_name(read_name)
    if n is None:
        return {"ok": False, "error": "BadName"}, read
    s = rome_symbol(read_symbol)
    if s is None:
        return {"ok": False, "error": "BadSymbol"}, read
    return {"ok": True, "name": hx(n), "symbol": hx(s)}, read

def mint_vectors():
    out = []
    # Each consumer derives the mint's Metaplex account its own way; the reference only needs it to be distinct.
    derive = {"metaplex": bytes([0x0A] + [0x5D] * 31)}
    keys = {"mint": MINT, "metaplex": derive["metaplex"], "other": OTHER_ACCOUNT}
    programs = {"classic": TOKEN, "p2022": TOKEN_2022, "metaplex": METAPLEX, "other": OTHER_PROGRAM}

    def add(i, accounts, source, name=None, symbol=None):
        """`source`, `name` and `symbol` are what the entry's author expects; the reference reader must agree."""
        placed = []
        for a in accounts:
            data = bytearray.fromhex(a["data"][2:])
            for p in a.get("patch", []):
                data[p["offset"]: p["offset"] + 32] = derive[p["address"]]
            placed.append({"pubkey": keys[a["at"]], "owner": programs[a["owner"]], "data": bytes(data)})
        src, rn, rs = read_mint_name(placed, derive)
        if source != "?":
            assert src == source, (i, src, source)
            if name is not None:
                assert (rn, rs) == (name, symbol), (i, rn, rs)
        expect_, read = verdict(rn, rs, src)
        out.append({"id": i, "mint": hx(MINT), "accounts": accounts, "expect": expect_, "read": read})

    # Metaplex, no extension
    for i, (n, s) in {
        "metaplex/plain": (b"Wrapped SOL", b"SOL"),
        "metaplex/cut-name-25": (b"A" * 25, b"JitoSOL"),
        "metaplex/cut-name-26": (b"B" * 26, b"ABCDEFGH"),
        "metaplex/name-32": (b"C" * 32, b"ABCDEFGHI"),
        "metaplex/symbol-10": (b"Name", b"ABCDEFGHIJ"),
        "metaplex/multibyte-across-25": (b"A" * 24 + "é".encode() + b"Z", b"ABCDEFG" + "é".encode()),
        "metaplex/four-byte-symbol-fits-10": (b"Name", b"ABCDEF" + "\U0001F600".encode()),
        "metaplex/NO_NAME": (b"NO_NAME", b"SYM"),
        "metaplex/NO_SYMBOL": (b"Name", b"NO_SYMBOL"),
        "metaplex/NOT_VALID_ENCODING-name": (b"NOT_VALID_ENCODING", b"SYM"),
        "metaplex/NO_NAMES": (b"NO_NAMES", b"NO_SYMBOLS"),
        "metaplex/empty-symbol": (b"Name", b""),
        "metaplex/control-name": (b"Wrapped" + bytes.fromhex("c285") + b" SOL", b"SOL"),
        "metaplex/bidi-name": (b"A" * 25 + bytes.fromhex("e280ae"), b"SOL"),
        "metaplex/control-symbol": (b"Name", b"SO" + bytes.fromhex("c285") + b"L"),
        "metaplex/bidi-symbol": (b"Name", b"AB" + bytes.fromhex("e280ae")),
        "metaplex/bad-utf8-name": (b"AB\xc3", b"SYM"),
        "metaplex/bad-utf8-symbol": (b"Name", b"AB\x80C"),
        "metaplex/ro-in": (b"Ether", b"roETH"),
    }.items():
        add(i, [A("metaplex", "metaplex", mpl(MINT, n, s)), A("mint", "classic", base_mint())], "Metaplex", n, s)

    add("metaplex/name-padding-only", [A("metaplex", "metaplex", mpl(MINT, b"", b"SYM")), A("mint", "classic", base_mint())], "Metaplex", b"", b"SYM")
    add("metaplex/embedded-zero-name", [A("metaplex", "metaplex", mpl(MINT, b"AB\x00CD", b"SYM")), A("mint", "classic", base_mint())], "Metaplex", b"AB\x00CD", b"SYM")
    # Metaplex account that fails a check: no name
    add("metaplex/wrong-owner", [A("metaplex", "other", mpl(MINT, b"Name", b"SYM")), A("mint", "classic", base_mint())], "None")
    add("metaplex/wrong-mint", [A("metaplex", "metaplex", mpl(OTHER_MINT, b"Name", b"SYM")), A("mint", "classic", base_mint())], "None")
    add("metaplex/wrong-key", [A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM", key=1)), A("mint", "classic", base_mint())], "None")
    add("metaplex/name-over-32", [A("metaplex", "metaplex", mpl(MINT, b"N" * 33, b"SYM", name_pad=33)), A("mint", "classic", base_mint())], "None")
    add("metaplex/symbol-over-10", [A("metaplex", "metaplex", mpl(MINT, b"Name", b"S" * 11, symbol_pad=11)), A("mint", "classic", base_mint())], "None")
    good = mpl(MINT, b"Name", b"SYM")
    for cut_at in (0, 1, 32, 33, 64, 68, 69, 70, 100, 101, 104, 105, 106):
        add("metaplex/truncated-%d" % cut_at, [A("metaplex", "metaplex", good[:cut_at]), A("mint", "classic", base_mint())], "None")
    add("metaplex/name-length-past-end", [A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM", raw_name_len=32)[:80]), A("mint", "classic", base_mint())], "None")
    add("metaplex/symbol-length-past-end", [A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM", raw_symbol_len=10)[:105]), A("mint", "classic", base_mint())], "None")
    add("metaplex/absent", [A("mint", "classic", base_mint())], "None")
    add("mint/absent", [], "None")
    add("mint/wrong-owner", [A("mint", "other", base_mint()), A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM"))], "None")
    add("mint/not-initialised", [A("mint", "classic", base_mint()[:45] + b"\x00" + base_mint()[46:]), A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM"))], "None")
    add("mint/short", [A("mint", "classic", base_mint()[:81]), A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM"))], "None")
    add("mint/classic-long", [A("mint", "classic", base_mint() + b"\x00"), A("metaplex", "metaplex", mpl(MINT, b"Name", b"SYM"))], "None")

    # Token-2022: the mint's own entry
    own = lambda n, s: t2022([pointer_entry(MINT), (19, tm_value(MINT, n, s))])
    for i, (n, s) in {
        "t2022/self/plain": (b"ai16z", b"ai16z"),
        "t2022/self/long-name": (b"A very long token name of 40 bytes!!!!!!!", b"LONGSYMBOL123"),
        "t2022/self/multibyte-across-25": (b"A" * 24 + "é".encode() + b"Z", b"ABCDEF" + "\U0001F600".encode()),
        "t2022/self/multibyte-symbol-across-10": (b"Name", b"ABCDEFGHI" + "é".encode()),
        "t2022/self/four-byte-symbol-across-10": (b"Name", b"ABCDEFGH" + "\U0001F600".encode()),
        "t2022/self/NO_SYMBOL": (b"Name", b"NO_SYMBOL"),
        "t2022/self/NO_NAME": (b"NO_NAME", b"SYM"),
        "t2022/self/NOT_VALID_ENCODING-symbol": (b"Name", b"NOT_VALID_ENCODING"),
        "t2022/self/zero-embedded-symbol": (b"Name", b"SY\x00M"),
        "t2022/self/bidi-symbol-past-10": (b"Name", b"ABCDEFGHIJ" + bytes.fromhex("e280ae")),
        "t2022/self/c1-name": (b"Wrapped" + bytes.fromhex("c285") + b" SOL", b"SOL"),
        "t2022/self/zwsp-name": (b"A\xe2\x80\x8bB", b"SOL"),
        "t2022/self/tag-symbol": (b"Name", "AB\U000e0041".encode()),
        "t2022/self/bad-utf8-name": (b"AB\xed\xa0\x80", b"SYM"),
        "t2022/self/overlong-symbol": (b"Name", b"AB\xc0\x80"),
        "t2022/self/empty-symbol": (b"Name", b""),
        "t2022/self/long-symbol-200": (b"Name", b"S" * 200),
        "t2022/self/long-name-200": (b"N" * 200, b"SYM"),
    }.items():
        add(i, [A("mint", "p2022", own(n, s))], "Token2022", n, s)
    add("t2022/self/empty-name", [A("mint", "p2022", own(b"", b"SYM"))], "Token2022", b"", b"SYM")
    # an entry that names another mint: no name, even with a Metaplex account beside it
    add("t2022/self/entry-for-other-mint", [A("mint", "p2022", t2022([pointer_entry(MINT), (19, tm_value(OTHER_MINT, b"Name", b"SYM"))])), A("metaplex", "metaplex", mpl(MINT, b"Beside", b"BSD"))], "None")
    add("t2022/self/pointer-without-entry", [A("mint", "p2022", t2022([pointer_entry(MINT)])), A("metaplex", "metaplex", mpl(MINT, b"Beside", b"BSD"))], "None")
    # no pointer: Metaplex
    add("t2022/no-pointer/metaplex", [A("mint", "p2022", t2022([])), A("metaplex", "metaplex", mpl(MINT, b"Wrapped SOL", b"SOL"))], "Metaplex", b"Wrapped SOL", b"SOL")
    add("t2022/no-pointer/entry-ignored", [A("mint", "p2022", t2022([(19, tm_value(MINT, b"Entry", b"ENT"))])), A("metaplex", "metaplex", mpl(MINT, b"Beside", b"BSD"))], "Metaplex", b"Beside", b"BSD")
    add("t2022/no-pointer/no-metaplex", [A("mint", "p2022", t2022([]))], "None")
    # a zero pointer is no pointer
    add("t2022/zero-pointer/metaplex", [A("mint", "p2022", t2022([pointer_entry(b"\x00" * 32)])), A("metaplex", "metaplex", mpl(MINT, b"Wrapped SOL", b"SOL"))], "Metaplex", b"Wrapped SOL", b"SOL")
    # pointer to the mint's own Metaplex account: Metaplex
    # The pointer's address is the mint's own Metaplex account, which each consumer derives: `patch` says where to write it.
    add("t2022/pointer-to-own-metaplex", [dict(A("mint", "p2022", t2022([pointer_entry(b"\xee" * 32)])), patch=[{"offset": 202, "address": "metaplex"}]), A("metaplex", "metaplex", mpl(MINT, b"Wrapped SOL", b"SOL"))], "Metaplex", b"Wrapped SOL", b"SOL")
    # any other pointer is refused, whatever the account holds and whoever owns it
    add("t2022/external-pointer/well-formed-token-metadata", [A("mint", "p2022", t2022([pointer_entry(OTHER_ACCOUNT)])), A("other", "p2022", t2022([(19, tm_value(MINT, b"Name", b"SYM"))]))], "ExternalPointer")
    add("t2022/external-pointer/with-metaplex", [A("mint", "p2022", t2022([pointer_entry(OTHER_ACCOUNT)])), A("metaplex", "metaplex", mpl(MINT, b"Beside", b"BSD"))], "ExternalPointer")
    add("t2022/external-pointer/absent-target", [A("mint", "p2022", t2022([pointer_entry(OTHER_ACCOUNT)]))], "ExternalPointer")
    add("t2022/external-pointer/metaplex-of-other-mint", [A("mint", "p2022", t2022([pointer_entry(OTHER_ACCOUNT)])), A("other", "metaplex", mpl(MINT, b"Name", b"SYM"))], "ExternalPointer")
    # malformed Token-2022 data: no name, never read past the end
    good_t = own(b"Name", b"SYM")
    for cut_at in (166, 167, 168, 169, 170, 200, 234, 235, 236, 240, 245, 250, 255, len(good_t) - 1):
        add("t2022/truncated-%d" % cut_at, [A("mint", "p2022", good_t[:cut_at]), A("metaplex", "metaplex", mpl(MINT, b"Beside", b"BSD"))], "?")
    add("t2022/short-165", [A("mint", "p2022", good_t[:165])], "None")
    add("t2022/bad-account-type", [A("mint", "p2022", good_t[:165] + b"\x02" + good_t[166:])], "None")
    add("t2022/nonzero-padding", [A("mint", "p2022", good_t[:100] + b"\x01" + good_t[101:])], "None")
    add("t2022/unknown-extension", [A("mint", "p2022", t2022([pointer_entry(MINT), (99, b"\x00" * 4), (19, tm_value(MINT, b"Name", b"SYM"))]))], "None")
    add("t2022/extension-type-32", [A("mint", "p2022", t2022([(32, b"")])), A("metaplex", "metaplex", mpl(MINT, b"Beside", b"BSD"))], "None")
    add("t2022/account-side-extension", [A("mint", "p2022", t2022([(8, b""), pointer_entry(MINT), (19, tm_value(MINT, b"Name", b"SYM"))]))], "None")
    add("t2022/duplicate-extension", [A("mint", "p2022", t2022([pointer_entry(MINT), pointer_entry(MINT), (19, tm_value(MINT, b"Name", b"SYM"))]))], "None")
    add("t2022/type-zero-entry", [A("mint", "p2022", t2022([(0, b"\x00" * 4)]))], "None")
    add("t2022/pointer-bad-length", [A("mint", "p2022", t2022([(18, b"\x00" * 63), (19, tm_value(MINT, b"Name", b"SYM"))]))], "None")
    add("t2022/metadata-name-length-past-entry", [A("mint", "p2022", t2022([pointer_entry(MINT), (19, (b"\x33" * 32) + MINT + struct.pack("<I", 4000) + b"Name" + struct.pack("<I", 3) + b"SYM" + struct.pack("<I", 0) + struct.pack("<I", 0))]))], "None")
    add("t2022/metadata-trailing-byte", [A("mint", "p2022", t2022([pointer_entry(MINT), (19, tm_value(MINT, b"Name", b"SYM") + b"\x00")]))], "None")
    add("t2022/metadata-pairs", [A("mint", "p2022", t2022([pointer_entry(MINT), (19, tm_value(MINT, b"Name", b"SYM", pairs=0))]))], "Token2022", b"Name", b"SYM")
    add("t2022/trailing-garbage", [A("mint", "p2022", good_t + b"\x00")], "None")
    add("t2022/bad-authority-tag", [A("mint", "p2022", struct.pack("<I", 2) + good_t[4:])], "None")
    # other extensions that are walked and carry no name
    add("t2022/with-other-extensions", [A("mint", "p2022", t2022([(3, b"\x44" * 32), pointer_entry(MINT), (19, tm_value(MINT, b"Name", b"SYM"))]))], "Token2022", b"Name", b"SYM")
    # a Token-2022 mint whose pointer names itself and whose symbol is too long for Metaplex is fine here
    return out

# ---- the authority path ------------------------------------------------------------------

def authority_vectors():
    """The authority path names by the same rule: its two strings are the caller's."""
    out = []
    for i, n, s in [
        ("plain", b"My Token", b"MYT"),
        ("long-name", b"N" * 40, b"S" * 20),
        ("multibyte", b"A" * 24 + "é".encode(), b"ABCDEFG" + "é".encode()),
        ("multibyte-symbol-across-10", b"Name", b"ABCDEFGHI" + "é".encode()),
        ("empty-name", b"", b"SYM"),
        ("empty-symbol", b"Name", b""),
        ("NO_NAME", b"NO_NAME", b"SYM"),
        ("NO_SYMBOL", b"Name", b"NO_SYMBOL"),
        ("bidi-name", b"A" * 25 + bytes.fromhex("e280ae"), b"SYM"),
        ("bidi-symbol", b"Name", b"ABCDEFGHIJ" + bytes.fromhex("e280ae")),
        ("bad-utf8-name", b"AB\xc3", b"SYM"),
        ("bad-utf8-symbol", b"Name", b"\xe2\x82"),
    ]:
        name, symbol = rome_name(n), rome_symbol(s)
        if name is None:
            e = {"ok": False, "error": "BadName"}
        elif symbol is None:
            e = {"ok": False, "error": "BadSymbol"}
        else:
            e = {"ok": True, "name": hx(name), "symbol": hx(symbol)}
        out.append({"id": "authority/" + i, "originName": hx(n), "originSymbol": hx(s), "expect": e})
    return out

doc = {
    "description": "Shared vectors for the Rome wrapper naming rule. See generate.py. 'at' says which account an entry is: "
                   "'mint', 'metaplex' (the mint's own Metaplex metadata account, wherever the consumer derives it) or "
                   "'other' (OTHER_ACCOUNT). An owner of 'classic', 'p2022', 'metaplex' or 'other' maps to the "
                   "programs below ('other' is OTHER_PROGRAM). An entry with `patch` has 32 bytes at `offset` overwritten with the "
                   "address named ('metaplex': the mint's own Metaplex account, derived by the consumer). `read` is what a mint reader returns as the "
                   "mint's own name (source None, ExternalPointer, Token2022 or Metaplex, and the strings as stored); "
                   "`expect` is the wrapper factory's verdict: the two Rome strings or one refusal.",
    "unicodeVersion": unicodedata.unidata_version,
    "constants": {
        "classicProgram": hx(TOKEN), "program2022": hx(TOKEN_2022), "metaplexProgram": hx(METAPLEX), "otherProgram": hx(OTHER_PROGRAM),
        "mint": hx(MINT), "otherMint": hx(OTHER_MINT), "otherAccount": hx(OTHER_ACCOUNT),
        "mintAuthority": hx(b"\x22" * 32),
    },
    "table": RANGES,
    "text": text_vectors(),
    "mints": mint_vectors(),
    "authority": authority_vectors(),
}

json.dump(doc, sys.stdout, indent=1)
sys.stdout.write("\n")
