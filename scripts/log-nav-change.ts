import { db } from "@/lib/db";
import { logChange } from "@/lib/changelog";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const dupe = await db.changeLog.findFirst({ where: { title: { contains: "Sidebar cut" } } });
if (!dupe) {
  await logChange(biz.id, {
    area: "UI",
    title: "Sidebar cut to the five pages on the path to a commission",
    before:
      "Seventeen nav items in one flat list with no indication which mattered. Legacy views (Prospects, Outreach, Supplier leads) sat alongside the working pipeline at equal weight.",
    after:
      "Five essential pages in the order the work happens — Generator, Needs, Matchmake, Approvals, Replies — then System, then ten parked links under a 'Not in use' heading. Everything still reachable; nothing deleted.",
    why:
      "The test is narrow on purpose: is this page on the shortest path from no companies to an introduction that earns a commission? Seventeen equal-weight links made that impossible to see.",
    impact: "Also renamed from 'Revenue Dept. Singapore' to 'AI Lead Generator Agent'.",
  });
  console.log("change logged");
} else console.log("already logged");
console.log(`change log entries: ${await db.changeLog.count()}`);
await db.$disconnect();
