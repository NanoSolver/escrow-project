"use client";

import { useEffect, useState } from "react";

const WORDS = ["GET", "SET", "READY"];

/** Full-screen intro: a word sequence and a 000% counter, then it slides up. Shown once per browser session. */
export default function Preloader() {
  const [n, setN] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (document.documentElement.dataset.intro === "seen") {
      setGone(true);
      return;
    }
    const start = performance.now();
    const duration = 1900;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (t: number) => {
      const p = Math.min((t - start) / duration, 1);
      setN(Math.round(p * 100));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        try {
          sessionStorage.setItem("intro", "seen");
        } catch {
          /* ignore */
        }
        setLeaving(true);
        timer = setTimeout(() => setGone(true), 1000);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  if (gone) return null;
  const word = WORDS[n < 34 ? 0 : n < 67 ? 1 : 2];
  return (
    <div className={`preloader ${leaving ? "leaving" : ""}`} aria-hidden="true">
      <div className="pre-top">TRUSTFORGE</div>
      <div className="pre-word">{word}</div>
      <div className="pre-bottom">
        <div className="pre-count">{String(n).padStart(3, "0")}%</div>
      </div>
      <div className="pre-bar">
        <span style={{ transform: `scaleX(${n / 100})` }} />
      </div>
    </div>
  );
}
