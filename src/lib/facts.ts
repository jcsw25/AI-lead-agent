import { db } from "@/lib/db";

/**
 * The sourced facts an email is allowed to reference.
 *
 * This exists because of a defect that hid for the entire project. The writer
 * reads `company.signals` for its verified facts, and BuyingSignal has never had
 * a row written to it — nothing produces buying signals. So `verifiedFacts` was
 * empty for every email ever drafted, and the prompt's rule ("every factual
 * claim must come from verifiedFacts") meant the model correctly refused to say
 * anything specific about anybody.
 *
 * Worse, it was being handed a good fact and told it could not use it. The
 * company's own description from its own website arrives as `companyContext` in
 * the same prompt, and 837 of 1,193 companies have one. The model was reading
 * "T32 Dental Group manages 8 dental clinics across Singapore", and then a rule
 * saying it may only reference an empty list.
 *
 * The Claim table was the other candidate and is the wrong source: its 2,652
 * rows are contact provenance — phone, email, address — recorded so the gate can
 * prove where an address came from. "I see your email is service@example.com" is
 * not a sentence anybody should send.
 *
 * So facts come from what the company published about itself, each carrying
 * where it was found, which is what ADR-003 asked for in the first place.
 */

export type VerifiedFact = string;

/** Text that means a scraper captured a block of page furniture, not a value. */
const SCRAPED_BLOCK = /\b(company details|legal name|registered address|uen no|business profile|about us)\b/i;

/**
 * A registered name fit to put in front of the company it belongs to, or null.
 *
 * Handles the two failures actually present in the data: the display name
 * duplicated onto the front of the legal name, and a trailing fragment of the
 * previous sentence stuck to the start.
 */
export function cleanLegalName(legal: string | null, displayName: string): string | null {
  if (!legal) return null;
  let s = legal.replace(/\s+/g, " ").trim();
  if (SCRAPED_BLOCK.test(s)) return null;

  // "GreenCool GreenCool Air-Condition Pte Ltd" -> the first word repeated,
  // which happens when the extractor picks up a heading and the name after it.
  // Checked against the value itself, not the display name: the stored display
  // name here is "Aircon Servicing Singapore", so comparing the two misses it.
  const words = s.split(/\s+/);
  if (words.length > 2 && words[0].toLowerCase() === words[1].toLowerCase()) {
    s = words.slice(1).join(" ");
  }

  const first = displayName.split(/\s+/)[0];
  if (first && s.toLowerCase().startsWith(`${first.toLowerCase()} ${first.toLowerCase()}`)) {
    s = s.slice(first.length).trim();
  } else if (first && s.toLowerCase().startsWith(first.toLowerCase()) && s.length > displayName.length) {
    const rest = s.slice(first.length).trim();
    if (rest.toLowerCase().startsWith(first.toLowerCase())) s = rest;
  }

  // "Centre. AIRCOND SERVICE CENTRE PTE. LTD" -> the sentence fragment before
  // the full stop is the tail of whatever preceded it on the page.
  const m = s.match(/^[A-Za-z]{2,12}\.\s+(.{6,})$/);
  if (m && /\b(pte|ltd|llp|inc|limited)\b/i.test(m[1])) s = m[1].trim();

  if (s.length < 4 || s.length > 90) return null;
  if (s.toLowerCase() === displayName.toLowerCase()) return null;
  return s;
}

/** An address short and clean enough to be one, or null. */
export function cleanAddress(address: string | null): string | null {
  if (!address) return null;
  const s = address.replace(/\s+/g, " ").trim();
  if (SCRAPED_BLOCK.test(s)) return null;
  // A real Singapore address fits comfortably; anything longer is a paragraph.
  if (s.length < 8 || s.length > 110) return null;
  // Must look like an address rather than prose: a postcode or a unit number.
  if (!/\b\d{6}\b|#\d{2}-\d{2,4}|\bblk\b|\bblock\b|\broad\b|\bstreet\b|\bave\b|\bdrive\b/i.test(s)) return null;
  return s;
}

/**
 * Facts about one company, safe to reference in outbound copy.
 *
 * Ordered by how useful they are in a first sentence. Everything here came off
 * the company's own site or its own registration — nothing is inferred, and
 * nothing is included that we could not point at if challenged.
 */
export async function verifiedFactsFor(companyId: string): Promise<VerifiedFact[]> {
  const c = await db.company.findUnique({
    where: { id: companyId },
    select: {
      name: true, legalName: true, description: true, websiteUrl: true,
      addressLine: true, city: true, industry: true,
      identifiers: { select: { scheme: true, value: true } },
      siteAudit: { select: { copyrightYear: true, socialCount: true, reliable: true } },
    },
  });
  if (!c) return [];

  const out: VerifiedFact[] = [];
  const where = c.websiteUrl ? ` (${c.websiteUrl})` : "";

  // The strongest fact available: how they describe themselves. It is specific,
  // it is checkable, and quoting it back shows you read the site rather than a
  // list. Trimmed because the writer only needs one clause of it.
  if (c.description && c.description.trim().length > 40) {
    out.push(
      `In their own words on their website${where}: "${c.description.replace(/\s+/g, " ").trim().slice(0, 240)}"`,
    );
  }

  // A registered name and UEN say this is a real, findable company. Both are
  // gated on looking clean, because the extractors that produced them do not
  // always. Real stored values include:
  //
  //   legalName   "GreenCool GreenCool Air-Condition Pte Ltd"   (name doubled)
  //   legalName   "Centre. AIRCOND SERVICE CENTRE PTE. LTD"     (leading fragment)
  //   address     "e Company details Legal name GreenCool ... Registered address Blk 3025 …"
  //
  // A dirty value in a database row is a data problem; the same value inside an
  // email is the recipient concluding nobody read it. Dropped here rather than
  // repaired, because a guess at what was meant is how "Centre." became part of
  // a company name in the first place.
  const uen = c.identifiers.find((i: { scheme: string }) => /uen|acra/i.test(i.scheme))?.value;
  const legal = cleanLegalName(c.legalName, c.name);
  if (legal) {
    out.push(`Registered as ${legal}${uen ? `, UEN ${uen}` : ""}.`);
  } else if (uen) {
    out.push(`UEN ${uen}.`);
  }

  const address = cleanAddress(c.addressLine);
  if (address) {
    out.push(`Address published on their site: ${address}${c.city ? `, ${c.city}` : ""}.`);
  }

  // Only where the page was fully delivered — the same rule the audit runs
  // under. On a client-rendered site an old copyright line may simply not have
  // been visible to the crawler.
  if (c.siteAudit?.reliable && c.siteAudit.copyrightYear) {
    const age = new Date().getFullYear() - c.siteAudit.copyrightYear;
    if (age >= 3) {
      out.push(`Their site's copyright line reads ${c.siteAudit.copyrightYear}.`);
    }
  }

  return out;
}

/**
 * Fill BuyingSignal from what we already hold.
 *
 * Kept deliberately narrow. BuyingSignal was designed for things that indicate
 * a company is about to buy — expansion, hiring, a funding round — and none of
 * that is available for a twelve-person Singapore aircon firm, which is why the
 * table stayed empty. Rather than pretend otherwise, the writer now reads facts
 * directly and this stays unused until there is a real producer for it.
 *
 * Named here so the next person to find an empty table knows it was a decision.
 */
export const BUYING_SIGNALS_ARE_UNUSED =
  "BuyingSignal has no producer. SME buying signals (funding, hiring, expansion) are " +
  "enterprise phenomena and are not published by the companies in this market. Facts for " +
  "outbound copy come from verifiedFactsFor() instead.";
