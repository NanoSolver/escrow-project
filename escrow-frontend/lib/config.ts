import { sepolia, foundry } from "viem/chains";

// "anvil" (default, local) or "sepolia". Set NEXT_PUBLIC_CHAIN in .env.local.
export const CHAIN = process.env.NEXT_PUBLIC_CHAIN === "sepolia" ? sepolia : foundry;

export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080";

// Block explorer link for transactions (no explorer for local Anvil).
export const EXPLORER_TX: string | null =
  CHAIN.id === sepolia.id ? "https://sepolia.etherscan.io/tx/" : null;
