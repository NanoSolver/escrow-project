package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

type Verdict struct {
	Decision  *bool  `json:"decision"`
	Reasoning string `json:"reasoning"`
}

// Keep the complete review comfortably inside submitWork's two-minute deadline.
// A single retry is enough for transient Gemini 503s without leaving the UI
// spinning for several minutes when the provider is unavailable.
const aiAttempts = 2

// Pause between attempts is attempt * retryBackoff. A variable so tests can shrink it.
var retryBackoff = 2 * time.Second

// evaluate asks the FastAPI judge for a clear verdict.
// Malformed replies are retried, and the contract is only touched after a clear decision.
func (a *App) evaluate(ctx context.Context, requirement, submission string) (Verdict, error) {
	var lastErr error
	for attempt := 1; attempt <= aiAttempts; attempt++ {
		v, err := a.callAI(ctx, requirement, submission)
		if err == nil {
			return v, nil
		}
		lastErr = err
		log.Printf("AI attempt %d/%d failed: %v", attempt, aiAttempts, err)

		select {
		case <-ctx.Done():
			return Verdict{}, fmt.Errorf("AI evaluation timed out; no blockchain transaction was sent. Please retry: %w", ctx.Err())
		case <-time.After(time.Duration(attempt) * retryBackoff):
		}
	}
	return Verdict{}, fmt.Errorf("AI evaluation failed after %d attempts: %w", aiAttempts, lastErr)
}

func (a *App) callAI(ctx context.Context, requirement, submission string) (Verdict, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	payload, _ := json.Marshal(map[string]string{
		"requirement": requirement,
		"submission":  submission,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.aiURL, bytes.NewReader(payload))
	if err != nil {
		return Verdict{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return Verdict{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Verdict{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Verdict{}, fmt.Errorf("AI service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var v Verdict
	if err := json.Unmarshal(body, &v); err != nil {
		return Verdict{}, fmt.Errorf("invalid JSON from AI: %w", err)
	}
	if strings.TrimSpace(v.Reasoning) == "" {
		return Verdict{}, fmt.Errorf("AI reply missing 'reasoning'")
	}
	if v.Decision == nil {
		return Verdict{}, fmt.Errorf("AI reply did not provide a clear decision")
	}
	return v, nil
}
