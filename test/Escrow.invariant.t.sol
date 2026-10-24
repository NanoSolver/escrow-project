// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";

/// Randomly calls the escrow in any order, from any caller, at any time, and checks that money
/// can never be created, destroyed or stuck in an inconsistent state.
contract Handler is Test {
    Escrow public immutable escrow;
    address public immutable client;
    address public immutable oracle;

    constructor(Escrow _escrow, address _client, address _oracle) {
        escrow = _escrow;
        client = _client;
        oracle = _oracle;
    }

    function deposit() external {
        uint256 a = escrow.amount(); // read BEFORE pranking: the prank applies to the next call only
        vm.prank(client);
        try escrow.deposit{value: a}() {} catch {}
    }

    function depositWrongAmount(uint256 v) external {
        v = bound(v, 0, 5 ether);
        vm.prank(client);
        try escrow.deposit{value: v}() {} catch {}
    }

    function release() external {
        vm.prank(oracle);
        try escrow.releaseFunds() {} catch {}
    }

    function refund() external {
        vm.prank(oracle);
        try escrow.refundClient() {} catch {}
    }

    function requestRevision() external {
        vm.prank(oracle);
        try escrow.requestRevision() {} catch {}
    }

    /// Anyone may try the deadline refund; the contract decides whether it is allowed.
    function refundAfterDeadline(address who) external {
        vm.prank(who);
        try escrow.refundAfterDeadline() {} catch {}
    }

    function strangerTriesToMoveFunds(address who, uint8 which) external {
        if (who == oracle) return;
        vm.prank(who);
        if (which % 3 == 0) {
            try escrow.releaseFunds() {} catch {}
        } else if (which % 3 == 1) {
            try escrow.refundClient() {} catch {}
        } else {
            try escrow.requestRevision() {} catch {}
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 30 days));
    }
}

contract EscrowInvariantTest is Test {
    Escrow internal escrow;
    Handler internal handler;

    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal oracle = makeAddr("oracle");

    uint256 internal constant AMOUNT = 1 ether;
    uint256 internal constant CLIENT_START = 100 ether;

    function setUp() public {
        escrow = new Escrow(client, freelancer, oracle, AMOUNT, uint64(block.timestamp + 7 days), 3);
        vm.deal(client, CLIENT_START);
        handler = new Handler(escrow, client, oracle);
        targetContract(address(handler));
    }

    /// The contract holds the full amount only while Funded, and nothing otherwise.
    function invariant_balanceMatchesStatus() public view {
        if (escrow.status() == Escrow.Status.Funded) {
            assertEq(address(escrow).balance, AMOUNT);
        } else {
            assertEq(address(escrow).balance, 0);
        }
    }

    /// Value is conserved: nothing is created or destroyed across the three parties.
    function invariant_fundsAreConserved() public view {
        assertEq(client.balance + freelancer.balance + address(escrow).balance, CLIENT_START);
    }

    /// The freelancer is paid either nothing or exactly the agreed amount, never more.
    function invariant_freelancerPaidExactlyOrNothing() public view {
        if (escrow.status() == Escrow.Status.Released) {
            assertEq(freelancer.balance, AMOUNT);
        } else {
            assertEq(freelancer.balance, 0);
        }
    }

    /// Revisions can never exceed the limit fixed at creation.
    function invariant_revisionsNeverExceedLimit() public view {
        assertLe(escrow.revisionsUsed(), escrow.revisionLimit());
    }
}
