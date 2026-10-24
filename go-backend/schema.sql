-- Minimal schema. Applied automatically on first `docker compose up`.
-- All wallet/contract addresses are stored lowercase.
-- (An existing database is upgraded automatically by the Go backend at startup.)

CREATE TABLE users (
    wallet_address TEXT PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    role           TEXT NOT NULL CHECK (role IN ('client', 'freelancer')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escrows (
    id                 BIGSERIAL PRIMARY KEY,
    contract_address   TEXT NOT NULL UNIQUE CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    client_address     TEXT NOT NULL REFERENCES users (wallet_address),
    freelancer_address TEXT REFERENCES users (wallet_address),  -- NULL = open job nobody has accepted yet
    initial_prompt     TEXT NOT NULL,          -- the requirement the AI judges against
    submission_text    TEXT,                   -- latest submission, shown to the client and freelancer only
    submitted_at       TIMESTAMPTZ,
    submission_link    TEXT,                   -- link (or 'inline-text') of the latest submission
    status             TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'funded', 'evaluating', 'released', 'refunded')),
    ai_decision        BOOLEAN,
    ai_reasoning       TEXT,
    tx_hash            TEXT,                   -- latest settlement / revision transaction
    last_error         TEXT,                   -- last AI/chain failure, for debugging
    deadline_at        TIMESTAMPTZ,            -- submission deadline (mirrors the contract)
    revision_limit     INTEGER NOT NULL DEFAULT 0,
    revisions_used     INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX escrows_client_idx ON escrows (client_address);
CREATE INDEX escrows_freelancer_idx ON escrows (freelancer_address);
