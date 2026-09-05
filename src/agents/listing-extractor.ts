import { z } from "zod/v4";
import { type AgentDef } from "./runtime";

/**
 * LISTING EXTRACTOR
 *
 * Reads one "business for sale" advertisement and pulls out the facts.
 *
 * A model is used because these pages agree on nothing. Asking price appears as
 * "S$450,000", "450K SGD", "Ask: 450,000" or inside a sentence; revenue is
 * "turnover", "sales" or "annual revenue"; EBITDA is "net profit", "cash flow",
 * "owner's earnings" or "SDE", which are not the same thing and are used as
 * though they were. Regular expressions were considered and would need a new
 * case per marketplace, silently returning nothing for the rest.
 *
 * Two rules, both enforced in code afterwards rather than trusted here:
 *
 *   1. A number that is not on the page is null. Never inferred from a
 *      multiple, never annualised from a monthly figure, never estimated from
 *      the industry. These numbers decide what gets offered for a company.
 *
 *   2. The multiple is arithmetic on two extracted numbers, computed outside
 *      this agent. A model is not asked to divide, because a model that is
 *      asked to divide will sometimes produce a plausible answer instead of a
 *      correct one, and the plausible answer is indistinguishable at a glance.
 */

const Input = z.object({
  url: z.string(),
  source: z.string(),
  pageText: z.string(),
});

const Output = z.object({
  /**
   * Is this actually one business for sale? Category pages, broker home pages
   * and articles about buying businesses all reach this agent and must not
   * become targets.
   */
  isSingleListing: z.boolean(),

  /**
   * The business name, or a descriptive title where the listing is anonymised.
   * Most brokered listings are — "Established Aircon Servicing Company, East
   * Singapore" is the honest title, and inventing a company name for it would
   * put a fabricated business in the pipeline.
   */
  name: z.string(),
  /** True where the seller is not named. Common and expected, not a problem. */
  isAnonymised: z.boolean(),
  industry: z.string().nullable(),
  /** Singapore only. A listing elsewhere is dropped by the caller. */
  country: z.string().nullable(),

  /** Figures. Every one of these is null unless it is stated on the page. */
  askingPrice: z.number().nullable(),
  revenue: z.number().nullable(),
  /**
   * Operating profit as the listing states it. Where it says "net profit",
   * "cash flow" or "SDE" instead, take the number and say which term was used
   * in profitTerm — they are not equivalent and the difference is the deal.
   */
  ebitda: z.number().nullable(),
  profitTerm: z.string().nullable(),
  currency: z.string().nullable(),

  employeeCount: z.number().nullable(),
  yearsEstablished: z.number().nullable(),
  /** Why they say they are selling, in their words. Null if unstated. */
  sellerReason: z.string().nullable(),
  /** Two or three sentences a buyer would want before opening the page. */
  summary: z.string(),
  /** Whether the page gives a way to reach the seller or broker directly. */
  hasDirectContact: z.boolean(),
  reasoning: z.string(),
});

const SYSTEM = `You read one "business for sale" web page and extract the facts on it.

The numbers you return decide what somebody offers for a real company. A figure that is not
on the page is null. That is always the correct answer when the page does not say.

RULES

1. NEVER infer, estimate, annualise or convert. If the page gives a monthly revenue, that is
   not annual revenue — return null for revenue and say so in reasoning. If it gives a
   multiple but no price, the price is null. If it gives a range, take the lower number.

2. Amounts are plain numbers in the listing's own currency: "S$450,000" is 450000, "1.2M" is
   1200000, "450K" is 450000. Put the currency code in the currency field.

3. Profit terms are not interchangeable. EBITDA, net profit, cash flow and SDE (seller's
   discretionary earnings) mean different things, and SDE in particular includes the owner's
   salary — a business at "SDE 300k" is not a business at "EBITDA 300k". Put the number in
   ebitda and the exact term the page used in profitTerm, so the difference stays visible.

4. isSingleListing is FALSE for a category page, a search results page, a broker's home page,
   an article about buying a business, or any page describing more than one business. These
   pages outrank real listings and reach you often. A page listing eight businesses is FALSE
   however detailed each entry is.

5. Most listings are anonymised — "Established Aircon Servicing Company, East Singapore". That
   is the correct name to return, with isAnonymised true. NEVER invent a company name, and
   never take the marketplace's or broker's own name as the business name.

6. country is where the business OPERATES, not where the marketplace is registered. Say
   Singapore only if the page says so.

7. sellerReason only if stated. "Owner retiring", "relocating", "pursuing other interests".
   Do not guess from anything else on the page.

If the page is truncated, paywalled, or a login screen, isSingleListing is false and reasoning
says which.`;

