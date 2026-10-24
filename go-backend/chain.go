package main

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Minimal hand-written ABI: only what the relayer needs, no abigen step.
const escrowABI = `[
 {"type":"function","name":"status","inputs":[],"outputs":[{"name":"","type":"uint8"}],"stateMutability":"view"},
 {"type":"function","name":"client","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
 {"type":"function","name":"freelancer","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
 {"type":"function","name":"oracleAddress","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
 {"type":"function","name":"amount","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
 {"type":"function","name":"submissionDeadline","inputs":[],"outputs":[{"name":"","type":"uint64"}],"stateMutability":"view"},
 {"type":"function","name":"revisionLimit","inputs":[],"outputs":[{"name":"","type":"uint8"}],"stateMutability":"view"},
 {"type":"function","name":"revisionsUsed","inputs":[],"outputs":[{"name":"","type":"uint8"}],"stateMutability":"view"},
 {"type":"function","name":"releaseFunds","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
 {"type":"function","name":"refundClient","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
 {"type":"function","name":"requestRevision","inputs":[],"outputs":[],"stateMutability":"nonpayable"}
]`

// Mirrors the Solidity enum order.
const (
	chainCreated  uint8 = 0
	chainFunded   uint8 = 1
	chainReleased uint8 = 2
	chainRefunded uint8 = 3
)

func statusName(s uint8) string {
	switch s {
	case chainCreated:
		return "created"
	case chainFunded:
		return "funded"
	case chainReleased:
		return "released"
	case chainRefunded:
		return "refunded"
	}
	return "unknown"
}

var ErrNoContract = errors.New("no contract code at that address")

type Chain struct {
	client  *ethclient.Client
	key     *ecdsa.PrivateKey
	addr    common.Address // the oracle address
	chainID *big.Int
	abi     abi.ABI
	mu      sync.Mutex // one oracle key => serialise txs so nonces never collide
}

type EscrowInfo struct {
	Client, Freelancer, Oracle   common.Address
	Status                       uint8
	Amount                       *big.Int // wei locked (or to be locked) in the escrow
	SubmissionDeadline           uint64   // unix seconds
	RevisionLimit, RevisionsUsed uint8
}

func NewChain(ctx context.Context, rpcURL, privateKeyHex string) (*Chain, error) {
	cl, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(strings.TrimSpace(privateKeyHex), "0x"))
	if err != nil {
		return nil, fmt.Errorf("bad ORACLE_PRIVATE_KEY: %w", err)
	}
	chainID, err := cl.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch chain id (is the RPC reachable?): %w", err)
	}
	parsed, err := abi.JSON(strings.NewReader(escrowABI))
	if err != nil {
		return nil, err
	}
	return &Chain{
		client:  cl,
		key:     key,
		addr:    crypto.PubkeyToAddress(key.PublicKey),
		chainID: chainID,
		abi:     parsed,
	}, nil
}

func (c *Chain) bound(addr common.Address) *bind.BoundContract {
	return bind.NewBoundContract(addr, c.abi, c.client, c.client, c.client)
}

func (c *Chain) callOne(ctx context.Context, bc *bind.BoundContract, method string) (any, error) {
	var out []any
	if err := bc.Call(&bind.CallOpts{Context: ctx}, &out, method); err != nil {
		return nil, fmt.Errorf("call %s: %w", method, err)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("call %s: empty result", method)
	}
	return out[0], nil
}

func (c *Chain) callAddr(ctx context.Context, bc *bind.BoundContract, method string) (common.Address, error) {
	v, err := c.callOne(ctx, bc, method)
	if err != nil {
		return common.Address{}, err
	}
	a, ok := v.(common.Address)
	if !ok {
		return common.Address{}, fmt.Errorf("call %s: unexpected type %T", method, v)
	}
	return a, nil
}

func (c *Chain) callUint8(ctx context.Context, bc *bind.BoundContract, method string) (uint8, error) {
	v, err := c.callOne(ctx, bc, method)
	if err != nil {
		return 0, err
	}
	n, ok := v.(uint8)
	if !ok {
		return 0, fmt.Errorf("call %s: unexpected type %T", method, v)
	}
	return n, nil
}

