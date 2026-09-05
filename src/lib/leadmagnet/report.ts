import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

/**
 * The free site report.
 *
 * The audit engine has always scored every company on things a visitor can
 * check — HTTPS, a mobile viewport, whether there is any way to ask for a
 * quote, how old the copyright line is — and that was only ever used
 * internally, as a scoring input and as the opening line of a cold email.
 *
 * Given away instead, it changes the ask. "Will you give me twenty minutes on a
 * call" is the highest-friction thing you can put to a stranger; "would you
 * like a free one-page report, no call needed" is close to the lowest. The
 * report costs nothing per send because the audit already ran.
 *
 * Two rules it inherits from the audit, and they matter more here than
 * anywhere else in the system:
 *
 *   1. Absence is only ever claimed where the page was fully delivered. On a
 *      client-rendered site nothing is asserted missing — the report says so
 *      plainly rather than quietly dropping the section, because a report that
 *      hides its own limits is a sales document pretending to be a diagnostic.
 *
 *   2. Nothing is scored against an invented benchmark. Every comparison is to
 *      the other Singapore companies actually measured in the same trade.
 */

export type ReportFinding = {
  label: string;
  /** true = they have it, false = they do not, null = could not verify. */
  state: boolean | null;
  detail: string;
  /** Whether this is worth their attention, given what it actually costs them. */
  weight: "high" | "medium" | "low";
};

export type Report = {
  token: string;
  companyName: string;
  websiteUrl: string | null;
  industry: string | null;
  score: number;
  /** Where they sit against others measured in the same trade. */
  peerCount: number;
  peerMedian: number | null;
  reliable: boolean;
  renderMode: string;
  findings: ReportFinding[];
  checkedAt: Date;
};

/** URL-safe and unguessable. Public, but not enumerable. */
function newToken(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Create (or reuse) the shareable report for one company.
 *
 * Reused rather than regenerated so a link already sent keeps working and its
 * view count keeps accumulating against the same row.
 */
export async function reportLinkFor(
  businessId: string,
  companyId: string,
  messageId?: string,
): Promise<string> {
  const existing = await db.siteReport.findUnique({
    where: { businessId_companyId: { businessId, companyId } },
    select: { token: true },
  });
  if (existing) return existing.token;

  const row = await db.siteReport.create({
    data: { businessId, companyId, token: newToken(), messageId },
    select: { token: true },
  });
  return row.token;
}

/**
 * Build the report a visitor sees.
 *
 * Returns null when the company has no audit, rather than inventing an empty
 * one — a report with nothing measured in it is worse than no link at all.
 */
export async function buildReport(token: string): Promise<Report | null> {
  const row = await db.siteReport.findUnique({
    where: { token },
    include: {
      company: {
        select: {
          id: true, name: true, websiteUrl: true, industry: true, primaryDomain: true,
          siteAudit: true,
        },
      },
    },
  });
  if (!row?.company.siteAudit) return null;

  const a = row.company.siteAudit;
  const findings: ReportFinding[] = [];

  // Ordered by what it actually costs the business, not by what is easiest to
  // measure. A visitor who cannot ask for a quote is a lost job; a missing
  // structured-data block is a rounding error.
  const state = (has: boolean) => (has ? true : a.reliable ? false : null);

  findings.push({
    label: "A way to ask for a quote without phoning",
    state: state(a.hasContactForm),
    weight: "high",
    detail: a.hasContactForm
      ? "There is an enquiry form on the site, so somebody who has decided they want you can say so there and then."
      : a.reliable
        ? "There is no enquiry form. Anyone who lands here ready to book has to call — which works, until they are calling at 9pm or you are up a ladder."
        : "Could not be checked. The page is assembled in the browser, so a form may well exist that a crawler cannot see.",
  });

  findings.push({
    label: "A tappable phone number or email",
    state: state(a.hasEmailLink || a.hasPhoneLink),
    weight: "high",
    detail:
      a.hasEmailLink || a.hasPhoneLink
        ? "Your number or address is a link, so it dials or opens with one tap on a phone."
        : a.reliable
          ? "Your contact details are not links. On a phone that means copying a number by hand, which is where a fair number of people give up."
          : "Could not be checked on a page that renders in the browser.",
  });

  findings.push({
    label: "Works properly on a phone",
    state: a.mobileViewport,
    weight: a.mobileViewport ? "low" : "high",
    detail: a.mobileViewport
      ? "The site adapts to phone screens. Almost every Singapore company measured does this, so it is table stakes rather than an advantage."
      : "The site has no mobile viewport tag, so it renders at desktop width on a phone and has to be pinched to read. This is rare — only about 2% of the companies measured have this problem.",
  });

  findings.push({
    label: "Secure connection (HTTPS)",
    state: a.httpsOk,
    weight: a.httpsOk ? "low" : "high",
    detail: a.httpsOk
      ? "Served over HTTPS."
      : "Not served over HTTPS, so browsers show a 'Not secure' warning in the address bar next to your name.",
  });

  if (a.copyrightYear) {
    const age = new Date().getFullYear() - a.copyrightYear;
    findings.push({
      label: "Looks maintained",
      state: age <= 1,
      weight: age >= 4 ? "medium" : "low",
      detail:
        age <= 1
          ? `The copyright line reads ${a.copyrightYear}, so the site looks current.`
          : `The copyright line still reads ${a.copyrightYear}. It is a small thing, but it is one of the first things a cautious customer notices when deciding whether a company is still trading.`,
    });
  }

  findings.push({
    label: "Search engines can read your business details",
    state: state(a.hasStructured),
    weight: "medium",
    detail: a.hasStructured
      ? "Structured data is present, so search engines can read your address, hours and services directly."
      : a.reliable
        ? "No structured data. Search engines have to guess your address, hours and service area from the page text rather than being told."
        : "Could not be checked on a page that renders in the browser.",
  });

  // Compared against companies actually measured in the same trade, never
  // against a number invented for the comparison.
  const peers = row.company.industry
    ? await db.siteAudit.findMany({
        where: {
          reachable: true,
          company: { industry: { equals: row.company.industry, mode: "insensitive" } },
        },
        select: { score: true },
      })
    : [];
  const scores = peers.map((p) => p.score).sort((x, y) => x - y);
  const peerMedian = scores.length >= 5 ? scores[Math.floor(scores.length / 2)] : null;

  return {
    token,
    companyName: row.company.name,
    websiteUrl: row.company.websiteUrl,
    industry: row.company.industry,
    score: a.score,
    peerCount: scores.length,
    peerMedian,
    reliable: a.reliable,
    renderMode: a.renderMode,
    findings,
    checkedAt: a.checkedAt,
  };
}

/**
 * Record that somebody opened it.
 *
 * This is the point of the token. An opened report is the warmest signal
 * available before anyone speaks — warmer than a polite reply — and a second
 * open usually means it was forwarded to somebody else, which is warmer still.
 */
export async function recordView(token: string) {
  const now = new Date();
  await db.siteReport.updateMany({
    where: { token, firstViewedAt: null },
    data: { firstViewedAt: now },
  });
  await db.siteReport.updateMany({
    where: { token },
    data: { viewCount: { increment: 1 }, lastViewedAt: now },
  });
}
