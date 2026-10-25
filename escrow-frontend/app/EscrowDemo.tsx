"use client";

import { useEffect, useState } from "react";

const STAGES = [
  { note: "Example escrow, locked on-chain", status: "Awaiting delivery", pct: 33 },
  { note: "Example escrow, work submitted", status: "AI is reviewing", pct: 66 },
  { note: "Example escrow, settled", status: "Released to freelancer", pct: 100 },
];

/** A small clickable example of the escrow life cycle. It also advances by itself every few seconds. */
export default function EscrowDemo() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setI((x) => (x + 1) % STAGES.length), 4000);
    return () => clearInterval(t);
  }, [paused]);

  const s = STAGES[i];
  return (
    <div
      className={`float-card ${i === 2 ? "done" : ""}`}
      aria-label="Example escrow"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="float-top">
        <span className="live-dot" />
        <span>{i === 2 ? "Funds released" : "Funds protected"}</span>
      </div>
      <div className="float-amount">
        0.01<span> ETH</span>
      </div>
      <p>{s.note}</p>
      <div className="float-bar">
        <span style={{ width: `${s.pct}%` }} />
      </div>
      <div className="float-foot">
        <span>Step {i + 1} of 3</span>
        <strong>{s.status}</strong>
      </div>
      <button type="button" className="demo-step" onClick={() => setI((x) => (x + 1) % STAGES.length)}>
        {i === 2 ? "Replay the example" : "Show next step"}
      </button>
    </div>
  );
}
