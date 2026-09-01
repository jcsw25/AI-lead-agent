import { serperAdapter } from "../src/adapters/search";
const t0 = Date.now();
try {
  const r = await serperAdapter.discover("aircon servicing", "Singapore", 100);
  console.log(`${((Date.now()-t0)/1000).toFixed(1)}s · ${r.length} companies · ${r.filter(x=>x.phone).length} with phone`);
  for (const c of r.slice(0, 20)) console.log(`   ${c.name.slice(0,30).padEnd(32)} ${(c.website??"").replace("https://","").slice(0,34)}`);
  if (r.length > 20) console.log(`   ... and ${r.length - 20} more`);
} catch (e) { console.log("FAILED:", e instanceof Error ? e.message.slice(0,200) : e); }
