/**
 * Backfill the change log with what was actually changed in this project.
 *
 * Every before/after figure below was measured at the time, not recalled.
 * Re-running is safe: entries are keyed on title and skipped if present.
 */
import { db } from "@/lib/db";
import { logChange, type ChangeEntry } from "@/lib/changelog";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const entries: ChangeEntry[] = [
  {
    area: "SCHEMA",
    title: "Need model — demand recorded before anything is sold",
    before:
      "No concept of a stated requirement. The system generated 782 introductions on the assumption that buyers wanted things; nothing ever tested that assumption, and no buyer had said anything.",
    after:
      "Need holds what a real buyer said, in their own words, with the reply that established it attached. Status ladder SUSPECTED → PROBED → CONFIRMED → FILLED → DEAD. Only CONFIRMED may be quoted to a supplier.",
    why:
      "Recruiting a supplier on a promise is the hardest email in the business. Recruiting one while holding a named buyer with a stated need is an offer of work, not a pitch.",
    impact: "Foundation for the demand-first remodel. Nothing downstream can be built without it.",
  },
  {
    area: "SCHEMA",
    title: "Change log — before/after recorded by the code that changes things",
    before: "No record of what changed or why. Status was whatever anyone remembered, which drifted from the code.",
    after: "ChangeLog with required before, after and why fields, written programmatically and shown in the admin panel.",
    why: "Two status claims on this project turned out to be true of a test script and false of anything stored. Measured beats remembered.",
  },
  {
    area: "AGENT",
    title: "Query strategist replaces hardcoded search variants",
    before:
      "Five trades had hand-written variants. Everything else got '<industry> company' and '<industry> services provider', which Google treats as one query. Dental clinic returned 8 companies.",
    after:
      "6-10 queries per industry across six vocabularies (core, synonym, trade, service, adjacent, buyer language), cached per industry. Dental clinic returned 108.",
    why: "Google ranks the same ~20 domains for any single phrasing however deep you page. Depth comes from genuinely different vocabulary, not from paging.",
    impact: "Roughly 13x more companies per industry, for one Haiku call each.",
  },
  {
    area: "AGENT",
    title: "Product terms converted to trade terms",
    before: "Searching 'mooncake' returned 54 results, 20 of them news sites, recipe blogs and marketplaces. Zero usable leads.",
    after:
      "The strategist detects a product noun and reframes it as a business: 'mooncake bakery wholesale distributor', 'mooncake confectionery factory', 'corporate mooncake gift supplier'.",
    why: "A product word ranks editorial content. A trade word ranks companies. The distinction was invisible until a search returned nothing usable.",
  },
  {
    area: "PIPELINE",
    title: "Scoring engine built — it existed only in the schema",
    before:
      "ScoringModel, ScoreSnapshot and OutcomeStat had zero references in src/. Designed, tabled, documented, never wired. 435 companies, 0 prospects.",
    after: "Seven weighted features, arithmetic scoring, hard gates before the number, rejections stored with reasons. 239 qualified, 245 prospects.",
    why: "Without it there was no answer to 'which 20 do I contact first'. The database was a list, not a pipeline.",
    impact: "ADR-002 honoured: the model extracts features, arithmetic produces the score.",
  },
  {
    area: "FIX",
    title: "Scoring silently produced zero for every company",
    before:
      "The seeded model carried weight names from the original architecture doc (signalStrength, companySize, timing). The features are named differently. Zero overlap, so nothing errored — all 435 companies scored 0 and graded D.",
    after: "activeScoringModel refuses a weights blob sharing no keys with the feature vocabulary and supersedes it with a warning.",
    why: "A silent zero is the worst possible failure: it looks like a real verdict.",
  },
  {
    area: "FIX",
    title: "Scoring calibrated against a market that exists",
    before:
      "contactability gave 45% of its weight to a named contact. Across 435 real Singapore companies, exactly zero publish named staff. That locked 13 points away from everyone, capped the database at 63/100 and produced no A or B grades.",
    after: "Email 50%, phone 30%, named contact 20% as a bonus. 81 grade A, 152 grade B.",
    why: "Scoring against a market that does not exist tells you nothing about the one that does.",
  },
  {
    area: "PIPELINE",
    title: "Pairings and company-level introductions",
    before: "69 pairings existed but none keyed to real industry strings. 181 contactable companies rejected for NO_PAIRING_THESIS — the largest rejection reason.",
    after: "23 pairings with companies on both sides, 791 introductions with a thesis, trigger and commission figure. NO_PAIRING_THESIS fell to 6.",
    why: "'Who would I introduce this company to, and why' is the product. It was blank.",
  },
  {
    area: "PIPELINE",
    title: "Website audit — measured, not judged",
    before: "No signal about a company beyond its contact details. Nothing to open an email with.",
    after:
      "303 sites audited from HTML already fetched: mobile viewport, enquiry form, HTTPS, structured data, copyright year, page weight. 55% have no enquiry form; only 2% lack a mobile viewport.",
    why:
      "Funding rounds are an enterprise phenomenon. A twelve-person aircon firm announces nothing, but its website is always inspectable — and 'your quote page has no form' is checkable by the person reading it.",
    impact: "Corrected an assumption: 'not mobile friendly' would have been the obvious pitch and is dead at 98% pass.",
  },
  {
    area: "FIX",
    title: "Discovery reported counts of rows it never wrote",
    before:
      "A test script called the search adapter and printed '86 companies in 38.6s'. It had no database write. Meanwhile the UI button was hardcoded to save 20. Two code paths: one reported numbers, one stored rows.",
    after: "One shared discoverIndustry(). Any path that reports a count is the path that writes the rows.",
    why: "A number that is true of a test and false of the database is worse than no number.",
  },
  {
    area: "FIX",
    title: "Regexes silently corrupted by backspace characters",
    before:
      "35 literal 0x08 bytes across four files where \\b should have been, from patching TypeScript through a Python heredoc. The UEN and address extractors ran against 435 companies in that state: 0 UENs captured, 10 addresses polluted with nav-menu text. Invisible in grep, invisible in an editor, compiles cleanly.",
    after: "All repaired; 30 UENs and 150 legal names recovered on re-crawl. npm run lint:bytes fails the build on any raw control character.",
    why: "The failure mode is a regex that matches nothing, with no error anywhere.",
  },
  {
    area: "COMPLIANCE",
    title: "Unsubscribe moved from a hosted link to a reply",
    before:
      "The footer carried http://localhost:3000/u/<hash> — unreachable by every recipient. Worse, the page opted people out on GET, so any mail scanner prefetching links would have silently unsubscribed them.",
    after:
      "Footer says reply with 'unsubscribe' or call the number. List-Unsubscribe is a mailto. The page now requires a form POST, which scanners do not perform.",
    why:
      "The Second Schedule requires the facility to carry an email address and a phone number — a reply-to address IS the facility the Act contemplates. And a facility that cannot be reached is not a working one.",
    impact: "Found because an automated check of the URL unsubscribed the owner's own address.",
  },
  {
    area: "COMPLIANCE",
    title: "Send gate refuses a fake sender address",
    before: "With no sender configured it fell back to noreply@example.test and sent anyway.",
    after: "Blocks. At bulk volume it also requires a phone number on the unsubscribe facility, as the Act does.",
    why: "The recipient cannot reply, the law requires a working contact address, and a fake domain burns the reputation of every message after it.",
  },
  {
    area: "AGENT",
    title: "Outreach tone rewritten, and enforced mechanically",
    before:
      "Emails opened 'Could you point me to whoever handles...', explained the recipient's own business back to them ('a failure mid-treatment cancels a full day of bookings'), and closed with 'Yes or no'.",
    after:
      "Four writers share one prompt discipline and one mechanical gate: cold openers, obligation language, manufactured pain, corporate register, money in the opening and campaign subjects are pattern-matched and regenerated with the failures named.",
    why: "Three prompt rewrites each produced copy that still broke rules the prompt stated. A prompt is a request; the gate is what holds.",
  },
  {
    area: "FIX",
    title: "Fabricated names and social proof caught before sending",
    before:
      "Given a supplier stored as 'Company A — RENAME BEFORE SENDING', the model wrote 'Smokehouse Social' into two buyer emails. Given a company with no description it wrote 'yours was one of the names that kept coming up'. Both read perfectly and passed every tone check.",
    after: "checkInventedNames scans proper-noun phrases against the companies actually in the database; checkPlaceholders catches placeholder text. Both block the draft.",
    why: "A fluent, confident introduction to a company that does not exist is the most damaging output this system can produce.",
  },
  {
    area: "PIPELINE",
    title: "Enrichment runs itself after a search",
    before:
      "Search saved companies; opening their websites was a separate manual step. A catering search returned 60 companies with zero emails and looked broken — 52 unopened websites were invisible unless you navigated to that industry's page.",
    after: "Search schedules the crawl and returns immediately. Live progress on the page. The Sheet syncs when the crawl finishes, not before.",
    why: "Three steps in a chain where only one is automatic is worse than none, because you cannot tell which state you are in.",
  },
  {
    area: "FIX",
    title: "Reply rate was inflating itself",
    before: "One reply marked every unreplied message to that contact as answered. Two sends and one reply reported 100%.",
    after: "Replies attributed by Gmail thread id. Two sends and one reply reports 50%.",
    why: "Reply rate is the input the entire learning loop gets fitted against. Inflating it would poison every conclusion drawn later, invisibly.",
  },
  {
    area: "PIPELINE",
    title: "Gmail connected — send and read, with token refresh",
    before: "EMAIL_ADAPTER was mock. Nothing could leave the machine, and replies would have been invisible to the system whatever was used to send.",
    after:
      "OAuth flow, AES-256-GCM encrypted refresh token, automatic refresh, reply capture and pattern-based classification. Verified end to end: two real emails, one reply captured and classified HOT.",
    why: "Only Gmail lets the system read replies back. Without that, reply rate and every outcome is invisible and the learning loop can never exist.",
  },
  {
    area: "UI",
    title: "Admin panel with live connection probes",
    before: "No way to tell whether a key worked. A rotated key, an exhausted quota and a typo all look identical in .env.",
    after: "Six probes making real calls, with latency, what each check found, and what breaks if it fails. Plus measured pipeline state and model spend.",
    why: "A one-character typo in the OAuth secret was diagnosed by asking Google, not by re-reading the config. That should not need a person.",
  },
  {
    area: "UI",
    title: "Matchmake — AI-proposed pairs judged on two-sided value",
    before: "Introductions were arithmetic: an industry thesis applied mechanically to every company on each side. Incapable of surprise.",
    after:
      "The model reads real companies and argues for specific pairs, with valueToA and valueToB both required and grounded facts separated from assumptions. First run: 7 proposals, including a counter-seasonal packaging match neither company would have found.",
    why: "A one-sided match is a sales lead with better manners. Two-sided value is why either party takes the next introduction.",
  },
];

let created = 0;
for (const e of entries) {
  const dupe = await db.changeLog.findFirst({ where: { title: e.title } });
  if (dupe) continue;
  await logChange(biz.id, e);
  created++;
}
console.log(`${created} change log entries written (${entries.length - created} already present)`);
console.log(`total in log: ${await db.changeLog.count()}`);
await db.$disconnect();
