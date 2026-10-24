import { BACKEND_URL } from "./config";

export type EscrowRecord = {
  contract_address: string;
  client_address: string;
  freelancer_address: string;
  initial_prompt: string;
  submission_link: string;
  status: string;
  ai_decision: boolean | null;
  ai_reasoning: string;
  tx_hash: string;
  last_error: string;
  deadline_at: string;
  revision_limit: number;
  revisions_used: number;
  created_at: string;
};

export type SubmitResult = {
  decision: boolean;
  reasoning: string;
  status: string; // "released" | "refunded" | "funded" (funded = revision requested)
  tx_hash: string;
  revisions_used: number;
  revision_limit: number;
};

// A funded job that nobody has accepted yet (listed on the Open jobs board).
export type OpenJob = {
  contract_address: string;
  client_address: string;
  requirement: string;
  amount_wei: string; // string: wei does not fit in a JS number
  deadline: number; // unix seconds
  revision_limit: number;
  created_at: string;
};

export type EscrowDetails = {
  escrow: EscrowRecord;
  chain_status?: string;
  chain_freelancer?: string; // "" = open job, nobody has accepted it yet
  chain_amount_wei?: string;
  chain_deadline?: number; // unix seconds
  chain_revision_limit?: number;
  chain_revisions_used?: number;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    throw new Error(`Cannot reach the backend at ${BACKEND_URL}. Is the Go server running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  health: () => req<{ ok: boolean; oracle: string }>("/health"),

  authChallenge: (address: string, role: "client" | "freelancer") =>
    req<{ message: string }>("/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address, role }),
    }),

  authVerify: (address: string, role: "client" | "freelancer", message: string, signature: string) =>
    req<{ address: string; role: "client" | "freelancer" }>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ address, role, message, signature }),
    }),

  register: (contract_address: string, initial_prompt: string) =>
    req<EscrowRecord>("/escrows", {
      method: "POST",
      body: JSON.stringify({ contract_address, initial_prompt }),
    }),

  get: (address: string) => req<EscrowDetails>(`/escrows/${address}`),

  openJobs: () => req<{ jobs: OpenJob[] }>("/escrows"),

  submit: (
    address: string,
    body: { freelancer: string; submission_link?: string; submission_text?: string },
  ) =>
    req<SubmitResult>(`/escrows/${address}/submit`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
