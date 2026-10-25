import { sepolia, foundry } from "viem/chains";

// "anvil" (default, local) or "sepolia". Set NEXT_PUBLIC_CHAIN in .env.local.
export const CHAIN = process.env.NEXT_PUBLIC_CHAIN === "sepolia" ? sepolia : foundry;

// Docker publishes the local API on IPv4 only; avoid localhost resolving to a stale IPv6 listener.
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8080";

// Must match Escrow.SETTLEMENT_GRACE in the contract (10 minutes): after the deadline the oracle
// keeps this long to finish an in-flight verdict before anyone may refund the client.
export const SETTLEMENT_GRACE_SECONDS = 600;

// Block explorer link for transactions (no explorer for local Anvil).
export const EXPLORER_TX: string | null =
  CHAIN.id === sepolia.id ? "https://sepolia.etherscan.io/tx/" : null;