func (c *Chain) callUint64(ctx context.Context, bc *bind.BoundContract, method string) (uint64, error) {
	v, err := c.callOne(ctx, bc, method)
	if err != nil {
		return 0, err
	}
	n, ok := v.(uint64)
	if !ok {
		return 0, fmt.Errorf("call %s: unexpected type %T", method, v)
	}
	return n, nil
}

// StatusOf reads only the escrow's status: one cheap call for list views.
func (c *Chain) StatusOf(ctx context.Context, addr common.Address) (uint8, error) {
	return c.callUint8(ctx, c.bound(addr), "status")
}

// HasCode reports whether a contract exists at addr on the connected chain.
func (c *Chain) HasCode(ctx context.Context, addr common.Address) (bool, error) {
	code, err := c.client.CodeAt(ctx, addr, nil)
	if err != nil {
		return false, err
	}
	return len(code) > 0, nil
}

// Now returns the timestamp of the latest block. Deadlines are enforced against chain time,
// the same clock the contract uses, so the backend and contract always agree.
func (c *Chain) Now(ctx context.Context) (uint64, error) {
	h, err := c.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("latest block: %w", err)
	}
	return h.Time, nil
}

// Info reads the escrow's parties, deadline, revisions and live status straight from the chain.
// Contracts without deadline support (the older ABI) fail here with a clear error.
func (c *Chain) Info(ctx context.Context, addr common.Address) (EscrowInfo, error) {
	var info EscrowInfo
	code, err := c.client.CodeAt(ctx, addr, nil)
	if err != nil {
		return info, fmt.Errorf("code at: %w", err)
	}
	if len(code) == 0 {
		return info, ErrNoContract
	}

	bc := c.bound(addr)
	if info.Client, err = c.callAddr(ctx, bc, "client"); err != nil {
		return info, err
	}
	if info.Freelancer, err = c.callAddr(ctx, bc, "freelancer"); err != nil {
		return info, err
	}
	if info.Oracle, err = c.callAddr(ctx, bc, "oracleAddress"); err != nil {
		return info, err
	}
	if info.Status, err = c.callUint8(ctx, bc, "status"); err != nil {
		return info, err
	}
	amt, err := c.callOne(ctx, bc, "amount")
	if err != nil {
		return info, err
	}
	var okAmt bool
	if info.Amount, okAmt = amt.(*big.Int); !okAmt {
		return info, fmt.Errorf("call amount: unexpected type %T", amt)
	}
	if info.SubmissionDeadline, err = c.callUint64(ctx, bc, "submissionDeadline"); err != nil {
		return info, err
	}
	if info.RevisionLimit, err = c.callUint8(ctx, bc, "revisionLimit"); err != nil {
		return info, err
	}
	if info.RevisionsUsed, err = c.callUint8(ctx, bc, "revisionsUsed"); err != nil {
		return info, err
	}
	return info, nil
}

// Settle signs and sends releaseFunds() (release=true) or refundClient() (release=false)
// with the oracle key, then waits until the transaction is mined.
func (c *Chain) Settle(ctx context.Context, addr common.Address, release bool) (string, error) {
	method := "refundClient"
	if release {
		method = "releaseFunds"
	}
	return c.transact(ctx, addr, method)
}

// RequestRevision records a rejection that still allows a resubmission. Funds stay locked.
func (c *Chain) RequestRevision(ctx context.Context, addr common.Address) (string, error) {
	return c.transact(ctx, addr, "requestRevision")
}

func (c *Chain) transact(ctx context.Context, addr common.Address, method string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	opts, err := bind.NewKeyedTransactorWithChainID(c.key, c.chainID)
	if err != nil {
		return "", err
	}
	opts.Context = ctx

	tx, err := c.bound(addr).Transact(opts, method)
	if err != nil {
		// Gas estimation fails here if the contract would revert (wrong role, wrong status...).
		return "", fmt.Errorf("send %s: %w", method, err)
	}
	log.Printf("tx sent: %s() hash=%s", method, tx.Hash().Hex())

	receipt, err := bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return tx.Hash().Hex(), fmt.Errorf("waiting for %s: %w", method, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return tx.Hash().Hex(), fmt.Errorf("%s reverted on-chain (tx %s)", method, tx.Hash().Hex())
	}
	log.Printf("tx confirmed in block %d", receipt.BlockNumber.Uint64())
	return tx.Hash().Hex(), nil
}
