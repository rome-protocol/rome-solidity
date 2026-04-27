import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type WalletClient,
} from "viem";

// touch() selector: keccak256("touch()")[0..4] = 0xa55526db
const TOUCH_SELECTOR = "0xa55526db" as `0x${string}`;

// EIP-712 typehash for OZ ERC2771Forwarder ForwardRequest
const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
} as const;

async function signForwardRequest(
  walletClient: WalletClient,
  paymasterAddress: Address,
  chainId: number,
  request: {
    from: Address;
    to: Address;
    value: bigint;
    gas: bigint;
    nonce: bigint;
    deadline: number;
    data: `0x${string}`;
  }
): Promise<`0x${string}`> {
  return walletClient.signTypedData({
    account: walletClient.account!,
    domain: {
      name: "RomeBridgePaymaster",
      version: "1",
      chainId,
      verifyingContract: paymasterAddress,
    },
    types: FORWARD_REQUEST_TYPES,
    primaryType: "ForwardRequest",
    message: request,
  });
}

describe("RomeBridgePaymaster", () => {
  let viem: Awaited<ReturnType<typeof hardhat.network.connect>>["viem"];
  let paymaster: any;
  let mockTarget: any;
  let admin: Address;
  let user: Address;
  let adminWallet: WalletClient;
  let userWallet: WalletClient;
  let chainId: number;

  before(async () => {
    const conn = await hardhat.network.connect({ network: "hardhatMainnet" });
    viem = conn.viem;
    const [adminClient, userClient] = await viem.getWalletClients();
    adminWallet = adminClient;
    userWallet = userClient;
    admin = adminClient.account.address;
    user = userClient.account.address;
    const pc = await viem.getPublicClient();
    chainId = await pc.getChainId();
  });

  beforeEach(async () => {
    paymaster = await viem.deployContract("RomeBridgePaymaster", [admin]);
    mockTarget = await viem.deployContract("MockBridgeTarget", [
      paymaster.address,
    ]);
  });

  // ─── Task 6: counter basics ───────────────────────────────────────────────

  it("starts every user with a 0 sponsored-tx count", async () => {
    const count = await paymaster.read.sponsoredTxCount([user]);
    assert.strictEqual(count, 0);
  });

  it("exposes the per-user cap as a public state var (default 3)", async () => {
    const cap = await paymaster.read.sponsoredTxCap();
    assert.strictEqual(cap, 3);
  });

  // ─── Task 8: EIP-712 meta-tx via OZ ERC2771Forwarder ─────────────────────

  it("executes a valid meta-tx, increments sponsoredTxCount, and rewrites msg.sender via ERC2771", async () => {
    // First allowlist the (target, selector) pair
    await paymaster.write.setAllowlistEntry(
      [mockTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    const pc = await viem.getPublicClient();
    const nonce = await paymaster.read.nonces([user]);
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    const data = encodeFunctionData({
      abi: parseAbi(["function touch()"]),
      functionName: "touch",
    });

    const request = {
      from: user,
      to: mockTarget.address as Address,
      value: 0n,
      gas: 100_000n,
      nonce,
      deadline,
      data: data as `0x${string}`,
    };

    const signature = await signForwardRequest(
      userWallet,
      paymaster.address,
      chainId,
      request
    );

    const forwardRequestData = {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    };

    const tx = await paymaster.write.execute([forwardRequestData], {
      account: adminWallet.account,
    });
    await pc.waitForTransactionReceipt({ hash: tx });

    const count = await paymaster.read.sponsoredTxCount([user]);
    assert.strictEqual(count, 1);

    const lastCaller = await mockTarget.read.lastCaller();
    assert.strictEqual(lastCaller.toLowerCase(), user.toLowerCase());
  });

  it("rejects a meta-tx with an invalid signature", async () => {
    await paymaster.write.setAllowlistEntry(
      [mockTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    const nonce = await paymaster.read.nonces([user]);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const data = encodeFunctionData({
      abi: parseAbi(["function touch()"]),
      functionName: "touch",
    });

    const request = {
      from: user,
      to: mockTarget.address as Address,
      value: 0n,
      gas: 100_000n,
      nonce,
      deadline,
      data: data as `0x${string}`,
    };

    // Sign with admin instead of user — wrong signer
    const badSignature = await signForwardRequest(
      adminWallet,
      paymaster.address,
      chainId,
      request
    );

    const forwardRequestData = {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature: badSignature,
    };

    await assert.rejects(
      () =>
        paymaster.write.execute([forwardRequestData], {
          account: adminWallet.account,
        }),
      /ERC2771ForwarderInvalidSigner|InvalidSigner/
    );
  });

  it("rejects sponsorship when the user has exhausted their 3-tx budget", async () => {
    await paymaster.write.setAllowlistEntry(
      [mockTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    const pc = await viem.getPublicClient();

    // Execute 3 meta-txs to exhaust the budget
    for (let i = 0; i < 3; i++) {
      const nonce = await paymaster.read.nonces([user]);
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const data = encodeFunctionData({
        abi: parseAbi(["function touch()"]),
        functionName: "touch",
      });
      const request = {
        from: user,
        to: mockTarget.address as Address,
        value: 0n,
        gas: 100_000n,
        nonce,
        deadline,
        data: data as `0x${string}`,
      };
      const signature = await signForwardRequest(
        userWallet,
        paymaster.address,
        chainId,
        request
      );
      const forwardRequestData = {
        from: request.from,
        to: request.to,
        value: request.value,
        gas: request.gas,
        deadline: request.deadline,
        data: request.data,
        signature,
      };
      const tx = await paymaster.write.execute([forwardRequestData], {
        account: adminWallet.account,
      });
      await pc.waitForTransactionReceipt({ hash: tx });
    }

    const count = await paymaster.read.sponsoredTxCount([user]);
    assert.strictEqual(count, 3);

    // 4th attempt should revert with BudgetExhausted
    const nonce = await paymaster.read.nonces([user]);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const data = encodeFunctionData({
      abi: parseAbi(["function touch()"]),
      functionName: "touch",
    });
    const request = {
      from: user,
      to: mockTarget.address as Address,
      value: 0n,
      gas: 100_000n,
      nonce,
      deadline,
      data: data as `0x${string}`,
    };
    const signature = await signForwardRequest(
      userWallet,
      paymaster.address,
      chainId,
      request
    );
    const forwardRequestData = {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    };

    await assert.rejects(
      () =>
        paymaster.write.execute([forwardRequestData], {
          account: adminWallet.account,
        }),
      /BudgetExhausted/
    );
  });

  it("emits PaymasterSponsored with the correct remainingBudget on each meta-tx", async () => {
    await paymaster.write.setAllowlistEntry(
      [mockTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    const pc = await viem.getPublicClient();
    const nonce = await paymaster.read.nonces([user]);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const data = encodeFunctionData({
      abi: parseAbi(["function touch()"]),
      functionName: "touch",
    });
    const request = {
      from: user,
      to: mockTarget.address as Address,
      value: 0n,
      gas: 100_000n,
      nonce,
      deadline,
      data: data as `0x${string}`,
    };
    const signature = await signForwardRequest(
      userWallet,
      paymaster.address,
      chainId,
      request
    );
    const forwardRequestData = {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    };

    const tx = await paymaster.write.execute([forwardRequestData], {
      account: adminWallet.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });

    const events = await paymaster.getEvents.PaymasterSponsored(
      { user },
      { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber }
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].args.remainingBudget, 2);
  });

  // ─── Task 9: (target, selector) allowlist ────────────────────────────────

  it("rejects a meta-tx to a non-allowlisted (target, selector) with TargetNotAllowed", async () => {
    // Do NOT call setAllowlistEntry — touch() is blocked by default
    const nonce = await paymaster.read.nonces([user]);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const data = encodeFunctionData({
      abi: parseAbi(["function touch()"]),
      functionName: "touch",
    });
    const request = {
      from: user,
      to: mockTarget.address as Address,
      value: 0n,
      gas: 100_000n,
      nonce,
      deadline,
      data: data as `0x${string}`,
    };
    const signature = await signForwardRequest(
      userWallet,
      paymaster.address,
      chainId,
      request
    );
    const forwardRequestData = {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    };

    await assert.rejects(
      () =>
        paymaster.write.execute([forwardRequestData], {
          account: adminWallet.account,
        }),
      /TargetNotAllowed/
    );
  });

  it("allows a meta-tx after admin adds (target, selector) to the allowlist", async () => {
    const pc = await viem.getPublicClient();

    // Admin enables touch() on mockTarget
    await paymaster.write.setAllowlistEntry(
      [mockTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    const isAllowed = await paymaster.read.allowlist([
      mockTarget.address,
      TOUCH_SELECTOR,
    ]);
    assert.strictEqual(isAllowed, true);

    // Now the meta-tx should succeed
    const nonce = await paymaster.read.nonces([user]);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const data = encodeFunctionData({
      abi: parseAbi(["function touch()"]),
      functionName: "touch",
    });
    const request = {
      from: user,
      to: mockTarget.address as Address,
      value: 0n,
      gas: 100_000n,
      nonce,
      deadline,
      data: data as `0x${string}`,
    };
    const signature = await signForwardRequest(
      userWallet,
      paymaster.address,
      chainId,
      request
    );
    const forwardRequestData = {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    };

    const tx = await paymaster.write.execute([forwardRequestData], {
      account: adminWallet.account,
    });
    await pc.waitForTransactionReceipt({ hash: tx });

    const count = await paymaster.read.sponsoredTxCount([user]);
    assert.strictEqual(count, 1);
  });

  it("rejects setAllowlistEntry from non-owner", async () => {
    await assert.rejects(
      () =>
        paymaster.write.setAllowlistEntry(
          [mockTarget.address, TOUCH_SELECTOR, true],
          { account: userWallet.account }
        ),
      /OwnableUnauthorizedAccount|Unauthorized/
    );
  });

  it("emits AllowlistUpdated when entry changes", async () => {
    const pc = await viem.getPublicClient();
    const latestBlock = await pc.getBlockNumber();

    await paymaster.write.setAllowlistEntry(
      [mockTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    const events = await paymaster.getEvents.AllowlistUpdated(
      { target: mockTarget.address, selector: TOUCH_SELECTOR },
      { fromBlock: latestBlock }
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].args.allowed, true);
  });

  // ─── C1 regression: executeBatch drain fix ───────────────────────────────

  it("does NOT charge sponsorship budget in executeBatch when signature is invalid (C1 regression)", async () => {
    // victim = third wallet; attacker = fourth wallet
    const allWallets = await viem.getWalletClients();
    const victimWallet = allWallets[2];
    const attackerWallet = allWallets[3];
    const victim = victimWallet.account.address;

    // Deploy a fresh allowlisted target
    const allowlistedTarget = await viem.deployContract("MockBridgeTarget", [
      paymaster.address,
    ]);
    await paymaster.write.setAllowlistEntry(
      [allowlistedTarget.address, TOUCH_SELECTOR, true],
      { account: adminWallet.account }
    );

    // Build a forged request: from = victim, nonce from victim's slot,
    // but signed by attacker — the signature is invalid for this request.
    const nonce = await paymaster.read.nonces([victim]);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const badSignature = await attackerWallet.signTypedData({
      account: attackerWallet.account!,
      domain: {
        name: "RomeBridgePaymaster",
        version: "1",
        chainId,
        verifyingContract: paymaster.address,
      },
      types: FORWARD_REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: {
        from: victim,
        to: allowlistedTarget.address as `0x${string}`,
        value: 0n,
        gas: 100_000n,
        nonce,
        deadline,
        data: TOUCH_SELECTOR,
      },
    });

    // The ForwardRequestData struct that the contract receives (no nonce field —
    // nonce is encoded inside the signature's EIP-712 typed data only).
    const forgedRequest = {
      from: victim,
      to: allowlistedTarget.address as `0x${string}`,
      value: 0n,
      gas: 100_000n,
      deadline,
      data: TOUCH_SELECTOR,
      signature: badSignature,
    };

    // executeBatch with a non-zero refundReceiver (admin) => requireValidRequest=false.
    // OZ skips the invalid request silently (returns success=false per request).
    // After the fix, victim's budget must NOT be charged.
    await paymaster.write.executeBatch([[forgedRequest], admin], {
      account: adminWallet.account,
    });

    // Victim's budget MUST remain at 0.
    const count = await paymaster.read.sponsoredTxCount([victim]);
    assert.strictEqual(count, 0);
  });

  // ─── Hardening A1: Pausable ──────────────────────────────────────────────

  describe("Pausable (A1 — incident response)", () => {
    it("starts unpaused", async () => {
      const paused = await paymaster.read.paused();
      assert.strictEqual(paused, false);
    });

    it("owner can pause + unpause", async () => {
      const pc = await viem.getPublicClient();
      const tx1 = await paymaster.write.pause({ account: adminWallet.account });
      await pc.waitForTransactionReceipt({ hash: tx1 });
      assert.strictEqual(await paymaster.read.paused(), true);
      const tx2 = await paymaster.write.unpause({ account: adminWallet.account });
      await pc.waitForTransactionReceipt({ hash: tx2 });
      assert.strictEqual(await paymaster.read.paused(), false);
    });

    it("non-owner cannot pause", async () => {
      await assert.rejects(
        async () => paymaster.write.pause({ account: userWallet.account }),
        (err: any) => /OwnableUnauthorizedAccount|Ownable/.test(String(err?.message ?? err)),
      );
    });

    it("execute() reverts while paused; resumes after unpause", async () => {
      await paymaster.write.setAllowlistEntry(
        [mockTarget.address, TOUCH_SELECTOR, true],
        { account: adminWallet.account },
      );
      const pc = await viem.getPublicClient();
      await pc.waitForTransactionReceipt({
        hash: await paymaster.write.pause({ account: adminWallet.account }),
      });

      const nonce = await paymaster.read.nonces([user]);
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const data = encodeFunctionData({
        abi: parseAbi(["function touch()"]),
        functionName: "touch",
      });
      const request = { from: user, to: mockTarget.address as Address, value: 0n, gas: 100_000n, nonce, deadline, data: data as `0x${string}` };
      const signature = await signForwardRequest(userWallet, paymaster.address, chainId, request);
      const fwd = { from: request.from, to: request.to, value: request.value, gas: request.gas, deadline: request.deadline, data: request.data, signature };

      // Paused: must revert
      await assert.rejects(
        async () => paymaster.write.execute([fwd], { account: adminWallet.account }),
        (err: any) => /EnforcedPause|paused/i.test(String(err?.message ?? err)),
      );

      // Unpause and retry — must succeed (and NOT consume nonce on the failed try
      // since the revert reverted state)
      await pc.waitForTransactionReceipt({
        hash: await paymaster.write.unpause({ account: adminWallet.account }),
      });
      const tx = await paymaster.write.execute([fwd], { account: adminWallet.account });
      await pc.waitForTransactionReceipt({ hash: tx });
      assert.strictEqual(await paymaster.read.sponsoredTxCount([user]), 1);
    });
  });

  // ─── Hardening A4: SPONSORED_TX_CAP — owner-mutable ──────────────────────

  describe("Mutable sponsorship cap (A4)", () => {
    it("defaults to 3 in constructor", async () => {
      const cap = await paymaster.read.sponsoredTxCap();
      assert.strictEqual(cap, 3);
    });

    it("owner can raise the cap; users with already-exhausted budget can be sponsored again", async () => {
      const pc = await viem.getPublicClient();
      // Burn through 3 tx for the user
      await paymaster.write.setAllowlistEntry(
        [mockTarget.address, TOUCH_SELECTOR, true],
        { account: adminWallet.account },
      );
      const data = encodeFunctionData({ abi: parseAbi(["function touch()"]), functionName: "touch" });
      for (let i = 0; i < 3; i++) {
        const nonce = await paymaster.read.nonces([user]);
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const req = { from: user, to: mockTarget.address as Address, value: 0n, gas: 100_000n, nonce, deadline, data: data as `0x${string}` };
        const sig = await signForwardRequest(userWallet, paymaster.address, chainId, req);
        const fwd = { from: req.from, to: req.to, value: req.value, gas: req.gas, deadline: req.deadline, data: req.data, signature: sig };
        await pc.waitForTransactionReceipt({
          hash: await paymaster.write.execute([fwd], { account: adminWallet.account }),
        });
      }
      assert.strictEqual(await paymaster.read.sponsoredTxCount([user]), 3);

      // Raise cap to 5 — user can now be sponsored two more times
      await pc.waitForTransactionReceipt({
        hash: await paymaster.write.setSponsoredTxCap([5], { account: adminWallet.account }),
      });
      assert.strictEqual(await paymaster.read.sponsoredTxCap(), 5);

      const nonce = await paymaster.read.nonces([user]);
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const req = { from: user, to: mockTarget.address as Address, value: 0n, gas: 100_000n, nonce, deadline, data: data as `0x${string}` };
      const sig = await signForwardRequest(userWallet, paymaster.address, chainId, req);
      const fwd = { from: req.from, to: req.to, value: req.value, gas: req.gas, deadline: req.deadline, data: req.data, signature: sig };
      await pc.waitForTransactionReceipt({
        hash: await paymaster.write.execute([fwd], { account: adminWallet.account }),
      });
      assert.strictEqual(await paymaster.read.sponsoredTxCount([user]), 4);
    });

    it("non-owner cannot change the cap", async () => {
      await assert.rejects(
        async () => paymaster.write.setSponsoredTxCap([10], { account: userWallet.account }),
        (err: any) => /OwnableUnauthorizedAccount|Ownable/.test(String(err?.message ?? err)),
      );
    });
  });
});
