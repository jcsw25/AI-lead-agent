"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * A submit button that shows it is working, and for how long.
 *
 * The search takes 20-60 seconds and the server action blocks until it
 * finishes. Without this the page simply sits there — the browser's own tab
 * spinner is the only signal, which reads as "nothing happened" and invites a
 * second click that starts a second search.
 *
 * The elapsed counter was added after a search sat for four minutes reading
 * "Searching Google…". A spinner with no clock cannot distinguish twenty
 * seconds from four minutes, so there is no moment at which a person can tell
 * that something has gone wrong. Now the count itself says so, and past the
 * point where a healthy search would have finished the label says it plainly.
 */
export function SearchButton({
  label,
  pendingLabel,
  className,
}: {
  label: string;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  const seconds = useElapsed(pending);

  // Roughly when a healthy search has finished. Past it, the wait is worth
  // explaining rather than leaving to be guessed at.
  const slow = seconds >= 45;

  return (
    <>
      <button type="submit" className={className} disabled={pending} aria-busy={pending}>
        {pending ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: ".5rem" }}>
            <Spinner />
            {pendingLabel ?? "Searching…"} {seconds}s
          </span>
        ) : (
          label
        )}
      </button>
      {pending && slow && (
        <p className="muted" style={{ fontSize: ".8rem", margin: ".45rem 0 0", maxWidth: "34rem" }}>
          Taking longer than usual. When Google returns few results the search also asks the slower providers,
          which is worth the wait for an unusual trade. It gives up at 150 seconds and keeps whatever it found.
        </p>
      )}
    </>
  );
}

/** A small indeterminate spinner. Respects reduced-motion. */
export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <>
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          border: "2px solid currentColor",
          borderTopColor: "transparent",
          borderRadius: "50%",
          display: "inline-block",
          animation: "spin .7s linear infinite",
          flexShrink: 0,
        }}
      />
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @media (prefers-reduced-motion: reduce) {
          [aria-hidden] { animation-duration: 2.5s !important }
        }
      `}</style>
    </>
  );
}

/** Seconds since the form started submitting; resets when it finishes. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  return seconds;
}
