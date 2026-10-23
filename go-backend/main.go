package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

type App struct {
	db               *pgxpool.Pool
	chain            *Chain
	aiURL            string
	humanReviewToken string
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
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ`); err != nil {
		log.Fatalf("db migration (deadline_at): %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows ADD COLUMN IF NOT EXISTS revision_limit INTEGER NOT NULL DEFAULT 0`); err != nil {
		log.Fatalf("db migration (revision_limit): %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows ADD COLUMN IF NOT EXISTS submission_text TEXT`); err != nil {
		log.Fatalf("db migration (submission_text): %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows ADD COLUMN IF NOT EXISTS human_decision BOOLEAN, ADD COLUMN IF NOT EXISTS human_reasoning TEXT`); err != nil {
		log.Fatalf("db migration (human decision): %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE escrows DROP CONSTRAINT IF EXISTS escrows_status_check, ADD CONSTRAINT escrows_status_check CHECK (status IN ('created', 'funded', 'evaluating', 'pending_review', 'released', 'refunded'))`); err != nil {
		log.Fatalf("db migration (pending_review status): %v", err)
	}

	chain, err := NewChain(ctx, mustEnv("RPC_URL"), mustEnv("ORACLE_PRIVATE_KEY"))
	if err != nil {
		log.Fatalf("chain: %v", err)
	}
	log.Printf("oracle address: %s | chain id: %s", chain.addr.Hex(), chain.chainID)

	app := &App{
		db:               pool,
		chain:            chain,
		aiURL:            envOr("AI_URL", "http://localhost:8000/evaluate"),
		humanReviewToken: envOr("HUMAN_REVIEW_TOKEN", ""),
	}

	app.reconcile(ctx) // local chain only: drop DB rows whose contracts vanished with an Anvil restart

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "oracle": chain.addr.Hex()})
	})
	mux.HandleFunc("POST /escrows", app.createEscrow)
	mux.HandleFunc("GET /escrows/{address}", app.getEscrow)
	mux.HandleFunc("POST /escrows/{address}/submit", app.submitWork)
	mux.HandleFunc("GET /reviews", app.listReviews)
	mux.HandleFunc("POST /reviews/{address}/decision", app.decideReview)

	srv := &http.Server{
		Addr:              ":" + envOr("PORT", "8080"),
		Handler:           cors(mux),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      3 * time.Minute, // submit waits for AI + block confirmation
	}
	log.Printf("listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}
