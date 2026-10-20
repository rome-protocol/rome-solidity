/**
 * Shared fixtures for the RomeBridgeWithdraw tests that run on the simulated
 * EVM through BridgePrecompileMock (no Rome stack).
 *
 * The CCTP destination list is no longer a constructor value (v13): a test that
 * needs a live domain plants a Circle RemoteTokenMessenger account in the mock's
 * account store (the 0xff..08 install, which `enableCctpDomain` reads through
 * `account_info`) and calls `enableCctpDomain`, exactly as the owner does on a
 * live chain.
 */
import { concatHex, keccak256, toHex } from "viem";

export const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009" as const;
export const CPI_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000008" as const;
export const SYSTEM_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000007" as const;

export const ZERO32 = ("0x" + "00".repeat(32)) as `0x${string}`;
export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
export const FORWARDER = ZERO_ADDR;
export const PK = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
export const ADDR = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
/** A stand-in guardian for suites that do not exercise it. */
export const GUARDIAN = ADDR(0x6a);

export const EVM = 1;
export const RAW32 = 2;

export const Rail = { CCTP: 0, WORMHOLE: 1, TO_SOLANA: 2 } as const;

/** The CCTP v2 Token Messenger Minter program id used by the fixtures. */
export const CCTP_TMM_PROGRAM = PK(1);

export const CCTP = {
  tokenMessengerProgram: CCTP_TMM_PROGRAM,
  messageTransmitterProgram: PK(2),
  splTokenProgram: PK(3),
  systemProgram: ZERO32,
  messageTransmitterConfig: PK(4),
  tokenMessengerConfig: PK(5),
  tokenMinter: PK(6),
  localTokenUsdc: PK(7),
  senderAuthorityPda: PK(10),
  eventAuthority: PK(11),
  messageTransmitterEventAuthority: PK(12),
};

export const WH = {
  tokenBridgeProgram: PK(20), coreProgram: PK(21), splTokenProgram: PK(3),
  systemProgram: ZERO32, clockSysvar: PK(22), rentSysvar: PK(23),
  config: PK(24), authoritySigner: PK(26), custodySigner: PK(27),
  bridgeConfig: PK(28), feeCollector: PK(29), emitter: PK(30), sequence: PK(31),
};

export const NO_WORMHOLE = (admin: `0x${string}`) => ({
  admin,
  targetChains: [] as number[],
  assetWrappers: [] as `0x${string}`[],
});

/** RemoteTokenMessenger discriminator, as read live from Circle's accounts. */
export const REMOTE_TM_DISCRIMINATOR = "6973ae225fe98afc";

/**
 * The PDA the contract derives for a domain. The mock's find_program_address is
 * keccak(program || seeds...), so this mirrors it for the fixture program id.
 */
export function remoteMessengerPda(domain: number, program: `0x${string}` = CCTP_TMM_PROGRAM): `0x${string}` {
  return keccak256(concatHex([program, toHex("remote_token_messenger"), toHex(String(domain))]));
}

/** A messenger value shaped like an EVM address (12 zero bytes, then 20). */
export const evmMessenger = (n: number): `0x${string}` => ("0x" + "00".repeat(12) + n.toString(16).padStart(40, "0")) as `0x${string}`;
/** A messenger that is NOT address-shaped (Sui/Aptos style: a full 32 bytes). */
export const suiMessenger = ("0x" + "e3e567f5d3598022563be19ee9da09b6c7190400ce48e6155a872e569f9e7a51") as `0x${string}`;

/** Raw account data: 8-byte discriminator, u32 LE domain, 32-byte messenger. */
export function circleAccountData(
  domain: number,
  messenger: `0x${string}`,
  discriminator: string = REMOTE_TM_DISCRIMINATOR,
): `0x${string}` {
  const dom = Buffer.alloc(4);
  dom.writeUInt32LE(domain, 0);
  return ("0x" + discriminator + dom.toString("hex") + messenger.slice(2)) as `0x${string}`;
}

/** Plants Circle's account for `domain` in the mock's account store. */
export async function plantCircleAccount(
  cpi: any,
  domain: number,
  opts: {
    messenger?: `0x${string}`;
    owner?: `0x${string}`;
    storedDomain?: number;
    discriminator?: string;
    program?: `0x${string}`;
  } = {},
) {
  const key = remoteMessengerPda(domain, opts.program);
  const data = circleAccountData(
    opts.storedDomain ?? domain,
    opts.messenger ?? evmMessenger(0xc0de00 + domain),
    opts.discriminator,
  );
  await cpi.write.setAccount([key, opts.owner ?? CCTP_TMM_PROGRAM, data]);
  return key;
}

/** Installs BridgePrecompileMock at the three precompile addresses. */
export async function installMock(conn: any) {
  const { viem } = conn;
  const proto = await viem.deployContract("BridgePrecompileMock");
  const client = await viem.getPublicClient();
  const code = await client.getCode({ address: proto.address });
  for (const addr of [HELPER_PROGRAM_ADDRESS, CPI_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS]) {
    await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
  }
  return {
    helper: await viem.getContractAt("BridgePrecompileMock", HELPER_PROGRAM_ADDRESS),
    cpi: await viem.getContractAt("BridgePrecompileMock", CPI_PROGRAM_ADDRESS),
  };
}

/** Plants a good EVM-shaped Circle account and enables the domain as the caller of `bridge`. */
export async function enableDomain(
  bridge: any,
  cpi: any,
  domain: number,
  kind: number = EVM,
  opts: Parameters<typeof plantCircleAccount>[2] = {},
  txOpts: any = {},
) {
  await plantCircleAccount(cpi, domain, {
    messenger: kind === EVM ? evmMessenger(0xc0de00 + domain) : suiMessenger,
    ...opts,
  });
  return bridge.write.enableCctpDomain([domain, kind], txOpts);
}
