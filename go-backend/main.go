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

	chain, err := NewChain(ctx, mustEnv("RPC_URL"), mustEnv("ORACLE_PRIVATE_KEY"))
	if err != nil {
		log.Fatalf("chain: %v", err)
	}
	log.Printf("oracle address: %s | chain id: %s", chain.addr.Hex(), chain.chainID)

	app := &App{
		db:    pool,
		chain: chain,
		aiURL: envOr("AI_URL", "http://localhost:8000/evaluate"),
	}

	app.reconcile(ctx) // local chain only: drop DB rows whose contracts vanished with an Anvil restart

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "oracle": chain.addr.Hex()})
	})
	mux.HandleFunc("POST /escrows", app.createEscrow)
	mux.HandleFunc("GET /escrows/{address}", app.getEscrow)
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
