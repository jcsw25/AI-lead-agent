"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallTarget } from "@/lib/calls/queue";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/calls/queue";
import { recordCall, refreshQueue, undoCall, updateCall } from "./actions";

/**
 * One call at a time, with the rest of the list underneath.
 *
 * The first version of this page was forty identical cards, each with a
 * dropdown, a text field and a Log button — a list you scroll. That is the
 * wrong shape for the task. Calling is repetitive and focused: you want one
 * person in front of you, the number big enough to read while holding a phone,
 * the thing to say already written, and the outcome one tap away.
 *
 * Three decisions follow from that:
 *
 *   The queue lives in the browser and advances locally. A server round trip
 *   between every call would reorder the list under someone mid-session, and
 *   the row they were about to dial would move.
 *
 *   Outcomes are buttons, not a select. A dropdown is three interactions —
 *   open, find, choose — for something done forty times an hour, and the keys
 *   1-7 do the same job without the mouse.
 *
 *   You can go back. A call logged in the wrong row, or an outcome picked
 *   before the person finished talking, has to be fixable — and fixing it
 *   UPDATES the existing record rather than adding a second, because the Calls
 *   tab is one row per company and two records would make the sheet and the app
 *   disagree about what was said.
 */

type Props = {
  businessId: string;
  queue: CallTarget[];
  sheetUrl: string | null;
  /**
   * Touches already recorded today, from the server.
   *
   * The counters live in here rather than on the page because two of them
   * disagreed: the page's "calls today" was server-rendered and stayed at 0
   * while the station's own "logged this session" counted up. One number is
   * either right or wrong; two numbers that disagree make the reader stop and
   * work out which to believe.
   */
  today: { calls: number; emails: number; total: number };
  target: { calls: number; total: number };
};

type Logged = { messageId: string; outcome: CallOutcome; notes: string };

/** Grouped so the eye finds the common ones first: most calls are no-answer. */
const OUTCOME_STYLE: Record<CallOutcome, { key: string; tone: "neutral" | "good" | "warn" | "stop"; short: string }> = {
  "No answer": { key: "1", tone: "neutral", short: "No answer" },
  "Gatekeeper — call back": { key: "2", tone: "neutral", short: "Gatekeeper" },
  "Wrong number": { key: "3", tone: "neutral", short: "Wrong number" },
  "Spoke to owner — interested": { key: "4", tone: "good", short: "Interested" },
  "Spoke to owner — not now": { key: "5", tone: "warn", short: "Not now" },
  "Spoke to owner — no": { key: "6", tone: "warn", short: "No" },
  "Asked not to be contacted": { key: "7", tone: "stop", short: "Do not contact" },
};

const BY_KEY = [...CALL_OUTCOMES].sort((a, b) => OUTCOME_STYLE[a].key.localeCompare(OUTCOME_STYLE[b].key));

function warmthLabel(t: CallTarget): { text: string; tone: string } | null {
  if (t.reportViews > 0) return { text: `opened report${t.reportViews > 1 ? ` ${t.reportViews}×` : ""}`, tone: "good" };
  if (t.emailStatus === "replied") return { text: "replied", tone: "good" };
  if (t.emailStatus === "sent") return { text: "emailed", tone: "" };
  return null;
}

