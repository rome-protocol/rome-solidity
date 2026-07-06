// scripts/bridge/set-wormhole-allowlist.ts
//
// Owner-only Wormhole allowlist setter for the LIVE RomeBridgeWithdraw. Enables
// asset wrappers and/or target chains on the already-deployed contract via
// setWormholeAssetAllowed / setWormholeTargetChainAllowed — NO redeploy.
//
// Reads the RomeBridgeWithdraw address from deployments/<network>.json and the
// items to enable from the environment (either may be empty):
//   WORMHOLE_ASSET_WRAPPERS  comma-separated 0x wrapper addresses
//   WORMHOLE_TARGET_CHAINS   comma-separated uint16 Wormhole chain ids
//
// Safety:
//   - Asserts the signer == owner() BEFORE any tx (setters are onlyOwner; this
//     turns a would-be revert into a clear early error).
//   - Idempotent: skips entries already allowed.
//   - Verifies each entry read-back == true after its tx (fails loud otherwise).
//
// Runs via the reviewer-gated contract-deploys `bridge-allowlist.yml` workflow
// (deployer key injected as env), or manually:
//   WORMHOLE_ASSET_WRAPPERS=0x8c2c14..,0x1dece0.. WORMHOLE_TARGET_CHAINS=23 \
//     npx hardhat run scripts/bridge/set-wormhole-allowlist.ts --network hadrian

import hardhat from "hardhat";
import { readDeployments } from "../lib/deployments.js";

function parseList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [signer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const d = readDeployments(networkName) as Record<string, { address?: string }>;
  const withdrawAddr = d["RomeBridgeWithdraw"]?.address as `0x${string}` | undefined;
  if (!withdrawAddr) {
    throw new Error(
      `[${networkName}] no RomeBridgeWithdraw in deployments/${networkName}.json — deploy it first`,
    );
  }

  const wrappers = parseList(process.env.WORMHOLE_ASSET_WRAPPERS) as `0x${string}`[];
  const chains = parseList(process.env.WORMHOLE_TARGET_CHAINS).map((c) => Number(c));
  if (wrappers.length === 0 && chains.length === 0) {
    throw new Error("nothing to do — set WORMHOLE_ASSET_WRAPPERS and/or WORMHOLE_TARGET_CHAINS");
  }
  for (const c of chains) {
    if (!Number.isInteger(c) || c <= 0 || c > 65535) {
      throw new Error(`invalid Wormhole chain id: ${c} (must be 1..65535)`);
    }
  }

  const withdraw = await viem.getContractAt("RomeBridgeWithdraw", withdrawAddr);

  // ── onlyOwner guard: fail early + loud if the signer isn't the owner ──
  const owner = (await withdraw.read.owner()) as `0x${string}`;
  const me = signer.account.address;
  console.log(`[${networkName}] RomeBridgeWithdraw ${withdrawAddr}`);
  console.log(`[${networkName}] owner=${owner} signer=${me}`);
  if (owner.toLowerCase() !== me.toLowerCase()) {
    throw new Error(
      `signer ${me} is not the owner ${owner} — setWormhole* are onlyOwner. ` +
        `Use the owner key, or transferOwnership to this signer first.`,
    );
  }

  for (const chainId of chains) {
    if ((await withdraw.read.wormholeTargetChainAllowed([chainId])) as boolean) {
      console.log(`[${networkName}] target chain ${chainId} already allowed — skip`);
      continue;
    }
    console.log(`[${networkName}] setWormholeTargetChainAllowed(${chainId}, true) …`);
    const hash = await withdraw.write.setWormholeTargetChainAllowed([chainId, true]);
    await publicClient.waitForTransactionReceipt({ hash });
    if (!((await withdraw.read.wormholeTargetChainAllowed([chainId])) as boolean)) {
      throw new Error(`verify failed: target chain ${chainId} not allowed after tx ${hash}`);
    }
    console.log(`[${networkName}]   ✓ chain ${chainId} allowed (tx ${hash})`);
  }

  for (const wrapper of wrappers) {
    if ((await withdraw.read.wormholeAssetAllowed([wrapper])) as boolean) {
      console.log(`[${networkName}] asset ${wrapper} already allowed — skip`);
      continue;
    }
    console.log(`[${networkName}] setWormholeAssetAllowed(${wrapper}, true) …`);
    const hash = await withdraw.write.setWormholeAssetAllowed([wrapper, true]);
    await publicClient.waitForTransactionReceipt({ hash });
    if (!((await withdraw.read.wormholeAssetAllowed([wrapper])) as boolean)) {
      throw new Error(`verify failed: asset ${wrapper} not allowed after tx ${hash}`);
    }
    console.log(`[${networkName}]   ✓ asset ${wrapper} allowed (tx ${hash})`);
  }

  console.log(`[${networkName}] Wormhole allowlist update complete.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
