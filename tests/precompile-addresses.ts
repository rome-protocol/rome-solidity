// Shared precompile addresses for tests that install a mock via
// `hardhat_setCode` at a real precompile address.
//
// These must track `contracts/interface.sol`'s `..._address` constants
// (interface.sol:336-343) exactly. Solidity's file-level free constants
// aren't importable from TypeScript, so this module is the one place that
// restates them for tests — every other test file should import from here
// rather than retyping the literal, so a precompile address change can't
// silently drift out of step with a copy nobody remembered to update.
export const SPL_CACHED_ADDRESS =
    "0xff00000000000000000000000000000000000005" as const;
export const ASSOCIATED_SPL_CACHED_ADDRESS =
    "0xff00000000000000000000000000000000000006" as const;
export const SYSTEM_PROGRAM_ADDRESS =
    "0xff00000000000000000000000000000000000007" as const;
export const CPI_PROGRAM_ADDRESS =
    "0xff00000000000000000000000000000000000008" as const;
export const HELPER_PROGRAM_ADDRESS =
    "0xff00000000000000000000000000000000000009" as const;
