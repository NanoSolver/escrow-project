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
  created_at: string;
};

export type SubmitResult = {
  decision: boolean | null;
  reasoning: string;
  status: string;
  tx_hash: string;
  revisions_used: number;
  revision_limit: number;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
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
    req<{ message: string }>("/auth/challenge", { method: "POST", body: JSON.stringify({ address, role }) }),

  authVerify: (address: string, role: "client" | "freelancer", message: string, signature: string) =>
    req<{ address: string; role: "client" | "freelancer" }>("/auth/verify", {
      method: "POST", body: JSON.stringify({ address, role, message, signature }),
    }),

  register: (contract_address: string, initial_prompt: string) =>
    req<EscrowRecord>("/escrows", {
      method: "POST",
      body: JSON.stringify({ contract_address, initial_prompt }),
    }),

  get: (address: string) =>
    req<{
      escrow: EscrowRecord;
      chain_status?: string;
      chain_freelancer?: string;
      chain_deadline?: number;
      chain_revision_limit?: number;
      chain_revisions_used?: number;
    }>(
      `/escrows/${address}`,
    ),

  submit: (
    address: string,
    body: { freelancer: string; submission_link?: string; submission_text?: string },
  ) =>
    req<SubmitResult>(`/escrows/${address}/submit`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

};
