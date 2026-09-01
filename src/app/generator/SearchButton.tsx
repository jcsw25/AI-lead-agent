"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that shows it is working.
 *
 * The search takes 20-60 seconds and the server action blocks until it
 * finishes. Without this the page simply sits there — the browser's own tab
 * spinner is the only signal, which reads as "nothing happened" and invites a
 * second click that starts a second search.
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

  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: ".5rem" }}>
          <Spinner />
          {pendingLabel ?? "Searching…"}
        </span>
      ) : (
        label
      )}
    </button>
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
