import * as cheerio from "cheerio";

/**
 * Where a website loses a visitor who already wants to buy.
 *
 * The existing audit answers "can they be contacted at all" — is there a form,
 * a tel: link, a mobile viewport. That is a floor. This asks the next question:
 * the visitor arrived, they are interested, and something on the page loses
 * them anyway.
 *
 * The distinction matters commercially. A firm with no enquiry form and no
 * traffic has a website problem nobody is paying for. A firm with real traffic
 * and a booking form seventeen thousand pixels down the page is losing money
 * every day, measurably, and that is a conversation worth having.
 *
 * Every signal here is computed from HTML already fetched for the contact
 * extraction — no extra request, no tokens. And every one inherits the audit's
 * central rule: on a page assembled in the browser, absence proves nothing, so
 * a client-rendered site scores no leaks rather than a perfect score.
 */

export type LeakSignals = {
  /** No <h1>. A page with no headline gives a visitor nothing to orient on. */
  missingH1: boolean;
  /** Nothing that reads as a call to action near the top of the document. */
  noAboveFoldCta: boolean;
  /**
   * How far down the document the first real enquiry form sits, as a
   * percentage. A form at 80% is one almost nobody scrolls to.
   */
  formDepthPct: number | null;
  /**
   * Distinct money figures on the page. Four different prices for the same
   * service is the commonest trust-killer in this trade — a visitor who cannot
   * work out what something costs assumes the worst and leaves.
   */
  distinctPrices: number;
  priceExamples: string[];
  /** A modal, pop-up or overlay that fires on load. */
  hasPopup: boolean;
  /** A slider or carousel occupying the hero with no headline beside it. */
  carouselHeroNoHeadline: boolean;
  /** Rough document length. A 22,000px page buries everything below it. */
  approxPageLength: number;
};

export type LeakResult = {
  signals: LeakSignals;
  /** 0-100. Higher means more visitors are being lost, not a better site. */
  leakScore: number;
  /** Plain sentences, each one checkable by the recipient. */
  findings: string[];
};

/** Words that mark a link or button as the thing you want them to press. */
const CTA_WORDS =
  /\b(book|booking|get a quote|request a quote|free quote|enquire|enquiry|contact us|call now|whatsapp|schedule|make an appointment|order now|buy now|get started)\b/i;

/** Markers of a modal that appears without being asked for. */
const POPUP_MARKERS =
  /(popup|pop-up|modal-overlay|lightbox|exit-intent|spin-to-win|wheelio|privy|optinmonster|sumo-|mailchimp-popup|klaviyo-form)/i;

/** Slider libraries, which on an SME site almost always occupy the hero. */
const CAROUSEL_MARKERS = /(swiper|slick-slider|owl-carousel|flickity|splide|glide__|carousel-inner|elementor-slides)/i;

/** SGD amounts. Deliberately narrow — a phone number is not a price. */
const PRICE = /(?:S?\$|SGD\s?)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\b/g;

