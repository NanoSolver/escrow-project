// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";

/// approveByClient(): the client releases the funds to the freelancer themselves
/// (for example when the AI rejected work the client is happy with).
contract EscrowClientApproveTest is Test {
    Escrow internal escrow;

    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal oracle = makeAddr("oracle");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 1 ether;
    uint64 internal deadline;

    event ClientApproved(address indexed client, address indexed freelancer, uint256 amount);

    function setUp() public {
        deadline = uint64(block.timestamp + 7 days);
        escrow = new Escrow(client, freelancer, oracle, AMOUNT, deadline, 2);
        vm.deal(client, 10 ether);
    }

    function _fund(Escrow e) internal {
        vm.prank(client);
        e.deposit{value: AMOUNT}();
    }

    function test_clientApprovalPaysFreelancer() public {
        _fund(escrow);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit ClientApproved(client, freelancer, AMOUNT);
        vm.prank(client);
        escrow.approveByClient();
        assertEq(freelancer.balance, AMOUNT);
        assertEq(address(escrow).balance, 0);
        assertEq(uint8(escrow.status()), uint8(Escrow.Status.Released));
    }

    function test_onlyClientCanApprove() public {
        _fund(escrow);
        address[3] memory others = [stranger, freelancer, oracle];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(Escrow.NotClient.selector);
            escrow.approveByClient();
        }
        assertEq(address(escrow).balance, AMOUNT, "funds must stay locked");
    }

    function test_cannotApproveBeforeFunding() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Created));
        escrow.approveByClient();
    }

    function test_cannotApproveTwice() public {
        _fund(escrow);
        vm.startPrank(client);
        escrow.approveByClient();
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Released));
        escrow.approveByClient();
        vm.stopPrank();
        assertEq(freelancer.balance, AMOUNT, "paid exactly once");
    }

    function test_cannotApproveAfterDeadline() public {
        _fund(escrow);
        vm.warp(deadline);
        vm.prank(client);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        escrow.approveByClient();
    }

    function test_cannotApproveAfterRefund() public {
        _fund(escrow);
        vm.prank(oracle);
        escrow.refundClient();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Refunded));
        escrow.approveByClient();
    }

    function test_oracleCannotReleaseAfterClientApproval() public {
        _fund(escrow);
        vm.prank(client);
        escrow.approveByClient();
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Released));
        escrow.releaseFunds();
    }

    function test_approveAfterRevisionRequested() public {
        _fund(escrow);
        vm.prank(oracle);
        escrow.requestRevision();
        vm.prank(client);
        escrow.approveByClient();
        assertEq(freelancer.balance, AMOUNT);
    }

    // ───────────── open jobs ─────────────

    function test_openJobCannotBeApprovedBeforeAcceptance() public {
        Escrow open = new Escrow(client, address(0), oracle, AMOUNT, deadline, 2);
        _fund(open);
        vm.prank(client);
        vm.expectRevert(Escrow.NoFreelancer.selector);
        open.approveByClient();
        assertEq(address(open).balance, AMOUNT, "funds must stay locked");
    }

    function test_openJobApprovalPaysWhoeverAccepted() public {
        Escrow open = new Escrow(client, address(0), oracle, AMOUNT, deadline, 2);
        _fund(open);
        vm.prank(stranger);
        open.acceptJob();
        vm.prank(client);
        open.approveByClient();
        assertEq(stranger.balance, AMOUNT);
    }
}
