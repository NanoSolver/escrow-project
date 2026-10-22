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
  created_at: string;
};

export type SubmitResult = {
  decision: boolean;
  reasoning: string;
  status: string;
  tx_hash: string;
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

  register: (contract_address: string, initial_prompt: string) =>
    req<EscrowRecord>("/escrows", {
      method: "POST",
      body: JSON.stringify({ contract_address, initial_prompt }),
    }),

  get: (address: string) =>
    req<{ escrow: EscrowRecord; chain_status?: string; chain_freelancer?: string }>(
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
