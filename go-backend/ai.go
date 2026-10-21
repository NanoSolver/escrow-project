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
	Decision  *bool  `json:"decision"` // pointer so a missing field is detected, not read as false
	Reasoning string `json:"reasoning"`
}

const aiAttempts = 3

// evaluate asks the FastAPI judge for a verdict. Anything other than a well-formed
// {decision: bool, reasoning: string} is treated as a failure and retried. The contract is
// only touched when this returns nil error, so a hallucinated reply can never move funds.
func (a *App) evaluate(ctx context.Context, requirement, submission string) (bool, string, error) {
	var lastErr error
	for attempt := 1; attempt <= aiAttempts; attempt++ {
		v, err := a.callAI(ctx, requirement, submission)
		if err == nil {
			return *v.Decision, v.Reasoning, nil
		}
		lastErr = err
		log.Printf("AI attempt %d/%d failed: %v", attempt, aiAttempts, err)

		select {
		case <-ctx.Done():
			return false, "", ctx.Err()
		case <-time.After(time.Duration(attempt) * 2 * time.Second):
		}
	}
	return false, "", fmt.Errorf("AI evaluation failed after %d attempts: %w", aiAttempts, lastErr)
}

func (a *App) callAI(ctx context.Context, requirement, submission string) (Verdict, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
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
	if v.Decision == nil {
		return Verdict{}, fmt.Errorf("AI reply missing 'decision'")
	}
	if strings.TrimSpace(v.Reasoning) == "" {
		return Verdict{}, fmt.Errorf("AI reply missing 'reasoning'")
	}
	return v, nil
}
