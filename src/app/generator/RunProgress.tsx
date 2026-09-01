"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "./SearchButton";

/**
 * Live progress for a search that is still finishing.
 *
 * A search returns quickly, but opening the websites and writing the Sheet
 * carry on behind it for a minute or two. Without a visible signal the results
 * page shows companies with empty email columns and looks broken — which it did,
 * twice, before this existed.
 *
 * Three stages, because those are the three things that can independently be in
 * progress or done. The Sheet light only turns green when the write actually
 * succeeded; a green light over a failed sync would be worse than none.
 */

export type Stage = {
  key: string;
  label: string;
  state: "done" | "running" | "waiting" | "failed";
  detail?: string;
};

export function RunProgress({
  stages,
  active,
  pollMs = 4000,
}: {
  stages: Stage[];
  /** Keep refreshing while true. */
  active: boolean;
  pollMs?: number;
}) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000);
    // router.refresh() re-runs the server component and streams new props in
    // without losing scroll position or clearing the page.
    const poll = setInterval(() => router.refresh(), pollMs);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [active, pollMs, router]);

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <strong style={{ fontSize: ".95rem" }}>
          {active ? "Working…" : "Finished"}
        </strong>
        {active && (
          <span className="muted" style={{ fontSize: ".76rem", fontVariantNumeric: "tabular-nums" }}>
            updating every {Math.round(pollMs / 1000)}s · {elapsed}s elapsed
          </span>
        )}
      </div>

      <ol style={{ listStyle: "none", margin: ".8rem 0 0", padding: 0, display: "grid", gap: ".55rem" }}>
        {stages.map((s) => (
          <li key={s.key} style={{ display: "flex", alignItems: "flex-start", gap: ".6rem" }}>
            <Light state={s.state} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: ".9rem", opacity: s.state === "waiting" ? 0.55 : 1 }}>{s.label}</div>
              {s.detail && (
                <div className="muted" style={{ fontSize: ".78rem" }}>{s.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The light itself. Green only ever means the thing actually happened. */
function Light({ state }: { state: Stage["state"] }) {
  if (state === "running") {
    return (
      <span style={{ color: "var(--accent, #0f6466)", display: "inline-flex", paddingTop: 2 }}>
        <Spinner size={12} />
      </span>
    );
  }

  const colour =
    state === "done" ? "var(--good, #2d6a44)" : state === "failed" ? "var(--bad, #982f2f)" : "var(--rule, #999)";

  return (
    <span
      aria-hidden
      title={state}
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: state === "waiting" ? "transparent" : colour,
        border: `2px solid ${colour}`,
        display: "inline-block",
        marginTop: 3,
        flexShrink: 0,
        boxShadow: state === "done" ? `0 0 6px ${colour}` : "none",
      }}
    />
  );
}
