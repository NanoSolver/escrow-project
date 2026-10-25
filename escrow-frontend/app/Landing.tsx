import type { CSSProperties } from "react";
import Image from "next/image";
import ThemeToggle from "./ThemeToggle";
import EscrowDemo from "./EscrowDemo";
import Reveal from "./Reveal";
import CryptoScene from "./CryptoScene";
import TransitionLink from "./TransitionLink";

const STEPS = [
  ["01", "Set the terms", "The client writes the requirement, the price, the deadline, and how many revisions are allowed."],
  ["02", "Fund the escrow", "The price is locked in a smart contract. Neither side can take it back early."],
  ["03", "Deliver the work", "The freelancer submits code or a link, and the AI reviews it against the requirement."],
  ["04", "Release or refund", "Approved work pays the freelancer. Rejected work, after the revisions, refunds the client."],
];

export default function Landing() {
  return (
    <>
      <section className="hero" id="top">
        <CryptoScene />
        <div className="hero-shade" aria-hidden="true" />

        <header className="site-nav">
          <a className="brand" href="#top" aria-label="TrustForge home">
            <Image src="/trustforge-ethereum.png" width={42} height={42} className="brand-logo" alt="TrustForge logo" priority />
            <span>TrustForge</span>
          </a>
          <nav className="nav-links" aria-label="Main navigation">
            <a href="#how-it-works"><b>01</b>How it works</a>
            <a href="#faq"><b>02</b>Questions</a>
            <TransitionLink className="nav-cta" href="/escrow">Start an escrow ↗</TransitionLink>
            <ThemeToggle />
          </nav>
        </header>

        <div className="hero-content">
          <h1>
            <span className="line"><span className="line-in">Your escrow</span></span>
            <span className="line"><span className="line-in" style={{ "--d": "0.14s" } as CSSProperties}><em>desk.</em></span></span>
          </h1>
          <div className="hero-bottom">
            <p className="hero-copy">
              Funds are locked in a smart contract while the work gets done. An AI judge checks the delivery against
              the agreement, and the money moves only when the terms are met.
            </p>
            <div className="hero-actions">
              <TransitionLink className="cta" href="/escrow">
                <span>Start an escrow</span>
                <span className="cta-icon" aria-hidden="true">↗</span>
              </TransitionLink>
              <a className="hero-link" href="#how-it-works">See how it works ↓</a>
            </div>
          </div>
        </div>

        <EscrowDemo />
        <p className="hero-hint">Move your cursor to tilt the crystal. Click to spin it.</p>
      </section>

      <section className="process" id="how-it-works">
        <Reveal>
          <p className="section-tag">[01] How it works</p>
          <h2>
            Four steps.
            <br />
            <em>One shared</em> agreement.
          </h2>
        </Reveal>
        <div className="steps-grid">
          {STEPS.map(([n, title, text], i) => (
            <Reveal key={n} delay={i * 0.12}>
              <strong>{n}</strong>
              <h3>{title}</h3>
              <p>{text}</p>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
