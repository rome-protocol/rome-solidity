// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {Convert} from "../convert.sol";
import "../rome_evm_account.sol";
import {ERC20SPLFactory} from "../erc20spl/erc20spl_factory.sol";
import {ERC20Users, SPL_ERC20} from "../erc20spl/erc20spl.sol";

library DAMMv1Lib {
    uint256 internal constant POOL_PREFIX_MIN_LEN = 379;
    uint256 internal constant VAULT_MIN_LEN = 1197;

    error InvalidVaultDataLength(uint256 actual, uint256 expected);
    error InvalidPoolDataLength(uint256 actual, uint256 expected);
    error InvalidPoolType(uint8 value);

    struct PoolFees {
        uint64 trade_fee_numerator;
        uint64 trade_fee_denominator;
        uint64 protocol_trade_fee_numerator;
        uint64 protocol_trade_fee_denominator;
    }

    enum PoolType {
        Permissioned,
        Permissionless
    }

    // DAMMv1 pool account state
    struct PoolState {
        bytes32 lp_mint;
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        uint8 a_vault_lp_bump;
        bool enabled;
        bytes32 protocol_token_a_fee;
        bytes32 protocol_token_b_fee;
        uint64 fee_last_updated_at;
        PoolFees fees;
        PoolType pool_type;
    }

    struct VaultBumps {
        uint8 vault_bump;
        uint8 token_vault_bump;
    }

    struct LockedProfitTracker {
        uint64 last_updated_locked_profit;
        uint64 last_report;
        uint64 locked_profit_degradation;
    }

    struct VaultState {
        uint8 enabled;
        VaultBumps bumps;
        uint64 total_amount;
        bytes32 token_vault;
        bytes32 fee_vault;
        bytes32 token_mint;
        bytes32 lp_mint;
        LockedProfitTracker locked_profit_tracker;
    }

        // Helper structure used to prepare list of account for Swap instruction
    struct SwapAccountsInput {
        bytes32 pool;
        bytes32 user_source_token;
        bytes32 user_destination_token;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_vault_lp_mint;
        bytes32 b_vault_lp_mint;
        bytes32 a_token_vault;
        bytes32 b_token_vault;
        bytes32 user;
        bytes32 vault_program;
        bytes32 token_program;
        bytes32 protocol_token_fee;
    }

    // Parses DAMMv1 pool
    // @param data raw Solana account data
    // @return instance PoolState structure
    function parse_pool(bytes memory data) pure internal returns (PoolState memory p)
    {
        if (data.length < POOL_PREFIX_MIN_LEN) {
            revert InvalidPoolDataLength(data.length, POOL_PREFIX_MIN_LEN);
        }

        uint256 o = 8; // anchor discriminator

        (p.lp_mint, o) = Convert.read_bytes32(data, o);
        (p.token_a_mint, o) = Convert.read_bytes32(data, o);
        (p.token_b_mint, o) = Convert.read_bytes32(data, o);
        (p.a_vault, o) = Convert.read_bytes32(data, o);
        (p.b_vault, o) = Convert.read_bytes32(data, o);
        (p.a_vault_lp, o) = Convert.read_bytes32(data, o);
        (p.b_vault_lp, o) = Convert.read_bytes32(data, o);

        (p.a_vault_lp_bump, o) = Convert.read_u8(data, o);

        uint8 enabled_u8;
        (enabled_u8, o) = Convert.read_u8(data, o);
        p.enabled = enabled_u8 != 0;

        (p.protocol_token_a_fee, o) = Convert.read_bytes32(data, o);
        (p.protocol_token_b_fee, o) = Convert.read_bytes32(data, o);
        (p.fee_last_updated_at, o) = Convert.read_u64le(data, o);

        o += 24; // _padding0

        (p.fees.trade_fee_numerator, o) = Convert.read_u64le(data, o);
        (p.fees.trade_fee_denominator, o) = Convert.read_u64le(data, o);
        (p.fees.protocol_trade_fee_numerator, o) = Convert.read_u64le(data, o);
        (p.fees.protocol_trade_fee_denominator, o) = Convert.read_u64le(data, o);

        uint8 pool_type_u8;
        (pool_type_u8, o) = Convert.read_u8(data, o);
        if (pool_type_u8 > uint8(PoolType.Permissionless)) {
            revert InvalidPoolType(pool_type_u8);
        }
        p.pool_type = PoolType(pool_type_u8);

        return p;
    }

    function parse_vault(bytes memory data)
    internal
    pure
    returns (VaultState memory v)
    {
        if (data.length < VAULT_MIN_LEN) {
            revert InvalidVaultDataLength(data.length, VAULT_MIN_LEN);
        }

        uint256 o = 8; // anchor discriminator

        (v.enabled, o) = Convert.read_u8(data, o);
        (v.bumps.vault_bump, o) = Convert.read_u8(data, o);
        (v.bumps.token_vault_bump, o) = Convert.read_u8(data, o);

        (v.total_amount, o) = Convert.read_u64le(data, o);
        (v.token_vault, o) = Convert.read_bytes32(data, o);
        (v.fee_vault, o) = Convert.read_bytes32(data, o);
        (v.token_mint, o) = Convert.read_bytes32(data, o);
        (v.lp_mint, o) = Convert.read_bytes32(data, o);

        o += 32 * 30; // strategies[30]
        o += 32; // base
        o += 32; // admin
        o += 32; // operator

        (v.locked_profit_tracker.last_updated_locked_profit, o) = Convert.read_u64le(data, o);
        (v.locked_profit_tracker.last_report, o) = Convert.read_u64le(data, o);
        (v.locked_profit_tracker.locked_profit_degradation, o) = Convert.read_u64le(data, o);

        return v;
    }

    // Reads DAMMv1 pool account from Solana and parses it
    // @param pool_pubkey address of DAMMv1 Pool account in Solana
    // @return instance PoolState structure
    function load_pool(bytes32 pool_pubkey, address cpi_program)
    internal
    view
    returns (PoolState memory) {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(pool_pubkey);
        return parse_pool(data);
    }

    function load_vault(bytes32 vault_pubkey, address cpi_program)
    internal
    view
    returns (VaultState memory)
    {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(vault_pubkey);
        return parse_vault(data);
    }


    function build_swap_account_metas(SwapAccountsInput memory a)
    internal
    pure
    returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](15);

        metas[0] = ICrossProgramInvocation.AccountMeta(a.pool, false, true);
        metas[1] = ICrossProgramInvocation.AccountMeta(
            a.user_source_token,
            false,
            true
        );
        metas[2] = ICrossProgramInvocation.AccountMeta(
            a.user_destination_token,
            false,
            true
        );
        metas[3] = ICrossProgramInvocation.AccountMeta(a.a_vault_lp, false, true);
        metas[4] = ICrossProgramInvocation.AccountMeta(a.b_vault_lp, false, true);
        metas[5] = ICrossProgramInvocation.AccountMeta(a.a_vault, false, true);
        metas[6] = ICrossProgramInvocation.AccountMeta(a.b_vault, false, true);
        metas[7] = ICrossProgramInvocation.AccountMeta(
            a.a_vault_lp_mint,
            false,
            true
        );
        metas[8] = ICrossProgramInvocation.AccountMeta(
            a.b_vault_lp_mint,
            false,
            true
        );
        metas[9] = ICrossProgramInvocation.AccountMeta(
            a.a_token_vault,
            false,
            true
        );
        metas[10] = ICrossProgramInvocation.AccountMeta(
            a.b_token_vault,
            false,
            true
        );
        metas[11] = ICrossProgramInvocation.AccountMeta(a.user, true, false);
        metas[12] = ICrossProgramInvocation.AccountMeta(
            a.vault_program,
            false,
            false
        );
        metas[13] = ICrossProgramInvocation.AccountMeta(
            a.token_program,
            false,
            false
        );
        metas[14] = ICrossProgramInvocation.AccountMeta(
            a.protocol_token_fee,
            false,
            true
        );
    }

    function build_swap_ix_data(uint64 in_amount, uint64 minimum_out_amount)
    internal
    pure
    returns (bytes memory)
    {
        bytes8 disc = bytes8(sha256(bytes("global:swap")));
        return abi.encodePacked(disc, Convert.u64le(in_amount), Convert.u64le(minimum_out_amount));
    }
}

