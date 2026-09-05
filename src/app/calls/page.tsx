import { currentBusiness } from "@/lib/business";
import { callQueue, touchesToday } from "@/lib/calls/queue";
import CallStation from "./CallStation";
import { syncCalls } from "./actions";

export const dynamic = "force-dynamic";

/** The daily target, split across channels rather than piled onto one. */
const TARGET = { EMAIL: 30, PHONE: 30, WHATSAPP: 40 } as const;

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const { industry } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [queue, today] = await Promise.all([
    // The whole queue, not a page of it: the station holds it in the browser
    // and advances locally, so re-fetching between calls would reorder the list
    // under whoever is working through it.
    callQueue(business.id, { industry, limit: 200 }),
    touchesToday(business.id),
  ]);

  const calls = today.byChannel.PHONE ?? 0;
  const targetTotal = Object.values(TARGET).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Outreach · warmest first</p>
        <h1>Calls</h1>
        <p className="sub">
          One at a time, warmest first. Somebody who opened their report, or was emailed on Tuesday, is a far
          better call than a stranger — you have something true to open with. Keys <strong>1&ndash;7</strong> log
          an outcome and move on, <strong>S</strong> skips to the back.
        </p>
      </div>

      <CallStation
        businessId={business.id}
        queue={queue}
        sheetUrl={business.sheetUrl}
        today={{ calls, emails: today.byChannel.EMAIL ?? 0, total: today.total }}
        target={{ calls: TARGET.PHONE, total: targetTotal }}
      />

      <div className="panel" style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <form action={syncCalls.bind(null, business.id)}>
            <button type="submit" className="ghost">Sync the Calls tab</button>
          </form>
          <span className="muted" style={{ fontSize: "0.82rem", flex: 1, minWidth: "16rem" }}>
            Log calls here or in the Sheet, whichever is to hand. Syncing reads the Sheet first and then writes
            back, so anything you typed wins — and a row you add yourself with a phone number becomes a real lead.
          </span>
        </div>
      </div>
    </>
  );
}
