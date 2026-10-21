package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// Only these hosts may be fetched. This blocks SSRF (a "submission link" pointing at
// localhost, cloud metadata endpoints, internal services...). Content is only ever
// downloaded as text and handed to the AI; it is never executed.
var allowedHosts = map[string]bool{
	"raw.githubusercontent.com":  true,
	"gist.githubusercontent.com": true,
}

const maxSubmissionBytes = 20000 // matches the FastAPI limit

func hostAllowed(u *url.URL) bool {
	return u.Scheme == "https" && u.Port() == "" && allowedHosts[strings.ToLower(u.Hostname())]
}

func fetchSubmission(ctx context.Context, link string) (string, error) {
	u, err := url.Parse(link)
	if err != nil || !hostAllowed(u) {
		return "", errors.New("submission_link must be an https link to raw.githubusercontent.com or gist.githubusercontent.com")
	}

	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 || !hostAllowed(req.URL) {
				return errors.New("redirect to a disallowed host")
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetching submission: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetching submission: status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSubmissionBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxSubmissionBytes {
		return "", fmt.Errorf("submission is larger than %d bytes", maxSubmissionBytes)
	}
	if !utf8.Valid(data) {
		return "", errors.New("submission is not valid UTF-8 text")
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "", errors.New("submission is empty")
	}
	return text, nil
}
