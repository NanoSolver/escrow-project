# TrustForge

TrustForge is a wallet-based freelance escrow app. A client creates and funds an escrow on an EVM chain, a freelancer accepts the job and submits work, and an AI review panel evaluates the submission. The smart contract holds the funds until they are released or refunded under its rules.

This guide runs TrustForge locally with **Anvil**, a local Ethereum development chain. Local Anvil ETH has no real-world value.

## What it does

- Clients can assign a job to a freelancer or publish it as an open job.
- The first freelancer to accept an open job becomes its freelancer.
- Deadlines and revision limits are enforced by the Solidity escrow contract.
- The Go API stores escrow metadata in PostgreSQL and coordinates AI reviews and on-chain settlement.
- OpenRouter provides the primary AI verdict. Groq, SambaNova, and NVIDIA NIM independently review whether they agree with that verdict.
- At least 2 of the 3 independent reviewers must agree. If they do not, OpenRouter reconsiders once and the reviewers vote again. The system fails closed if it cannot get at least two reviewer responses or the reconsidered verdict does not receive the required agreement.
- Clients can inspect a submission and approve payment themselves before the deadline.
- If an escrow remains unsettled past the deadline and grace period, anyone can trigger the contract's refund to the client.

The AI reads submitted work as text; it does not execute submitted code. Model output is fallible, so clients should inspect submissions before approving payment.

## How the application fits together

| Part | Technology | Local address | Purpose |
| --- | --- | --- | --- |
| Web app | Next.js, React, viem | http://localhost:3000 | Wallet sign-in and client/freelancer screens |
| Blockchain | Anvil | http://127.0.0.1:8545 | Local EVM chain, chain ID 31337 |
| API | Go, net/http | http://localhost:8080 | Auth, escrow records, AI orchestration, settlement |
| Database | PostgreSQL in Docker | localhost:5432 | Wallet roles and escrow metadata |
| AI judge | FastAPI, Python | http://localhost:8000 | OpenRouter verdict and independent reviewer panel |

The browser sends wallet transactions directly through MetaMask. The API independently reads the same chain through its RPC connection.

## Requirements

Install these tools before setup:

