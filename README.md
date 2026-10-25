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
