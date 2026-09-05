import { db } from "@/lib/db";
import { emailWorthyLeak } from "@/scraper/leaks";
import { displayCompanyName } from "@/lib/entity";

/**
 * Who to pitch first: real traffic, poorly converted.
 *
 * The thesis in one line — a company with visitors it is losing has a problem
 * worth money, and one without visitors does not. The two halves multiply
 * rather than add, and that is the whole point:
 *
 *   traffic, no leaks   → their site works. Nothing to sell, and saying
 *                         otherwise is the invented-problem failure the
 *                         outreach gates exist to block.
 *   leaks, no traffic   → a real website problem that costs them nothing,
 *                         because nobody is arriving to be lost. A hard sell
 *                         and a poor use of a send.
 *   traffic AND leaks   → measurable money walking away every day. This is the
 *                         conversation.
 *
 * Both inputs are free. Search position comes from Serper, which returns it on
 * every result and which the discovery searches already pay for; leak signals
 * come from HTML already fetched for the contact crawl.
 *
 * What this is NOT is a traffic figure. Real numbers need Similarweb, which is
 * paid. Search position is a proxy, and it is worth being honest about its
 * limits: it says nothing about paid traffic, direct traffic, or a company that
 * gets all its work by word of mouth. It is evidence, not measurement.
 */

export type PitchTarget = {
  companyId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  /** 0-100, from search position and how many phrasings they appeared for. */
  reach: number;
  /** 0-100, how much of that traffic the site is losing. */
  leak: number;
  /** reach x leak, the ranking number. */
  priority: number;
  /**
   * The one line to open with, told from the customer's seat.
   *
   * The raw leak findings are written as facts about the website ("nothing that
   * asks for the booking near the top of the page"). That phrasing is banned
   * from emails now, so showing it here would mean the screen and the draft
   * disagree about what to say — and whoever read the screen first would go
   * into a call with the accusatory version in their head.
   */
  opener: string | null;
  /** The remaining signals, for detail. Not for sending. */
  findings: string[];
  serpBestPosition: number | null;
  serpAppearances: number;
  hasEmail: boolean;
  hasPhone: boolean;
  pinnedForCall: boolean;
  pinnedForEmail: boolean;
};

/**
 * Turn a search position into a 0-100 reach estimate.
 *
 * Click-through falls away steeply with position — roughly a third of clicks to
 * the first result, and very little past the first page. Appearing for several
 * of our phrasings raises it, because breadth of ranking is what separates a
 * company people find from one that happens to rank for a single long-tail
 * phrase.
 */
export function reachScore(position: number | null, appearances: number): number {
  if (!position) return 0;
  // Measured on aircon: of 151 companies, 11 rank in the top 10, 15 in 11-20,
  // 6 in 21-30, and 45 sit past position 30 — where organic clicks are close
  // to nil. The tail is scored low deliberately, so a deeper backfill adds
  // honest zeroes rather than inflating the list with companies nobody finds.
  const byPosition =
    position <= 3 ? 100
    : position <= 10 ? 70
    : position <= 20 ? 40
    : position <= 30 ? 20
    : position <= 50 ? 8
    : 3;
  // Each extra phrasing adds, with diminishing returns. Capped so breadth can
  // lift a mid-page company but never outrank a genuine top-three result.
  const breadth = Math.min(30, (Math.max(1, appearances) - 1) * 10);
  return Math.min(100, byPosition + breadth);
}

/**
 * Rank companies by how much business their website is losing.
 *
 * Contactable only: a target you cannot write to or call is not a pitch, it is
 * an observation.
 */
export async function pitchPriority(
  opts: { industry?: string; limit?: number; minReach?: number } = {},
): Promise<PitchTarget[]> {
  const rows = await db.company.findMany({
    where: {
      ...(opts.industry
        ? { industry: { contains: opts.industry, mode: "insensitive" } }
        : {}),
      siteAudit: { reachable: true },
      contacts: { some: { OR: [{ email: { not: null } }, { phone: { not: null } }] } },
    },
    select: {
      id: true, name: true, primaryDomain: true, industry: true,
      serpBestPosition: true, serpAppearances: true,
      pinnedForCallAt: true, pinnedForEmailAt: true,
      contacts: { select: { email: true, phone: true } },
      siteAudit: {
        select: {
          leakScore: true, leakFindings: true, reliable: true,
          hasContactForm: true, findings: true,
          missingH1: true, noAboveFoldCta: true, formDepthPct: true,
          distinctPrices: true, hasPopup: true,
        },
      },
    },
    take: 800,
  });

  const out: PitchTarget[] = [];
  for (const c of rows) {
    const a = c.siteAudit!;
    const reach = reachScore(c.serpBestPosition, c.serpAppearances);
    const leak = a.leakScore;

    // Multiplied, not added. A company with no measurable reach scores zero
    // however broken its site is — because the pitch is "you are losing the
    // visitors you have", and without visitors that sentence is false.
    const priority = Math.round((reach / 100) * leak);

    if (opts.minReach && reach < opts.minReach) continue;

    out.push({
      companyId: c.id,
      // "Get in Touch" and "The Vital Role of Elevator Maintenance" both reached
      // this list as company names — scraped page headings that the ingest guard
      // does not catch because neither is made purely of heading words.
      name: displayCompanyName(c.name, c.primaryDomain, c.industry ?? undefined) ?? c.name,
      domain: c.primaryDomain,
      industry: c.industry,
      reach,
      leak,
      priority,
      opener: emailWorthyLeak(
        {
          missingH1: a.missingH1, noAboveFoldCta: a.noAboveFoldCta,
          formDepthPct: a.formDepthPct, distinctPrices: a.distinctPrices,
          priceExamples: [], hasPopup: a.hasPopup,
          carouselHeroNoHeadline: false, approxPageLength: 0,
        },
        a.reliable,
      ),
      // The opener is rendered separately, so excluding its source signal here
      // stops the card saying "the enquiry form sits about 83% of the way down"
      // twice — once as the quote and again in the detail list.
      findings: ((a.leakFindings as string[] | null) ?? [])
        .filter((f) => !(a.formDepthPct && f.includes(`${a.formDepthPct}%`)))
        .filter((f) => !(a.distinctPrices >= 5 && f.startsWith(`${a.distinctPrices} different prices`)))
        .slice(0, 3),
      serpBestPosition: c.serpBestPosition,
      serpAppearances: c.serpAppearances,
      hasEmail: c.contacts.some((x) => x.email),
      hasPhone: c.contacts.some((x) => x.phone),
      pinnedForCall: Boolean(c.pinnedForCallAt),
      pinnedForEmail: Boolean(c.pinnedForEmailAt),
    });
  }

  return out
    .sort((a, b) => b.priority - a.priority || b.reach - a.reach)
    .slice(0, opts.limit ?? 50);
}
