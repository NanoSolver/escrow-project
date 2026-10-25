package main

import (
	"context"
	_ "embed"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

//go:embed schema.sql
var schemaSQL string

type App struct {
	db    *pgxpool.Pool
	chain *Chain
	aiURL string
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("missing required env var %s", k)
	}
	return v
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	_ = godotenv.Load() // optional .env file; works the same on Windows/macOS/Linux

	ctx := context.Background()

	pool, err := pgxpool.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("db ping: %v", err)
	}
	// Create tables and indexes on fresh databases (e.g. Neon), then upgrade older schemas below.
	for _, stmt := range strings.Split(schemaSQL, ";") {
		if stmt = strings.TrimSpace(stmt); stmt == "" {
			continue
		}
		if _, err := pool.Exec(ctx, stmt); err != nil {
			log.Fatalf("db schema: %v", err)
		}
	}
	// Upgrade databases created before deadlines/revisions existed (safe to run every start).
	for _, stmt := range []string{
		`ALTER TABLE escrows ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ`,
		`ALTER TABLE escrows ADD COLUMN IF NOT EXISTS revision_limit INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE escrows ADD COLUMN IF NOT EXISTS revisions_used INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			log.Fatalf("db migration: %v", err)
		}
	}

	// The client reviews the latest submission, so it is stored (the link alone can change or vanish).
	for _, stmt := range []string{
		`ALTER TABLE escrows ADD COLUMN IF NOT EXISTS submission_text TEXT`,
		`ALTER TABLE escrows ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`,
		`ALTER TABLE escrows ADD COLUMN IF NOT EXISTS amount_wei TEXT`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			log.Fatalf("db migration (submissions): %v", err)
		}
	}
	// Open jobs have no freelancer until someone accepts them on-chain.
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows ALTER COLUMN freelancer_address DROP NOT NULL`); err != nil {
		log.Fatalf("db migration (open jobs): %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE escrows SET status = 'funded' WHERE status = 'pending_review'`); err != nil {
		log.Fatalf("db migration (remove pending reviews): %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows DROP CONSTRAINT IF EXISTS escrows_status_check, ADD CONSTRAINT escrows_status_check CHECK (status IN ('created', 'funded', 'evaluating', 'released', 'refunded'))`); err != nil {
		log.Fatalf("db migration (status): %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows DROP COLUMN IF EXISTS human_decision, DROP COLUMN IF EXISTS human_reasoning`); err != nil {
		log.Fatalf("db migration (remove reviewer data): %v", err)
	}

	chain, err := NewChain(ctx, mustEnv("RPC_URL"), mustEnv("ORACLE_PRIVATE_KEY"))
	if err != nil {
		log.Fatalf("chain: %v", err)
	}
	if expected := strings.TrimSpace(os.Getenv("EXPECTED_CHAIN_ID")); expected != "" && expected != chain.chainID.String() {
		log.Fatalf("connected chain ID %s does not match EXPECTED_CHAIN_ID=%s", chain.chainID, expected)
	}
	log.Printf("oracle address: %s | chain id: %s", chain.addr.Hex(), chain.chainID)
	if bal, err := chain.client.BalanceAt(ctx, chain.addr, nil); err == nil {
		log.Printf("oracle balance: %s wei", bal)
		if bal.Sign() == 0 {
			log.Printf("WARNING: the oracle has 0 balance and cannot pay gas to settle escrows. Fund it first")
		}
	}

	app := &App{
		db:    pool,
		chain: chain,
		aiURL: envOr("AI_URL", "http://localhost:8000/evaluate"),
	}

	app.reconcile(ctx) // local chain only: drop DB rows whose contracts vanished with an Anvil restart

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"oracle":   chain.addr.Hex(),
			"chain_id": chain.chainID.String(),
		})
	})
	mux.HandleFunc("POST /auth/challenge", app.authChallenge)
	mux.HandleFunc("POST /auth/verify", app.authVerify)
	mux.HandleFunc("GET /escrows", app.listOpenEscrows)
	mux.HandleFunc("POST /escrows", app.createEscrow)
	mux.HandleFunc("GET /escrows/{address}", app.getEscrow)
	mux.HandleFunc("GET /escrows/{address}/submission", app.getSubmission)
	mux.HandleFunc("GET /clients/{address}/escrows", app.listClientEscrows)
	mux.HandleFunc("GET /freelancers/{address}/escrows", app.listFreelancerEscrows)
	mux.HandleFunc("POST /escrows/{address}/submit", app.submitWork)

	srv := &http.Server{
		Addr:              ":" + envOr("PORT", "8080"),
		Handler:           cors(mux),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      3 * time.Minute, // submit waits for AI + block confirmation
	}
	log.Printf("listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}
