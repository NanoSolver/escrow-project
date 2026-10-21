// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";

contract EscrowTest is Test {
    Escrow internal escrow;

    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal oracle = makeAddr("oracle");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 1 ether;

    event Deposited(address indexed client, uint256 amount);
    event Released(address indexed freelancer, uint256 amount);
    event Refunded(address indexed client, uint256 amount);

    function setUp() public {
        escrow = new Escrow(client, freelancer, oracle, AMOUNT);
        vm.deal(client, 10 ether);
    }

    function _fund() internal {
        vm.prank(client);
        escrow.deposit{value: AMOUNT}();
    }

    // ───────────── Constructor ─────────────

    function test_constructorSetsState() public view {
        assertEq(escrow.client(), client);
        assertEq(escrow.freelancer(), freelancer);
        assertEq(escrow.oracleAddress(), oracle);
        assertEq(escrow.amount(), AMOUNT);
        assertEq(uint8(escrow.status()), uint8(Escrow.Status.Created));
    }

    function test_constructorRejectsZeroAddress() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(address(0), freelancer, oracle, AMOUNT);
    }

    function test_constructorRejectsZeroAmount() public {
        vm.expectRevert(Escrow.ZeroAmount.selector);
        new Escrow(client, freelancer, oracle, 0);
    }

    function test_constructorRejectsDuplicateRoles() public {
        vm.expectRevert(Escrow.DuplicateRoles.selector);
        new Escrow(client, client, oracle, AMOUNT);
        vm.expectRevert(Escrow.DuplicateRoles.selector);
        new Escrow(client, freelancer, client, AMOUNT);
    }

    // ───────────── deposit() ─────────────

    function test_depositFundsEscrow() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(client, AMOUNT);
        _fund();

        assertEq(uint8(escrow.status()), uint8(Escrow.Status.Funded));
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_depositRevertsForNonClient() public {
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        vm.expectRevert(Escrow.NotClient.selector);
        escrow.deposit{value: AMOUNT}();
    }

    function test_depositRevertsOnWrongAmount() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.IncorrectDeposit.selector, 0.5 ether, AMOUNT));
        escrow.deposit{value: 0.5 ether}();
    }

    function test_depositRevertsWhenAlreadyFunded() public {
        _fund();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Funded));
        escrow.deposit{value: AMOUNT}();
    }

    function test_plainEtherTransferReverts() public {
        vm.prank(client);
        (bool ok, ) = address(escrow).call{value: AMOUNT}("");
        assertFalse(ok);
    }

    // ───────────── releaseFunds() ─────────────

    function test_oracleCanRelease() public {
        _fund();

        vm.expectEmit(true, false, false, true);
        emit Released(freelancer, AMOUNT);
        vm.prank(oracle);
        escrow.releaseFunds();

        assertEq(uint8(escrow.status()), uint8(Escrow.Status.Released));
        assertEq(freelancer.balance, AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_releaseRevertsForNonOracle() public {
        _fund();
        // client, freelancer and strangers must all be rejected
        address[3] memory callers = [client, freelancer, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(Escrow.NotOracle.selector);
            escrow.releaseFunds();
        }
    }

    function test_releaseRevertsBeforeDeposit() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Created));
        escrow.releaseFunds();
    }

    function test_cannotReleaseTwice() public {
        _fund();
        vm.startPrank(oracle);
        escrow.releaseFunds();
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Released));
        escrow.releaseFunds();
        vm.stopPrank();
    }

    // ───────────── refundClient() ─────────────

    function test_oracleCanRefund() public {
        _fund();
        uint256 before = client.balance;

        vm.expectEmit(true, false, false, true);
        emit Refunded(client, AMOUNT);
        vm.prank(oracle);
        escrow.refundClient();

        assertEq(uint8(escrow.status()), uint8(Escrow.Status.Refunded));
        assertEq(client.balance, before + AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_refundRevertsForNonOracle() public {
        _fund();
        vm.prank(client);
        vm.expectRevert(Escrow.NotOracle.selector);
        escrow.refundClient();
    }

    function test_cannotRefundAfterRelease() public {
        _fund();
        vm.startPrank(oracle);
        escrow.releaseFunds();
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Released));
        escrow.refundClient();
        vm.stopPrank();
    }

    function test_cannotReleaseAfterRefund() public {
        _fund();
        vm.startPrank(oracle);
        escrow.refundClient();
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, Escrow.Status.Refunded));
        escrow.releaseFunds();
        vm.stopPrank();
    }

    // ───────────── Fuzz ─────────────

    /// Any amount other than the agreed one must be rejected.
    function testFuzz_depositWrongAmountReverts(uint256 sent) public {
        vm.assume(sent != AMOUNT && sent <= 100 ether);
        vm.deal(client, sent);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.IncorrectDeposit.selector, sent, AMOUNT));
        escrow.deposit{value: sent}();
    }

    /// Any random caller (other than the oracle) can never move funds.
    function testFuzz_onlyOracleMovesFunds(address caller) public {
        vm.assume(caller != oracle);
        _fund();
        vm.startPrank(caller);
        vm.expectRevert(Escrow.NotOracle.selector);
        escrow.releaseFunds();
        vm.expectRevert(Escrow.NotOracle.selector);
        escrow.refundClient();
        vm.stopPrank();
        assertEq(address(escrow).balance, AMOUNT);
    }

    /// Escrow is generic over amount.
    function testFuzz_fullFlowAnyAmount(uint96 amt) public {
        vm.assume(amt > 0);
        Escrow e = new Escrow(client, freelancer, oracle, amt);
        vm.deal(client, amt);
        vm.prank(client);
        e.deposit{value: amt}();
        vm.prank(oracle);
        e.releaseFunds();
        assertEq(freelancer.balance, amt);
    }
}