contract DAMMv1Pool {
    enum PoolToken {
        TokenA,
        TokenB
    }

    struct Reserves {
        uint128 a_reserve;
        uint128 b_reserve;
    }

    error ZeroReserve();
    error DivisionByZero();

    address public immutable pool_factory;
    address public immutable token_factory;
    bool public initialized;

    bytes32 public pool_address;
    bytes32 public prog_dynamic_vault;
    bytes32 public prog_dynamic_amm;
    address public cpi_program;

    //////////////////////////////////////////////////////
    // Pool state (does not fit into stack as a structure)
    bytes32 public lp_mint;
    bytes32 public token_a_mint;
    bytes32 public token_b_mint;
    bytes32 public a_vault;
    bytes32 public b_vault;
    bytes32 public a_vault_lp;
    bytes32 public b_vault_lp;
    uint8 public a_vault_lp_bump;
    bool public enabled;
    bytes32 public protocol_token_a_fee;
    bytes32 public protocol_token_b_fee;
    uint64 public fee_last_updated_at;
    DAMMv1Lib.PoolFees public fees;
    DAMMv1Lib.PoolType public pool_type;
    //////////////////////////////////////////////////////

    DAMMv1Lib.VaultState public vault_a;
    DAMMv1Lib.VaultState public vault_b;

    constructor(address _token_factory) {
        pool_factory = msg.sender;
        token_factory = _token_factory;
    }

    modifier onlyFactory() {
        require(msg.sender == pool_factory, "FORBIDDEN");
        _;
    }

    function initialize(
        bytes32 _pool_address,
        bytes32 _prog_dynamic_vault,
        bytes32 _prog_dynamic_amm,
        address _cpi_program
    ) public onlyFactory {
        require(!initialized, "ALREADY_INITIALIZED");
        initialized = true;
        
        pool_address = _pool_address;
        prog_dynamic_vault = _prog_dynamic_vault;
        prog_dynamic_amm = _prog_dynamic_amm;
        cpi_program = _cpi_program;
        update_state();
    }

    function update_state() public {
        DAMMv1Lib.PoolState memory pool = DAMMv1Lib.load_pool(pool_address, cpi_program);
        update_pool_state(pool);
        vault_a = DAMMv1Lib.load_vault(a_vault, cpi_program);
        vault_b = DAMMv1Lib.load_vault(b_vault, cpi_program);
    }

    function update_pool_state(DAMMv1Lib.PoolState memory pool) internal
    {
        lp_mint = pool.lp_mint;
        token_a_mint = pool.token_a_mint;
        token_b_mint = pool.token_b_mint;
        a_vault = pool.a_vault;
        b_vault = pool.b_vault;
        a_vault_lp = pool.a_vault_lp;
        b_vault_lp = pool.b_vault_lp;
        a_vault_lp_bump = pool.a_vault_lp_bump;
        enabled = pool.enabled;
        protocol_token_a_fee = pool.protocol_token_a_fee;
        protocol_token_b_fee = pool.protocol_token_b_fee;
        fee_last_updated_at = pool.fee_last_updated_at;
        fees = pool.fees;
        pool_type = pool.pool_type;
    }

    function get_reserves()
    public
    view
    returns (Reserves memory r)
    {
        DAMMv1Lib.VaultState memory vault_a_state = DAMMv1Lib.load_vault(a_vault, cpi_program);
        DAMMv1Lib.VaultState memory vault_b_state = DAMMv1Lib.load_vault(b_vault, cpi_program);

        SplTokenLib.SplMint memory a_lp_mint = SplTokenLib.load_mint(vault_a_state.lp_mint, cpi_program);
        SplTokenLib.SplMint memory b_lp_mint = SplTokenLib.load_mint(vault_b_state.lp_mint, cpi_program);

        uint64 pool_lp_a = SplTokenLib.load_token_amount(a_vault_lp, cpi_program);
        uint64 pool_lp_b = SplTokenLib.load_token_amount(b_vault_lp, cpi_program);

        uint128 a_reserve = a_lp_mint.supply == 0
            ? 0
            : uint128(pool_lp_a) * uint128(vault_a_state.total_amount)
            / uint128(a_lp_mint.supply);

        uint128 b_reserve = b_lp_mint.supply == 0
            ? 0
            : uint128(pool_lp_b) * uint128(vault_b_state.total_amount)
            / uint128(b_lp_mint.supply);

        r = Reserves({a_reserve: a_reserve, b_reserve: b_reserve});
    }

    function get_price_e18(PoolToken token)
    external
    view
    returns (uint256)
    {
        Reserves memory r = get_reserves();
        SplTokenLib.SplMint memory mint_a = SplTokenLib.load_mint(token_a_mint, cpi_program);
        SplTokenLib.SplMint memory mint_b = SplTokenLib.load_mint(token_b_mint, cpi_program);

        if (token == PoolToken.TokenA) {
            if (r.a_reserve == 0) revert ZeroReserve();

            return uint256(r.b_reserve)
                * (10 ** uint256(mint_a.decimals))
                * 1e18
                / uint256(r.a_reserve)
                / (10 ** uint256(mint_b.decimals));
        } else {
            if (r.b_reserve == 0) revert ZeroReserve();

            return uint256(r.a_reserve)
                * (10 ** uint256(mint_b.decimals))
                * 1e18
                / uint256(r.b_reserve)
                / (10 ** uint256(mint_a.decimals));
        }
    }

    function get_fees_e18()
    external
    view
    returns (uint256)
    {
        if (
            fees.trade_fee_denominator == 0
            || fees.protocol_trade_fee_denominator == 0
        ) {
            revert DivisionByZero();
        }

        uint256 lp_fee_e18 = uint256(fees.trade_fee_numerator) * 1e18
            / uint256(fees.trade_fee_denominator);

        uint256 protocol_fee_e18 =
            uint256(fees.protocol_trade_fee_numerator) * 1e18
            / uint256(fees.protocol_trade_fee_denominator);

        return lp_fee_e18 * (1e18 + protocol_fee_e18) / 1e18;
    }

    function make_swap_accounts_from_pool(
        bytes32 user_source_token_account,
        bytes32 user_destination_token_account,
        bytes32 user,
        PoolToken in_token
    ) internal view returns (DAMMv1Lib.SwapAccountsInput memory out) {
        bytes32 protocol_token_fee = in_token == PoolToken.TokenA
            ? protocol_token_a_fee
            : protocol_token_b_fee;

        out = DAMMv1Lib.SwapAccountsInput({
            pool: pool_address,
            user_source_token: user_source_token_account,
            user_destination_token: user_destination_token_account,
            a_vault_lp: a_vault_lp,
            b_vault_lp: b_vault_lp,
            a_vault: a_vault,
            b_vault: b_vault,
            a_vault_lp_mint: vault_a.lp_mint,
            b_vault_lp_mint: vault_b.lp_mint,
            a_token_vault: vault_a.token_vault,
            b_token_vault: vault_b.token_vault,
            user: user,
            vault_program: prog_dynamic_vault,
            token_program: SplTokenLib.SPL_TOKEN_PROGRAM,
            protocol_token_fee: protocol_token_fee
        });
    }

    function invoke_swap(
        DAMMv1Lib.SwapAccountsInput memory a,
        uint64 in_amount,
        uint64 minimum_out_amount
    ) internal {
        ICrossProgramInvocation.AccountMeta[] memory accounts = DAMMv1Lib.build_swap_account_metas(a);
        bytes memory data = DAMMv1Lib.build_swap_ix_data(in_amount, minimum_out_amount);

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                prog_dynamic_amm,
                accounts,
                data
            )
        );

        require(success, string(result));
    }

    function invoke_swap(
        bytes32 user_source_token_account,
        bytes32 user_destination_token_account,
        bytes32 user,
        PoolToken in_token,
        uint64 in_amount,
        uint64 minimum_out_amount
    ) external {
        DAMMv1Lib.SwapAccountsInput memory a = make_swap_accounts_from_pool(
            user_source_token_account,
            user_destination_token_account,
            user,
            in_token
        );

        invoke_swap(a, in_amount, minimum_out_amount);
    }
}

