package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

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
	writeJSON(w, http.StatusOK, map[string]string{"address": strings.ToLower(req.Address), "role": req.Role})
}
