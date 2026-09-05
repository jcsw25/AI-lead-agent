"use client";

import { useState, useTransition } from "react";
import type { PitchTarget } from "@/lib/scoring/pitch-priority";
import { pinForCall, pinForEmail } from "./actions";

/**
 * One target, and the two things you can do about it.
 *
 * A client component only because pinning should feel instant. The action is a
 * single database write, but a server round trip plus a revalidate reorders the
 * whole list under the reader — and the row they just pinned would jump. So the
 * button flips locally and the write happens behind it.
 */
export default function LeakCard({ t }: { t: PitchTarget }) {
  const [call, setCall] = useState(t.pinnedForCall);
  const [email, setEmail] = useState(t.pinnedForEmail);
  const [busy, start] = useTransition();

  return (
    <article className={`lk${call || email ? " pinned" : ""}`}>
      <div className="lk-rail">
        <span className="lk-n">{t.priority}</span>
        <span className="lk-c">pitch</span>
        <span className="lk-bars">
          <span className="b" title={`reach ${t.reach}`}>
            <i style={{ width: `${t.reach}%` }} className="reach" />
          </span>
          <span className="b" title={`leak ${t.leak}`}>
            <i style={{ width: `${t.leak}%` }} className="leak" />
          </span>
        </span>
        <span className="lk-x">
          {t.reach} <em>&times;</em> {t.leak}
        </span>
      </div>

      <div className="lk-body">
        <header className="lk-h">
          <h2>{t.name}</h2>
          <p>
            {t.industry ?? "industry not recorded"} · Google <strong>#{t.serpBestPosition}</strong>, found on{" "}
            {t.serpAppearances} {t.serpAppearances === 1 ? "phrasing" : "phrasings"}
          </p>
        </header>

        {t.opener ? (
          <blockquote className="lk-open">&ldquo;{t.opener}&rdquo;</blockquote>
        ) : (
          <p className="lk-none">
            Nothing safe to open with — ask how bookings reach them instead.
          </p>
        )}

        <footer className="lk-f">
          <div className="lk-do">
            <button
              className={call ? "pin on" : "pin"}
              disabled={busy || !t.hasPhone}
              title={t.hasPhone ? "Move to the top of the call queue" : "No phone number for this company"}
              onClick={() => {
                setCall(!call);
                start(() => void pinForCall(t.companyId, !call));
              }}
            >
              {call ? "queued to call" : "call first"}
            </button>
            <button
              className={email ? "pin on" : "pin"}
              disabled={busy || !t.hasEmail}
              title={t.hasEmail ? "Move to the top of the email queue" : "No email address for this company"}
              onClick={() => {
                setEmail(!email);
                start(() => void pinForEmail(t.companyId, !email));
              }}
            >
              {email ? "queued to email" : "email first"}
            </button>
          </div>

          <div className="lk-meta">
            {t.domain && (
              <a href={`https://${t.domain}`} target="_blank" rel="noopener noreferrer">
                {t.domain}
              </a>
            )}
            {t.findings.length > 0 && (
              <details>
                <summary>
                  {t.findings.length} more signal{t.findings.length > 1 ? "s" : ""}
                </summary>
                <ul>
                  {t.findings.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </footer>
      </div>
    </article>
  );
}
