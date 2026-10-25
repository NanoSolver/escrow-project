# Free Sepolia deployment

## Hosting layout

- Vercel Hobby hosts the Next.js frontend (subject to Vercel's personal/non-commercial eligibility terms).
- Render Free runs the Go API and the private FastAPI AI judge together in one Docker web service. It sleeps after 15 minutes without inbound traffic, and the first request after sleep may wait about a minute. The free instance has 512 MB RAM and 750 instance hours per workspace per month.
- Neon Free provides Postgres with 1 GB storage and 100 compute-unit hours per month. Render's free Postgres expires after 30 days, so Neon is used for persistent demo data.
- The app and API must use Sepolia, chain ID `11155111`. Sepolia ETH comes from faucets and has no real-world value.

## 1. Create the Neon database

Create a Neon project on the Free plan and copy its pooled connection string. It contains the database password; keep it private. Use `sslmode=require`. The Go service creates the schema and applies upgrades on startup.

## 2. Deploy the API to Render

Create a Render Blueprint from this repository and select `render.yaml`. Render builds the root `Dockerfile` and uses `/health` for health checks. Set these secret variables in the Render dashboard before the service starts:

```text
DATABASE_URL=<Neon pooled Postgres URL, including sslmode=require>
ORACLE_PRIVATE_KEY=<dedicated Sepolia oracle wallet private key>
FRONTEND_ORIGIN=<exact Vercel production origin>
OPENROUTER_API_KEY=<OpenRouter key>
GROQ_API_KEY=<Groq key>
SAMBANOVA_API_KEY=<SambaNova key>
NVIDIA_NIM_API_KEY=<NVIDIA NIM key>
```

The Docker image starts FastAPI on loopback and the Go API on Render's assigned port. Do not expose or change `AI_URL`. Never commit real secrets or place them in frontend variables.

## 3. Deploy the frontend to Vercel

Import the repository and set **Root Directory** to `escrow-frontend`. Set these environment variables:

```text
NEXT_PUBLIC_CHAIN=sepolia
NEXT_PUBLIC_BACKEND_URL=https://<your-render-service>.onrender.com
```

After the first Vercel deployment, copy its exact production origin into Render's `FRONTEND_ORIGIN`, then redeploy the Render service.

## 4. Verify Sepolia end to end

1. Visit `https://<your-render-service>.onrender.com/health`. It must return `ok: true` and `chain_id: "11155111"`.
2. Open the Vercel site, connect MetaMask on Sepolia, and use separate client and freelancer wallets.
3. Get faucet Sepolia ETH for the client, freelancer, and oracle wallet. The client funds the escrow, and the freelancer pays gas to accept and submit.
4. Create an escrow as the client, accept and submit as the freelancer, then verify settlement on Sepolia Etherscan.

Local `escrow-frontend/.env.local` and `go-backend/.env` are ignored and must stay out of Git.
