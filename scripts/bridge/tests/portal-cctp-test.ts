// CCTP outbound via direct CPI to 0xff..08 with the unified-PDA substitution.
// Mirrors debug-portal/cctp.html's flow + Pass B's substitution for Wormhole.
//
// Layout (per ICCTP.sol metas builder, 18 entries with MT __event_authority at [17]):
//   [0] owner                       userPda  (signer, writable)
//   [1] event_rent_payer            userPda  (signer, writable) — was userPayer
//   [2] sender_authority_pda        cctpPdas (false, false)
//   [3] burn_token_account          userAta  (false, true)
//   [4] message_transmitter         cctpPdas (false, true)
//   [5] token_messenger             cctpPdas (false, false)
//   [6] remote_token_messenger      cctpPdas (false, false)
//   [7] token_minter                cctpPdas (false, false)
//   [8] local_token                 cctpPdas (false, true)
//   [9] burn_token_mint             usdcMint (false, true)
//   [10] message_sent_event_data    msgPda   (signer, writable)
//   [11] mt program
//   [12] tmm program
//   [13] spl token
//   [14] system
//   [15] tmm event_authority
//   [16] tmm program (IDL convention)
//   [17] mt __event_authority — emulator workaround
// salts: [cctpSalt] only — no PAYER salt (unified-PDA model)

import hardhat from "hardhat";
import { encodeFunctionData, parseAbi, parseGwei } from "viem";
import { PublicKey } from "@solana/web3.js";

const ROME_PROGRAM = "RomeDbGQYbqomGVk13h9JkQHKoNWKB84Lw1ij9AtRXT";
const CCTP_TMM = "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3";
const CCTP_MT  = "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PRECOMPILE_CPI = "0xff00000000000000000000000000000000000008";
const SEPOLIA_RECIPIENT = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" as `0x${string}`;
const CCTP_DOMAIN_ETHEREUM = 0;

// sha256("global:deposit_for_burn")[0..8]
const DEPOSIT_FOR_BURN_DISCRIMINATOR = Buffer.from([0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0]);
const EXTERNAL_AUTHORITY = Buffer.from("EXTERNAL_AUTHORITY");

function evmAddrBytes(addr: string): Buffer { return Buffer.from(addr.replace(/^0x/, "").toLowerCase(), "hex"); }
function deriveAuthorityPda(evmAddr: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([EXTERNAL_AUTHORITY, evmAddrBytes(evmAddr)], new PublicKey(ROME_PROGRAM));
  return pda;
}
function deriveSaltedPda(evmAddr: string, salt: Buffer): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([EXTERNAL_AUTHORITY, evmAddrBytes(evmAddr), salt], new PublicKey(ROME_PROGRAM));
  return pda;
}
function deriveAta(owner: PublicKey, mint: string): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(SPL_TOKEN).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  );
  return ata;
}
function pkToBytes32(pk: PublicKey): `0x${string}` { return ("0x" + pk.toBuffer().toString("hex")) as `0x${string}`; }
function bufToHex(b: Buffer | Uint8Array): `0x${string}` { return ("0x" + Buffer.from(b).toString("hex")) as `0x${string}`; }
function uintLE(value: bigint | number, byteLen: number): Uint8Array {
  const arr = new Uint8Array(byteLen);
  let v = BigInt(value);
  for (let i = 0; i < byteLen; i++) { arr[i] = Number(v & 0xffn); v >>= 8n; }
  return arr;
}

function deriveCctpProgramPdas() {
  const tmm = new PublicKey(CCTP_TMM);
  const mt = new PublicKey(CCTP_MT);
  const usdcMint = new PublicKey(USDC_MINT);
  const [messageTransmitterConfig] = PublicKey.findProgramAddressSync([Buffer.from("message_transmitter")], mt);
  const [tokenMessengerConfig] = PublicKey.findProgramAddressSync([Buffer.from("token_messenger")], tmm);
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync([Buffer.from("remote_token_messenger"), Buffer.from(String(CCTP_DOMAIN_ETHEREUM))], tmm);
  const [tokenMinter] = PublicKey.findProgramAddressSync([Buffer.from("token_minter")], tmm);
  const [localToken] = PublicKey.findProgramAddressSync([Buffer.from("local_token"), usdcMint.toBuffer()], tmm);
  const [senderAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("sender_authority")], tmm);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], tmm);
  const [mtEventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], mt);
  return { messageTransmitterConfig, tokenMessengerConfig, remoteTokenMessenger, tokenMinter, localToken, senderAuthorityPda, eventAuthority, mtEventAuthority };
}

const INVOKE_SIGNED_ABI = parseAbi([
  "function invoke_signed(bytes32 programId, (bytes32 pubkey, bool isSigner, bool isWritable)[] metas, bytes data, bytes32[] salts)"
]);

