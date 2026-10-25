# Escrow Project

An escrow system where an AI makes the call on who gets paid, and a small panel of other AIs checks its work before anything moves.

Escrow is really just a trust problem: two people don't trust each other, so a third party holds the money until the deal is done. This project swaps that third party for smart contracts plus an AI decision layer. One model makes the decision. Three independent "judge" models review it. If the judges don't agree, the first model has to go back and think again.

## How it works

1. **A deal is created on-chain.** Funds get locked in the escrow contract.
2. **A decision is needed.** Did the seller deliver? Should the buyer get a refund? The AI service looks at the situation and makes a call using a model on OpenRouter.
3. **The judges weigh in.** That decision goes to three separate reviewers: Groq, SambaNova, and Nvidia NIM. Each one votes to approve or reject.
4. **Two out of three wins.** If at least 2 judges approve, the decision goes through. If not, the OpenRouter model reconsiders and the cycle repeats.
5. **The contract settles.** Once a decision passes, the backend sends it on-chain and the funds are released.

The idea behind using three different providers is simple: no single model gets the final word, and they're less likely to all make the same mistake at the same time.

## What's in the repo

```
.
├── src/          Solidity contracts (the escrow itself)
├── test/         Foundry tests for the contracts
├── script/       Deployment scripts (DeployEscrow.s.sol)
├── go-backend/   Go service that connects the chain and the AI
├── ai-service/   The decision model + the 3-judge consensus layer
├── lib/          Dependencies (git submodules)
└── env.example   Template for your API keys and config
```

The `out/`, `cache/`, and `broadcast/` folders are build and deployment output from Foundry.

## Getting started

### What you'll need

- [Foundry](https://book.getfoundry.sh/getting-started/installation) for the contracts
- [Go](https://go.dev/dl/) for the backend
- API keys for:
  - [OpenRouter](https://openrouter.ai/) (the decision-maker)
  - [Groq](https://groq.com/), [SambaNova](https://sambanova.ai/), and [Nvidia NIM](https://build.nvidia.com/) (the judges, all of which have free tiers)

### Setup

```bash
# Clone with submodules so the contract libraries come along
git clone --recurse-submodules https://github.com/d-luigi/escrow-project.git
cd escrow-project

# Set up your environment
cp env.example .env
# Open .env and fill in your keys
```

### Build and test the contracts

```bash
forge build
forge test
```

### Run it locally

Start a local chain in one terminal:

```bash
anvil
```

Deploy the contract from another:

```bash
forge script script/DeployEscrow.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

Then start the backend and the AI service. The exact commands depend on how each one is set up, so check the folders for specifics:

```bash
cd go-backend && go run .
```

## Configuration

Everything lives in `.env`. Copy `env.example` and fill in:

| Variable | What it's for |
| --- | --- |
| OpenRouter key | The model that makes the decisions |
| Groq key | Judge #1 |
| SambaNova key | Judge #2 |
| Nvidia NIM key | Judge #3 |

Check `env.example` for the exact variable names. And please don't commit your real `.env`. It's already in `.gitignore`, but it's worth double-checking.

## Why a judge panel?

A single model deciding where money goes is a lot of trust to place in one place. Models can be wrong, confidently so, and sometimes they can be nudged by clever inputs. Having three separate providers review each decision adds a safety net without much extra complexity. The 2-of-3 rule keeps things moving when one judge is having a bad day, while still blocking decisions that most reviewers don't buy.

## Status

This is a work in progress and hasn't been audited. Please don't put real money through it. Treat it as an experiment.

## Contributing

Ideas, bug reports, and pull requests are welcome. Open an issue first if you're planning something big so we can talk it through.

## License

No license has been added yet. If you plan to share or reuse this, add one (MIT is a common choice).
