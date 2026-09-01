import { db } from "@/lib/db";
import { emailScope, isSendable } from "@/lib/entity";

const companies = await db.company.findMany({
  where: { contacts: { some: { email: { not: null } } } },
  select: {
    name: true, primaryDomain: true,
    contacts: { where: { email: { not: null } }, select: { email: true } },
    introsAsA: { select: { id: true } }, introsAsB: { select: { id: true } },
  },
});

let keepsAtLeastOne = 0;
let losesAll = 0;
const losers: string[] = [];

for (const c of companies) {
  const real = c.contacts.filter((x) => x.email && !x.email.startsWith("unknown-"));
  if (!real.length) continue;
  const sendable = real.filter((x) => isSendable(emailScope(x.email!, c.primaryDomain)));
  if (sendable.length) keepsAtLeastOne++;
  else {
    losesAll++;
    if (losers.length < 12) {
      losers.push(`  ${c.name.slice(0, 28).padEnd(30)} ${(c.primaryDomain ?? "").padEnd(28)} ${real[0].email}` +
        (c.introsAsA.length + c.introsAsB.length ? "  [in an introduction]" : ""));
    }
  }
}

console.log(`companies with at least one email      ${keepsAtLeastOne + losesAll}`);
console.log(`  keep a sendable address              ${keepsAtLeastOne}`);
console.log(`  would lose their ONLY email          ${losesAll}`);
console.log(`\nthe ones that would go dark:`);
for (const l of losers) console.log(l);
await db.$disconnect();
