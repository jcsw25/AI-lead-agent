import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { buildReport, recordView, type Report } from "@/lib/leadmagnet/report";

/**
 * The report a prospect opens.
 *
 * A route handler rather than a page, deliberately. This is the only thing in
 * the system a stranger ever sees, and every internal page inherits a layout
 * with the operator's sidebar in it — a prospect must never be shown the
 * machinery that emailed them. Returning a self-contained document also keeps
 * it fast on a phone on 4G, which is where it will actually be opened.
 *
 * It does not sell. There is one contact line at the bottom and no
 * call-to-action above it. A free report that turns out to be a pitch in
 * disguise costs more trust than the attention it buys, and the entire reason
 * this ask converts is that it is genuinely free.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function findingBlock(f: Report["findings"][number], kind: "bad" | "ok" | "unknown"): string {
  const mark = kind === "ok" ? "✓" : kind === "bad" ? "!" : "?";
  return `<div class="f ${kind}"><div class="mark">${mark}</div><div><h3>${esc(f.label)}</h3><p>${esc(f.detail)}</p></div></div>`;
}

function render(r: Report, sender: { name?: string | null; email?: string | null; phone?: string | null }): string {
  const high = r.findings.filter((f) => f.state === false && f.weight === "high");
  const other = r.findings.filter((f) => f.state === false && f.weight !== "high");
  const good = r.findings.filter((f) => f.state === true);
  const unknown = r.findings.filter((f) => f.state === null);

  const checked = r.checkedAt.toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" });
  const peer =
    r.peerMedian !== null
      ? ` For comparison, the median across ${r.peerCount} ${esc(r.industry ?? "similar")} companies we measured in Singapore is ${r.peerMedian}.`
      : "";

  // The score is only shown where it means something.
  //
  // On a client-rendered site the audit CREDITS what it could not see, so as
  // not to accuse anyone of a fault that may not exist. That is right for
  // scoring and wrong to publish: it produced a report telling a florist they
  // scored 100/100 and "everything a customer would notice is in place", on the
  // strength of four checks that were never actually performed. A free report
  // that flatters is worse than no report — it wastes the send and teaches the
  // reader the whole thing is decorative.
  const headline = !r.reliable
    ? `<strong>Partly checkable.</strong> ${good.length} of the things a customer notices could be confirmed from the outside; the rest could not, and are listed below rather than assumed.`
    : high.length === 0
      ? `<strong>Nothing urgent.</strong> Everything a customer would notice is in place.${peer}`
      : `<strong>${high.length === 1 ? "One thing" : `${high.length} things`} worth a look.</strong> The rest is fine.${peer}`;

  const scoreBlock = r.reliable
    ? `<div class="score"><span class="v">${r.score}</span><span class="l">out of 100</span></div>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Website check — ${esc(r.companyName)}</title>
<style>
:root{--bg:#F7F8FA;--card:#fff;--ink:#11161D;--mute:#5A6674;--line:#E1E6EC;--ok:#0E7C86;--bad:#B4531A;--unk:#7A8794}
@media(prefers-color-scheme:dark){:root{--bg:#0D1218;--card:#151C24;--ink:#E8ECF1;--mute:#8D99A6;--line:#26303A;--ok:#48B2BC;--bad:#D98A52;--unk:#7A8794}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:0 1.1rem 4rem}
.w{max-width:38rem;margin:0 auto}
header{padding:2.6rem 0 1.4rem}
.eyebrow{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin:0 0 .5rem}
h1{font-size:1.65rem;line-height:1.2;margin:0 0 .3rem;letter-spacing:-.01em}
.url a{color:var(--mute);font-size:.92rem;text-decoration:none}
.url a:hover{text-decoration:underline}
.sum{display:flex;gap:1.1rem;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.2rem;margin:1.2rem 0 1.6rem}
.score{text-align:center;flex:0 0 auto;min-width:4.4rem}
.score .v{display:block;font-size:2.1rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.score .l{display:block;font-size:.7rem;color:var(--mute);margin-top:.2rem}
.sum p{margin:0;font-size:.95rem}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--unk);border-radius:0 8px 8px 0;padding:.9rem 1.1rem;margin:0 0 1.6rem;font-size:.9rem;color:var(--mute)}
h2{font-size:.78rem;letter-spacing:.09em;text-transform:uppercase;color:var(--mute);margin:2rem 0 .7rem;font-weight:600}
.f{display:flex;gap:.85rem;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.95rem 1.1rem;margin-bottom:.6rem}
.f h3{margin:0 0 .25rem;font-size:1rem;font-weight:600}
.f p{margin:0;font-size:.93rem;color:var(--mute)}
.mark{flex:0 0 1.4rem;height:1.4rem;border-radius:50%;display:grid;place-items:center;font-size:.8rem;font-weight:700;color:#fff;margin-top:.15rem}
.f.ok .mark{background:var(--ok)} .f.bad .mark{background:var(--bad)} .f.unknown .mark{background:var(--unk)}
footer{margin-top:2.6rem;padding-top:1.3rem;border-top:1px solid var(--line);color:var(--mute);font-size:.87rem}
footer a{color:var(--ok)}
</style></head><body><div class="w">
<header>
  <p class="eyebrow">Website check · ${esc(checked)}</p>
  <h1>${esc(r.companyName)}</h1>
  ${r.websiteUrl ? `<p class="url"><a href="${esc(r.websiteUrl)}" rel="noopener noreferrer nofollow" target="_blank">${esc(r.websiteUrl.replace(/^https?:\/\//, ""))}</a></p>` : ""}
</header>

<div class="sum">
  ${scoreBlock}
  <p>${headline}</p>
</div>

${
  !r.reliable
    ? `<div class="note"><strong>One limitation, up front.</strong> Your site assembles itself in the browser rather than arriving complete, so an automated check cannot see everything a person would. Anything below marked <em>could not check</em> may well be there — this report will not claim otherwise.</div>`
    : ""
}

${high.length ? `<h2>Worth your attention</h2>${high.map((f) => findingBlock(f, "bad")).join("")}` : ""}
${other.length ? `<h2>Minor</h2>${other.map((f) => findingBlock(f, "bad")).join("")}` : ""}
${good.length ? `<h2>Already fine</h2>${good.map((f) => findingBlock(f, "ok")).join("")}` : ""}
${unknown.length ? `<h2>Could not check</h2>${unknown.map((f) => findingBlock(f, "unknown")).join("")}` : ""}

<footer>
  <p>Put together by ${esc(sender.name ?? "us")} from what is publicly visible on your site. Nothing was collected about you and you are not on any list — if it is useful, keep it.</p>
  ${
    sender.email
      ? `<p>Think something here is wrong, or want the detail behind a line? <a href="mailto:${esc(sender.email)}">${esc(sender.email)}</a>${sender.phone ? ` · ${esc(sender.phone)}` : ""}</p>`
      : ""
  }
</footer>
</div></body></html>`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const report = await buildReport(token);
  if (!report) {
    return new Response("<!doctype html><meta charset=utf-8><title>Not found</title><p>That report link is not valid.</p>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Counted before rendering, so an open still registers if rendering fails.
  // Wrapped because a failure to count must never cost the prospect the page.
  try {
    await recordView(token);
  } catch {
    /* the report matters more than the metric */
  }

  const business = await currentBusiness();
  const policy = business ? await db.sendPolicy.findUnique({ where: { businessId: business.id } }) : null;

  return new Response(
    render(report, {
      name: policy?.senderName,
      email: policy?.senderContactEmail,
      phone: policy?.senderContactPhone,
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Never cached at the edge: the view count is the point.
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}
