# TrustForge local development

The checked-in examples target local development. GitHub stores source code and setup examples; it does not run your computer's `localhost` services. Never commit `.env`, `.env.local`, API keys, or wallet private keys.

## Local endpoints

- Frontend: `http://localhost:3000`
- Go API: `http://localhost:8080`
- AI judge: private inside the API container on `127.0.0.1:8001`
- PostgreSQL: `localhost:5435` (mapped to PostgreSQL port 5432 inside Docker)
- Anvil: `http://127.0.0.1:8545`, chain ID `31337`

The frontend, API, database, and Anvil chain run on this computer. AI reviews still call OpenRouter, Groq, SambaNova, and NVIDIA NIM over the internet using the keys in `ai-service/.env`; those requests are subject to each provider's quota and billing terms.

## One-time setup

1. Copy the examples to local secret files:

   ```powershell
   Copy-Item escrow-frontend/.env.example escrow-frontend/.env.local
   Copy-Item go-backend/backend.env.example go-backend/.env
   Copy-Item ai-service/ai.env.example ai-service/.env
   ```

   Add your AI provider keys to `ai-service/.env`. Set `ORACLE_PRIVATE_KEY` in `go-backend/.env` to a local Anvil test key only. Never use an Anvil key on a public network.

2. Make sure Docker Desktop is running. Start Anvil in a separate terminal:

   ```powershell
   & "$env:USERPROFILE\.foundry\bin\anvil.exe" --silent
   ```

   Use a local test key for the oracle. If you use a non-default key, fund its address on the local Anvil node before testing oracle transactions.

## Start the app

From the repository root, start Postgres and the Go API with its private AI service:

```powershell
docker compose up -d --build
```

Then start the frontend in another terminal:

```powershell
Set-Location escrow-frontend
npm run dev
```

Open `http://localhost:3000`. In MetaMask, use the Foundry network at `http://127.0.0.1:8545` with chain ID `31337`. Use Anvil test accounts only; their keys are public test keys with no real funds.

The Go API initializes the local Postgres schema at startup. Verify it at `http://localhost:8080/health`; the response should show chain ID `31337`.

To stop the frontend, press Ctrl+C in its terminal. To stop the API and database containers but retain database data, run `docker compose down`. Avoid `docker compose down -v` if you want to keep the database volume.
