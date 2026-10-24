// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Escrow
/// @notice One escrow per job. The client locks ETH; only the oracle (the Go backend, acting on
///         the AI's verdict) can release it to the freelancer, refund the client, or grant the
///         freelancer another revision. If the oracle goes silent, anyone can refund the client
///         once the deadline (plus a short grace period) has passed, so funds can never be stuck.
///
///         Two ways to name the freelancer:
///           - assigned: the client passes the freelancer's address when deploying;
///           - open:     the client passes address(0). Once the job is funded, the first wallet that
///                       calls acceptJob() becomes the freelancer (one time, final).
contract Escrow {
    // ───────────────────────────── Types ─────────────────────────────
    enum Status {
        Created,   // deployed, waiting for the client's deposit
        Funded,    // ETH locked, waiting for the oracle's verdict
        Released,  // paid out to the freelancer (terminal)
        Refunded   // returned to the client (terminal)
    }

    // ─────────────────────────── Constants ───────────────────────────
    uint8 public constant MAX_REVISIONS = 10;

    /// @notice After the deadline the oracle keeps this long to finish a verdict that was already
    ///         in flight. Only then may anyone trigger refundAfterDeadline().
    uint64 public constant SETTLEMENT_GRACE = 10 minutes;

    // ──────────────────────────── Storage ────────────────────────────
    address public immutable client;
    address public freelancer;              // address(0) while an open job is waiting for someone to accept
    address public immutable oracleAddress; // the Go backend's signing key
    uint256 public immutable amount;        // exact amount (in wei) that must be deposited
    uint64 public immutable submissionDeadline; // unix time by which work must be submitted
    uint8 public immutable revisionLimit;       // how many rejections may be followed by a resubmission

    Status public status;
    uint8 public revisionsUsed;

    // ──────────────────────────── Events ─────────────────────────────
    event Deposited(address indexed client, uint256 amount);
    event Released(address indexed freelancer, uint256 amount);
    event Refunded(address indexed client, uint256 amount);
    event RevisionRequested(address indexed freelancer, uint8 revisionsUsed, uint8 revisionLimit);
    event JobAccepted(address indexed freelancer);
    event ClientApproved(address indexed client, address indexed freelancer, uint256 amount);

    // ──────────────────────────── Errors ─────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error DuplicateRoles();
    error InvalidDeadline();
    error RevisionLimitTooHigh();
    error NotClient();
    error NotOracle();
    error InvalidStatus(Status current);
    error IncorrectDeposit(uint256 sent, uint256 expected);
    error DeadlinePassed();
    error DeadlineNotReached();
    error AlreadyAssigned();
    error NoFreelancer();
    error NoRevisionsRemaining();
    error TransferFailed();

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
        // _freelancer == address(0) is allowed on purpose: it makes this an open job.
        if (_client == address(0) || _oracleAddress == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (_submissionDeadline <= block.timestamp) revert InvalidDeadline();
        if (_revisionLimit > MAX_REVISIONS) revert RevisionLimitTooHigh();
        // Three distinct parties: the oracle must never be a party to the deal.
        if (_client == _oracleAddress) revert DuplicateRoles();
        if (_freelancer != address(0) && (_freelancer == _client || _freelancer == _oracleAddress)) {
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

    /// @notice Client locks the agreed amount. Must match `amount` exactly and happen before the deadline.
    function deposit() external payable onlyClient inStatus(Status.Created) {
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        if (msg.value != amount) revert IncorrectDeposit(msg.value, amount);

        status = Status.Funded;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Open jobs only: the first caller becomes the freelancer. Only possible while the
    ///         escrow is funded (so the freelancer can see the money is locked) and before the deadline.
    function acceptJob() external inStatus(Status.Funded) {
        if (freelancer != address(0)) revert AlreadyAssigned();
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        // The client and the oracle can never be the freelancer.
        if (msg.sender == client || msg.sender == oracleAddress) revert DuplicateRoles();

        freelancer = msg.sender;
        emit JobAccepted(msg.sender);
    }

    /// @notice Oracle approves the work: pay the freelancer.
    function releaseFunds() external onlyOracle inStatus(Status.Funded) {
        if (freelancer == address(0)) revert NoFreelancer();
        // Effects before interaction (checks-effects-interactions) blocks reentrancy:
        // a second call fails the inStatus check.
        status = Status.Released;

        (bool ok, ) = payable(freelancer).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Released(freelancer, amount);
    }

    /// @notice Oracle rejects the work but a revision is still allowed: funds stay locked.
    function requestRevision() external onlyOracle inStatus(Status.Funded) {
        if (freelancer == address(0)) revert NoFreelancer();
        if (revisionsUsed >= revisionLimit) revert NoRevisionsRemaining();

        revisionsUsed += 1;
        emit RevisionRequested(freelancer, revisionsUsed, revisionLimit);
    }

    /// @notice Client approves AI-approved work and releases the escrowed funds.
    function approveByClient() external onlyClient inStatus(Status.Funded) {
        if (block.timestamp >= submissionDeadline) revert DeadlinePassed();
        if (freelancer == address(0)) revert NoFreelancer();
        status = Status.Released;
        (bool ok, ) = payable(freelancer).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ClientApproved(client, freelancer, amount);
    }

    /// @notice Oracle rejects the work for good (no revisions left): return the funds to the client.
    function refundClient() external onlyOracle inStatus(Status.Funded) {
        _refund();
    }

    /// @notice Safety valve: if nobody settled the escrow, anyone may return the funds to the client
    ///         once the deadline plus the grace period has passed. The funds can only go to the client.
    function refundAfterDeadline() external inStatus(Status.Funded) {
        if (block.timestamp < uint256(submissionDeadline) + SETTLEMENT_GRACE) revert DeadlineNotReached();
        _refund();
    }

    // ─────────────────────────── Internals ───────────────────────────

    function _refund() private {
        status = Status.Refunded;

        (bool ok, ) = payable(client).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Refunded(client, amount);
    }

    // No receive()/fallback(): plain ETH transfers revert, so the only way
    // to fund the escrow is deposit().
}
