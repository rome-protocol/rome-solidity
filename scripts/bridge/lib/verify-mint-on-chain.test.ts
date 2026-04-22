import { describe, it, expect, vi } from "vitest";
import { verifyMintOnChain } from "./verify-mint-on-chain.js";

function mockConnection(response: { owner: string | null; executable: boolean }) {
  return {
    getAccountInfo: vi.fn(async () =>
      response.owner
        ? { owner: { toBase58: () => response.owner, equals: () => false }, executable: response.executable }
        : null,
    ),
  } as unknown as import("@solana/web3.js").Connection;
}

describe("verifyMintOnChain", () => {
  it("resolves true when account is owned by SPL Token program", async () => {
    const conn = mockConnection({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false });
    const ok = await verifyMintOnChain(
      conn,
      "H9Y7B8L9K4HMjyzXwFy8JxDhzyF5cNaxP1wFDUQR6Vx2", // placeholder pubkey — content doesn't matter with mock
    );
    expect(ok).toBe(true);
  });

  it("throws when account is missing", async () => {
    const conn = mockConnection({ owner: null, executable: false });
    await expect(
      verifyMintOnChain(conn, "H9Y7B8L9K4HMjyzXwFy8JxDhzyF5cNaxP1wFDUQR6Vx2"),
    ).rejects.toThrow(/not found on-chain/);
  });

  it("throws when account owner is unexpected", async () => {
    const conn = mockConnection({ owner: "11111111111111111111111111111111", executable: false });
    await expect(
      verifyMintOnChain(conn, "H9Y7B8L9K4HMjyzXwFy8JxDhzyF5cNaxP1wFDUQR6Vx2"),
    ).rejects.toThrow(/owner mismatch/);
  });
});
