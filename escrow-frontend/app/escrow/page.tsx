"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { formatEther, isAddress, parseEther, zeroAddress, type Address, type EIP1193Provider } from "viem";
import { api, type ClientEscrow, type OpenJob, type SubmissionView, type SubmitResult } from "../../lib/api";
import { CHAIN, EXPLORER_TX, SETTLEMENT_GRACE_SECONDS } from "../../lib/config";
import { escrowAbi, escrowBytecode } from "../../lib/escrow";
import { connect } from "../../lib/wallet";
import CurtainIn from "../CurtainIn";
import ThemeToggle from "../ThemeToggle";

type Tab = "client" | "review" | "freelancer" | "track";
type Identity = { address: string; role: "client" | "freelancer"; token?: string };
type StepState = "todo" | "active" | "done" | "error";
type Step = { label: string; state: StepState };

async function registerWithRetry(address: string, prompt: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.register(address, prompt);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

function errMsg(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string };
  return x?.shortMessage ?? x?.message ?? String(e);
}

function walletError(e: unknown): string {
  const x = e as { code?: number; message?: string; shortMessage?: string };
  if (x?.code === 4001 || /user rejected|request rejected/i.test(x?.message ?? "")) {
    return "MetaMask sign-in was canceled. Retry and approve the one-time signature; it is not a transaction and costs no gas.";
  }
  return errMsg(e);
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const fmtAmount = (wei?: string) => (wei ? `${formatEther(BigInt(wei))} ${CHAIN.nativeCurrency.symbol}` : "");

/** The signed-in wallet's own escrows (as client or as freelancer). pollMs = 0 loads just once. */
function useMyEscrows(identity: Identity, refreshKey = 0, pollMs = 10000) {
  const [items, setItems] = useState<ClientEscrow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = identity.token;

  useEffect(() => {
    if (!token) {
      setError("Your sign-in predates this feature. Sign out (top right) and sign in again.");
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const d =
          identity.role === "client"
            ? await api.clientEscrows(identity.address, token)
            : await api.freelancerEscrows(identity.address, token);
        if (!stop) {
          setItems(d.escrows);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(errMsg(e));
      }
    };
    load();
    const t = pollMs > 0 ? setInterval(load, pollMs) : undefined;
    return () => {
      stop = true;
      if (t) clearInterval(t);
    };
  }, [identity.address, identity.role, token, refreshKey, pollMs]);

  return { items, error };
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
  const [pendingRegistration, setPendingRegistration] = useState<{ address: string; prompt: string } | null>(null);
  const [parties, setParties] = useState<{ client: string; freelancer: string } | null>(null);

  const setStep = (i: number, state: StepState) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, state } : x)));

  async function create() {
    setError(null);
    setCreated(null);
    setPendingRegistration(null);
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
      ["Connect MetaMask", "Check network", "Deploy escrow contract", "Deposit funds", "Register with backend"].map((label) => ({
        label,
        state: "todo" as StepState,
      })),
    );
    setBusy(true);
    let current = 0;
    let fundedAddress: string | null = null;
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
      setStep(0, "done");

      current = 1;
      setStep(1, "active");
      const { oracle, chain_id: backendChainId } = await api.health(); // oracle = the Go backend's signing address
      const backendChainNumber = Number(backendChainId);
      if (!Number.isSafeInteger(backendChainNumber) || backendChainNumber <= 0) {
        throw new Error("The backend did not report its chain ID. Restart the local API and refresh; no escrow was created.");
      }
      if (backendChainNumber !== CHAIN.id) {
        throw new Error(
          `Network mismatch: this page is set to ${CHAIN.name} (${CHAIN.id}), but the backend is on chain ${backendChainId}. No escrow was created. Restart the local services and refresh.`,
        );
      }
      setStep(1, "done");

      current = 2;
      setStep(2, "active");
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
      setStep(2, "done");

      current = 3;
      setStep(3, "active");
      const depositHash = await w.walletClient.writeContract({
        address: addr,
        abi: escrowAbi,
        functionName: "deposit",
        value,
        account: w.account,
        chain: CHAIN,
      });
      await w.publicClient.waitForTransactionReceipt({ hash: depositHash });
      setStep(3, "done");
      fundedAddress = addr;
      setCreated(addr);

      current = 4;
      setStep(4, "active");
      await registerWithRetry(addr, prompt.trim());
      setStep(4, "done");
      setPendingRegistration(null);
    } catch (e) {
      setStep(current, "error");
      if (current === 4 && fundedAddress) {
        setPendingRegistration({ address: fundedAddress, prompt: prompt.trim() });
        setError(
          `The escrow is funded on-chain, but backend sync did not finish. Do not create another escrow. Contract: ${fundedAddress}`,
        );
      } else {
        setError(errMsg(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryRegistration() {
    if (!pendingRegistration || busy) return;
    setBusy(true);
    setError(null);
    setStep(4, "active");
    try {
      await registerWithRetry(pendingRegistration.address, pendingRegistration.prompt);
      setStep(4, "done");
      setPendingRegistration(null);
    } catch {
      setStep(4, "error");
      setError(
        `Backend sync is still unavailable. Your funded escrow is safe at ${pendingRegistration.address}. Retry sync later; do not create another escrow.`,
      );
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

      <button onClick={create} disabled={busy || !!pendingRegistration}>
        {busy ? "Working…" : "Create & fund escrow"}
      </button>
      {pendingRegistration && (
        <button onClick={retryRegistration} disabled={busy}>
          {busy ? "Syncing…" : "Retry backend sync"}
        </button>
      )}

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
          <code className="wrap">{`${window.location.origin}/escrow?escrow=${created}`}</code>
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

/** Everything this freelancer was assigned or has accepted, so nobody has to paste an address. */
function MyJobs({
  items,
  error,
  selected,
  onSelect,
  token,
}: {
  items: ClientEscrow[] | null;
  error: string | null;
  selected: string;
  onSelect: (addr: string) => void;
  token?: string;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const isActive = (s: string) => s === "created" || s === "funded" || s === "evaluating";
  const active = items?.filter((i) => isActive(i.status)) ?? [];
  const finished = items?.filter((i) => !isActive(i.status)) ?? [];

  const row = (it: ClientEscrow) => {
    const due = it.deadline_at ? new Date(it.deadline_at) : null;
    const hasDue = due !== null && due.getFullYear() > 1971;
    const isSel = selected.toLowerCase() === it.contract_address;
    const isViewing = viewing === it.contract_address;
    return (
      <article className="job" key={it.contract_address}>
        <div className="job-head">
          <span>
            <strong>{fmtAmount(it.amount_wei) || "Escrow"}</strong>{" "}
            <span className={`pill ${it.status}`}>{it.status}</span>
          </span>
          <span className="muted small">
            {hasDue && due ? `due ${due.toLocaleString()}${due.getTime() < Date.now() ? " (passed)" : ""} · ` : ""}
            revisions {it.revisions_used} of {it.revision_limit} · client {shortAddr(it.client_address)}
          </span>
        </div>
        <p className="job-req">{it.initial_prompt}</p>
        {it.ai_reasoning && (
          <p className="small">
            <strong>{it.ai_decision === false ? "Latest AI feedback: " : "Latest AI review: "}</strong>
            {it.ai_reasoning}
          </p>
        )}
        {it.status === "released" && <p className="small">Paid: the funds were released to you.</p>}
        {it.status === "refunded" && <p className="small">The funds went back to the client.</p>}
        <div className="toggle">
          {isActive(it.status) && (
            <button
              className={isSel ? "on" : ""}
              onClick={() => onSelect(it.contract_address)}
              disabled={it.status === "evaluating"}
            >
              {it.status === "evaluating" ? "AI review in progress…" : isSel ? "Selected ✓" : "Work on this job"}
            </button>
          )}
          {it.has_submission && (
            <button onClick={() => setViewing(isViewing ? null : it.contract_address)}>
              {isViewing ? "Hide my submission" : "View my submission"}
            </button>
          )}
        </div>
        {isViewing && token && (
          <SubmissionPanel address={it.contract_address} token={token} submittedAt={it.submitted_at} />
        )}
      </article>
    );
  };

  return (
    <section className="card">
      <h2>My jobs</h2>
      <p className="muted">Jobs the client assigned to you and open jobs you accepted. Pick one to work on it.</p>
      {error && <p className="error">{error}</p>}
      {items === null && !error && <p className="muted small">Loading your jobs…</p>}
      {items?.length === 0 && (
        <p className="muted small">
          Nothing yet. Accept one of the open jobs below, or ask a client to assign you one.
        </p>
      )}
      {active.length > 0 && <h3 className="section-title">In progress</h3>}
      {active.map(row)}
      {finished.length > 0 && <h3 className="section-title">Finished</h3>}
      {finished.map(row)}
    </section>
  );
}

function FreelancerView({
  initial,
  identity,
  onAccount,
}: {
  initial: string;
  identity: Identity;
  onAccount: (a: string) => void;
}) {
  const [escrow, setEscrow] = useState(initial);
  const [mode, setMode] = useState<"text" | "link">("text");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [reload, setReload] = useState(0);
  const [acceptBusy, setAcceptBusy] = useState(false);

  useEffect(() => setEscrow(initial), [initial]);

  // "My jobs" list, and remembering the last job you picked so a page reload keeps it.
  const { items: myJobs, error: jobsError } = useMyEscrows(identity, reload);
  const SELECTED_KEY = `escrow.selected.${identity.address}`;
  useEffect(() => {
    if (initial) return;
    try {
      const saved = window.localStorage.getItem(SELECTED_KEY);
      if (saved && isAddress(saved)) setEscrow(saved);
    } catch {
      /* storage unavailable: just start without a selection */
    }
  }, [initial, SELECTED_KEY]);
  useEffect(() => {
    if (!isAddress(escrow)) return;
    try {
      window.localStorage.setItem(SELECTED_KEY, escrow);
    } catch {
      /* ignore */
    }
  }, [escrow, SELECTED_KEY]);
  const selectedJob = myJobs?.find((j) => j.contract_address === escrow.toLowerCase());

  function selectJob(addr: string) {
    if (addr !== escrow) {
      setResult(null);
      setError(null);
      setContent("");
    }
    setEscrow(addr);
    document.getElementById("submit-work")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Show who this escrow expects, straight from the chain, so a wrong wallet is obvious.
  const [expected, setExpected] = useState<string | null>(null);
  const [dealInfo, setDealInfo] = useState<{
    deadline: number;
    used: number;
    limit: number;
    status?: string;
    requirement: string;
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
            requirement: d.escrow.initial_prompt,
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
      setReload((n) => n + 1); // refresh My jobs and the job details
    }
  }

  return (
    <>
      <MyJobs items={myJobs} error={jobsError} selected={escrow} onSelect={selectJob} token={identity.token} />
      <OpenJobsBoard
        onAccount={onAccount}
        onPick={(addr) => {
          setEscrow(addr);
          setReload((n) => n + 1);
        }}
      />
      <section className="card" id="submit-work">
        <h2>Submit work</h2>
        <p className="muted">
          Connect with the freelancer wallet: the one the client named, or the one that accepted the open job.
        </p>

        {selectedJob ? (
          <p>
            <strong>{fmtAmount(selectedJob.amount_wei) || "Selected job"}</strong> ·{" "}
            <code>{shortAddr(selectedJob.contract_address)}</code>{" "}
            <span className={`pill ${selectedJob.status}`}>{selectedJob.status}</span>
          </p>
        ) : isAddress(escrow) ? (
          <p className="muted small">
            Escrow <code>{shortAddr(escrow)}</code> (not in your list yet)
          </p>
        ) : (
          <p className="muted small">Pick one of your jobs above or accept an open job. No typing needed.</p>
        )}
        <details className="manual">
          <summary className="muted small">Use a different escrow address</summary>
          <input value={escrow} onChange={(e) => setEscrow(e.target.value.trim())} placeholder="0x…" />
        </details>
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

        {dealInfo?.requirement && (
          <>
            <label>Requirement</label>
            <p className="job-req">{dealInfo.requirement}</p>
          </>
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
          <div className="processing review-progress">
            <div className="review-progress-heading">
              <span className="spinner" />
              <div>
                <strong>Multi-model AI review in progress</strong>
                <p>OpenRouter makes the initial decision. Three independent models review it, and at least two must agree.</p>
              </div>
            </div>
            <div className="reviewer-grid" aria-label="Independent AI reviewers">
              {["Groq", "SambaNova", "NVIDIA NIM"].map((name) => (
                <div className="reviewer-chip" key={name}>
                  <span className="reviewer-pulse" />
                  <span><strong>{name}</strong><small>Reviewing OpenRouter&apos;s verdict</small></span>
                </div>
              ))}
            </div>
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
            <p><strong>{result.decision ? "Review summary: " : "Why it wasn’t approved: "}</strong>{result.reasoning}</p>
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

/* ─────────────────────── Review & approve (client) ─────────────────────── */

function approveErrMsg(e: unknown): string {
  const m = errMsg(e);
  if (m.includes("NotClient"))
    return "Only the client who created this escrow can approve it. Switch MetaMask to that account.";
  if (m.includes("DeadlinePassed")) return "The deadline has passed, so the client can no longer approve this escrow.";
  if (m.includes("NoFreelancer")) return "No freelancer has accepted this open job yet, so there is nobody to pay.";
  if (m.includes("InvalidStatus"))
    return "This escrow is not funded any more (it may already be released or refunded).";
  return m;
}

const SAFE_LINK = /^https:\/\/(raw|gist)\.githubusercontent\.com\//;

/** The latest submitted work for one escrow. Fetched with the sign-in token; shown as plain text. */
function SubmissionPanel({
  address,
  token,
  submittedAt,
}: {
  address: string;
  token: string;
  submittedAt: string | null;
}) {
  const [sub, setSub] = useState<SubmissionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setSub(null);
    setError(null);
    api
      .submission(address, token)
      .then((d) => {
        if (!stop) setSub(d);
      })
      .catch((e) => {
        if (!stop) setError(errMsg(e));
      });
    return () => {
      stop = true;
    };
  }, [address, token, submittedAt]); // a newer submission reloads the panel

  if (error) return <p className="error">{error}</p>;
  if (!sub) return <p className="muted small">Loading the submitted work…</p>;
  const verdict =
    sub.status === "evaluating"
      ? "The AI is reviewing this right now."
      : sub.ai_decision === true
        ? "AI verdict: approved."
        : sub.ai_decision === false
          ? "AI verdict: rejected."
          : "No AI verdict recorded for this submission.";
  return (
    <div className="submission-panel">
      <p className="muted small">
        Submitted {sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : "(time unknown)"} · revisions used{" "}
        {sub.revisions_used} of {sub.revision_limit}
      </p>
      {SAFE_LINK.test(sub.submission_link) && (
        <p className="small">
          Source:{" "}
          <a href={sub.submission_link} target="_blank" rel="noreferrer noopener">
            {sub.submission_link}
          </a>
        </p>
      )}
      <pre className="review-submission">{sub.submission_text || "(empty submission)"}</pre>
      <p className="small">
        <strong>{verdict}</strong>
        {sub.ai_reasoning && (
          <><br /><strong>{sub.ai_decision === false ? "Why it wasn’t approved: " : "Review reasoning: "}</strong>{sub.ai_reasoning}</>
        )}
      </p>
    </div>
  );
}

/** The client's portal: read what the freelancer submitted, then approve to release the funds. */
function ReviewView({ identity, onAccount }: { identity: Identity; onAccount: (a: string) => void }) {
  const [items, setItems] = useState<ClientEscrow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tx: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const token = identity.token;

  useEffect(() => {
    if (!token) {
      setError("Your sign-in predates the review portal. Sign out (top right) and sign in again.");
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const d = await api.clientEscrows(identity.address, token);
        if (!stop) {
          setItems(d.escrows);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(errMsg(e));
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [identity.address, token, tick]);

  /** Why approval is not possible right now, or null when it is. */
  function blocker(it: ClientEscrow): string | null {
    if (it.status === "released") return "Already released to the freelancer.";
    if (it.status === "refunded") return "Refunded to you.";
    if (it.status === "evaluating") return "The AI review is in progress.";
    if (it.status !== "funded") return "This escrow is not funded.";
    if (!it.freelancer_address) return "Waiting for a freelancer to accept this open job.";
    if (!it.has_submission) return "Waiting for the freelancer to submit work.";
    return null;
  }

  async function approve(it: ClientEscrow) {
    setError(null);
    setNotice(null);
    setBusy(it.contract_address);
    try {
      const w = await connect();
      onAccount(w.account);
      if (w.account.toLowerCase() !== identity.address.toLowerCase()) {
        throw new Error(
          `MetaMask is on a different account than the one you signed in with. Switch to ${identity.address}.`,
        );
      }
      // Re-check against the chain right before sending, using the chain's own clock.
      const [live, block] = await Promise.all([api.get(it.contract_address), w.publicClient.getBlock()]);
      if (live.chain_status !== "funded") throw new Error("This escrow is no longer funded on-chain.");
      if (!live.chain_freelancer) throw new Error("No freelancer has accepted this job yet.");
      if (live.chain_deadline !== undefined && block.timestamp >= BigInt(live.chain_deadline)) {
        throw new Error("The deadline has passed, so the client can no longer approve this escrow.");
      }
      const price = live.chain_amount_wei
        ? `${formatEther(BigInt(live.chain_amount_wei))} ${CHAIN.nativeCurrency.symbol}`
        : "the escrowed funds";
      if (
        !window.confirm(`Release ${price} to ${live.chain_freelancer}? This sends a transaction and cannot be undone.`)
      )
        return;

      const hash = await w.walletClient.writeContract({
        address: it.contract_address as Address,
        abi: escrowAbi,
        functionName: "approveByClient",
        account: w.account,
        chain: CHAIN,
      });
      await w.publicClient.waitForTransactionReceipt({ hash });
      await api.get(it.contract_address); // lets the backend record the new status
      setNotice({ text: `Approved: ${price} released to the freelancer.`, tx: hash });
    } catch (e) {
      setError(approveErrMsg(e));
    } finally {
      setBusy(null);
      setTick((n) => n + 1);
    }
  }

  return (
    <section className="card">
      <h2>Review &amp; approve</h2>
      <p className="muted">
        Read what the freelancer submitted and release the funds yourself. You can approve work the AI rejected, or
        confirm work it approved. Approving is a transaction from your wallet, and it is only possible before the
        deadline.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && (
        <div className="result ok">
          <strong>{notice.text}</strong>
          <p>
            Transaction: <TxLink hash={notice.tx} />
          </p>
        </div>
      )}
      {items === null && !error && <p className="muted small">Loading your escrows…</p>}
      {items?.length === 0 && <p className="muted small">You have not created any escrows yet.</p>}
      {items?.map((it) => {
        const why = blocker(it);
        const isOpen = open === it.contract_address;
        return (
          <article className="job" key={it.contract_address}>
            <div className="job-head">
              <span>
                <code>{shortAddr(it.contract_address)}</code> <span className={`pill ${it.status}`}>{it.status}</span>
              </span>
              <span className="muted small">
                {it.freelancer_address
                  ? `freelancer ${shortAddr(it.freelancer_address)}`
                  : "open job, not accepted yet"}
                {it.submitted_at ? ` · submitted ${new Date(it.submitted_at).toLocaleString()}` : ""}
              </span>
            </div>
            <p className="job-req">{it.initial_prompt}</p>
            <div className="toggle">
              <button
                onClick={() => setOpen(isOpen ? null : it.contract_address)}
                disabled={!it.has_submission}
                title={it.has_submission ? "" : "Nothing submitted yet"}
              >
                {isOpen ? "Hide submission" : it.has_submission ? "View submission" : "No submission yet"}
              </button>
              <button onClick={() => approve(it)} disabled={why !== null || busy !== null}>
                {busy === it.contract_address ? "Confirm in MetaMask…" : "Approve & release funds"}
              </button>
            </div>
            {why && <p className="muted small">{why}</p>}
            {isOpen && token && (
              <SubmissionPanel address={it.contract_address} token={token} submittedAt={it.submitted_at} />
            )}
          </article>
        );
      })}
      <button className="ghost" onClick={() => setTick((n) => n + 1)} disabled={busy !== null}>
        Refresh
      </button>
    </section>
  );
}

/* ───────────────────────────── Track ───────────────────────────── */

function TrackView({ initial, identity }: { initial: string; identity: Identity }) {
  const { items: mine } = useMyEscrows(identity, 0, 0);
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
      {mine && mine.length > 0 && (
        <>
          <label>Your escrows</label>
          <select
            value={mine.some((i) => i.contract_address === addr.toLowerCase()) ? addr.toLowerCase() : ""}
            onChange={(ev) => setAddr(ev.target.value)}
          >
            <option value="">Pick one of yours…</option>
            {mine.map((i) => (
              <option key={i.contract_address} value={i.contract_address}>
                {fmtAmount(i.amount_wei) || "escrow"} · {shortAddr(i.contract_address)} · {i.status}
              </option>
            ))}
          </select>
        </>
      )}
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
              <dt>{e.ai_decision === false ? "Why it wasn’t approved" : "AI reasoning"}</dt>
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
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [hasMetaMask, setHasMetaMask] = useState(false);
  const [pendingWallet, setPendingWallet] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const signInWallet = useRef<Awaited<ReturnType<typeof connect>> | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("escrow.identity");
      if (saved) {
        const parsed = JSON.parse(saved) as Identity;
        setIdentity(parsed);
        setTab(parsed.role); // a saved freelancer must not land on the (empty) client tab
      }
    } catch {
      window.localStorage.removeItem("escrow.identity");
    }
  }, []);

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
    setHasMetaMask(true);
    eth
      .request({ method: "eth_accounts" })
      .then((a) => setAccount(a[0] ?? null))
      .catch(() => {});
    const onChange = (a: string[]) => {
      const next = a[0] ?? null;
      setAccount(next);
      if (identity && next?.toLowerCase() !== identity.address.toLowerCase()) {
        setIdentity(null);
        window.localStorage.removeItem("escrow.identity");
      }
      if (pendingWallet && next?.toLowerCase() !== pendingWallet.toLowerCase()) {
        setPendingWallet(null);
        signInWallet.current = null;
      }
    };
    eth.on("accountsChanged", onChange);
    return () => eth.removeListener("accountsChanged", onChange);
  }, [identity, pendingWallet]);

  async function connectForSignIn() {
    setAuthError("");
    setAuthBusy(true);
    try {
      const wallet = await connect();
      signInWallet.current = wallet;
      setPendingWallet(wallet.account);
      setAccount(wallet.account);
    } catch (e) {
      setAuthError(walletError(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signIn(role: "client" | "freelancer") {
    setAuthError("");
    setAuthBusy(true);
    try {
      const wallet = signInWallet.current ?? (await connect());
      if (pendingWallet && wallet.account.toLowerCase() !== pendingWallet.toLowerCase()) {
        throw new Error("The connected MetaMask account changed. Connect the intended account and try again.");
      }
      const challenge = await api.authChallenge(wallet.account, role);
      const signature = await wallet.walletClient.signMessage({ account: wallet.account, message: challenge.message });
      const verified = await api.authVerify(wallet.account, role, challenge.message, signature);
      const next: Identity = { address: verified.address, role: verified.role, token: verified.token };
      setIdentity(next);
      setAccount(verified.address);
      setTab(role);
      window.localStorage.setItem("escrow.identity", JSON.stringify(next));
      signInWallet.current = null;
      setPendingWallet(null);
    } catch (e) {
      setAuthError(walletError(e));
    } finally {
      setAuthBusy(false);
    }
  }

  if (!identity)
    return (
      <main className="auth-shell" id="app">
          <CurtainIn />
          <section className="auth-card">
            <div className="auth-card-nav"><a href="/">← Home</a><ThemeToggle /></div>
            <Image src="/trustforge-ethereum.png" width={48} height={48} className="auth-brand-logo" alt="TrustForge logo" priority />
            <p className="eyebrow">SECURE WEB3 WORK</p>
            <h1>TrustForge</h1>
            <p className="muted">Fair freelance work, protected on-chain.</p>
            <div className={`setup-note ${hasMetaMask ? "ready" : ""}`}>
              <strong>{hasMetaMask ? "MetaMask detected" : "Before you start"}</strong>
              <ol>
                <li>
                  <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                    Install the MetaMask browser extension
                  </a>
                  .
                </li>
                <li>Open MetaMask and create a wallet or import your existing one.</li>
                <li>Come back here and sign in with that wallet.</li>
              </ol>
              <p className="muted small">Never share your recovery phrase or private key with this site.</p>
            </div>
            {!pendingWallet ? (
              hasMetaMask ? (
                <button disabled={authBusy} onClick={connectForSignIn}>
                  {authBusy ? "Connecting…" : "Sign in with MetaMask"}
                </button>
              ) : (
                <a className="button-link" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                  Get MetaMask
                </a>
              )
            ) : (
              <>
                <p className="muted small">
                  Connected wallet: <code>{shortAddr(pendingWallet)}</code>. Choose your role to finish signing in.
                </p>
                <button disabled={authBusy} onClick={() => signIn("client")}>
                  {authBusy ? "Verifying signature…" : "Continue as client"}
                </button>
                <button className="ghost" disabled={authBusy} onClick={() => signIn("freelancer")}>
                  Continue as freelancer
                </button>
              </>
            )}
            <p className="muted small">
              Signing a one-time message verifies your wallet. It sends no transaction and costs no gas.
            </p>
            {authError && <p className="error">{authError}</p>}
            <p className="muted small">Network: {CHAIN.name}. MetaMask will prompt you to add it if needed.</p>
          </section>
      </main>
    );

  return (
    <main id="app">
        <CurtainIn />
        <header>
          <div>
            <div className="app-title">
              <Image src="/trustforge-ethereum.png" width={42} height={42} className="brand-logo" alt="" aria-hidden />
              <h1>TrustForge</h1>
            </div>
            <span className="muted small">Funds locked on-chain · released by AI verdict · {CHAIN.name}</span>
          </div>
          <div className="app-route-actions">
            <a href="/">← Home</a>
            <ThemeToggle />
            <button
              className="ghost"
              onClick={() => {
                setIdentity(null);
                window.localStorage.removeItem("escrow.identity");
              }}
            >
              {shortAddr(identity.address)} · Sign out
            </button>
          </div>
        </header>

      {account && (
        <p className="muted small">
          Wallet this page sees: <code>{account}</code>
        </p>
      )}

      <nav className="tabs">
        {(
          (identity.role === "client"
            ? [
                ["client", "Create escrow"],
                ["review", "Review & approve"],
                ["track", "Track escrow"],
              ]
            : [
                ["freelancer", "Freelancer dashboard"],
                ["track", "Track escrow"],
              ]) as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "client" && identity.role === "client" && <ClientView onAccount={setAccount} />}
      {tab === "review" && identity.role === "client" && <ReviewView identity={identity} onAccount={setAccount} />}
      {tab === "freelancer" && identity.role === "freelancer" && (
        <FreelancerView initial={prefill} identity={identity} onAccount={setAccount} />
      )}
      {tab === "track" && <TrackView initial={prefill} identity={identity} />}
    </main>
  );
}