export const listingExtractor: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "COMPANY_RESEARCH",
  // Haiku: reading one page and copying numbers off it. The judgement that
  // matters — is this one listing, is that figure really stated — is stated as
  // rules rather than requiring inference.
  model: "claude-haiku-4-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `Source: ${i.source}\nURL: ${i.url}\n\nPAGE TEXT:\n---\n${i.pageText.slice(0, 12000)}\n---`,
  mock: () => ({
    isSingleListing: false,
    name: "",
    isAnonymised: true,
    industry: null,
    country: null,
    askingPrice: null,
    revenue: null,
    ebitda: null,
    profitTerm: null,
    currency: null,
    employeeCount: null,
    yearsEstablished: null,
    sellerReason: null,
    summary: "",
    hasDirectContact: false,
    reasoning: "No ANTHROPIC_API_KEY, so the listing was not read.",
  }),
};

/**
 * Asking price over EBITDA, as arithmetic.
 *
 * Kept out of the agent deliberately: the multiple is the number a buyer
 * decides on, and a model asked to divide will occasionally return something
 * plausible rather than something correct. Two stored numbers and one division
 * can be checked by anybody.
 *
 * It returns null unless the listing's profit figure actually IS EBITDA, and
 * that restriction came from the data. Computing it across whatever term each
 * listing happened to use produced a spread from 0.6x to 50x, and the outliers
 * were not businesses priced absurdly — they were unit mismatches:
 *
 *   Little Sprout Preschool   520,000 asking / 20,000 "Monthly profit"  = 26x
 *
 * The real annual multiple there is about 2.2. A note recording that the term
 * was "Monthly profit" is not enough of a guard, because the number still gets
 * read, sorted and compared against genuine EBITDA multiples sitting next to
 * it. Where the terms differ the honest output is no multiple at all.
 */
export function askingMultiple(
  price: number | null,
  profit: number | null,
  profitTerm: string | null,
): number | null {
  if (!price || !profit || profit <= 0) return null;
  // No stated term means we do not know what the figure is. Silence beats a
  // number whose meaning is unknown.
  if (!profitTerm || !/\bebitda\b/i.test(profitTerm)) return null;
  // Even within EBITDA, a figure this far out is a typo or a mismatch rather
  // than a real price.
  const m = price / profit;
  if (m > 30 || m < 0.1) return null;
  return Math.round(m * 10) / 10;
}

/**
 * Is this a property to rent rather than a business to buy?
 *
 * Business-for-sale marketplaces carry shop leases alongside businesses, and
 * they read almost identically to an extractor. One reached the database as a
 * company with an asking price of SGD 100 — which was a rent figure, not a
 * price for anything.
 */
export function isPropertyNotBusiness(name: string): boolean {
  const t = name.toLowerCase();
  // The title only, and only as a complete phrase offering the premises.
  //
  // A first attempt scanned the summary too and matched the bare word
  // "rental" — which dropped "Woodlands Car Rental Operation With Booking App
  // And Fleet", a car rental company, and a book binder whose listing happened
  // to mention its lease. Renting things out is a business; being rented out is
  // not. The distinction lives in the phrase, so the phrase is what is matched.
  if (!/\bfor rent\b|\bto let\b|\bfor lease\b|\blease assignment\b/.test(t)) return false;
  // "Restaurant for sale, premises for rent" is still a business being sold.
  return !/\bfor sale\b|\btakeover\b|\bgoing concern\b/.test(t);
}
