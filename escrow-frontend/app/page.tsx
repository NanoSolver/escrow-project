"use client";

import { useEffect, useState } from "react";
import { formatEther, isAddress, parseEther, zeroAddress, type Address, type EIP1193Provider } from "viem";
import { api, type OpenJob, type SubmitResult } from "../lib/api";
import { CHAIN, EXPLORER_TX, SETTLEMENT_GRACE_SECONDS } from "../lib/config";
import { escrowAbi, escrowBytecode } from "../lib/escrow";
import { connect } from "../lib/wallet";

type Tab = "client" | "freelancer" | "track";
type StepState = "todo" | "active" | "done" | "error";
type Step = { label: string; state: StepState };

function errMsg(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string };
  return x?.shortMessage ?? x?.message ?? String(e);
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The AI + blockchain step takes 5-15 s, so show progress text instead of a frozen button.
const AI_STAGES = [
  "Fetching your submission…",
  "Processing AI evaluation…",
  "The AI is reviewing the work against the requirement…",
  "Waiting for blockchain confirmation…",
];

function useStage(active: boolean) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) {
      setI(0);
      return;
    }
    const t = setInterval(() => setI((x) => Math.min(x + 1, AI_STAGES.length - 1)), 3500);
    return () => clearInterval(t);
  }, [active]);
  return AI_STAGES[i];
}

function TxLink({ hash }: { hash: string }) {
  if (!hash) return null;
  return EXPLORER_TX ? (
    <a href={EXPLORER_TX + hash} target="_blank" rel="noreferrer">
      {shortAddr(hash)} ↗
    </a>
  ) : (
    <code>{hash}</code>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  const icon = { todo: "○", active: "◔", done: "●", error: "✕" } as const;
  return (
    <ul className="steps">
      {steps.map((s) => (
        <li key={s.label} className={`step ${s.state}`}>
          <span className="icon">{icon[s.state]}</span> {s.label}
          {s.state === "active" && <span className="spinner small" />}
        </li>
      ))}
    </ul>
  );
}

/** Turns the contract's custom errors into sentences a freelancer can act on. */
function acceptErrMsg(e: unknown): string {
  const m = errMsg(e);
  if (m.includes("AlreadyAssigned")) return "Someone else accepted this job first.";
  if (m.includes("DuplicateRoles"))
    return "The client (or the oracle) cannot accept their own job. Switch MetaMask to a freelancer account.";
  if (m.includes("DeadlinePassed")) return "This job's deadline has passed, so it can no longer be accepted.";
  if (m.includes("InvalidStatus"))
    return "This job is not open for acceptance (it must be funded and not yet settled).";
  return m;
}

/** The freelancer's own wallet claims an open job on-chain, then the backend learns who got it. */
async function acceptOnChain(addr: Address): Promise<Address> {
  const w = await connect();
  const hash = await w.walletClient.writeContract({
    address: addr,
    abi: escrowAbi,
    functionName: "acceptJob",
    account: w.account,
    chain: CHAIN,
  });
  await w.publicClient.waitForTransactionReceipt({ hash });
  await api.get(addr); // the backend reads the chain and records the new freelancer
  return w.account;
}

/* ───────────────────────────── Client ───────────────────────────── */

const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 } as const;
type Unit = keyof typeof UNIT_SECONDS;

