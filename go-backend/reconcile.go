package main

import (
	"context"
	"log"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

const localChainID = 31337 // Anvil / Hardhat

// reconcile runs once at startup. A local Anvil chain is wiped on every restart, but the
// database survives, so old escrow rows would point at contracts that no longer exist (and
// block new escrows that land on the same deterministic address). Drop those stale rows.
//
// Deliberately skipped on real networks like Sepolia: a flaky RPC must never cause the
// backend to delete legitimate records.
func (a *App) reconcile(ctx context.Context) {
	if !a.chain.chainID.IsUint64() || a.chain.chainID.Uint64() != localChainID {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rows, err := a.db.Query(ctx, `SELECT contract_address FROM escrows`)
	if err != nil {
		log.Printf("reconcile: query failed: %v", err)
		return
	}
	var addrs []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			log.Printf("reconcile: scan failed: %v", err)
			rows.Close()
			return
		}
		addrs = append(addrs, s)
	}
	rows.Close()

	removed := 0
	for _, s := range addrs {
		exists, err := a.chain.HasCode(ctx, common.HexToAddress(s))
		if err != nil {
			log.Printf("reconcile: could not check %s: %v", s, err)
			continue // never delete on an RPC error
		}
		if exists {
			continue
		}
		if _, err := a.db.Exec(ctx, `DELETE FROM escrows WHERE contract_address = $1`, s); err != nil {
			log.Printf("reconcile: delete %s failed: %v", s, err)
			continue
		}
		removed++
	}
	if removed > 0 {
		log.Printf("reconcile: removed %d stale escrow(s) left over from a previous local chain", removed)
	}
}