export default function CallStation({ businessId, queue, sheetUrl, today, target }: Props) {
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [logged, setLogged] = useState<Record<string, Logged>>({});
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  // Skipped rows go to the back rather than disappearing — "not now" usually
  // means "after lunch", not "never".
  const ordered = useMemo(() => {
    const skip = new Set(skipped);
    return [...queue.filter((t) => !skip.has(t.contactId)), ...queue.filter((t) => skip.has(t.contactId))];
  }, [queue, skipped]);

  const current = ordered[index];
  const currentLog = current ? logged[current.contactId] : undefined;
  const doneCount = Object.keys(logged).length;

  // Moving to a row restores whatever was typed against it, so going back to
  // fix an outcome does not also wipe the note explaining it.
  const goTo = useCallback(
    (i: number) => {
      const t = ordered[i];
      setIndex(i);
      setNotes(t ? (logged[t.contactId]?.notes ?? "") : "");
      setError(null);
    },
    [ordered, logged],
  );

  const log = useCallback(
    async (outcome: CallOutcome) => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);

      const prior = logged[current.contactId];
      const res = prior
        ? await updateCall(businessId, prior.messageId, outcome, notes.trim())
        : await recordCall(businessId, current.contactId, outcome, notes.trim());
      setBusy(false);

      if (!res.ok) {
        setError(res.error ?? "Could not save that.");
        return;
      }

      const messageId = prior ? prior.messageId : (res as { messageId?: string }).messageId!;
      setLogged((m) => ({ ...m, [current.contactId]: { messageId, outcome, notes: notes.trim() } }));

      // Re-logging an earlier row keeps you there; a fresh one moves on.
      if (!prior) goTo(index + 1);
    },
    [businessId, current, notes, busy, logged, index, goTo],
  );

  // 1-7 log an outcome, S skips, arrows move. Typing in the notes field is
  // exempt, or the first digit of a unit count would file the call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "ArrowLeft") { e.preventDefault(); goTo(Math.max(0, index - 1)); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); goTo(Math.min(ordered.length - 1, index + 1)); return; }
      if (e.key.toLowerCase() === "s") {
        if (current) setSkipped((s) => [...s, current.contactId]);
        goTo(index + 1);
        return;
      }
      const match = BY_KEY.find((o) => OUTCOME_STYLE[o].key === e.key);
      if (match) {
        e.preventDefault();
        void log(match);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [log, goTo, index, ordered.length, current]);

  const callsToday = today.calls + doneCount;
  const touchesToday = today.total + doneCount;

  if (!current) {
    return (
      <div className="empty">
        <h3>{doneCount > 0 ? `${doneCount} logged. That's the list.` : "Nobody left to call"}</h3>
        <p>
          {doneCount > 0
            ? "Everyone in this queue has an outcome against them."
            : "Everyone with a phone number here has been called already."}
        </p>
        <button onClick={() => void refreshQueue()}>Reload the queue</button>
      </div>
    );
  }

  return (
    <div className="station">
      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className={callsToday >= target.calls ? "stat good" : "stat"}>
          <span className="v">{callsToday}</span>
          <span className="l">Calls today of {target.calls}</span>
        </div>
        <div className="stat">
          <span className="v">{today.emails}</span>
          <span className="l">Emails today</span>
        </div>
        <div className={touchesToday >= target.total ? "stat good" : "stat"}>
          <span className="v">{touchesToday}</span>
          <span className="l">All touches of {target.total}</span>
        </div>
        <div className="stat">
          <span className="v">{ordered.length - doneCount}</span>
          <span className="l">Left to call</span>
        </div>
      </div>

      <div className="station-bar">
        <div className="track" aria-hidden>
          <div className="fill" style={{ width: `${Math.round((index / ordered.length) * 100)}%` }} />
        </div>
        <div className="station-meta">
          <button className="linkish" disabled={index === 0} onClick={() => goTo(index - 1)}>
            <span className="k">←</span> Back
          </button>
          <span><strong>{index + 1}</strong> of {ordered.length}</span>
          {doneCount > 0 && <span>{doneCount} logged just now</span>}
          {currentLog && (
            <button
              className="linkish"
              onClick={async () => {
                await undoCall(businessId, currentLog.messageId);
                setLogged((m) => {
                  const next = { ...m };
                  delete next[current.contactId];
                  return next;
                });
              }}
            >
              remove this call
            </button>
          )}
        </div>
      </div>

      <div className="station-card">
        <div className="station-head">
          <div>
            <h2>{current.company}</h2>
            <p className="station-sub">
              {current.industry ?? "industry not recorded"}
              {current.grade ? ` · grade ${current.grade}` : ""}
              {current.websiteUrl && (
                <>
                  {" · "}
                  <a href={current.websiteUrl} target="_blank" rel="noopener noreferrer">their site</a>
                </>
              )}
            </p>
          </div>
          <div className="station-warmth">
            {(() => {
              const w = warmthLabel(current);
              return w ? <span className={`tag ${w.tone}`}>{w.text}</span> : <span className="tag muted">not contacted</span>;
            })()}
          </div>
        </div>

        <div className="station-phone">
          <a href={`tel:${current.phone.replace(/\s/g, "")}`}>{current.phone}</a>
          <button
            className="ghost"
            onClick={() => void navigator.clipboard?.writeText(current.phone).catch(() => {})}
            title="Copy the number"
          >
            copy
          </button>
        </div>

        {/* Only ever a finding the audit could actually see. On a page that
            renders in the browser there is no observation, and the prompt to
            ask rather than assert is the honest fallback — a wrong opener gets
            corrected out loud, immediately, by the person you are calling. */}
        <div className={current.observation ? "station-say" : "station-say none"}>
          <span className="l">{current.observation ? "Checkable, safe to open with" : "Nothing verified about them"}</span>
          <p>
            {current.observation ??
              "Ask how bookings reach them today rather than leading with a claim about their site."}
          </p>
        </div>

        <input
          className="station-notes"
          placeholder="Notes — what they said, when to call back (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {currentLog && (
          <p className="station-logged">
            Logged as <strong>{OUTCOME_STYLE[currentLog.outcome].short}</strong>. Pick another to change it.
          </p>
        )}
        {error && <p className="station-error">{error}</p>}

        {/* Rendered in key order, not in the order the outcomes happen to be
            declared — otherwise the shortcuts read 1, 3, 2, 4 across the row
            and the numbers stop being usable at a glance. */}
        <div className="station-outcomes">
          {BY_KEY.map((o) => {
            const s = OUTCOME_STYLE[o];
            const on = currentLog?.outcome === o;
            return (
              <button
                key={o}
                disabled={busy}
                className={`outcome ${s.tone}${on ? " on" : ""}`}
                onClick={() => void log(o)}
                title={o}
              >
                <span className="k">{s.key}</span>
                {s.short}
              </button>
            );
          })}
        </div>

        <div className="station-foot">
          <button
            className="linkish"
            onClick={() => {
              setSkipped((s) => [...s, current.contactId]);
              goTo(index + 1);
            }}
          >
            skip for now <span className="k">S</span>
          </button>
          {sheetUrl && (
            <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className="linkish">
              log in the Google Sheet instead
            </a>
          )}
        </div>
      </div>

      {/* The rest of the queue. Not a preview of three — the whole list, so you
          can see what is coming, jump to somebody out of order when a callback
          is due, and check what you logged half an hour ago without leaving the
          page. */}
      <div className="queue">
        <div className="queue-head">
          <span className="l">The queue</span>
          <span className="c">{ordered.length - doneCount} to call · {doneCount} done</span>
        </div>
        <ol className="queue-list">
          {ordered.map((t, i) => {
            const lg = logged[t.contactId];
            const w = warmthLabel(t);
            return (
              <li key={t.contactId} className={i === index ? "on" : lg ? "done" : ""}>
                <button onClick={() => goTo(i)} className="queue-row">
                  <span className="n">{i + 1}</span>
                  <span className="co">{t.company}</span>
                  <span className="in">{t.industry ?? ""}</span>
                  <span className="ph">{t.phone}</span>
                  <span className="st">
                    {lg ? (
                      <span className={`tag ${OUTCOME_STYLE[lg.outcome].tone === "good" ? "good" : ""}`}>
                        {OUTCOME_STYLE[lg.outcome].short}
                      </span>
                    ) : w ? (
                      <span className={`tag ${w.tone}`}>{w.text}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
