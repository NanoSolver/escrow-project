// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";

/// Deploys one Escrow. The broadcasting account becomes the client.
///
/// Required env vars (see .env.example):
///   ORACLE_ADDRESS      - public address of the Go backend's signing key
///   FREELANCER_ADDRESS  - the freelancer's wallet
///   ESCROW_AMOUNT_WEI   - e.g. 10000000000000000 (0.01 ETH)
contract DeployEscrow is Script {
    function run() external returns (Escrow escrow) {
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address freelancer = vm.envAddress("FREELANCER_ADDRESS");
        uint256 amount = vm.envUint("ESCROW_AMOUNT_WEI");
        uint64 deadline = uint64(block.timestamp + vm.envOr("DEADLINE_DAYS", uint256(7)) * 1 days);
        uint8 revisionLimit = uint8(vm.envOr("REVISION_LIMIT", uint256(2)));

        vm.startBroadcast();
        // msg.sender inside a broadcast is the broadcaster (set via --account / --private-key)
        escrow = new Escrow(msg.sender, freelancer, oracle, amount, deadline, revisionLimit);
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
        console.log("client:    ", msg.sender);
        console.log("freelancer:", freelancer);
        console.log("oracle:    ", oracle);
        console.log("amount:    ", amount);
    }
}
