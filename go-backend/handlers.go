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
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
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

var zeroAddress common.Address

// An open job has no freelancer until someone calls acceptJob() on-chain; FreelancerAddress is "".
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
	DeadlineAt        time.Time `json:"deadline_at"`
	RevisionLimit     int       `json:"revision_limit"`
	RevisionsUsed     int       `json:"revisions_used"`
	CreatedAt         time.Time `json:"created_at"`
	AmountWei         string    `json:"amount_wei"` // "" until first read from the chain
}

const escrowCols = `contract_address, client_address, COALESCE(freelancer_address, ''), initial_prompt,
	COALESCE(submission_link, ''), status, ai_decision, COALESCE(ai_reasoning, ''),
	COALESCE(tx_hash, ''), COALESCE(last_error, ''),
	COALESCE(deadline_at, to_timestamp(0)), revision_limit, revisions_used, created_at,
	COALESCE(amount_wei, '')`

func scanEscrow(row pgx.Row) (Escrow, error) {
	var e Escrow
	err := row.Scan(&e.ContractAddress, &e.ClientAddress, &e.FreelancerAddress, &e.InitialPrompt,
		&e.SubmissionLink, &e.Status, &e.AIDecision, &e.AIReasoning, &e.TxHash, &e.LastError,
		&e.DeadlineAt, &e.RevisionLimit, &e.RevisionsUsed, &e.CreatedAt, &e.AmountWei)
	return e, err
}

func (a *App) loadEscrow(ctx context.Context, addr string) (Escrow, error) {
	return scanEscrow(a.db.QueryRow(ctx, `SELECT `+escrowCols+` FROM escrows WHERE contract_address = $1`, addr))
}

