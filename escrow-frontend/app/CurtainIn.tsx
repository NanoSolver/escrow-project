"use client";

import { useEffect } from "react";

/** Lifts the curtain on the page we just arrived at, then switches itself off. */
export default function CurtainIn() {
  useEffect(() => {
    const d = document.documentElement;
    if (!d.dataset.curtain) return;
    const t = setTimeout(() => {
      delete d.dataset.curtain;
    }, 1400);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="curtain-in" aria-hidden="true">
      <span>TrustForge</span>
    </div>
  );
}
