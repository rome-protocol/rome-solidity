object "cu_example" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }

    object "runtime" {
        code {

            // dispatcher
            switch shr(224, calldataload(0))
            case 0x3b3b57de {
                create_payer_account1()
                return(0, 0)
            }
            default {
                revert(0, 0)
            }

            function create_payer_account1() {

                let ptr := mload(0x40)

                // ----------------------------------
                // rome_evm_program_id()
                // ----------------------------------
                mstore(ptr, 0xb76fd45b00000000000000000000000000000000000000000000000000000000)

                let success := staticcall(
                    gas(),
                    0xfF00000000000000000000000000000000000007,
                    ptr,
                    4,
                    ptr,
                    32
                )
                if iszero(success) { revert(0,0) }

                let rome_program := mload(ptr)

                // ----------------------------------
                // operator()
                // ----------------------------------
                mstore(ptr, 0x570ca73500000000000000000000000000000000000000000000000000000000)

                success := staticcall(
                    gas(),
                    0xfF00000000000000000000000000000000000007,
                    ptr,
                    4,
                    ptr,
                    32
                )
                if iszero(success) { revert(0,0) }

                let from := mload(ptr)


                // ----------------------------------
                // SystemProgram.find_program_address()
                // ----------------------------------

                mstore(ptr, 0x27e3edda00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 4), rome_program)

                let seeds_ptr := add(ptr, 36)
                
                mstore(seeds_ptr, 64)               // offset of len
                mstore(add(seeds_ptr, 32), 3)       // array length

                let data_ptr := add(seeds_ptr, 64)  // where elements (pointers) go
                mstore(data_ptr, 96)
                mstore(add(data_ptr, 32), 192)
                mstore(add(data_ptr, 64), 288)


                // ----------------------------------
                // Seed[0] = "EXTERNAL_AUTHORITY"
                // ----------------------------------
                let s0 := add(data_ptr, 96)
                mstore(s0, 32)
                mstore(add(s0, 32), 18) // length
                mstore(add(s0, 64), 0x45585445524e414c5f415554484f524954590000000000000000000000000000)

                // ----------------------------------
                // Seed[1] = abi.encodePacked(user)
                // ----------------------------------
                let s1 := add(s0, 96)
                mstore(s1, 32)
                mstore(add(s1, 32), 20) // address = 20 bytes
                mstore(add(s1, 64), shl(96, caller()))
                let free := add(s1, 96)

                // ----------------------------------
                // Seed[2] = bytes32 → bytes        salt = "PAYER"
                // ----------------------------------
                let s2 := free
                mstore(s2, 32)
                mstore(add(s2, 32), 32)
                mstore(add(s2, 64), 0x5041594552000000000000000000000000000000000000000000000000000000)

                success := staticcall(
                    gas(),
                    0xfF00000000000000000000000000000000000007,
                    ptr,
                    484,
                    ptr,
                    64
                )
                if iszero(success) { revert(0,0) }
                let to := mload(ptr)

                // ----------------------------------
                // invoke(...)
                // ----------------------------------
                mstore(ptr,
                    0x7480cb8600000000000000000000000000000000000000000000000000000000
                )

                // SYSTEM_PROGRAM_ID = 0
                mstore(add(ptr, 4), 0)

                // ----------------------------------
                // AccountMeta[2]
                // ----------------------------------
                mstore(add(ptr, 36), 96)           // offset meta
                mstore(add(ptr, 68), 320)          // offset data

                let meta_ptr := add(ptr, 100)
                mstore(meta_ptr, 2)

                // meta[0]
                mstore(add(meta_ptr, 32), from)
                mstore(add(meta_ptr, 64), 1)
                mstore(add(meta_ptr, 96), 1)

                // meta[1]
                mstore(add(meta_ptr, 128), to)
                mstore(add(meta_ptr, 160), 0)
                mstore(add(meta_ptr, 192), 1)

                // ----------------------------------
                // data encoding
                // ----------------------------------
                data_ptr := add(ptr, 324)

                // instruction = 2
                mstore(data_ptr, 12)
                data_ptr := add(data_ptr, 32)


                let value := 2
                for { let i := 0 } lt(i, 4) { i := add(i,1) } {
                    mstore8(
                        add(data_ptr, i),
                        and(shr(mul(8, i), value), 0xff)
                    )
                }

                data_ptr := add(data_ptr, 4)
                value := 1000000000
                for { let i := 0 } lt(i, 8) { i := add(i,1) } {
                    mstore8(
                        add(data_ptr, i),
                        and(shr(mul(8, i), value), 0xff)
                    )
                }

                success := delegatecall(
                    gas(),
                    0xFF00000000000000000000000000000000000008,
                    ptr,
                    388,
                    0,
                    0
                )

                if iszero(success) {
                    revert(0,0)
                }
            }
        }
    }
}


