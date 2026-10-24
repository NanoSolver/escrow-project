package main

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func reqWithToken(token string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return r
}

func TestSessionRoundTrip(t *testing.T) {
	tok := issueSession("0xAbCdEf0000000000000000000000000000000001", "client")
	got, ok := sessionAddress(reqWithToken(tok))
	if !ok || got != "0xabcdef0000000000000000000000000000000001" {
		t.Fatalf("valid token rejected or address not lowercased: %q %v", got, ok)
	}
}

func TestSessionRejectsBadTokens(t *testing.T) {
	good := issueSession("0x0000000000000000000000000000000000000001", "client")
	parts := strings.Split(good, ".")

	forgedPayload := base64.RawURLEncoding.EncodeToString(
		[]byte(fmt.Sprintf("0x0000000000000000000000000000000000000002|client|%d", time.Now().Add(time.Hour).Unix())))
	expired := fmt.Sprintf("0x0000000000000000000000000000000000000001|client|%d", time.Now().Add(-time.Minute).Unix())
	expiredTok := base64.RawURLEncoding.EncodeToString([]byte(expired)) + "." +
		base64.RawURLEncoding.EncodeToString(sessionMAC(expired))

	cases := map[string]string{
		"missing":          "",
		"garbage":          "not-a-token",
		"one part":         parts[0],
		"swapped payload":  forgedPayload + "." + parts[1], // someone else's address, my signature
		"truncated sig":    parts[0] + "." + parts[1][:10],
		"expired":          expiredTok,
		"extra separators": good + ".x",
	}
	for name, tok := range cases {
		if addr, ok := sessionAddress(reqWithToken(tok)); ok {
			t.Errorf("%s: token was accepted (address %q)", name, addr)
		}
	}
}

func TestRequireSessionReturns401(t *testing.T) {
	w := httptest.NewRecorder()
	if _, ok := requireSession(w, reqWithToken("")); ok {
		t.Fatal("request without a token must not pass")
	}
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}
