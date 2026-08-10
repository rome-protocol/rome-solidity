import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";

// The generic SPL facade intentionally supports broader Token-2022 shapes,
// including transfer-fee mints. That is useful for general interoperability but
// is not safe to present as the ordinary ERC-20 facade used by the RWA/Morpho
// route. This test fixes the narrower admission contract in executable form.
describe("RWA standard Token-2022 wrapper admission", async () => {
    const HELPER = "0xff00000000000000000000000000000000000009";
    const SPL_CACHED = "0xff00000000000000000000000000000000000005";
    const SYSTEM = "0xff00000000000000000000000000000000000007";

    const conn = await network.connect();
    const { viem } = conn;
    const mock = await viem.deployContract("MintInfoMock");
    const code = await (await viem.getPublicClient()).getCode({ address: mock.address });
    assert.ok(code && code !== "0x", "mint-info mock must be deployable");

    for (const address of [HELPER, SPL_CACHED, SYSTEM]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [address, code] });
    }

    function mintId(
        token2022: boolean,
        hookArmed: boolean,
        feeBps: number,
        tag: number,
    ): `0x${string}` {
        const bytes = new Uint8Array(32);
        bytes[0] = 6;
        bytes[1] = hookArmed ? 1 : 0;
        bytes[2] = (feeBps >> 8) & 0xff;
        bytes[3] = feeBps & 0xff;
        bytes[4] = token2022 ? 0 : 1;
        bytes[31] = tag;
        return `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
    }

    async function deploy(mint: `0x${string}`) {
        const users = await viem.deployContract("ERC20Users");
        return viem.deployContract("SPL_ERC20_RwaStandard", [
            mint,
            "0xff00000000000000000000000000000000000008",
            "Approved Asset",
            "RWA",
            users.address,
        ]);
    }

    it("accepts the hook-less, zero-fee Token-2022 transfer profile", async () => {
        const wrapper = await deploy(mintId(true, false, 0, 1));
        assert.equal(await wrapper.read.decimals(), 6);
    });

    it("rejects a legacy SPL mint", async () => {
        await assert.rejects(deploy(mintId(false, false, 0, 2)), /RwaStandardToken2022Required/);
    });

    it("rejects a transfer-fee mint", async () => {
        await assert.rejects(deploy(mintId(true, false, 25, 3)), /RwaStandardTransferFeeUnsupported/);
    });

    it("rejects an armed transfer hook", async () => {
        await assert.rejects(deploy(mintId(true, true, 0, 4)), /ArmedTransferHookUnsupported/);
    });

    it("records the strict facade as the mint's canonical factory wrapper", async () => {
        const factory = await viem.deployContract("ERC20SPLFactory", [
            "0xff00000000000000000000000000000000000008",
        ]);
        const mint = mintId(true, false, 0, 5);
        await factory.write.add_rwa_standard_token_no_metadata([
            mint,
            "Approved Asset",
            "RWA2",
        ]);

        const wrapper = await factory.read.token_by_mint([mint]);
        assert.notEqual(wrapper, "0x0000000000000000000000000000000000000000");
        assert.equal(await factory.read.wrapper_kind_by_mint([mint]), 3);
    });
});
