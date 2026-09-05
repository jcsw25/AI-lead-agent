import { crawlCompanySite } from "@/scraper/crawl";
for (const url of ["https://xmachina.biz/", "https://greencoolaircon.com", "https://smilepoint.com.sg"]) {
  const s = await crawlCompanySite(url);
  const a = s?.audit;
  if (!a) { console.log(`${url}  — no audit`); continue; }
  console.log(`\n${url}`);
  console.log(`  render mode  ${a.renderMode}   absences trustworthy: ${a.reliable}`);
  console.log(`  score        ${a.score}/100`);
  console.log(`  form=${a.hasContactForm} emailLink=${a.hasEmailLink} structured=${a.hasStructured}`);
  console.log(`  findings:`);
  for (const f of a.findings) console.log(`     - ${f.slice(0, 110)}`);
}