async function main() {
  const { viem } = await hardhat.network.connect();
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const user = walletClient.account!.address;
  const userPda = deriveAuthorityPda(user);
  const userAta = deriveAta(userPda, USDC_MINT);

  const cctpSalt = (() => {
    const buf = Buffer.alloc(32);
    Buffer.from("CCTP_MSG_", "utf8").copy(buf, 0);
    const nonce = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    Buffer.from(nonce, "utf8").copy(buf, 9);
    return buf;
  })();
  const messageSentEventData = deriveSaltedPda(user, cctpSalt);
  const cctpPdas = deriveCctpProgramPdas();

  const amount = 10000n;  // 0.01 USDC
  console.log(`user EOA:      ${user}`);
  console.log(`userPda:       ${userPda.toBase58()}`);
  console.log(`userAta:       ${userAta.toBase58()}`);
  console.log(`messageSentEventData: ${messageSentEventData.toBase58()}`);

  const recipient32 = new Uint8Array(32);
  recipient32.set(evmAddrBytes(SEPOLIA_RECIPIENT), 12);

  const ixData = new Uint8Array(8 + 8 + 4 + 32);
  let o = 0;
  Buffer.from(DEPOSIT_FOR_BURN_DISCRIMINATOR).copy(ixData, o); o += 8;
  ixData.set(uintLE(amount, 8), o); o += 8;
  ixData.set(uintLE(CCTP_DOMAIN_ETHEREUM, 4), o); o += 4;
  ixData.set(recipient32, o);

  const metas = [
    { pubkey: pkToBytes32(userPda),                        isSigner: true,  isWritable: true  },  //  0 owner
    { pubkey: pkToBytes32(userPda),                        isSigner: true,  isWritable: true  },  //  1 event_rent_payer (UNIFIED — same as owner)
    { pubkey: pkToBytes32(cctpPdas.senderAuthorityPda),    isSigner: false, isWritable: false },  //  2
    { pubkey: pkToBytes32(userAta),                        isSigner: false, isWritable: true  },  //  3 burn_token_account
    { pubkey: pkToBytes32(cctpPdas.messageTransmitterConfig), isSigner: false, isWritable: true },  //  4
    { pubkey: pkToBytes32(cctpPdas.tokenMessengerConfig),  isSigner: false, isWritable: false },  //  5
    { pubkey: pkToBytes32(cctpPdas.remoteTokenMessenger),  isSigner: false, isWritable: false },  //  6
    { pubkey: pkToBytes32(cctpPdas.tokenMinter),           isSigner: false, isWritable: false },  //  7
    { pubkey: pkToBytes32(cctpPdas.localToken),            isSigner: false, isWritable: true  },  //  8
    { pubkey: pkToBytes32(new PublicKey(USDC_MINT)),       isSigner: false, isWritable: true  },  //  9 burn_token_mint
    { pubkey: pkToBytes32(messageSentEventData),           isSigner: true,  isWritable: true  },  // 10
    { pubkey: pkToBytes32(new PublicKey(CCTP_MT)),         isSigner: false, isWritable: false },  // 11
    { pubkey: pkToBytes32(new PublicKey(CCTP_TMM)),        isSigner: false, isWritable: false },  // 12
    { pubkey: pkToBytes32(new PublicKey(SPL_TOKEN)),       isSigner: false, isWritable: false },  // 13
    { pubkey: pkToBytes32(new PublicKey(SYSTEM_PROGRAM)),  isSigner: false, isWritable: false },  // 14
    { pubkey: pkToBytes32(cctpPdas.eventAuthority),        isSigner: false, isWritable: false },  // 15 TMM event_authority
    { pubkey: pkToBytes32(new PublicKey(CCTP_TMM)),        isSigner: false, isWritable: false },  // 16 TMM (program in IDL)
    { pubkey: pkToBytes32(cctpPdas.mtEventAuthority),      isSigner: false, isWritable: false },  // 17 MT __event_authority workaround
  ];

  const calldata = encodeFunctionData({
    abi: INVOKE_SIGNED_ABI,
    functionName: "invoke_signed",
    args: [pkToBytes32(new PublicKey(CCTP_TMM)), metas, bufToHex(ixData), [bufToHex(cctpSalt)]],
  });

  console.log(`\nSending CCTP deposit_for_burn via direct CPI (unified-PDA, salts=[CCTP_MSG] only)...`);
  try {
    const hash = await walletClient.sendTransaction({
      to: PRECOMPILE_CPI as `0x${string}`,
      data: calldata,
      type: "legacy",
      gas: 50_000_000n,
      gasPrice: parseGwei("1"),
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`status: ${r.status} (gas ${r.gasUsed}, tx ${hash})`);
  } catch (e: any) {
    const detail = (e?.cause?.details ?? e?.shortMessage ?? String(e)).slice(0, 250);
    console.log(`FAILED: ${detail}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
