// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";

/// Open jobs: the client deploys with freelancer = address(0) and the first wallet to call
/// acceptJob() on the funded escrow becomes the freelancer.
contract EscrowOpenJobTest is Test {
    Escrow internal escrow;

    address internal client = makeAddr("client");
    address internal oracle = makeAddr("oracle");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant AMOUNT = 1 ether;
    uint64 internal deadline;

    event JobAccepted(address indexed freelancer);

    function setUp() public {
        deadline = uint64(block.timestamp + 7 days);
        escrow = new Escrow(client, address(0), oracle, AMOUNT, deadline, 2);
        vm.deal(client, 10 ether);
    }

    function _fund() internal {
        vm.prank(client);
        escrow.deposit{value: AMOUNT}();
    }

    // ───────────── Constructor ─────────────

    function test_openJobHasNoFreelancer() public view {
        assertEq(escrow.freelancer(), address(0));
    }

    function test_openJobStillRejectsZeroClientOrOracle() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(address(0), address(0), oracle, AMOUNT, deadline, 2);
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(client, address(0), address(0), AMOUNT, deadline, 2);
    }

    function test_clientAndOracleMustDifferEvenForOpenJobs() public {
        vm.expectRevert(Escrow.DuplicateRoles.selector);
        new Escrow(client, address(0), client, AMOUNT, deadline, 2);
    }

    // ───────────── acceptJob ─────────────

    function test_acceptJobSetsFreelancerAndEmits() public {
        _fund();
        vm.expectEmit(true, false, false, false, address(escrow));
        emit JobAccepted(alice);
        vm.prank(alice);
        escrow.acceptJob();
        assertEq(escrow.freelancer(), alice);
    }

    function test_cannotAcceptBeforeFunded() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Created));
        escrow.acceptJob();
    }

    function test_secondAcceptReverts() public {
        _fund();
        vm.prank(alice);
        escrow.acceptJob();
        vm.prank(bob);
        vm.expectRevert(Escrow.AlreadyAssigned.selector);
        escrow.acceptJob();
        assertEq(escrow.freelancer(), alice);
    }

    function test_sameWalletCannotAcceptTwice() public {
        _fund();
        vm.startPrank(alice);
        escrow.acceptJob();
        vm.expectRevert(Escrow.AlreadyAssigned.selector);
        escrow.acceptJob();
        vm.stopPrank();
    }

    function test_clientAndOracleCannotAccept() public {
        _fund();
        vm.prank(client);
        vm.expectRevert(Escrow.DuplicateRoles.selector);
        escrow.acceptJob();
        vm.prank(oracle);
        vm.expectRevert(Escrow.DuplicateRoles.selector);
        escrow.acceptJob();
        assertEq(escrow.freelancer(), address(0));
    }

    function test_cannotAcceptAfterDeadline() public {
        _fund();
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        escrow.acceptJob();
    }

    function test_cannotAcceptAssignedJob() public {
        Escrow assigned = new Escrow(client, bob, oracle, AMOUNT, deadline, 2);
        vm.prank(client);
        assigned.deposit{value: AMOUNT}();
        vm.prank(alice);
        vm.expectRevert(Escrow.AlreadyAssigned.selector);
        assigned.acceptJob();
        assertEq(assigned.freelancer(), bob);
    }

    function test_cannotAcceptAfterSettlement() public {
        _fund();
        vm.prank(oracle);
        escrow.refundClient();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Refunded));
        escrow.acceptJob();
    }

    // ───────────── Settlement needs a freelancer ─────────────

    function test_releaseWithoutFreelancerReverts() public {
        _fund();
        vm.prank(oracle);
        vm.expectRevert(Escrow.NoFreelancer.selector);
        escrow.releaseFunds();
        assertEq(address(escrow).balance, AMOUNT, "funds must stay locked");
    }

    function test_revisionWithoutFreelancerReverts() public {
        _fund();
        vm.prank(oracle);
        vm.expectRevert(Escrow.NoFreelancer.selector);
        escrow.requestRevision();
    }

    function test_refundWorksWithoutFreelancer() public {
        _fund();
        vm.prank(oracle);
        escrow.refundClient();
        assertEq(client.balance, 10 ether);
    }

    function test_nobodyAcceptsThenDeadlineRefund() public {
        _fund();
        vm.warp(uint256(deadline) + escrow.SETTLEMENT_GRACE());
        escrow.refundAfterDeadline();
        assertEq(client.balance, 10 ether);
        assertEq(uint8(escrow.status()), uint8(Escrow.Status.Refunded));
    }

    // ───────────── Full flows ─────────────

    function test_acceptThenRelease() public {
        _fund();
        vm.prank(alice);
        escrow.acceptJob();
        vm.prank(oracle);
        escrow.releaseFunds();
        assertEq(alice.balance, AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_acceptRevisionThenRelease() public {
        _fund();
        vm.prank(alice);
        escrow.acceptJob();
        vm.prank(oracle);
        escrow.requestRevision();
        assertEq(escrow.revisionsUsed(), 1);
        vm.prank(oracle);
        escrow.releaseFunds();
        assertEq(alice.balance, AMOUNT);
    }

    /// Whoever accepts first is paid, whoever they are.
    function testFuzz_firstAccepterGetsPaid(address first, address second) public {
        vm.assume(first != address(0) && first != client && first != oracle);
        vm.assume(second != first);
        // Skip precompiles, the Foundry cheatcode address and the test contract itself, which are
        // not valid payout targets for a plain ETH transfer.
        vm.assume(uint160(first) > 0xffff && first.code.length == 0 && first.balance == 0);
        vm.assume(first != address(vm) && first != address(this) && first != address(escrow));
        _fund();
        vm.prank(first);
        escrow.acceptJob();
        vm.prank(second);
        vm.expectRevert(Escrow.AlreadyAssigned.selector);
        escrow.acceptJob();
        vm.prank(oracle);
        escrow.releaseFunds();
        assertEq(first.balance, AMOUNT);
    }
}
