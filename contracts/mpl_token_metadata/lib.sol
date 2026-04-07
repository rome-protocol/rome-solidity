// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../borsch.sol";
import "../interface.sol";

library MplTokenMetadataLib {
    // =========================
    // Errors
    // =========================
    error InvalidEnumDiscriminant(string enumName, uint8 value);

    // =========================
    // Rust enum Key
    // =========================

    enum Key {
        Uninitialized,
        EditionV1,
        MasterEditionV1,
        ReservationListV1,
        MetadataV1,
        ReservationListV2,
        MasterEditionV2,
        EditionMarker,
        UseAuthorityRecord,
        CollectionAuthorityRecord,
        TokenOwnedEscrow,
        TokenRecord,
        MetadataDelegate,
        EditionMarkerV2,
        HolderDelegate
    }

    // =========================
    // Rust struct Creator
    // =========================

    struct Creator {
        bytes32 address_;
        bool verified;
        uint8 share;
    }

    // =========================
    // Rust enum TokenStandard
    // =========================

    enum TokenStandard {
        NonFungible,
        FungibleAsset,
        Fungible,
        NonFungibleEdition,
        ProgrammableNonFungible,
        ProgrammableNonFungibleEdition
    }

    // =========================
    // Rust struct Collection
    // =========================

    struct Collection {
        bool verified;
        bytes32 key;
    }

    // =========================
    // Rust enum UseMethod
    // =========================

    enum UseMethod {
        Burn,
        Multiple,
        Single
    }

    // =========================
    // Rust struct Uses
    // =========================

    struct Uses {
        UseMethod useMethod;
        uint64 remaining;
        uint64 total;
    }

    // =========================
    // Rust enum CollectionDetails
    // enum CollectionDetails {
    //     V1 { size: u64 },
    //     V2 { padding: [u8; 8] },
    // }
    // =========================

    enum CollectionDetailsVariant {
        None,
        V1,
        V2
    }

    struct CollectionDetails {
        CollectionDetailsVariant variant;
        uint64 size;    // valid when variant == V1
        bytes8 padding; // valid when variant == V2
    }

    // =========================
    // Rust enum ProgrammableConfig
    // enum ProgrammableConfig {
    //     V1 { rule_set: Option<Pubkey> },
    // }
    // =========================

    enum ProgrammableConfigVariant {
        None,
        V1
    }

    struct ProgrammableConfig {
        ProgrammableConfigVariant variant;
        bool hasRuleSet;
        bytes32 ruleSet;
    }

    // =========================
    // Rust struct Metadata
    // =========================

    struct Metadata {
        Key key;
        bytes32 updateAuthority;
        bytes32 mint;
        string name;
        string symbol;
        string uri;
        uint16 sellerFeeBasisPoints;

        bool hasCreators;
        Creator[] creators;

        bool primarySaleHappened;
        bool isMutable;

        bool hasEditionNonce;
        uint8 editionNonce;

        bool hasTokenStandard;
        TokenStandard tokenStandard;

        bool hasCollection;
        Collection collection;

        bool hasUses;
        Uses uses_;

        bool hasCollectionDetails;
        CollectionDetails collectionDetails;

        bool hasProgrammableConfig;
        ProgrammableConfig programmableConfig;
    }

    // =========================
    // Public entrypoint
    // =========================

    function parse_metadata(bytes memory data) internal pure returns (Metadata memory md) {
        uint256 offset = 0;

        (md.key, offset) = _read_key(data, offset);
        (md.updateAuthority, offset) = Borsch.read_pubkey(data, offset);
        (md.mint, offset) = Borsch.read_pubkey(data, offset);
        (md.name, offset) = Borsch.read_string(data, offset);
        (md.symbol, offset) = Borsch.read_string(data, offset);
        (md.uri, offset) = Borsch.read_string(data, offset);
        (md.sellerFeeBasisPoints, offset) = Borsch.read_u16(data, offset);

        (md.hasCreators, md.creators, offset) = _read_option_creators_vec(data, offset);

        (md.primarySaleHappened, offset) = Borsch.read_bool(data, offset);
        (md.isMutable, offset) = Borsch.read_bool(data, offset);

        (md.hasEditionNonce, md.editionNonce, offset) = Borsch.read_option_u8(data, offset);
        (md.hasTokenStandard, md.tokenStandard, offset) = _read_option_token_standard(data, offset);
        (md.hasCollection, md.collection, offset) = _read_option_collection(data, offset);
        (md.hasUses, md.uses_, offset) = _read_option_uses(data, offset);
        (md.hasCollectionDetails, md.collectionDetails, offset) = _read_option_collection_details(data, offset);
        (md.hasProgrammableConfig, md.programmableConfig, offset) = _read_option_programmable_config(data, offset);

        require(offset == data.length, "Trailing bytes after Metadata");
        return md;
    }

    function find_metadata_pda(bytes32 mint, bytes32 mpl_program_id)
    internal
    pure
    returns (bytes32 pda, uint8 bump)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("metadata"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(mpl_program_id));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(mint));

        return SystemProgram.find_program_address(mpl_program_id, seeds);
    }

    function load_metadata(bytes32 mint, bytes32 mpl_program_id, address cpi_program)
    internal
    view
    returns (bool, Metadata memory)
    {
        (bytes32 metadata_pubkey,) = find_metadata_pda(mint, mpl_program_id);
        (uint64 lamports,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(metadata_pubkey);
        if (lamports == 0) {
            return (
                false, 
                Metadata(
                    Key.Uninitialized, 0, 0, "", "", "", 0, false, 
                    new Creator[](0), false, false, false, 0, false, 
                    TokenStandard.NonFungible, false, Collection(false, 0), 
                    false, Uses(UseMethod.Burn, 0, 0), false, 
                    CollectionDetails(CollectionDetailsVariant.None, 0, 0), 
                    false, ProgrammableConfig(ProgrammableConfigVariant.None, false, 0)
                )
            );
        }

        return (lamports > 0, parse_metadata(data));
    }

    // =========================
    // Metadata sub-parsers
    // =========================

    function _read_creator(bytes memory data, uint256 offset)
    private
    pure
    returns (Creator memory c, uint256 newOffset)
    {
        (c.address_, offset) = Borsch.read_pubkey(data, offset);
        (c.verified, offset) = Borsch.read_bool(data, offset);
        Borsch.ensure(data, offset, 1);
        c.share = uint8(data[offset]);
        offset += 1;
        return (c, offset);
    }

    function _read_collection(bytes memory data, uint256 offset)
    private
    pure
    returns (Collection memory c, uint256 newOffset)
    {
        (c.verified, offset) = Borsch.read_bool(data, offset);
        (c.key, offset) = Borsch.read_pubkey(data, offset);
        return (c, offset);
    }

    function _read_uses(bytes memory data, uint256 offset)
    private
    pure
    returns (Uses memory u, uint256 newOffset)
    {
        (u.useMethod, offset) = _read_use_method(data, offset);
        (u.remaining, offset) = Borsch.read_u64(data, offset);
        (u.total, offset) = Borsch.read_u64(data, offset);
        return (u, offset);
    }

    function _read_collection_details(bytes memory data, uint256 offset)
    private
    pure
    returns (CollectionDetails memory cd, uint256 newOffset)
    {
        uint8 discr;
        Borsch.ensure(data, offset, 1);
        discr = uint8(data[offset]);
        offset += 1;

        if (discr == 0) {
            cd.variant = CollectionDetailsVariant.V1;
            (cd.size, offset) = Borsch.read_u64(data, offset);
            return (cd, offset);
        }

        if (discr == 1) {
            cd.variant = CollectionDetailsVariant.V2;
            (cd.padding, offset) = Borsch.read_bytes8(data, offset);
            return (cd, offset);
        }

        revert InvalidEnumDiscriminant("CollectionDetails", discr);
    }

    function _read_programmable_config(bytes memory data, uint256 offset)
    private
    pure
    returns (ProgrammableConfig memory pc, uint256 newOffset)
    {
        uint8 discr;
        Borsch.ensure(data, offset, 1);
        discr = uint8(data[offset]);
        offset += 1;

        if (discr == 0) {
            pc.variant = ProgrammableConfigVariant.V1;
            (pc.hasRuleSet, pc.ruleSet, offset) = Borsch.read_option_pubkey(data, offset);
            return (pc, offset);
        }

        revert InvalidEnumDiscriminant("ProgrammableConfig", discr);
    }

    // =========================
    // Option parsers
    // =========================

    function _read_option_creators_vec(bytes memory data, uint256 offset)
    private
    pure
    returns (bool hasValue, Creator[] memory value, uint256 newOffset)
    {
        uint8 tag;
        Borsch.ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            return (false, value, offset);
        }
        if (tag == 1) {
            uint32 len;
            (len, offset) = Borsch.read_u32(data, offset);

            value = new Creator[](len);
            for (uint256 i = 0; i < len; i++) {
                (value[i], offset) = _read_creator(data, offset);
            }
            return (true, value, offset);
        }

        revert Borsch.InvalidOptionTag(tag);
    }

    function _read_option_token_standard(bytes memory data, uint256 offset)
    private
    pure
    returns (bool hasValue, TokenStandard value, uint256 newOffset)
    {
        uint8 tag;
        Borsch.ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            return (false, TokenStandard.NonFungible, offset);
        }
        if (tag == 1) {
            (value, offset) = _read_token_standard(data, offset);
            return (true, value, offset);
        }

        revert Borsch.InvalidOptionTag(tag);
    }

    function _read_option_collection(bytes memory data, uint256 offset)
    private
    pure
    returns (bool hasValue, Collection memory value, uint256 newOffset)
    {
        uint8 tag;
        Borsch.ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            return (false, value, offset);
        }
        if (tag == 1) {
            (value, offset) = _read_collection(data, offset);
            return (true, value, offset);
        }

        revert Borsch.InvalidOptionTag(tag);
    }

    function _read_option_uses(bytes memory data, uint256 offset)
    private
    pure
    returns (bool hasValue, Uses memory value, uint256 newOffset)
    {
        uint8 tag;
        Borsch.ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            return (false, value, offset);
        }
        if (tag == 1) {
            (value, offset) = _read_uses(data, offset);
            return (true, value, offset);
        }

        revert Borsch.InvalidOptionTag(tag);
    }

    function _read_option_collection_details(bytes memory data, uint256 offset)
    private
    pure
    returns (bool hasValue, CollectionDetails memory value, uint256 newOffset)
    {
        uint8 tag;
        Borsch.ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            value.variant = CollectionDetailsVariant.None;
            return (false, value, offset);
        }
        if (tag == 1) {
            (value, offset) = _read_collection_details(data, offset);
            return (true, value, offset);
        }

        revert Borsch.InvalidOptionTag(tag);
    }

    function _read_option_programmable_config(bytes memory data, uint256 offset)
    private
    pure
    returns (bool hasValue, ProgrammableConfig memory value, uint256 newOffset)
    {
        uint8 tag;
        Borsch.ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            value.variant = ProgrammableConfigVariant.None;
            return (false, value, offset);
        }
        if (tag == 1) {
            (value, offset) = _read_programmable_config(data, offset);
            return (true, value, offset);
        }

        revert Borsch.InvalidOptionTag(tag);
    }

    // =========================
    // Enum parsers
    // =========================

    function _read_key(bytes memory data, uint256 offset)
    private
    pure
    returns (Key value, uint256 newOffset)
    {
        uint8 discr;
        Borsch.ensure(data, offset, 1);
        discr = uint8(data[offset]);
        offset += 1;

        if (discr > uint8(Key.HolderDelegate)) {
            revert InvalidEnumDiscriminant("Key", discr);
        }

        value = Key(discr);
        return (value, offset);
    }

    function _read_token_standard(bytes memory data, uint256 offset)
    private
    pure
    returns (TokenStandard value, uint256 newOffset)
    {
        uint8 discr;
        Borsch.ensure(data, offset, 1);
        discr = uint8(data[offset]);
        offset += 1;

        if (discr > uint8(TokenStandard.ProgrammableNonFungibleEdition)) {
            revert InvalidEnumDiscriminant("TokenStandard", discr);
        }

        value = TokenStandard(discr);
        return (value, offset);
    }

    function _read_use_method(bytes memory data, uint256 offset)
    private
    pure
    returns (UseMethod value, uint256 newOffset)
    {
        uint8 discr;
        Borsch.ensure(data, offset, 1);
        discr = uint8(data[offset]);
        offset += 1;

        if (discr > uint8(UseMethod.Single)) {
            revert InvalidEnumDiscriminant("UseMethod", discr);
        }

        value = UseMethod(discr);
        return (value, offset);
    }
}