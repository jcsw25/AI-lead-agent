import { checkProbe } from "@/lib/outreach/quality-probe";
const allowed = ["Smilepoint Dental Centre", "Jason Chan"];

const pitch = `Hi there,

I'm Jason. I work with an aircon servicing company here in Singapore who take referrals from me.

Would you be interested in an introduction? I take 10% if it closes.

Jason`;

const probe = `Hi there,

I'm Jason. I connect Singapore businesses with suppliers, so this is a question rather than a pitch.

Who looks after your aircon servicing at the moment?

I'd rather know who's already doing good work than guess. If you're happy with yours, that's useful to know too.

Jason`;

console.log("a pitch dressed as a probe:");
for (const v of checkProbe("An opportunity for you", pitch, "Would you be interested?", allowed)) {
  console.log(`  CAUGHT  ${v.rule}: ${v.detail.slice(0, 88)}`);
}
console.log("\na real probe:");
const clean = checkProbe("Quick question about your aircon servicing", probe, "Who looks after your aircon servicing at the moment?", allowed);
console.log(clean.length ? clean.map((v) => `  ${v.rule}: ${v.detail}`).join("\n") : "  clean");

console.log("\ntwo questions:");
for (const v of checkProbe("Quick question", probe.replace("guess.", "guess. And are you happy with them?"), "Who looks after your aircon servicing at the moment?", allowed)) {
  console.log(`  CAUGHT  ${v.rule}: ${v.detail.slice(0, 80)}`);
}
