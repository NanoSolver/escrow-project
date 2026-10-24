// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Escrow
/// @notice One escrow per job. The client locks ETH; only the oracle (the Go backend,
///         acting on the AI's verdict) can release it to the freelancer or refund the client.
contract Escrow {
    // ───────────────────────────── Types ─────────────────────────────
    enum Status {
        Created,   // deployed, waiting for the client's deposit
        Funded,    // ETH locked, waiting for the oracle's verdict
        Released,  // paid out to the freelancer (terminal)
        Refunded   // returned to the client (terminal)
    }

    // ──────────────────────────── Storage ────────────────────────────
    address public immutable client;
    address public immutable freelancer;
    address public immutable oracleAddress; // the Go backend's signing key
    uint256 public immutable amount;        // exact amount (in wei) that must be deposited
    uint64 public immutable submissionDeadline; // unix timestamp; work must be approved before this time
    uint8 public immutable revisionLimit;    // additional submissions allowed after rejection
    uint8 public revisionsUsed;
    Status public status;

    // ──────────────────────────── Events ─────────────────────────────
    event Deposited(address indexed client, uint256 amount);
    event Released(address indexed freelancer, uint256 amount);
    event Refunded(address indexed client, uint256 amount);
    event RevisionRequested(address indexed freelancer, uint8 revisionsUsed, uint8 revisionLimit);
    event ClientApproved(address indexed client, address indexed freelancer, uint256 amount);
    event ClientReviewRequested(address indexed client);

    // ──────────────────────────── Errors ─────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error DuplicateRoles();
    error NotClient();
    error NotOracle();
    error InvalidStatus(Status current);
    error IncorrectDeposit(uint256 sent, uint256 expected);
    error TransferFailed();
    error DeadlinePassed();
    error DeadlineNotReached();
    error NoRevisionsRemaining();
    error RevisionLimitTooHigh();
    error AlreadyRequested();

    bool public clientReviewRequested;

    // ─────────────────────────── Modifiers ───────────────────────────
    modifier onlyClient() {
        if (msg.sender != client) revert NotClient();
        _;
    }

    /// @dev RBAC: the core security rule of the project.
    modifier onlyOracle() {
        if (msg.sender != oracleAddress) revert NotOracle();
        _;
    }

    modifier inStatus(Status expected) {
        if (status != expected) revert InvalidStatus(status);
        _;
    }

    // ────────────────────────── Constructor ──────────────────────────
    constructor(
        address _client,
        address _freelancer,
        address _oracleAddress,
        uint256 _amount,
        uint64 _submissionDeadline,
        uint8 _revisionLimit
    ) {
        if (_client == address(0) || _freelancer == address(0) || _oracleAddress == address(0)) {
            revert ZeroAddress();
        }
        if (_amount == 0) revert ZeroAmount();
        if (_submissionDeadline <= block.timestamp) revert DeadlinePassed();
        if (_revisionLimit > 10) revert RevisionLimitTooHigh();
        // Three distinct parties: the oracle must never be a party to the deal.
        if (_client == _freelancer || _client == _oracleAddress || _freelancer == _oracleAddress) {
            revert DuplicateRoles();
        }

        client = _client;
        freelancer = _freelancer;
        oracleAddress = _oracleAddress;
        amount = _amount;
        submissionDeadline = _submissionDeadline;
        revisionLimit = _revisionLimit;
        status = Status.Created;
    }

    // ───────────────────────── Core functions ────────────────────────

    /// @notice Client locks the agreed amount. Must match `amount` exactly.
    function deposit() external payable onlyClient inStatus(Status.Created) {
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        if (msg.value != amount) revert IncorrectDeposit(msg.value, amount);

        status = Status.Funded;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Oracle approves the work: pay the freelancer.
    function releaseFunds() external onlyOracle inStatus(Status.Funded) {
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        // Effects before interaction (checks-effects-interactions) blocks reentrancy:
        // a second call fails the inStatus check.
        status = Status.Released;

        (bool ok, ) = payable(freelancer).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Released(freelancer, amount);
    }

    /// @notice Oracle rejects the work: return the funds to the client.
    function refundClient() external onlyOracle inStatus(Status.Funded) {
        _refundClient();
    }

    /// @notice Oracle rejects a submission while revisions remain; funds stay locked.
    function requestRevision() external onlyOracle inStatus(Status.Funded) {
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        if (revisionsUsed >= revisionLimit) revert NoRevisionsRemaining();
        revisionsUsed += 1;
        emit RevisionRequested(freelancer, revisionsUsed, revisionLimit);
    }

    /// @notice Client approves AI-approved work and releases the escrowed funds.
    function approveByClient() external onlyClient inStatus(Status.Funded) {
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        status = Status.Released;
        (bool ok, ) = payable(freelancer).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ClientApproved(client, freelancer, amount);
    }

    /// @notice Client disputes an AI approval; funds remain locked for human review.
    function requestHumanReview() external onlyClient inStatus(Status.Funded) {
        if (clientReviewRequested) revert AlreadyRequested();
        clientReviewRequested = true;
        emit ClientReviewRequested(client);
    }

    /// @notice Anyone can return stuck funds to the client after the submission deadline.
    function refundAfterDeadline() external inStatus(Status.Funded) {
        if (block.timestamp < submissionDeadline) revert DeadlineNotReached();
        _refundClient();
    }

    function _refundClient() private {
        status = Status.Refunded;

        (bool ok, ) = payable(client).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Refunded(client, amount);
    }

    // No receive()/fallback(): plain ETH transfers revert, so the only way
    // to fund the escrow is deposit().
}
