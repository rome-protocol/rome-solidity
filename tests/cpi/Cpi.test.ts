import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CPI_PATH = join(__dirname, "../../contracts/cpi/Cpi.sol");
const IFACE_PATH = join(__dirname, "../../contracts/interface.sol");

/**
 * Cpi library is a thin forwarder around the precompile. Runtime verification
 * requires live Rome EVM (no precompile on hardhatMainnet). Here we do a
 * structural check — `Cpi.sol` re-exports the precompile address constant
 * and its three forwarding methods line up with
 * `ICrossProgramInvocation`.
 */

describe("Cpi", () => {
    const src = readFileSync(CPI_PATH, "utf8");
    const ifaceSrc = readFileSync(IFACE_PATH, "utf8");

    it("PRECOMPILE resolves to 0xFF...08", () => {
        // Cpi uses the `cpi_program_address` constant from interface.sol —
        // cross-check that it really is 0xFF...08.
        const m = ifaceSrc.match(/cpi_program_address\s*=\s*address\(0x([0-9a-fA-F]+)\)/);
        assert.ok(m, "cpi_program_address literal not found in interface.sol");
        const hex = m![1].toLowerCase();
        assert.equal(
            hex,
            "ff00000000000000000000000000000000000008",
        );
    });

    it("Cpi.invoke forwards to CpiProgram.invoke", () => {
        assert.match(
            src,
            /CpiProgram\.invoke\s*\(\s*program\s*,\s*metas\s*,\s*data\s*\)/,
        );
    });

    it("Cpi.invokeSigned forwards to CpiProgram.invoke_signed", () => {
        assert.match(
            src,
            /CpiProgram\.invoke_signed\s*\(\s*program\s*,\s*metas\s*,\s*data\s*,\s*seeds\s*\)/,
        );
    });

    it("Cpi.accountInfo returns the 6-tuple from the precompile", () => {
        assert.match(
            src,
            /CpiProgram\.account_info\s*\(\s*pubkey\s*\)/,
        );
    });

    it("interface.sol ICrossProgramInvocation still has invoke / invoke_signed / account_info", () => {
        assert.match(ifaceSrc, /function\s+invoke\s*\(/);
        assert.match(ifaceSrc, /function\s+invoke_signed\s*\(/);
        assert.match(ifaceSrc, /function\s+account_info\s*\(/);
    });
});
