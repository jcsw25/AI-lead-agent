import * as cheerio from "cheerio";
import { detectRenderMode, type RenderMode } from "./render-mode";
import { detectLeaks, type LeakResult } from "./leaks";

/**
 * What a company's website measurably is.
 *
 * Every field here is observed, not judged. That is a deliberate constraint,
 * for two reasons:
 *
 *   1. It costs nothing. No tokens, no extra request — the HTML is already in
 *      hand from the contact crawl.
 *   2. It survives contact with the reader. "Your quote page has no form" is
 *      something the recipient can check in five seconds and either fix or
 *      reply to. "Your site looks dated" is an opinion they can dismiss, and
 *      one we cannot defend if challenged.
 *
 * This is also the only signal reliably available for a Singapore SME. Funding
 * rounds and expansion announcements are enterprise phenomena; a twelve-person
 * aircon firm announces nothing. Its website, however, is always inspectable.
 */

export type SiteAuditResult = {
  reachable: boolean;
  httpsOk: boolean;
  mobileViewport: boolean;
  hasContactForm: boolean;
  hasEmailLink: boolean;
  hasPhoneLink: boolean;
  hasStructured: boolean;
  pageBytes: number | null;
  loadMs: number | null;
  titleLength: number | null;
  copyrightYear: number | null;
  socialCount: number;
  pagesFetched: number;
  jsRendered: boolean;
  renderMode: RenderMode;
  /** False when the page renders client-side: absences cannot be believed. */
  reliable: boolean;
  score: number;
  findings: string[];
  /**
   * Where a visitor who already wants to buy gets lost.
   *
   * Separate from `score` on purpose, and pointing the other way: `score` is
   * how good the site is, `leak.leakScore` is how much business it is losing.
   * A firm with no form and no traffic has a website problem nobody pays for;
   * a firm with real traffic and a booking form 80% down the page is losing
   * money every day, and that is the conversation worth having.
   */
  leak: LeakResult;
};

/** Weights sum to 100. Each one is a thing a buyer would actually notice. */
const WEIGHTS = {
  reachable: 15,
  httpsOk: 10,
  mobileViewport: 20,
  hasContactForm: 20,
  contactLink: 10,
  structured: 5,
  fresh: 10,
  weight: 5,
  social: 5,
} as const;

const CURRENT_YEAR = new Date().getFullYear();

