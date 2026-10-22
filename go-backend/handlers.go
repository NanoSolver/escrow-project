package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ───────────────────────────── helpers ─────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func cors(next http.Handler) http.Handler {
	origin := envOr("FRONTEND_ORIGIN", "http://localhost:3000")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

// parseAddress validates a hex address and returns it plus its canonical lowercase form.
func parseAddress(s string) (common.Address, string, bool) {
	if !common.IsHexAddress(s) {
		return common.Address{}, "", false
	}
	a := common.HexToAddress(s)
	return a, strings.ToLower(a.Hex()), true
}

// ───────────────────────────── model ─────────────────────────────

type Escrow struct {
	ContractAddress   string    `json:"contract_address"`
	ClientAddress     string    `json:"client_address"`
	FreelancerAddress string    `json:"freelancer_address"`
	InitialPrompt     string    `json:"initial_prompt"`
	SubmissionLink    string    `json:"submission_link"`
	Status            string    `json:"status"`
	AIDecision        *bool     `json:"ai_decision"`
	AIReasoning       string    `json:"ai_reasoning"`
	TxHash            string    `json:"tx_hash"`
	LastError         string    `json:"last_error"`
	CreatedAt         time.Time `json:"created_at"`
}

const escrowCols = `contract_address, client_address, freelancer_address, initial_prompt,
	COALESCE(submission_link, ''), status, ai_decision, COALESCE(ai_reasoning, ''),
	COALESCE(tx_hash, ''), COALESCE(last_error, ''), created_at`

func scanEscrow(row pgx.Row) (Escrow, error) {
	var e Escrow
	err := row.Scan(&e.ContractAddress, &e.ClientAddress, &e.FreelancerAddress, &e.InitialPrompt,
		&e.SubmissionLink, &e.Status, &e.AIDecision, &e.AIReasoning, &e.TxHash, &e.LastError, &e.CreatedAt)
	return e, err
}

func (a *App) loadEscrow(ctx context.Context, addr string) (Escrow, error) {
	return scanEscrow(a.db.QueryRow(ctx, `SELECT `+escrowCols+` FROM escrows WHERE contract_address = $1`, addr))
}

// ───────────────────── POST /escrows ─────────────────────
// Called by the frontend after the client deploys the contract. Parties are read from the
// chain, never trusted from the request body.

func (a *App) createEscrow(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ContractAddress string `json:"contract_address"`
		InitialPrompt   string `json:"initial_prompt"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	addr, addrLower, ok := parseAddress(body.ContractAddress)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid contract_address")
		return
	}
	prompt := strings.TrimSpace(body.InitialPrompt)
	if prompt == "" || len(prompt) > 5000 {
		writeErr(w, http.StatusBadRequest, "initial_prompt must be 1-5000 characters")
		return
	}

	ctx := r.Context()
	info, err := a.chain.Info(ctx, addr)
	if errors.Is(err, ErrNoContract) {
		writeErr(w, http.StatusBadRequest, "no contract deployed at that address on this network")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not read contract: "+err.Error())
		return
	}
	// Refuse contracts that name a different oracle: we could never settle them, and
	// accepting arbitrary contracts would let strangers make us spend gas.
	if info.Oracle != a.chain.addr {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("contract oracle is %s, not this backend (%s)", info.Oracle.Hex(), a.chain.addr.Hex()))
		return
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(ctx)

	client := strings.ToLower(info.Client.Hex())
	freelancer := strings.ToLower(info.Freelancer.Hex())
	for _, u := range []struct{ addr, role string }{{client, "client"}, {freelancer, "freelancer"}} {
		if _, err := tx.Exec(ctx,
			`INSERT INTO users (wallet_address, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, u.addr, u.role); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO escrows (contract_address, client_address, freelancer_address, initial_prompt, status)
		 VALUES ($1, $2, $3, $4, $5)`, addrLower, client, freelancer, prompt, statusName(info.Status)); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeErr(w, http.StatusConflict, "escrow already registered")
			return
		}
		log.Printf("insert escrow: %v", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	e, err := a.loadEscrow(ctx, addrLower)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	log.Printf("escrow registered: %s (client %s, freelancer %s)", addrLower, client, freelancer)
	writeJSON(w, http.StatusCreated, e)
}

// ───────────────────── GET /escrows/{address} ─────────────────────

func (a *App) getEscrow(w http.ResponseWriter, r *http.Request) {
	addr, addrLower, ok := parseAddress(r.PathValue("address"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid address")
		return
	}
	e, err := a.loadEscrow(r.Context(), addrLower)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "escrow not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Attach the live on-chain status (the chain, not the DB, is the source of truth for money).
	resp := map[string]any{"escrow": e}
	if info, err := a.chain.Info(r.Context(), addr); err == nil {
		resp["chain_status"] = statusName(info.Status)
		resp["chain_freelancer"] = strings.ToLower(info.Freelancer.Hex())
	}
	writeJSON(w, http.StatusOK, resp)
}

// ───────────────────── POST /escrows/{address}/submit ─────────────────────
// The core pipeline: fetch submission -> AI verdict (with retries) -> sign & send tx -> wait.

func (a *App) submitWork(w http.ResponseWriter, r *http.Request) {
	addr, addrLower, ok := parseAddress(r.PathValue("address"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid address")
		return
	}
	var body struct {
		Freelancer     string `json:"freelancer"`
		SubmissionLink string `json:"submission_link"`
		SubmissionText string `json:"submission_text"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	hasLink := strings.TrimSpace(body.SubmissionLink) != ""
	hasText := strings.TrimSpace(body.SubmissionText) != ""
	if hasLink == hasText {
		writeErr(w, http.StatusBadRequest, "provide exactly one of submission_link or submission_text")
		return
	}

	// Detach from the HTTP request: if the browser disconnects mid-flight we must still
	// finish (or cleanly fail) the pipeline so DB and chain never diverge.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()

	e, err := a.loadEscrow(ctx, addrLower)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "escrow not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Money must actually be locked on-chain.
	info, err := a.chain.Info(ctx, addr)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not read contract: "+err.Error())
		return
	}

	// The DB row must describe THIS contract. After an Anvil restart, a stale row from the
	// previous chain can share the same address; refuse instead of judging the wrong escrow.
	if strings.ToLower(info.Freelancer.Hex()) != e.FreelancerAddress ||
		strings.ToLower(info.Client.Hex()) != e.ClientAddress {
		writeErr(w, http.StatusConflict, "the database record does not match the contract on-chain (stale escrow from a previous local chain?). Clear it and register the escrow again")
		return
	}

	// NOTE: this only checks the claimed address, it does not prove the caller owns it.
	// Hackathon shortcut; production would verify an EIP-191 signed message.
	if _, claimed, ok := parseAddress(body.Freelancer); !ok || claimed != e.FreelancerAddress {
		writeErr(w, http.StatusForbidden, "only the escrow's freelancer may submit work")
		return
	}
	if info.Status != chainFunded {
		writeErr(w, http.StatusConflict, fmt.Sprintf("escrow is %s on-chain; it must be funded", statusName(info.Status)))
		return
	}

	// Get the submission text (fetched from an allowlisted host, or sent inline).
	submission := strings.TrimSpace(body.SubmissionText)
	link := "inline-text"
	if hasLink {
		link = strings.TrimSpace(body.SubmissionLink)
		if submission, err = fetchSubmission(ctx, link); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	// Atomically claim the escrow so two concurrent submits can't both trigger a payout.
	tag, err := a.db.Exec(ctx,
		`UPDATE escrows SET status = 'evaluating', submission_link = $2, last_error = NULL, updated_at = now()
		 WHERE contract_address = $1 AND status IN ('created', 'funded')`, addrLower, link)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusConflict, "escrow is already being evaluated or settled")
		return
	}

	// fail puts the escrow back to 'funded' so the freelancer can resubmit, and records why.
	fail := func(code int, msg string) {
		log.Printf("submit failed for %s: %s", addrLower, msg)
		bg, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_, _ = a.db.Exec(bg, `UPDATE escrows SET status = 'funded', last_error = $2, updated_at = now() WHERE contract_address = $1`, addrLower, msg)
		writeErr(w, code, msg)
	}

	log.Printf("evaluating submission for %s ...", addrLower)
	decision, reasoning, err := a.evaluate(ctx, e.InitialPrompt, submission)
	if err != nil {
		fail(http.StatusBadGateway, err.Error()) // contract untouched
		return
	}
	log.Printf("AI VERDICT: decision=%v | %s", decision, reasoning)

	txHash, err := a.chain.Settle(ctx, addr, decision)
	if err != nil {
		fail(http.StatusBadGateway, err.Error())
		return
	}

	finalStatus := "refunded"
	if decision {
		finalStatus = "released"
	}
	bg, c := context.WithTimeout(context.Background(), 5*time.Second)
	defer c()
	if _, err := a.db.Exec(bg,
		`UPDATE escrows SET status = $2, ai_decision = $3, ai_reasoning = $4, tx_hash = $5, updated_at = now()
		 WHERE contract_address = $1`, addrLower, finalStatus, decision, reasoning, txHash); err != nil {
		// The chain already settled; just report it loudly.
		log.Printf("WARNING: settled on-chain (tx %s) but DB update failed: %v", txHash, err)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"decision":  decision,
		"reasoning": reasoning,
		"status":    finalStatus,
		"tx_hash":   txHash,
	})
}