function ClientView({ onAccount }: { onAccount: (a: string) => void }) {
  const [assignment, setAssignment] = useState<"assigned" | "open">("assigned");
  const [freelancer, setFreelancer] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [deadlineValue, setDeadlineValue] = useState("7");
  const [deadlineUnit, setDeadlineUnit] = useState<Unit>("days");
  const [revisionLimit, setRevisionLimit] = useState("2");
  const [prompt, setPrompt] = useState(
    "Write a Python script that reverses a string. It must define reverse_string(s) that returns the reversed string and works for any input, including the empty string.",
  );
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [parties, setParties] = useState<{ client: string; freelancer: string } | null>(null);

  const setStep = (i: number, state: StepState) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, state } : x)));

  async function create() {
    setError(null);
    setCreated(null);
    const isOpen = assignment === "open";
    if (!isOpen && !isAddress(freelancer)) return setError("Enter a valid freelancer wallet address.");
    const eth = Number(amount);
    if (!(eth > 0)) return setError("Amount must be greater than 0.");
    const deadlineSeconds = Number(deadlineValue) * UNIT_SECONDS[deadlineUnit];
    if (!(deadlineSeconds >= 300 && deadlineSeconds <= 365 * 86400)) {
      return setError("Deadline must be between 5 minutes and 365 days.");
    }
    const revisions = Number(revisionLimit);
    if (!Number.isInteger(revisions) || revisions < 0 || revisions > 10) {
      return setError("Revisions must be a whole number from 0 to 10.");
    }
    if (!prompt.trim()) return setError("Describe what the freelancer must deliver.");

    setSteps(
      ["Connect MetaMask", "Deploy escrow contract", "Deposit funds", "Register with backend"].map((label) => ({
        label,
        state: "todo" as StepState,
      })),
    );
    setBusy(true);
    let current = 0;
    try {
      setStep(0, "active");
      const w = await connect();
      onAccount(w.account);
      if (!isOpen && w.account.toLowerCase() === freelancer.toLowerCase()) {
        throw new Error(
          "MetaMask is currently on the same address you entered as freelancer. Switch MetaMask to the CLIENT account (and connect it to this site) first.",
        );
      }
      setParties({ client: w.account, freelancer: isOpen ? zeroAddress : freelancer });
      const { oracle } = await api.health(); // oracle = the Go backend's signing address
      setStep(0, "done");

      current = 1;
      setStep(1, "active");
      const value = parseEther(amount);
      // Base the deadline on the chain's clock, so a skewed PC clock can't break it.
      const latestBlock = await w.publicClient.getBlock();
      const deadline = latestBlock.timestamp + BigInt(Math.round(deadlineSeconds));
      const deployHash = await w.walletClient.deployContract({
        abi: escrowAbi,
        bytecode: escrowBytecode,
        // address(0) as the freelancer makes this an open job: the first wallet to accept it wins.
        args: [
          w.account,
          isOpen ? zeroAddress : (freelancer as Address),
          oracle as Address,
          value,
          deadline,
          revisions,
        ],
        account: w.account,
        chain: CHAIN,
      });
      const receipt = await w.publicClient.waitForTransactionReceipt({ hash: deployHash });
      const addr = receipt.contractAddress;
      if (!addr) throw new Error("Deployment receipt has no contract address.");
      // Read the parties back from the deployed contract so you can see what really got locked in.
      const [chainClient, chainFreelancer] = await Promise.all([
        w.publicClient.readContract({ address: addr, abi: escrowAbi, functionName: "client" }),
        w.publicClient.readContract({ address: addr, abi: escrowAbi, functionName: "freelancer" }),
      ]);
      setParties({ client: String(chainClient), freelancer: String(chainFreelancer) });
      setStep(1, "done");

      current = 2;
      setStep(2, "active");
      const depositHash = await w.walletClient.writeContract({
        address: addr,
        abi: escrowAbi,
        functionName: "deposit",
        value,
        account: w.account,
        chain: CHAIN,
      });
      await w.publicClient.waitForTransactionReceipt({ hash: depositHash });
      setStep(2, "done");

      current = 3;
      setStep(3, "active");
      await api.register(addr, prompt.trim());
      setStep(3, "done");

      setCreated(addr);
    } catch (e) {
      setStep(current, "error");
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Create escrow</h2>
      <p className="muted">Lock funds in a smart contract. They are released only if the AI judge approves the work.</p>

      <label>Who can take this job?</label>
      <div className="toggle">
        <button
          className={assignment === "assigned" ? "on" : ""}
          onClick={() => setAssignment("assigned")}
          disabled={busy}
        >
          A freelancer I choose
        </button>
        <button className={assignment === "open" ? "on" : ""} onClick={() => setAssignment("open")} disabled={busy}>
          Open to anyone
        </button>
      </div>

      {assignment === "assigned" ? (
        <>
          <label>Freelancer wallet address</label>
          <input value={freelancer} onChange={(e) => setFreelancer(e.target.value.trim())} placeholder="0x…" />
        </>
      ) : (
        <p className="muted small">
          Your job is listed on the Open jobs board once it is funded. The first freelancer to accept it is the only one
          who can submit work and be paid, at the price below. Nobody can accept after the deadline.
        </p>
      )}

      <label>
        {assignment === "open" ? "Price" : "Amount"} ({CHAIN.nativeCurrency.symbol})
      </label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />

      <label>Submission deadline (from now)</label>
      <div className="row">
        <input value={deadlineValue} onChange={(e) => setDeadlineValue(e.target.value)} inputMode="decimal" />
        <select value={deadlineUnit} onChange={(e) => setDeadlineUnit(e.target.value as Unit)}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>

      <label>Revisions allowed after a rejection</label>
      <input value={revisionLimit} onChange={(e) => setRevisionLimit(e.target.value)} inputMode="numeric" />
      <p className="muted small">
        If the AI rejects the work, the freelancer may resubmit this many times before the client is refunded (0 =
        refund on the first rejection). If nothing is settled by the deadline plus a 10-minute grace period, anyone can
        refund the client.
      </p>

      <label>Requirement (what the AI will judge against)</label>
      <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      <button onClick={create} disabled={busy}>
        {busy ? "Working…" : "Create & fund escrow"}
      </button>

      {steps.length > 0 && <StepList steps={steps} />}
      {parties && (
        <div className="muted small">
          <p>
            Client (MetaMask): <code>{parties.client}</code>
          </p>
          <p>
            Freelancer:{" "}
            {parties.freelancer === zeroAddress ? (
              <em>open: the first freelancer to accept</em>
            ) : (
              <code>{parties.freelancer}</code>
            )}
          </p>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {created && (
        <div className="result ok">
          <strong>Escrow funded.</strong>
          <p>
            Contract: <code>{created}</code>
          </p>
          {parties?.freelancer === zeroAddress ? (
            <p>
              The job is now on the <strong>Open jobs</strong> board (under &quot;I&apos;m the freelancer&quot;). You
              can also share this link directly:
            </p>
          ) : (
            <p>Send this link to the freelancer:</p>
          )}
          <code className="wrap">{`${window.location.origin}/?escrow=${created}`}</code>
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── Freelancer ─────────────────────────── */

/** Funded jobs nobody has accepted yet. Accepting is an on-chain transaction from the freelancer's wallet. */
function OpenJobsBoard({ onPick, onAccount }: { onPick: (addr: string) => void; onAccount: (a: string) => void }) {
  const [jobs, setJobs] = useState<OpenJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const d = await api.openJobs();
        if (!stop) {
          setJobs(d.jobs);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(errMsg(e));
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [tick]);

  async function accept(job: OpenJob) {
    setError(null);
    setNotice(null);
    setAcceptingId(job.contract_address);
    try {
      const who = await acceptOnChain(job.contract_address as Address);
      onAccount(who);
      setNotice(
        `You accepted this job. Submit your work below before ${new Date(job.deadline * 1000).toLocaleString()}.`,
      );
      onPick(job.contract_address);
    } catch (e) {
      setError(acceptErrMsg(e));
    } finally {
      setAcceptingId(null);
      setTick((n) => n + 1);
    }
  }

  return (
    <section className="card">
      <h2>Open jobs</h2>
      <p className="muted">
        These jobs are already funded: the price is locked in the contract. The first wallet to accept a job is the only
        one who can submit work and be paid when the AI approves it.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="result ok">{notice}</p>}
      {jobs === null && !error && <p className="muted small">Loading open jobs…</p>}
      {jobs?.length === 0 && <p className="muted small">No open jobs right now.</p>}
      {jobs?.map((job) => (
        <article className="job" key={job.contract_address}>
          <div className="job-head">
            <strong>
              {formatEther(BigInt(job.amount_wei))} {CHAIN.nativeCurrency.symbol}
            </strong>
            <span className="muted small">
              due {new Date(job.deadline * 1000).toLocaleString()} · {job.revision_limit} revision
              {job.revision_limit === 1 ? "" : "s"} · client {shortAddr(job.client_address)}
            </span>
          </div>
          <p className="job-req">{job.requirement}</p>
          <button onClick={() => accept(job)} disabled={acceptingId !== null}>
            {acceptingId === job.contract_address ? "Confirm in MetaMask…" : "Accept this job"}
          </button>
        </article>
      ))}
      <button className="ghost" onClick={() => setTick((n) => n + 1)} disabled={acceptingId !== null}>
        Refresh
      </button>
    </section>
  );
}

function FreelancerView({ initial, onAccount }: { initial: string; onAccount: (a: string) => void }) {
  const [escrow, setEscrow] = useState(initial);
  const [mode, setMode] = useState<"text" | "link">("text");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const stage = useStage(busy);
  const [reload, setReload] = useState(0);
  const [acceptBusy, setAcceptBusy] = useState(false);

  useEffect(() => setEscrow(initial), [initial]);

  // Show who this escrow expects, straight from the chain, so a wrong wallet is obvious.
  const [expected, setExpected] = useState<string | null>(null);
  const [dealInfo, setDealInfo] = useState<{
    deadline: number;
    used: number;
    limit: number;
    status?: string;
  } | null>(null);
  useEffect(() => {
    setExpected(null);
    setDealInfo(null);
    if (!isAddress(escrow)) return;
    let stop = false;
    api
      .get(escrow)
      .then((d) => {
        if (stop) return;
        setExpected(d.chain_freelancer ?? d.escrow.freelancer_address);
        if (d.chain_deadline !== undefined) {
          setDealInfo({
            deadline: d.chain_deadline,
            used: d.chain_revisions_used ?? 0,
            limit: d.chain_revision_limit ?? 0,
            status: d.chain_status,
          });
        }
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [escrow, reload]);

  const canAccept = expected === "" && dealInfo?.status === "funded" && Date.now() / 1000 < (dealInfo?.deadline ?? 0);

  // Used by people who arrive through a shared link to an open job instead of the board.
  async function accept() {
    setError(null);
    setAcceptBusy(true);
    try {
      const who = await acceptOnChain(escrow as Address);
      onAccount(who);
      setReload((n) => n + 1);
    } catch (e) {
      setError(acceptErrMsg(e));
    } finally {
      setAcceptBusy(false);
    }
  }

  async function submit() {
    setError(null);
    setResult(null);
    if (!isAddress(escrow)) return setError("Enter the escrow contract address.");
    if (!content.trim()) return setError(mode === "text" ? "Paste your work." : "Paste a link.");

    setBusy(true);
    try {
      const w = await connect();
      onAccount(w.account);
      // Pre-check so a wrong MetaMask account gives a clear message instead of a bare 403.
      const rec = await api.get(escrow);
      if (rec.chain_freelancer === "") {
        throw new Error(
          "This is an open job and nobody has accepted it yet. Accept the job first, then submit your work.",
        );
      }
      if (rec.chain_freelancer && rec.chain_freelancer !== rec.escrow.freelancer_address) {
        throw new Error(
          `The backend's record for this escrow is out of date (it likely belongs to an earlier Anvil session): the database says the freelancer is ${rec.escrow.freelancer_address}, the contract says ${rec.chain_freelancer}. Clear the database rows and create a new escrow.`,
        );
      }
      const expected = rec.escrow.freelancer_address;
      if (w.account.toLowerCase() !== expected) {
        throw new Error(
          `Wrong wallet: MetaMask is on ${w.account}, but this escrow's freelancer is ${expected}. Switch MetaMask to that account (and connect it to this site), then reload and try again.`,
        );
      }
      const body =
        mode === "text"
          ? { freelancer: w.account, submission_text: content }
          : { freelancer: w.account, submission_link: content.trim() };
      setResult(await api.submit(escrow, body));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OpenJobsBoard
        onAccount={onAccount}
        onPick={(addr) => {
          setEscrow(addr);
          setReload((n) => n + 1);
        }}
      />
      <section className="card">
        <h2>Submit work</h2>
        <p className="muted">
          Connect with the freelancer wallet: the one the client named, or the one that accepted the open job.
        </p>

        <label>Escrow contract address</label>
        <input value={escrow} onChange={(e) => setEscrow(e.target.value.trim())} placeholder="0x…" />
        {expected === "" && (
          <div className="muted small">
            <p>Open job: nobody has accepted it yet.</p>
            {canAccept && (
              <button onClick={accept} disabled={acceptBusy || busy}>
                {acceptBusy ? "Confirm in MetaMask…" : "Accept this job"}
              </button>
            )}
          </div>
        )}
        {expected && (
          <p className="muted small">
            This escrow&apos;s freelancer: <code>{expected}</code>
          </p>
        )}
        {dealInfo && (
          <p className="muted small">
            Deadline: {new Date(dealInfo.deadline * 1000).toLocaleString()}
            {Date.now() / 1000 >= dealInfo.deadline ? " (passed)" : ""} · revisions used: {dealInfo.used} of{" "}
            {dealInfo.limit}
          </p>
        )}

        <div className="toggle">
          <button className={mode === "text" ? "on" : ""} onClick={() => setMode("text")} disabled={busy}>
            Paste code
          </button>
          <button className={mode === "link" ? "on" : ""} onClick={() => setMode("link")} disabled={busy}>
            Link
          </button>
        </div>

        {mode === "text" ? (
          <textarea
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your submission…"
          />
        ) : (
          <>
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="https://raw.githubusercontent.com/…"
            />
            <p className="muted small">
              Only raw.githubusercontent.com and gist.githubusercontent.com links are accepted.
            </p>
          </>
        )}

        <button onClick={submit} disabled={busy}>
          {busy ? "Processing…" : "Submit for AI review"}
        </button>

        {busy && (
          <div className="processing">
            <span className="spinner" />
            <span>{stage}</span>
          </div>
        )}
        {error && <p className="error">{error}</p>}

        {result && (
          <div className={`result ${result.decision ? "ok" : result.status === "funded" ? "" : "bad"}`}>
            <strong>
              {result.decision
                ? "Approved: funds released to the freelancer"
                : result.status === "funded"
                  ? `Revision requested (${result.revisions_used} of ${result.revision_limit} used)`
                  : "Rejected: funds refunded to the client"}
            </strong>
            <p>{result.reasoning}</p>
            {result.status === "funded" && (
              <p>The funds are still locked. Improve the work and submit again before the deadline.</p>
            )}
            <p>
              Transaction: <TxLink hash={result.tx_hash} />
            </p>
          </div>
        )}
      </section>
    </>
  );
}

/* ───────────────────────────── Track ───────────────────────────── */

function TrackView({ initial }: { initial: string }) {
  const [addr, setAddr] = useState(initial);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.get>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);

  useEffect(() => setAddr(initial), [initial]);

  useEffect(() => {
    if (!isAddress(addr)) {
      setData(null);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const d = await api.get(addr);
        if (!stop) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!stop) {
          setData(null);
          setError(errMsg(e));
        }
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [addr]);

  const e = data?.escrow;
  const deadline = data?.chain_deadline ?? 0;
  const refundableAt = deadline + SETTLEMENT_GRACE_SECONDS;
  const refundable = deadline > 0 && data?.chain_status === "funded" && Date.now() / 1000 >= refundableAt;

  // Anyone may send this transaction; the contract only ever pays the client.
  async function refundAfterDeadline() {
    setError(null);
    setRefundBusy(true);
    try {
      if (!isAddress(addr)) throw new Error("Enter a valid escrow contract address.");
      const w = await connect();
      const hash = await w.walletClient.writeContract({
        address: addr as Address,
        abi: escrowAbi,
        functionName: "refundAfterDeadline",
        account: w.account,
        chain: CHAIN,
      });
      await w.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setRefundBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Track escrow</h2>
      <label>Escrow contract address</label>
      <input value={addr} onChange={(ev) => setAddr(ev.target.value.trim())} placeholder="0x…" />
      {error && <p className="error">{error}</p>}
      {e && (
        <dl>
          <dt>On-chain status</dt>
          <dd>
            <span className={`pill ${data?.chain_status}`}>{data?.chain_status ?? "unknown"}</span>
          </dd>
          <dt>Backend status</dt>
          <dd>{e.status}</dd>
          {deadline > 0 && (
            <>
              <dt>Submission deadline</dt>
              <dd>
                {new Date(deadline * 1000).toLocaleString()}
                {Date.now() / 1000 >= deadline ? " · passed" : ""}
              </dd>
            </>
          )}
          {data?.chain_revision_limit !== undefined && (
            <>
              <dt>Revisions used</dt>
              <dd>
                {data.chain_revisions_used ?? 0} of {data.chain_revision_limit}
              </dd>
            </>
          )}
          <dt>Client</dt>
          <dd>
            <code>{e.client_address}</code>
          </dd>
          <dt>Freelancer</dt>
          <dd>
            {e.freelancer_address ? (
              <code>{e.freelancer_address}</code>
            ) : (
              <span className="muted">Open job: nobody has accepted it yet</span>
            )}
          </dd>
          <dt>Requirement</dt>
          <dd>{e.initial_prompt}</dd>
          {e.ai_reasoning && (
            <>
              <dt>AI reasoning</dt>
              <dd>{e.ai_reasoning}</dd>
            </>
          )}
          {e.tx_hash && (
            <>
              <dt>Settlement tx</dt>
              <dd>
                <TxLink hash={e.tx_hash} />
              </dd>
            </>
          )}
          {e.last_error && (
            <>
              <dt>Last error</dt>
              <dd className="error">{e.last_error}</dd>
            </>
          )}
          {refundable && (
            <>
              <dt>Deadline refund</dt>
              <dd>
                <button onClick={refundAfterDeadline} disabled={refundBusy}>
                  {refundBusy ? "Refunding…" : "Refund funds to the client"}
                </button>
                <p className="muted small">
                  The deadline and grace period have passed without a verdict. Anyone can send this transaction, and the
                  funds can only go to the client.
                </p>
              </dd>
            </>
          )}
          {deadline > 0 && data?.chain_status === "funded" && !refundable && (
            <>
              <dt>Deadline refund</dt>
              <dd className="muted small">
                Available from {new Date(refundableAt * 1000).toLocaleString()} if the escrow is still unsettled.
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

/* ───────────────────────────── Page ───────────────────────────── */

export default function Home() {
  const [tab, setTab] = useState<Tab>("client");
  const [account, setAccount] = useState<string | null>(null);
  const [prefill, setPrefill] = useState("");

  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("escrow");
    if (e) {
      setPrefill(e);
      setTab("freelancer");
    }
  }, []);

  // Track which account this site can actually see (not just what MetaMask's window shows).
  useEffect(() => {
    const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!eth) return;
    eth
      .request({ method: "eth_accounts" })
      .then((a) => setAccount(a[0] ?? null))
      .catch(() => {});
    const onChange = (a: string[]) => setAccount(a[0] ?? null);
    eth.on("accountsChanged", onChange);
    return () => eth.removeListener("accountsChanged", onChange);
  }, []);

  async function connectWallet() {
    try {
      setAccount((await connect()).account);
    } catch {
      /* the action buttons show wallet errors; ignore here */
    }
  }

  return (
    <main>
      <header>
        <div>
          <h1>AI Escrow</h1>
          <span className="muted small">Funds locked on-chain · released by AI verdict · {CHAIN.name}</span>
        </div>
        <button className="ghost" onClick={connectWallet}>
          {account ? shortAddr(account) : "Connect MetaMask"}
        </button>
      </header>

      {account && (
        <p className="muted small">
          Wallet this page sees: <code>{account}</code>
        </p>
      )}

      <nav className="tabs">
        {(
          [
            ["client", "I'm the client"],
            ["freelancer", "I'm the freelancer"],
            ["track", "Track escrow"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "client" && <ClientView onAccount={setAccount} />}
      {tab === "freelancer" && <FreelancerView initial={prefill} onAccount={setAccount} />}
      {tab === "track" && <TrackView initial={prefill} />}
    </main>
  );
}
