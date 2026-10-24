// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";

/// Deploys one Escrow. The broadcasting account becomes the client.
///
/// Required env vars (see .env.example):
///   ORACLE_ADDRESS      - public address of the Go backend's signing key
///   ESCROW_AMOUNT_WEI   - e.g. 10000000000000000 (0.01 ETH)
/// Optional:
///   FREELANCER_ADDRESS  - the freelancer's wallet. Leave it out (or set it to the zero address) to
///                         create an OPEN job: after funding, the first wallet to call acceptJob() wins.
///   DEADLINE_DAYS       - days from now until the submission deadline (default 7)
///   REVISION_LIMIT      - resubmissions allowed after a rejection, 0-10 (default 2)
contract DeployEscrow is Script {
    function run() external returns (Escrow escrow) {
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address freelancer = vm.envOr("FREELANCER_ADDRESS", address(0));
        uint256 amount = vm.envUint("ESCROW_AMOUNT_WEI");
        uint256 deadlineDays = vm.envOr("DEADLINE_DAYS", uint256(7));
        uint256 revisionLimit = vm.envOr("REVISION_LIMIT", uint256(2));

        require(deadlineDays >= 1 && deadlineDays <= 365, "DEADLINE_DAYS must be 1-365");
        require(revisionLimit <= 10, "REVISION_LIMIT must be 0-10");

        uint64 deadline = uint64(block.timestamp + deadlineDays * 1 days);

        vm.startBroadcast();
        // msg.sender inside a broadcast is the broadcaster (set via --account / --private-key)
        escrow = new Escrow(msg.sender, freelancer, oracle, amount, deadline, uint8(revisionLimit));
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
        console.log("client:    ", msg.sender);
        if (freelancer == address(0)) {
            console.log("freelancer: OPEN (first wallet to call acceptJob() after funding)");
        } else {
            console.log("freelancer:", freelancer);
        }
        console.log("oracle:    ", oracle);
        console.log("amount:    ", amount);
        console.log("deadline:  ", deadline);
        console.log("revisions: ", revisionLimit);
    }
}
