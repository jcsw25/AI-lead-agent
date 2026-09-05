"use client";

import { useMemo, useState } from "react";
import { approveAndSend, discardDraft, regenerate, saveDraft } from "./actions";

/**
 * Quick Email — read one, send one.
 *
 * The page this replaces rendered every draft as a fully expanded panel with an
 * open subject field and a twelve-row textarea. At four drafts that was merely
 * heavy. At sixty-four it is unusable: you scroll past a wall of identical
 * editors looking for the one you were reading, and there is no way to see how
 * many are left or which ones a tone check flagged.
 *
 * So it is a list you scan and one draft you read. The list carries the company,
 * the subject, the length and whether the tone gate flagged anything; clicking
 * a row opens that draft beside it. Nothing is hidden — the editor is the same
 * editable subject and body it always was — but only one is open at a time,
 * which is also how many a person can actually read.
 *
 * Approval still sends immediately and one at a time. There is deliberately no
 * "approve all": a queue whose whole purpose is that a human reads each message
 * before it reaches a stranger does not get a bulk button.
 */

export type Draft = {
  id: string;
  subject: string;
  body: string;
  company: string;
  email: string | null;
  industry: string | null;
  websiteUrl: string | null;
  words: number;
  status: string;
  blockedReason: string | null;
  /** Tone-gate rules this draft still breaks, checked on the server. */
  violations: string[];
  pitching: string | null;
  /** Worked to the front from the Leaks list. */
  pinned: boolean;
};

export default function QuickEmail({
  businessId,
  drafts,
  isMock,
}: {
  businessId: string;
  drafts: Draft[];
  isMock: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(drafts[0]?.id ?? null);
  const [filter, setFilter] = useState<"all" | "clean" | "flagged">("all");

  const shown = useMemo(
    () =>
      drafts.filter((d) =>
        filter === "clean" ? d.violations.length === 0 : filter === "flagged" ? d.violations.length > 0 : true,
      ),
    [drafts, filter],
  );

  const open = drafts.find((d) => d.id === openId) ?? shown[0] ?? null;
  const cleanCount = drafts.filter((d) => d.violations.length === 0).length;

  if (!drafts.length) {
    return (
      <div className="empty">
        <h3>Nothing waiting</h3>
        <p>No drafts to review. Generate some from the Generator or the batch drafter.</p>
      </div>
    );
  }

  return (
    <div className="qe">
      <div className="qe-filters">
        {([
          { k: "all", label: `all ${drafts.length}` },
          { k: "clean", label: `clean ${cleanCount}` },
          { k: "flagged", label: `flagged ${drafts.length - cleanCount}` },
        ] as const).map((f) => (
          <button
            key={f.k}
            className={filter === f.k ? "chip on" : "chip"}
            onClick={() => setFilter(f.k)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="qe-split">
        <ol className="qe-list">
          {shown.map((d) => (
            <li key={d.id} className={d.id === open?.id ? "on" : ""}>
              <button onClick={() => setOpenId(d.id)}>
                <span className="co">{d.company}</span>
                <span className="su">{d.subject}</span>
                <span className="me">
                  {d.pinned && <span className="tag good">first</span>}
                  {d.violations.length > 0 && (
                    <span className="tag warn">{d.violations.length}</span>
                  )}
                  <span className="w">{d.words}w</span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="qe-none">Nothing matches that filter.</li>}
        </ol>

        {open && (
          <div className="qe-read">
            <div className="qe-head">
              <div>
                <h2>{open.company}</h2>
                <p className="qe-to">
                  {open.email ?? "no address"}
                  {open.industry ? ` · ${open.industry}` : ""}
                  {open.websiteUrl && (
                    <>
                      {" · "}
                      <a href={open.websiteUrl} target="_blank" rel="noopener noreferrer">their site</a>
                    </>
                  )}
                </p>
              </div>
              {open.pitching && <span className="tag">{open.pitching}</span>}
            </div>

            {open.blockedReason && (
              <p className="qe-blocked"><strong>Blocked by the gate:</strong> {open.blockedReason}</p>
            )}

            {/* The tone failures, named. The old page ran the same checks and
                showed none of them, so a flagged draft looked identical to a
                clean one and got approved just as readily. */}
            {open.violations.length > 0 && (
              <div className="qe-flags">
                <span className="fl">This draft breaks {open.violations.length === 1 ? "a rule" : `${open.violations.length} rules`}</span>
                <ul>{open.violations.map((v) => <li key={v}>{v}</li>)}</ul>
              </div>
            )}

            <form action={saveDraft.bind(null, businessId)} className="qe-form">
              <input type="hidden" name="id" value={open.id} />
              <label>
                <span>Subject</span>
                <input name="subject" defaultValue={open.subject} key={`s-${open.id}`} />
              </label>
              <label>
                <span>Body</span>
                <textarea name="bodyText" defaultValue={open.body} rows={14} key={`b-${open.id}`} />
              </label>
              <button type="submit" className="ghost">Save edits</button>
            </form>

            <div className="qe-actions">
              <form action={approveAndSend.bind(null, businessId)}>
                <input type="hidden" name="id" value={open.id} />
                <button type="submit">{isMock ? "Approve (mock send)" : "Approve and send"}</button>
              </form>
              <form action={regenerate.bind(null, businessId)}>
                <input type="hidden" name="id" value={open.id} />
                <button type="submit" className="ghost">Rewrite</button>
              </form>
              <form action={discardDraft.bind(null, businessId)}>
                <input type="hidden" name="id" value={open.id} />
                <button type="submit" className="ghost">Discard</button>
              </form>
              <span className="qe-note">
                Approving sends immediately, through the compliance gate. There is no bulk approve on purpose.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
