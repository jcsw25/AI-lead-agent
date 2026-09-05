import { checkInventedNames, checkPlaceholders } from "@/lib/outreach/quality";
const allowed = ["Company A (BBQ catering) — RENAME BEFORE SENDING", "Shipping Gazette Pte Ltd", "Jason Chan"];

const fabricated = `Hi there,

I came across Shipping Gazette Pte Ltd while reading up on freight platforms.

I work with a private BBQ caterer, Smokehouse Social, who do corporate events.

Jason Chan`;

const honest = `Hi there,

I came across Shipping Gazette Pte Ltd while reading up on freight platforms.

I work with a private barbecue catering outfit here who do corporate events.

Jason Chan`;

console.log("fabricated draft:");
for (const v of checkInventedNames(fabricated, allowed)) console.log(`  CAUGHT  ${v.rule}: ${v.detail.slice(0, 90)}`);
console.log("\nhonest draft:");
const clean = checkInventedNames(honest, allowed);
console.log(clean.length ? clean.map((v) => `  ${v.detail}`).join("\n") : "  clean — no invented names");

console.log("\nplaceholder leak:");
for (const v of checkPlaceholders("I work with Company A who cater events.", "A thought")) console.log(`  CAUGHT  ${v.detail}`);
