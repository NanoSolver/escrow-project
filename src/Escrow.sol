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
    Status public status;

    // ──────────────────────────── Events ─────────────────────────────
    event Deposited(address indexed client, uint256 amount);
    event Released(address indexed freelancer, uint256 amount);
    event Refunded(address indexed client, uint256 amount);

    // ──────────────────────────── Errors ─────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error DuplicateRoles();
    error NotClient();
    error NotOracle();
    error InvalidStatus(Status current);
    error IncorrectDeposit(uint256 sent, uint256 expected);
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
    constructor(address _client, address _freelancer, address _oracleAddress, uint256 _amount) {
        if (_client == address(0) || _freelancer == address(0) || _oracleAddress == address(0)) {
            revert ZeroAddress();
        }
        if (_amount == 0) revert ZeroAmount();
        // Three distinct parties: the oracle must never be a party to the deal.
        if (_client == _freelancer || _client == _oracleAddress || _freelancer == _oracleAddress) {
            revert DuplicateRoles();
        }

        client = _client;
        freelancer = _freelancer;
        oracleAddress = _oracleAddress;
        amount = _amount;
        status = Status.Created;
    }

    // ───────────────────────── Core functions ────────────────────────

    /// @notice Client locks the agreed amount. Must match `amount` exactly.
    function deposit() external payable onlyClient inStatus(Status.Created) {
        if (msg.value != amount) revert IncorrectDeposit(msg.value, amount);

        status = Status.Funded;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Oracle approves the work: pay the freelancer.
    function releaseFunds() external onlyOracle inStatus(Status.Funded) {
        // Effects before interaction (checks-effects-interactions) blocks reentrancy:
        // a second call fails the inStatus check.
        status = Status.Released;

        (bool ok, ) = payable(freelancer).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Released(freelancer, amount);
    }

    /// @notice Oracle rejects the work: return the funds to the client.
    function refundClient() external onlyOracle inStatus(Status.Funded) {
        status = Status.Refunded;

        (bool ok, ) = payable(client).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Refunded(client, amount);
    }

    // No receive()/fallback(): plain ETH transfers revert, so the only way
    // to fund the escrow is deposit().
}
