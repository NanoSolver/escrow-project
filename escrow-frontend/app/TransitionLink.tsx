"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A link that covers the screen with a dark curtain, then opens the next page behind it. */
export default function TransitionLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [going, setGoing] = useState(false);

  // Whenever the route changes (or we come back to this page), the curtain must go away.
  useEffect(() => {
    setGoing(false);
  }, [pathname]);

  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
    e.preventDefault();
    if (going) return;
    router.prefetch(href);
    setGoing(true);
    window.setTimeout(() => {
      document.documentElement.dataset.curtain = "1"; // the next page starts covered, then slides the curtain away
      router.push(href);
      // Safety net: even if this component is kept alive in the background, never leave the curtain up.
      window.setTimeout(() => setGoing(false), 1500);
    }, 650);
  }

  return (
    <>
      <a href={href} className={className} onClick={onClick}>
        {children}
      </a>
      {going &&
        createPortal(
          <div className="curtain-out" aria-hidden="true">
            <span>TrustForge</span>
          </div>,
          document.body,
        )}
    </>
  );
}
