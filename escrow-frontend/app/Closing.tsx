import Reveal from "./Reveal";
import TransitionLink from "./TransitionLink";

export default function Closing() {
  return (
    <footer className="closing">
      <Reveal>
        <h2>
          Start on the <em>same side.</em>
        </h2>
        <p>Create an escrow, fund it from your wallet, and let the contract and the AI handle the rest.</p>
        <TransitionLink className="cta" href="/escrow">
          <span>Start an escrow</span>
          <span className="cta-icon" aria-hidden="true">↗</span>
        </TransitionLink>
      </Reveal>
      <div className="closing-foot">
        <span>© 2026 TrustForge · Funds locked on-chain, released by an AI verdict</span>
        <a href="#top">Back to top ↑</a>
      </div>
    </footer>
  );
}