// ───────────────────── POST /escrows ─────────────────────
// Called by the frontend after the client deploys the contract. Parties, deadline and revision
// limit are read from the chain, never trusted from the request body.

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
		writeErr(w, http.StatusBadGateway, "could not read contract (is it a deadline-enabled escrow?): "+err.Error())
		return
	}
	// Refuse contracts that name a different oracle: we could never settle them, and
	// accepting arbitrary contracts would let strangers make us spend gas.
	if info.Oracle != a.chain.addr {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("contract oracle is %s, not this backend (%s)", info.Oracle.Hex(), a.chain.addr.Hex()))
		return
	}

	// Registration can be retried after a browser/API response is lost. Treat an identical
	// retry as success so a funded escrow is not stranded behind a duplicate-key error.
	client := strings.ToLower(info.Client.Hex())
	if existing, err := a.loadEscrow(ctx, addrLower); err == nil {
		if existing.ClientAddress != client || existing.InitialPrompt != prompt {
			writeErr(w, http.StatusConflict, "escrow is already registered with different details")
			return
		}
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(ctx)

	users := []struct{ addr, role string }{{client, "client"}}
	// freelancerArg stays nil (SQL NULL) for an open job nobody has accepted yet.
	var freelancerArg any
	freelancer := "open"
	if info.Freelancer != zeroAddress {
		freelancer = strings.ToLower(info.Freelancer.Hex())
		freelancerArg = freelancer
		users = append(users, struct{ addr, role string }{freelancer, "freelancer"})
	}
	for _, u := range users {
		if _, err := tx.Exec(ctx,
			`INSERT INTO users (wallet_address, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, u.addr, u.role); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO escrows (contract_address, client_address, freelancer_address, initial_prompt, status,
		                      deadline_at, revision_limit, revisions_used, amount_wei)
		 VALUES ($1, $2, $3, $4, $5, to_timestamp($6), $7, $8, $9)`,
		addrLower, client, freelancerArg, prompt, statusName(info.Status),
		float64(info.SubmissionDeadline), int(info.RevisionLimit), int(info.RevisionsUsed),
		info.Amount.String()); err != nil {
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
	log.Printf("escrow registered: %s (client %s, freelancer %s, deadline %s, revisions %d)",
		addrLower, client, freelancer, time.Unix(int64(info.SubmissionDeadline), 0).Format(time.RFC3339), info.RevisionLimit)
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

	// Attach the live on-chain state (the chain, not the DB, is the source of truth for money).
	resp := map[string]any{"escrow": e}
	if info, err := a.chain.Info(r.Context(), addr); err == nil {
		chainStatus := statusName(info.Status)
		resp["chain_status"] = chainStatus
		chainFreelancer := "" // empty = open job, nobody has accepted it yet
		if info.Freelancer != zeroAddress {
			chainFreelancer = strings.ToLower(info.Freelancer.Hex())
		}
		resp["chain_freelancer"] = chainFreelancer
		resp["chain_amount_wei"] = info.Amount.String()
		resp["chain_deadline"] = info.SubmissionDeadline
		resp["chain_revision_limit"] = info.RevisionLimit
		resp["chain_revisions_used"] = info.RevisionsUsed

		// Someone accepted an open job directly on-chain: record who (only if this row really
		// describes this contract).
		if e.FreelancerAddress == "" && chainFreelancer != "" &&
			strings.ToLower(info.Client.Hex()) == e.ClientAddress {
			if err := a.adoptFreelancer(r.Context(), addrLower, info.Freelancer); err == nil {
				e.FreelancerAddress = chainFreelancer
				resp["escrow"] = e
			} else {
				log.Printf("adopt freelancer for %s: %v", addrLower, err)
			}
		}

		// Keep the DB in step with things that happen without the backend, such as someone
		// calling refundAfterDeadline() directly on the contract.
		newStatus := e.Status
		if info.Status == chainReleased || info.Status == chainRefunded {
			newStatus = chainStatus
		}
		if newStatus != e.Status || int(info.RevisionsUsed) != e.RevisionsUsed {
			if _, err := a.db.Exec(r.Context(),
				`UPDATE escrows SET status = $2, revisions_used = $3, updated_at = now() WHERE contract_address = $1`,
				addrLower, newStatus, int(info.RevisionsUsed)); err == nil {
				e.Status = newStatus
				e.RevisionsUsed = int(info.RevisionsUsed)
				resp["escrow"] = e
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// ───────────────────── POST /escrows/{address}/submit ─────────────────────
// The core pipeline: fetch submission -> AI verdict (with retries) -> sign & send tx -> wait.
// A verdict has three possible outcomes: release (approved), revision (rejected but the
// freelancer may try again), or refund (rejected and no revisions left or deadline passed).

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
	staleMsg := "the database record does not match the contract on-chain (stale escrow from a previous local chain?). Clear it and register the escrow again"
	if strings.ToLower(info.Client.Hex()) != e.ClientAddress {
		writeErr(w, http.StatusConflict, staleMsg)
		return
	}
	// Open job: work can only be submitted once a freelancer has accepted it on-chain.
	if info.Freelancer == zeroAddress {
		writeErr(w, http.StatusConflict, "no freelancer has accepted this open job yet. Accept the job first, then submit your work")
		return
	}
	if e.FreelancerAddress == "" {
		if err := a.adoptFreelancer(ctx, addrLower, info.Freelancer); err != nil {
			log.Printf("adopt freelancer for %s: %v", addrLower, err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		e.FreelancerAddress = strings.ToLower(info.Freelancer.Hex())
	}
	if strings.ToLower(info.Freelancer.Hex()) != e.FreelancerAddress {
		writeErr(w, http.StatusConflict, staleMsg)
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

	// Deadline: enforced against chain time, the same clock the contract uses.
	chainNow, err := a.chain.Now(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if chainNow >= info.SubmissionDeadline {
		writeErr(w, http.StatusConflict, "the submission deadline has passed; after a short grace period anyone can trigger the on-chain refund to the client")
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

	// Atomically claim the escrow so two concurrent submits can't both trigger a settlement.
	tag, err := a.db.Exec(ctx,
		`UPDATE escrows SET status = 'evaluating', submission_link = $2, submission_text = $3, submitted_at = now(),
		        ai_decision = NULL, ai_reasoning = NULL, last_error = NULL, updated_at = now()
		 WHERE contract_address = $1 AND status IN ('created', 'funded')`, addrLower, link, submission)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusConflict, "escrow is already being evaluated or settled")
		return
	}

	// fail restores the escrow's real state (normally 'funded') so the freelancer can resubmit,
	// and records why.
	fail := func(code int, msg string) {
		log.Printf("submit failed for %s: %s", addrLower, msg)
		bg, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		status := "funded"
		if latest, readErr := a.chain.Info(bg, addr); readErr == nil {
			status = statusName(latest.Status)
		}
		_, _ = a.db.Exec(bg, `UPDATE escrows SET status = $2, last_error = $3, updated_at = now() WHERE contract_address = $1`, addrLower, status, msg)
		writeErr(w, code, msg)
	}

	log.Printf("evaluating submission for %s ...", addrLower)
	verdict, err := a.evaluate(ctx, e.InitialPrompt, submission)
	if err != nil {
		fail(http.StatusBadGateway, err.Error()) // contract untouched
		return
	}
	decision := *verdict.Decision
	reasoning := verdict.Reasoning
	log.Printf("AI VERDICT: decision=%v | %s", decision, reasoning)

	// Decide what to do on-chain. Re-read chain time: the AI call may have run past the deadline,
	// in which case a revision would be pointless and a rejection refunds immediately.
	nowAfter := chainNow
	if t, terr := a.chain.Now(ctx); terr == nil {
		nowAfter = t
	}
	action := "refund"
	switch {
	case decision:
		action = "release"
	case info.RevisionsUsed < info.RevisionLimit && nowAfter < info.SubmissionDeadline:
		action = "revision"
	}
	log.Printf("settlement action for %s: %s (revisions %d/%d)", addrLower, action, info.RevisionsUsed, info.RevisionLimit)

	var txHash string
	switch action {
	case "release":
		txHash, err = a.chain.Settle(ctx, addr, true)
	case "revision":
		txHash, err = a.chain.RequestRevision(ctx, addr)
	default:
		txHash, err = a.chain.Settle(ctx, addr, false)
	}
	if err != nil {
		fail(http.StatusBadGateway, err.Error())
		return
	}

	finalStatus := "refunded"
	revisionsUsed := info.RevisionsUsed
	switch action {
	case "release":
		finalStatus = "released"
	case "revision":
		finalStatus = "funded"
		revisionsUsed++
	}

	bg, c := context.WithTimeout(context.Background(), 5*time.Second)
	defer c()
	if _, err := a.db.Exec(bg,
		`UPDATE escrows SET status = $2, ai_decision = $3, ai_reasoning = $4, tx_hash = $5,
		        revisions_used = $6, last_error = NULL, updated_at = now()
		 WHERE contract_address = $1`,
		addrLower, finalStatus, decision, reasoning, txHash, int(revisionsUsed)); err != nil {
		// The chain already settled; just report it loudly.
		log.Printf("WARNING: settled on-chain (tx %s) but DB update failed: %v", txHash, err)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"decision":       decision,
		"reasoning":      reasoning,
		"status":         finalStatus,
		"tx_hash":        txHash,
		"revisions_used": revisionsUsed,
		"revision_limit": info.RevisionLimit,
	})
}

// ───────────────────── open jobs ─────────────────────

// adoptFreelancer stores the wallet that accepted an open job. It only fills an empty slot, so a
// freelancer already on record can never be overwritten.
func (a *App) adoptFreelancer(ctx context.Context, addrLower string, freelancer common.Address) error {
	f := strings.ToLower(freelancer.Hex())
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`INSERT INTO users (wallet_address, role) VALUES ($1, 'freelancer') ON CONFLICT DO NOTHING`, f); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE escrows SET freelancer_address = $2, updated_at = now()
		 WHERE contract_address = $1 AND freelancer_address IS NULL`, addrLower, f); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ───────────────────── GET /escrows (the open-jobs board) ─────────────────────
// Lists funded jobs that no freelancer has accepted yet. The database is only an index: every
// candidate is re-checked against the chain before it is shown.

const maxOpenJobs = 20

func (a *App) listOpenEscrows(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := a.db.Query(ctx, `SELECT `+escrowCols+` FROM escrows
		WHERE freelancer_address IS NULL AND status = 'funded'
		ORDER BY created_at DESC LIMIT $1`, maxOpenJobs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	var candidates []Escrow
	for rows.Next() {
		e, err := scanEscrow(rows)
		if err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		candidates = append(candidates, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	type job struct {
		ContractAddress string    `json:"contract_address"`
		ClientAddress   string    `json:"client_address"`
		Requirement     string    `json:"requirement"`
		AmountWei       string    `json:"amount_wei"`
		Deadline        uint64    `json:"deadline"` // unix seconds
		RevisionLimit   int       `json:"revision_limit"`
		CreatedAt       time.Time `json:"created_at"`
	}
	jobs := make([]job, 0, len(candidates))
	if len(candidates) > 0 {
		chainNow, err := a.chain.Now(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		for _, e := range candidates {
			info, err := a.chain.Info(ctx, common.HexToAddress(e.ContractAddress))
			if err != nil {
				continue // stale row or flaky RPC: simply leave it off the board
			}
			if strings.ToLower(info.Client.Hex()) != e.ClientAddress {
				continue
			}
			if info.Freelancer != zeroAddress {
				// Taken on-chain since we last looked: record it and hide it from the board.
				if err := a.adoptFreelancer(ctx, e.ContractAddress, info.Freelancer); err != nil {
					log.Printf("adopt freelancer for %s: %v", e.ContractAddress, err)
				}
				continue
			}
			if info.Status != chainFunded || chainNow >= info.SubmissionDeadline {
				continue
			}
			jobs = append(jobs, job{
				ContractAddress: e.ContractAddress,
				ClientAddress:   e.ClientAddress,
				Requirement:     e.InitialPrompt,
				AmountWei:       info.Amount.String(),
				Deadline:        info.SubmissionDeadline,
				RevisionLimit:   int(info.RevisionLimit),
				CreatedAt:       e.CreatedAt,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

// ───────────────────── submission review (client & freelancer only) ─────────────────────

// GET /escrows/{address}/submission  (Authorization: Bearer <session token>)
// The submitted work is private: only the escrow's client and its freelancer may read it.
func (a *App) getSubmission(w http.ResponseWriter, r *http.Request) {
	_, addrLower, ok := parseAddress(r.PathValue("address"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid address")
		return
	}
	who, ok := requireSession(w, r)
	if !ok {
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
	if who != e.ClientAddress && (e.FreelancerAddress == "" || who != e.FreelancerAddress) {
		writeErr(w, http.StatusForbidden, "only this escrow's client or freelancer can view the submitted work")
		return
	}
	var text string
	var submittedAt *time.Time
	if err := a.db.QueryRow(r.Context(),
		`SELECT COALESCE(submission_text, ''), submitted_at FROM escrows WHERE contract_address = $1`,
		addrLower).Scan(&text, &submittedAt); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"submission_link": e.SubmissionLink,
		"submission_text": text,
		"submitted_at":    submittedAt,
		"status":          e.Status,
		"ai_decision":     e.AIDecision,
		"ai_reasoning":    e.AIReasoning,
		"revisions_used":  e.RevisionsUsed,
		"revision_limit":  e.RevisionLimit,
	})
}

// GET /clients/{address}/escrows and GET /freelancers/{address}/escrows
// (Authorization: Bearer <session token>). Your own escrows for the review portal and "My jobs".
func (a *App) listClientEscrows(w http.ResponseWriter, r *http.Request) {
	a.listMyEscrows(w, r, "client_address")
}

func (a *App) listFreelancerEscrows(w http.ResponseWriter, r *http.Request) {
	a.listMyEscrows(w, r, "freelancer_address")
}

// column is one of two constants above, never user input. Settled-on-chain states are synced here,
// so an approval or refund made straight from a wallet shows up without a manual refresh.
func (a *App) listMyEscrows(w http.ResponseWriter, r *http.Request, column string) {
	_, addrLower, ok := parseAddress(r.PathValue("address"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid address")
		return
	}
	who, ok := requireSession(w, r)
	if !ok {
		return
	}
	if who != addrLower {
		writeErr(w, http.StatusForbidden, "you can only list your own escrows")
		return
	}
	ctx := r.Context()

	rows, err := a.db.Query(ctx, `SELECT `+escrowCols+` FROM escrows WHERE `+column+` = $1
		ORDER BY created_at DESC LIMIT 50`, addrLower)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	var list []Escrow
	for rows.Next() {
		e, err := scanEscrow(rows)
		if err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		list = append(list, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	submitted := map[string]time.Time{}
	if srows, err := a.db.Query(ctx, `SELECT contract_address, submitted_at FROM escrows
		WHERE `+column+` = $1 AND submission_text IS NOT NULL AND submission_text <> ''
		  AND submitted_at IS NOT NULL`, addrLower); err == nil {
		for srows.Next() {
			var addr string
			var at time.Time
			if srows.Scan(&addr, &at) == nil {
				submitted[addr] = at
			}
		}
		srows.Close()
	}

	type item struct {
		Escrow
		HasSubmission bool       `json:"has_submission"`
		SubmittedAt   *time.Time `json:"submitted_at"`
	}
	out := make([]item, 0, len(list))
	for _, e := range list {
		// Escrows registered before amounts were stored get theirs from the chain, once.
		if e.AmountWei == "" {
			if info, err := a.chain.Info(ctx, common.HexToAddress(e.ContractAddress)); err == nil {
				e.AmountWei = info.Amount.String()
				_, _ = a.db.Exec(ctx, `UPDATE escrows SET amount_wei = $2 WHERE contract_address = $1`,
					e.ContractAddress, e.AmountWei)
			}
		}
		if e.Status == "created" || e.Status == "funded" || e.Status == "evaluating" {
			if s, err := a.chain.StatusOf(ctx, common.HexToAddress(e.ContractAddress)); err == nil &&
				(s == chainReleased || s == chainRefunded) {
				name := statusName(s)
				if _, err := a.db.Exec(ctx,
					`UPDATE escrows SET status = $2, updated_at = now() WHERE contract_address = $1`,
					e.ContractAddress, name); err == nil {
					e.Status = name
				}
			}
		}
		it := item{Escrow: e}
		if at, ok := submitted[e.ContractAddress]; ok {
			it.HasSubmission = true
			it.SubmittedAt = &at
		}
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"escrows": out})
}