contract ERC20DAMMv1Pool {
    DAMMv1Pool private immutable internal_pool;
    ERC20Users private immutable users;
    SPL_ERC20 private immutable tokenA;
    SPL_ERC20 private immutable tokenB;

    constructor(
        DAMMv1Pool _internal_pool,
        ERC20SPLFactory token_factory
    ) {
        tokenA = SPL_ERC20(token_factory.token_by_mint(_internal_pool.token_a_mint()));
        tokenB = SPL_ERC20(token_factory.token_by_mint(_internal_pool.token_b_mint()));
        internal_pool = _internal_pool;
        users = token_factory.users();
    }

    function update_state() external {
        internal_pool.update_state();
    }

    function get_reserves() external view returns (DAMMv1Pool.Reserves memory) {
        return internal_pool.get_reserves();
    }

    function get_price_e18(DAMMv1Pool.PoolToken token)
    external
    view
    returns (uint256)    {
        return internal_pool.get_price_e18(token);
    }

    function get_fees_e18() external view returns (uint256) {
        return internal_pool.get_fees_e18();
    }

    function swapExactTokensForTokens(
        address token_in,
        uint256 amount_in,
        uint256 min_amount_out
    ) external {
        bytes32 tokenA_account = tokenA.get_token_account(msg.sender);
        bytes32 tokenB_account = tokenB.get_token_account(msg.sender);
        bytes32 user = users.get_user(msg.sender).owner;

        DAMMv1Pool.PoolToken in_token = DAMMv1Pool.PoolToken.TokenA;
        bytes32 source_account = tokenA_account;
        bytes32 destination_account = tokenB_account;

        if (address(tokenB) == token_in) {
            in_token = DAMMv1Pool.PoolToken.TokenB;
            source_account = tokenB_account;
            destination_account = tokenA_account;
        }

        require(amount_in <= type(uint64).max, "amount_in exceeds uint64");
        require(min_amount_out <= type(uint64).max, "min_amount_out exceeds uint64");

        (bool success, bytes memory result) = address(internal_pool).delegatecall(
            abi.encodeWithSignature(
                "invoke_swap(bytes32,bytes32,bytes32,uint8,uint64,uint64)",
                source_account,
                destination_account,
                user,
                uint8(in_token),
                uint64(amount_in),
                uint64(min_amount_out)
            )
        );

        require(success, string(Convert.revert_msg(result)));
    }
}