export function detectLeaks(html: string, reliable: boolean): LeakResult {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const bodyText = $("body").text().replace(/\s+/g, " ");
  const approxPageLength = bodyText.length;

  // The first slice of the document is a reasonable stand-in for what a visitor
  // sees before scrolling. Not exact — that needs a browser and a viewport —
  // but a page whose first 3,000 characters contain no call to action is not
  // one where the button is above the fold.
  const head = bodyText.slice(0, 3000).toLowerCase();
  const topLinks = $("a, button")
    .slice(0, 40)
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim())
    .join(" | ");

  const missingH1 = $("h1").length === 0;
  const noAboveFoldCta = !CTA_WORDS.test(topLinks) && !CTA_WORDS.test(head);

  // Where the first form that takes a message sits, as a fraction of the page.
  let formDepthPct: number | null = null;
  const formEl = $("form").filter((_, f) => {
    const inputs = $(f).find("input, textarea, select");
    return $(f).find("textarea").length > 0 || inputs.length >= 3;
  }).first();
  if (formEl.length) {
    const idx = html.indexOf($.html(formEl).slice(0, 120));
    if (idx > 0) formDepthPct = Math.round((idx / html.length) * 100);
  }

  const prices = [...bodyText.matchAll(PRICE)].map((m) => m[1]);
  const distinct = [...new Set(prices)];

  const hasPopup = POPUP_MARKERS.test(html);
  const heroHasCarousel = CAROUSEL_MARKERS.test(html.slice(0, Math.min(html.length, 40_000)));
  const carouselHeroNoHeadline = heroHasCarousel && missingH1;

  const signals: LeakSignals = {
    missingH1,
    noAboveFoldCta,
    formDepthPct,
    distinctPrices: distinct.length,
    priceExamples: distinct.slice(0, 6),
    hasPopup,
    carouselHeroNoHeadline,
    approxPageLength,
  };

  // On a client-rendered page none of the absences mean anything — the headline
  // and the button may both be there, assembled after the HTML arrived. Same
  // rule as the audit: no assertion without delivery.
  if (!reliable) {
    return { signals, leakScore: 0, findings: [] };
  }

  const findings: string[] = [];
  let score = 0;

  if (noAboveFoldCta) {
    score += 30;
    findings.push(
      "nothing that asks for the booking near the top of the page — a visitor who has already decided has to go looking",
    );
  }
  if (missingH1) {
    score += 10;
    findings.push("no headline on the page, so there is nothing telling a visitor what they have landed on");
  }
  if (carouselHeroNoHeadline) {
    score += 10;
    findings.push("the top of the page is a rotating image slider with no headline beside it");
  }
  if (formDepthPct !== null && formDepthPct >= 60) {
    score += 25;
    findings.push(`the enquiry form sits about ${formDepthPct}% of the way down the page`);
  }
  // Two prices is a range. Five is a page that cannot answer "what does it
  // cost", and a visitor who cannot work that out assumes the worst.
  if (distinct.length >= 5) {
    score += 20;
    findings.push(
      `${distinct.length} different prices appear on the one page (${distinct.slice(0, 4).map((p) => `$${p}`).join(", ")}…)`,
    );
  }
  if (hasPopup) {
    score += 10;
    findings.push("a pop-up or overlay loads over the page");
  }
  if (approxPageLength > 25_000) {
    score += 5;
    findings.push("the homepage is very long, which pushes everything below the first screen out of reach");
  }

  return { signals, leakScore: Math.min(100, score), findings };
}

/**
 * The one leak worth mentioning to the owner, phrased as their customer's
 * experience rather than as a fault in their website.
 *
 * Two separate jobs, and both matter.
 *
 * First, not every signal belongs in an email. A missing <h1> and a long
 * document are real and mean nothing to somebody who runs an aircon firm — put
 * either in front of them and you sound like a web developer touting for work.
 * A pop-up is true and petty. Those are dropped.
 *
 * Second, and more important: the same fact can be an accusation or an
 * observation depending on whose side it is told from. "Twelve different prices
 * appear on your page" says the owner is confusing. "I couldn't work out which
 * price applied to me" says a customer got lost — which is the actual problem,
 * is impossible to argue with, and is the version that gets answered rather
 * than resented.
 */
export function emailWorthyLeak(signals: LeakSignals, reliable: boolean): string | null {
  if (!reliable) return null;

  // Ordered by how SPECIFIC the line is, not by how severe the signal is.
  //
  // Severity order was tried and produced a page where every single card read
  // "I couldn't see anywhere to book or ask for a quote without scrolling" —
  // because a missing call to action is the commonest failure, it won every
  // time. One sentence repeated across forty companies is the template tell all
  // over again, and it would have gone into forty emails.
  //
  // The two signals carrying a real number differ company by company, so they
  // go first. The generic one is the fallback it should always have been.
  if (signals.distinctPrices >= 5) {
    return `there are ${signals.distinctPrices} different prices on the page and I couldn't work out which one applied to me`;
  }
  if (signals.formDepthPct !== null && signals.formDepthPct >= 60) {
    return `the enquiry form is about ${signals.formDepthPct}% of the way down the page — someone who has already decided has to scroll past everything to reach it`;
  }
  if (signals.noAboveFoldCta) {
    return "I couldn't see anywhere to book or ask for a quote without scrolling down the page";
  }
  // Deliberately nothing for missingH1, hasPopup or page length. All true, none
  // of them a sentence an owner would thank you for.
  return null;
}