export function auditHomepage(
  html: string,
  url: string,
  meta: { loadMs?: number; pagesFetched?: number; jsRendered?: boolean } = {},
): SiteAuditResult {
  const $ = cheerio.load(html);
  const findings: string[] = [];

  // Decided first, because it governs what the rest of this function is
  // allowed to conclude. On a client-rendered page a missing form means we
  // could not see one, not that there isn't one.
  const render = detectRenderMode(html, $("body").text());

  const httpsOk = url.startsWith("https://");

  const viewport = $('meta[name="viewport"]').attr("content") ?? "";
  const mobileViewport = /width\s*=\s*device-width/i.test(viewport);

  // A form is only a contact route if it takes text. A single search box or a
  // newsletter signup is not somewhere a buyer asks for a quote.
  const hasContactForm = $("form").toArray().some((f) => {
    const $f = $(f);
    const inputs = $f.find("input, textarea, select").toArray();
    if ($f.find("textarea").length) return true;
    const named = inputs
      .map((i) => `${$(i).attr("name") ?? ""} ${$(i).attr("type") ?? ""} ${$(i).attr("placeholder") ?? ""}`.toLowerCase())
      .join(" ");
    if (/search|newsletter|subscribe/.test(named) && inputs.length <= 2) return false;
    return inputs.length >= 3 || /email|message|enquir|inquir|name/.test(named);
  });

  const hasEmailLink = $('a[href^="mailto:"]').length > 0;
  const hasPhoneLink = $('a[href^="tel:"]').length > 0;

  const hasStructured =
    $('script[type="application/ld+json"]').length > 0 || $("[itemscope]").length > 0;

  const title = $("title").first().text().trim();
  const titleLength = title.length || null;

  // Most recent four-digit year anywhere in the footer area or a copyright line.
  const footerText = `${$("footer").text()} ${$("body").text().slice(-3000)}`;
  const years = [...footerText.matchAll(/(?:©|\(c\)|copyright)[^0-9]{0,20}(20\d{2})|(20\d{2})\s*(?:©|all rights)/gi)]
    .flatMap((m) => [m[1], m[2]])
    .filter(Boolean)
    .map(Number)
    .filter((y) => y >= 2000 && y <= CURRENT_YEAR + 1);
  const copyrightYear = years.length ? Math.max(...years) : null;

  const SOCIAL = /facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|x\.com|twitter\.com/i;
  const socialCount = new Set(
    $("a[href]")
      .toArray()
      .map((a) => $(a).attr("href") ?? "")
      .filter((h) => SOCIAL.test(h))
      .map((h) => (h.match(SOCIAL) ?? [""])[0].toLowerCase()),
  ).size;

  const pageBytes = html.length;

  let score = 0;
  score += WEIGHTS.reachable;

  if (httpsOk) score += WEIGHTS.httpsOk;
  else findings.push("no HTTPS — browsers mark the site as not secure");

  if (mobileViewport) score += WEIGHTS.mobileViewport;
  else findings.push("no mobile viewport tag — the site does not adapt to phones");

  if (hasContactForm) score += WEIGHTS.hasContactForm;
  else if (render.reliable) {
    findings.push("no enquiry form — a visitor ready to buy has to find another way to ask");
  } else {
    // Credit it rather than penalise it. Scoring a site down for something we
    // could not see punishes modern sites for being modern.
    score += WEIGHTS.hasContactForm;
  }

  if (hasEmailLink || hasPhoneLink) score += WEIGHTS.contactLink;
  else if (render.reliable) findings.push("no clickable email or phone link");
  else score += WEIGHTS.contactLink;

  if (hasStructured) score += WEIGHTS.structured;
  else if (render.reliable) {
    findings.push("no structured data — search engines cannot read the business details");
  } else {
    score += WEIGHTS.structured;
  }

  if (copyrightYear === null) {
    score += WEIGHTS.fresh / 2;
  } else if (copyrightYear >= CURRENT_YEAR - 1) {
    score += WEIGHTS.fresh;
  } else {
    findings.push(`copyright still reads ${copyrightYear} — the site has not been updated in ${CURRENT_YEAR - copyrightYear} years`);
  }

  // Over ~1.5MB of HTML alone is slow on mobile data, which is how most
  // Singapore buyers will open it.
  if (pageBytes < 1_500_000) score += WEIGHTS.weight;
  else findings.push(`homepage HTML is ${(pageBytes / 1_000_000).toFixed(1)}MB — slow on a phone`);

  if (socialCount > 0) score += WEIGHTS.social;
  else if (render.reliable) findings.push("no social profiles linked");
  else score += WEIGHTS.social;

  if (!render.reliable) {
    findings.push(
      `page renders in the browser (${render.mode}: ${render.signals[0] ?? "client-side"}) — ` +
        `what is missing from the HTML may still be on the site, so nothing above is asserted as absent`,
    );
  }

  return {
    reachable: true,
    leak: detectLeaks(html, render.reliable),
    httpsOk,
    mobileViewport,
    hasContactForm,
    hasEmailLink,
    hasPhoneLink,
    hasStructured,
    pageBytes,
    loadMs: meta.loadMs ?? null,
    titleLength,
    copyrightYear,
    socialCount,
    pagesFetched: meta.pagesFetched ?? 1,
    jsRendered: Boolean(meta.jsRendered) || !render.reliable,
    renderMode: render.mode,
    reliable: render.reliable,
    score: Math.round(Math.min(100, score)),
    findings,
  };
}

/** A site that could not be opened at all. Still a fact worth storing. */
export function unreachableAudit(reason: string): SiteAuditResult {
  return {
    reachable: false,
    leak: {
      signals: {
        missingH1: false, noAboveFoldCta: false, formDepthPct: null,
        distinctPrices: 0, priceExamples: [], hasPopup: false,
        carouselHeroNoHeadline: false, approxPageLength: 0,
      },
      leakScore: 0,
      findings: [],
    },
    httpsOk: false,
    mobileViewport: false,
    hasContactForm: false,
    hasEmailLink: false,
    hasPhoneLink: false,
    hasStructured: false,
    pageBytes: null,
    loadMs: null,
    titleLength: null,
    copyrightYear: null,
    socialCount: 0,
    pagesFetched: 0,
    jsRendered: false,
    renderMode: "static",
    reliable: false,
    score: 0,
    findings: [`site could not be opened: ${reason}`],
  };
}
