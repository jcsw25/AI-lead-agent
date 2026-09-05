import { crawlCompanySite } from "@/scraper/crawl";
const s = await crawlCompanySite("https://xmachina.biz/");
if (!s) { console.log("could not crawl"); process.exit(0); }
console.log(`name         ${s.name ?? "(none)"}`);
console.log(`legal name   ${s.legalName ?? "(none)"}`);
console.log(`pages read   ${s.pagesFetched.length}  ${s.pagesFetched.join(", ").slice(0, 160)}`);
console.log(`description  ${(s.description ?? "(none)").slice(0, 300)}`);
console.log(`emails       ${s.emails.map((e) => e.value).join(", ") || "(none)"}`);
console.log(`phones       ${s.phones.map((p) => p.value).join(", ") || "(none)"}`);
console.log(`socials      ${s.socialLinks.join(", ").slice(0, 140) || "(none)"}`);
if (s.audit) {
  const a = s.audit;
  console.log(`\nsite audit   ${a.score}/100`);
  console.log(`  enquiry form   ${a.hasContactForm}`);
  console.log(`  email link     ${a.hasEmailLink}   phone link ${a.hasPhoneLink}`);
  console.log(`  mobile ready   ${a.mobileViewport}   structured data ${a.hasStructured}`);
  console.log(`  copyright      ${a.copyrightYear ?? "none"}   js-rendered ${a.jsRendered}`);
  console.log(`  findings: ${a.findings.join(" | ")}`);
}
console.log(`\n--- what the site says (first 1800 chars) ---`);
console.log(s.corpus.replace(/\s+/g, " ").slice(0, 1800));
