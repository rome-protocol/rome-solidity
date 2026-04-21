import { expect } from "chai";
import { ethers } from "hardhat";

describe("AdapterMetadata", () => {
  const MOCK_PYTH_PROGRAM = "0x0cb7fabb52f7a648bb5b317d9a018b9057cb024774fafe01e6c4df98cc385881";
  const MOCK_SB_PROGRAM = "0x068851c68c6832f02fa581b1bf491b77ca41776ba2b988b5a6faba8ee3a2ec90";

  // OracleSource enum values (must match IAdapterMetadata.OracleSource)
  const SRC_PYTH = 0;
  const SRC_SWITCHBOARD = 1;

  describe("PythPullAdapter.metadata()", () => {
    it("returns the values passed at initialize", async () => {
      // Deploy a standalone adapter (no factory) for pure unit testing.
      const Adapter = await ethers.getContractFactory("PythPullAdapter");
      const adapter = await Adapter.deploy();

      const account = "0x" + "ab".repeat(32);
      const description = "SOL / USD";
      const maxStaleness = 60n;
      const fakeFactory = ethers.Wallet.createRandom().address;

      await adapter.initialize(account, description, maxStaleness, fakeFactory);

      const m = await adapter.metadata();
      expect(m.description).to.equal(description);
      expect(Number(m.sourceType)).to.equal(SRC_PYTH);
      expect(m.solanaAccount).to.equal(account);
      expect(m.maxStaleness).to.equal(maxStaleness);
      expect(m.factory).to.equal(fakeFactory);
      expect(m.paused).to.equal(false);
      expect(m.createdAt).to.be.greaterThan(0n);
    });
  });

  describe("SwitchboardV3Adapter.metadata()", () => {
    it("returns the values passed at initialize", async () => {
      const Adapter = await ethers.getContractFactory("SwitchboardV3Adapter");
      const adapter = await Adapter.deploy();

      const account = "0x" + "cd".repeat(32);
      const description = "BTC / USD";
      const maxStaleness = 120n;
      const fakeFactory = ethers.Wallet.createRandom().address;

      await adapter.initialize(account, description, maxStaleness, fakeFactory);

      const m = await adapter.metadata();
      expect(m.description).to.equal(description);
      expect(Number(m.sourceType)).to.equal(SRC_SWITCHBOARD);
      expect(m.solanaAccount).to.equal(account);
      expect(m.maxStaleness).to.equal(maxStaleness);
      expect(m.factory).to.equal(fakeFactory);
      expect(m.paused).to.equal(false);
      expect(m.createdAt).to.be.greaterThan(0n);
    });
  });
});
