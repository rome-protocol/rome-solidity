import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  "contracts/erc20spl/erc20spl_token2022_hooked.sol",
  "utf8",
);
const directWrapper = readFileSync("contracts/erc20spl/erc20spl.sol", "utf8");
const cachedWrapper = readFileSync(
  "contracts/erc20spl/erc20spl_cached.sol",
  "utf8",
);
const hookTransfer = readFileSync(
  "contracts/spl_token/token2022_hooked_transfer.sol",
  "utf8",
);

function body(functionName: string): string {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const next = source.indexOf("\n    function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("SPL_ERC20_Token2022Hooked hot-path dispatch", () => {
  it("reads mint metadata once per hooked transfer", () => {
    const validate = body("_validateCurrentPlan");
    const transfer = body("_hookedTransfer");

    assert.match(
      validate,
      /returns \(uint16 feeBps\)/,
      "the metadata validation pass must return the fee predicate it already read",
    );
    assert.equal(
      (validate.match(/HelperProgram\.mint_info\(/g) ?? []).length,
      1,
      "the validation pass is the one authoritative metadata read",
    );
    assert.doesNotMatch(
      transfer,
      /HelperProgram\.mint_info\(/,
      "the hot transfer path must reuse feeBps from validation rather than read the mint twice",
    );
  });

  it("keeps hook plans in calldata until the single required CPI meta allocation", () => {
    for (const entrypoint of [
      "transferWithHookAccounts",
      "transferFromWithHookAccounts",
      "bridgeOutToSolanaWithHookAccounts",
    ]) {
      assert.match(body(entrypoint), /AccountMeta\[\] calldata hookMetas/);
    }
    assert.match(
      hookTransfer,
      /AccountMeta\[\] calldata hookMetas/,
      "the library must not reintroduce a memory copy before it builds fixed + hook metas",
    );
  });

  it("uses the shared compact u64 encoder rather than eight Solidity memory writes", () => {
    assert.match(hookTransfer, /Convert\.u64le\(amount\)/);
    assert.doesNotMatch(hookTransfer, /for \(uint256 i; i < 8; \+\+i\)/);
  });

  it("retains automatic ATA creation for a first hooked transfer", () => {
    assert.match(
      body("_hookedTransfer"),
      /bytes32 destination = ensure_token_account\(to\)/,
      "the hook-aware path must retain the base wrapper's check-or-create recipient ATA behavior",
    );
  });

  it("does not retain obsolete direct-wrapper cache writes or derivations", () => {
    assert.doesNotMatch(
      directWrapper,
      /mapping\(address => bytes32\) private _accounts/,
    );
    assert.doesNotMatch(directWrapper, /bytes32 from_ata\s*=/);
  });

  it("does not register a hook bridge caller twice", () => {
    assert.doesNotMatch(
      body("bridgeOutToSolanaWithHookAccounts"),
      /_users\.ensure_user\(msg\.sender\)/,
    );
  });

  it("no longer exposes mint_to (#511 change 5 / scope §6.1) — minting is a direct creator call to SplCached.mint", () => {
    assert.doesNotMatch(cachedWrapper, /function mint_to\(/);
  });
});
