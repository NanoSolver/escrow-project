package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type reply struct {
	status int
	body   string
}

// fakeAI serves the given replies in order (repeating the last one) and counts requests.
func fakeAI(replies []reply) (*httptest.Server, *int32) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := int(atomic.AddInt32(&n, 1)) - 1
		if i >= len(replies) {
			i = len(replies) - 1
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(replies[i].status)
		_, _ = w.Write([]byte(replies[i].body))
	}))
	return srv, &n
}

const goodReply = `{"decision":true,"reasoning":"ok"}`

func TestEvaluateRetriesThenSucceeds(t *testing.T) {
	retryBackoff = time.Millisecond
	srv, calls := fakeAI([]reply{{200, "not json at all"}, {200, goodReply}})
	defer srv.Close()

	a := &App{aiURL: srv.URL}
	v, err := a.evaluate(context.Background(), "req", "sub")
	if err != nil {
		t.Fatalf("expected success after a retry, got %v", err)
	}
	if v.Decision == nil || !*v.Decision || v.Reasoning != "ok" {
		t.Fatalf("unexpected verdict: %+v", v)
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("expected 2 calls, got %d", got)
	}
}

// A malformed AI reply must NEVER turn into a verdict: it has to fail closed after all retries.
func TestEvaluateFailsClosedOnBadReplies(t *testing.T) {
	retryBackoff = time.Millisecond
	bad := []string{
		`garbage`,
		`{}`,
		`{"decision":true}`,                   // missing reasoning
		`{"reasoning":"looks fine"}`,          // missing decision
		`{"decision":null,"reasoning":"x"}`,   // null decision
		`{"decision":"true","reasoning":"x"}`, // string instead of bool
		`{"decision":true,"reasoning":"   "}`, // blank reasoning
		`[{"decision":true,"reasoning":"x"}]`, // wrong shape
	}
	for i, body := range bad {
		t.Run(fmt.Sprintf("bad-%d", i), func(t *testing.T) {
			srv, calls := fakeAI([]reply{{200, body}})
			defer srv.Close()

			a := &App{aiURL: srv.URL}
			if _, err := a.evaluate(context.Background(), "req", "sub"); err == nil {
				t.Fatalf("reply %q was accepted; it must be rejected", body)
			}
			if got := atomic.LoadInt32(calls); got != aiAttempts {
				t.Fatalf("expected %d attempts, got %d", aiAttempts, got)
			}
		})
	}
}

func TestEvaluateFailsClosedWhenServiceDown(t *testing.T) {
	retryBackoff = time.Millisecond
	srv, calls := fakeAI([]reply{{502, `{"detail":"evaluation failed"}`}})
	defer srv.Close()

	a := &App{aiURL: srv.URL}
	if _, err := a.evaluate(context.Background(), "req", "sub"); err == nil {
		t.Fatal("expected an error when the AI service keeps failing")
	}
	if got := atomic.LoadInt32(calls); got != aiAttempts {
		t.Fatalf("expected %d attempts, got %d", aiAttempts, got)
	}
}

func TestEvaluateAcceptsRejection(t *testing.T) {
	retryBackoff = time.Millisecond
	srv, _ := fakeAI([]reply{{200, `{"decision":false,"reasoning":"does not reverse"}`}})
	defer srv.Close()

	a := &App{aiURL: srv.URL}
	v, err := a.evaluate(context.Background(), "req", "sub")
	if err != nil || v.Decision == nil || *v.Decision {
		t.Fatalf("a valid 'false' verdict must be returned as-is, got %+v err=%v", v, err)
	}
}
