import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { associatedTokenAddress, bridgedMintsFrom } from "./ensure-bridge-atas.js";

// Hadrian RomeBridgeWithdraw v10 (0x49e5b8d7…) — bridge PDA and the three ATAs,
// derived independently with @solana/spl-token on 2026-09-09.
const BRIDGE_PDA = "DLU6AuvsMLTps8qg1kUHhfTwijnRFAyp5g8csdEjv1Dk";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WETH = "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs";
const WSOL = "So11111111111111111111111111111111111111112";

describe("associatedTokenAddress", () => {
  it("derives the bridge PDA's ATA for each bridged mint (off-curve owner)", () => {
    const pda = new PublicKey(BRIDGE_PDA);
    expect(associatedTokenAddress(pda, new PublicKey(USDC)).toBase58()).toBe(
      "Eg2itrCWBTaz78KViToDd2hbsRu4nyWNzbfqy6gkDDkj",
    );
    expect(associatedTokenAddress(pda, new PublicKey(WETH)).toBase58()).toBe(
      "HCLAwGWdLjX638Zpk9mV1qan8QWwMR4uTEH3M6jessAM",
    );
    expect(associatedTokenAddress(pda, new PublicKey(WSOL)).toBase58()).toBe(
      "4KZWKmTd5sigCTy6LrV3T6kuEvxaYhFDxbdTQeuAhjBG",
    );
  });
});

describe("bridgedMintsFrom", () => {
  const deployments = {
    SPL_ERC20_USDC: { address: "0xae28", mintId: USDC, symbol: "wUSDC" },
    SPL_ERC20_WETH: { address: "0xd696", mintId: WETH, symbol: "wETH" },
    SPL_ERC20_WSOL: { address: "0x30ae", mintId: WSOL, symbol: "wSOL" },
    // a cached-track test wrapper carries `mint` as bytes32 hex, not a mintId — not a bridged asset
    SPL_ERC20_cached: { address: "0x979c", mint: "0xe129…", symbol: "wTESTc" },
    RomeBridgeWithdraw: { address: "0x49e5" },
  };

  it("with no explicit list, takes every SPL_ERC20_* wrapper that carries a base58 mintId", () => {
    expect(bridgedMintsFrom(deployments, undefined).map((m) => m.symbol)).toEqual(["wUSDC", "wETH", "wSOL"]);
    expect(bridgedMintsFrom(deployments, "").map((m) => m.mint)).toEqual([USDC, WETH, WSOL]);
  });

  it("an explicit comma list wins verbatim and is labelled by the matching wrapper when known", () => {
    const out = bridgedMintsFrom(deployments, ` ${WETH}, ${USDC} `);
    expect(out.map((m) => m.mint)).toEqual([WETH, USDC]);
    expect(out.map((m) => m.symbol)).toEqual(["wETH", "wUSDC"]);
  });

  it("an explicit mint the deployments file does not know is still accepted, labelled by its mint", () => {
    const other = "2gsErzRCTA7T6hGnYo44EnpP7hP79CHQerDhtmggkZZF";
    expect(bridgedMintsFrom(deployments, other)).toEqual([{ mint: other, symbol: other.slice(0, 8) + "…" }]);
  });

  it("rejects a malformed mint instead of sending it to the owner call", () => {
    expect(() => bridgedMintsFrom(deployments, "not-a-pubkey")).toThrow(/not a Solana pubkey/);
  });

  it("with nothing to do it throws — an empty run must never look like success", () => {
    expect(() => bridgedMintsFrom({ RomeBridgeWithdraw: { address: "0x49e5" } }, undefined)).toThrow(/no bridged mints/);
  });
});