- Git
- Node.js 20.9 or newer and npm (the frontend is pinned to Next.js 16). [Next.js installation requirements](https://nextjs.org/docs/pages/getting-started/installation)
- Go 1.25 or newer
- Python 3.10 or newer
- Foundry, including Anvil, Forge, and Cast. [Foundry installation guide](https://getfoundry.sh/introduction/installation/)
- Docker Desktop or Docker Engine with Docker Compose. [Docker installation guide](https://docs.docker.com/get-started/get-docker/)
- MetaMask browser extension

## Clone the project

Clone the repository on the machine where you want to run it:

```bash
git clone --recurse-submodules https://github.com/NanoSolver/escrow-project.git
cd escrow-project
```

If you have access to another fork, use that repository URL instead.

## Configure local environment files

Copy the checked-in templates:

### Windows PowerShell

```powershell
Copy-Item .\go-backend\backend.env.example .\go-backend\.env
Copy-Item .\ai-service\ai.env.example .\ai-service\.env
Copy-Item .\escrow-frontend\env.local .\escrow-frontend\.env.local
```

### macOS or Linux

```bash
cp go-backend/backend.env.example go-backend/.env
cp ai-service/ai.env.example ai-service/.env
cp escrow-frontend/env.local escrow-frontend/.env.local
```

Edit the files on the new machine:

1. In **go-backend/.env**, keep the local database and RPC settings:

   - Database: **postgres://escrow:escrow@localhost:5432/escrow?sslmode=disable**
   - RPC: **http://127.0.0.1:8545**
   - AI URL: **http://localhost:8000/evaluate**
   - API port: **8080**
   - Frontend origin: **http://localhost:3000**

   Set **ORACLE_PRIVATE_KEY** to the private key of Anvil account 0. This key must derive the oracle address passed to the escrow contract. Use only a disposable Anvil key here.

2. In **ai-service/.env**, set the API keys for OpenRouter, Groq, SambaNova, and NVIDIA NIM. The example file lists the supported variable names and model defaults. Keep real keys in these ignored local environment files; never commit or share them.

3. In **escrow-frontend/.env.local**, set:

```dotenv
NEXT_PUBLIC_CHAIN=anvil
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8080
```

The IPv4 URL avoids accidentally reaching a different service if **localhost** resolves to an old IPv6 listener.

API-provider account limits and charges depend on the provider. The frontend and blockchain can run without AI keys, but work evaluation requires working provider keys and reviewer responses.

## Start the local stack

Keep each process running in its own terminal. Start them in this order.

### 1. Start Anvil

```bash
anvil
```

Leave this terminal open. Anvil prints test accounts and private keys. Use account 0 as the backend oracle, account 1 as the client, and account 2 as the freelancer. The private keys printed by Anvil are public test keys; never reuse them on a real network.

Anvil uses chain ID **31337**. Avoid starting a second Anvil on port **8545**. If you see “address already in use,” an Anvil process is already listening; use that chain or stop it deliberately. Stopping Anvil resets its local chain, so contracts and balances from that run will no longer exist.

### 2. Start PostgreSQL

From the repository root:

```bash
docker compose -f go-backend/docker-compose.yml up -d db
```

Confirm Docker is running first. The Compose file publishes PostgreSQL on port **5432** and creates the schema on the first start.

If port 5432 is already in use, change the host-side port in **go-backend/docker-compose.yml** (for example, **5433:5432**) and update the port in **DATABASE_URL** in **go-backend/.env** to match.

### 3. Start the AI service

In a new terminal:

#### Windows PowerShell

```powershell
cd ai-service
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

#### macOS or Linux

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The AI service health endpoint is http://localhost:8000/health.

### 4. Start the Go API

Open another terminal:

```bash
cd go-backend
go mod download
go run .
```

Run the command from **go-backend** so the service loads **go-backend/.env**. Check http://localhost:8080/health; it should return **ok: true** and the oracle address.

### 5. Start the frontend

Open another terminal:

```bash
cd escrow-frontend
npm ci
npm run dev
```

Open http://localhost:3000.

## Configure MetaMask for Anvil

In MetaMask, add or select a local network with:

| Setting | Value |
| --- | --- |
| Network name | Anvil Local |
| RPC URL | http://127.0.0.1:8545 |
| Chain ID | 31337 |
| Currency symbol | ETH |

Import Anvil account 1 for the client and account 2 for the freelancer using the private keys printed in the Anvil terminal. Keep account 0 reserved for the backend oracle. These accounts and keys are for local testing only.

Sign-in uses a wallet signature and does not submit a transaction. Creating, funding, accepting, approving, or settling an escrow does submit a local Anvil transaction, but it does not spend real ETH.

## Typical demo flow

1. Sign in as the client with Anvil account 1.
2. Create an escrow, choose a freelancer or make it open, set the amount/deadline/revision limit, and fund it.
3. Sign out and sign in as the freelancer with Anvil account 2.
4. Accept the open job (if applicable) and submit code or a link.
5. The API sends the requirement and submission to the AI service. The primary model and independent reviewers evaluate it.
6. Return to the client view to inspect the result and approve payment if appropriate.

No separate manual contract deployment is needed for this flow: the client page deploys the escrow contract through MetaMask and then deposits the funds.

## Contract artifact

The frontend uses the checked-in artifact at **escrow-frontend/lib/Escrow.json**. If you change **src/Escrow.sol**, rebuild and copy the new artifact before running the frontend:

### Windows PowerShell

```powershell
forge build
Copy-Item .\out\Escrow.sol\Escrow.json .\escrow-frontend\lib\Escrow.json
```

### macOS or Linux

```bash
forge build
cp out/Escrow.sol/Escrow.json escrow-frontend/lib/Escrow.json
```

## Useful checks

From the repository root:

```bash
cast chain-id --rpc-url http://127.0.0.1:8545
docker compose -f go-backend/docker-compose.yml ps
```

The first command should print **31337**. The service health endpoints are:

- Frontend: http://localhost:3000
- Go API: http://localhost:8080/health
- AI service: http://localhost:8000/health

Optional project checks:

```bash
forge test
```

```bash
cd go-backend
go test ./...
```

The AI reliability runner makes live model calls and may consume API quota:

```bash
cd ai-service
python run_tests.py
```

## Data and safety notes

- Anvil is local to one machine. Another developer's Anvil chain, MetaMask network, and PostgreSQL database are separate; local escrow records are not shared between computers.
- Restarting Anvil creates a fresh local chain. Old contract addresses will not have code on the new chain. Keep the same Anvil process running while using an escrow.
- PostgreSQL data persists in Docker's named volume. Stopping the database does not delete it. Removing the volume with **docker compose down -v** permanently deletes that local database data.
- Do not commit **.env** or **.env.local** files, provider keys, or real private keys. Use Anvil keys only for local development.
- The current setup is intended for local development and demos. The Go API listens on all interfaces by default, and Docker publishes the database port on the host. It uses development database credentials; do not expose it as-is to the public internet.

## Troubleshooting

### MetaMask says the transaction failed

Check that MetaMask is on **Anvil Local (31337)** and that Anvil is still running at **127.0.0.1:8545**. Check the transaction details in MetaMask's activity view. If Anvil was restarted, contracts deployed in the previous run no longer exist.

### “No contract deployed at that address on this network”

The frontend, MetaMask, and backend must all use the same chain. For this guide, use Anvil chain ID **31337** and RPC **127.0.0.1:8545**. A Sepolia address or an address from an earlier Anvil run will not identify the current local contract.

### Frontend cannot reach the API

Confirm the Go API is running on port **8080** and set **NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8080** in **escrow-frontend/.env.local**. Restart the frontend after changing environment variables.

### AI review fails or does not finish

Confirm the AI service is running on port **8000**, the OpenRouter key is valid, and at least two of the three reviewer providers are configured and responding. Rate limits, unavailable models, or invalid keys can prevent a quorum; the system should not settle funds without a valid verdict.

### PostgreSQL will not start

Check whether port **5432** is occupied. If it is, use another host port and make the matching port change in **DATABASE_URL**.

## Development notes

- Solidity contract: **src/Escrow.sol**
- Deployment script: **script/DeployEscrow.s.sol**
- Foundry tests: **test/**
- Go API and database schema: **go-backend/**
- AI review service: **ai-service/**
- Next.js client: **escrow-frontend/**

