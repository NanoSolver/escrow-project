package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// ── session tokens ──
// Signing in proves wallet ownership once. The backend then hands out a short-lived HMAC token
// ("address|role|expiry", signed with SESSION_SECRET) that protects private data such as the
// submitted work. Without SESSION_SECRET a random secret is generated at startup, so everyone
// simply signs in again after a backend restart.

const sessionTTL = 12 * time.Hour

var sessionSecret = loadSessionSecret()

func loadSessionSecret() []byte {
	if s := strings.TrimSpace(os.Getenv("SESSION_SECRET")); s != "" {
		return []byte(s)
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func sessionMAC(payload string) []byte {
	m := hmac.New(sha256.New, sessionSecret)
	m.Write([]byte(payload))
	return m.Sum(nil)
}

func issueSession(address, role string) string {
	payload := fmt.Sprintf("%s|%s|%d", strings.ToLower(address), role, time.Now().Add(sessionTTL).Unix())
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(sessionMAC(payload))
}

// sessionAddress returns the lowercase wallet address from a valid "Authorization: Bearer" token.
func sessionAddress(r *http.Request) (string, bool) {
	token, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found {
		return "", false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, sessionMAC(string(payload))) {
		return "", false
	}
	fields := strings.Split(string(payload), "|")
	if len(fields) != 3 {
		return "", false
	}
	exp, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	return fields[0], true
}

func requireSession(w http.ResponseWriter, r *http.Request) (string, bool) {
	who, ok := sessionAddress(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "your sign-in is missing or has expired: sign out and sign in again")
		return "", false
	}
	return who, true
}

var authChallenges = struct {
	sync.Mutex
	items map[string]time.Time
}{items: make(map[string]time.Time)}

type authRequest struct {
	Address   string `json:"address"`
	Role      string `json:"role"`
	Message   string `json:"message"`
	Signature string `json:"signature"`
}

func (a *App) authChallenge(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if !common.IsHexAddress(req.Address) || (req.Role != "client" && req.Role != "freelancer") {
		writeErr(w, http.StatusBadRequest, "provide a wallet address and client or freelancer role")
		return
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create sign-in challenge")
		return
	}
	message := fmt.Sprintf("AI Escrow sign-in\nWallet: %s\nRole: %s\nNonce: %s\nExpires: %s", strings.ToLower(req.Address), req.Role, hex.EncodeToString(nonce[:]), time.Now().Add(5*time.Minute).UTC().Format(time.RFC3339))
	authChallenges.Lock()
	for m, expiry := range authChallenges.items {
		if time.Now().After(expiry) {
			delete(authChallenges.items, m)
		}
	}
	authChallenges.items[message] = time.Now().Add(5 * time.Minute)
	authChallenges.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"message": message})
}

func (a *App) authVerify(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if !common.IsHexAddress(req.Address) || (req.Role != "client" && req.Role != "freelancer") || req.Signature == "" {
		writeErr(w, http.StatusBadRequest, "invalid sign-in request")
		return
	}
	authChallenges.Lock()
	expires, ok := authChallenges.items[req.Message]
	delete(authChallenges.items, req.Message)
	authChallenges.Unlock()
	if !ok || time.Now().After(expires) || !strings.Contains(req.Message, "Wallet: "+strings.ToLower(req.Address)+"\nRole: "+req.Role+"\n") {
		writeErr(w, http.StatusUnauthorized, "sign-in challenge expired or does not match this wallet and role")
		return
	}
	sig, err := hex.DecodeString(strings.TrimPrefix(req.Signature, "0x"))
	if err != nil || len(sig) != crypto.SignatureLength {
		writeErr(w, http.StatusUnauthorized, "invalid wallet signature")
		return
	}
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	pub, err := crypto.SigToPub(accounts.TextHash([]byte(req.Message)), sig)
	if err != nil || !strings.EqualFold(crypto.PubkeyToAddress(*pub).Hex(), req.Address) {
		writeErr(w, http.StatusUnauthorized, "wallet signature does not match the selected address")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"address": strings.ToLower(req.Address),
		"role":    req.Role,
		"token":   issueSession(req.Address, req.Role),
	})
}
