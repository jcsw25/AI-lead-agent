"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSearchAdapters } from "@/adapters/search";
import { discoverIndustry } from "@/lib/discover-industry";
import { ingestDomain } from "@/scraper/ingest";
import { classifyAndLink } from "@/agents/company-classifier";
import { registrableDomain } from "@/lib/domain";

function refresh() {
  revalidatePath("/generator");
  revalidatePath("/leads");
  revalidatePath("/pairings");
  revalidatePath("/");
}


/**
 * Push to the Sheet after a search, when one is connected and auto-sync is on.
 * Swallows failures on purpose: a Sheets outage must not lose search results
 * that are already safely in the database.
 */
async function autoSync(businessId: string) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { sheetId: true, sheetAutoSync: true } });
  if (!b?.sheetId || !b.sheetAutoSync) return;
  try {
    const { syncBusinessSheet } = await import("@/adapters/sheets");
    const { buildExportData } = await import("@/lib/export-data");
    await syncBusinessSheet(businessId, await buildExportData(businessId));
  } catch (e) {
    console.error("[sheets] auto-sync failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Search by industry -> a list of real companies in it.
 *
 * Results are persisted immediately rather than held in memory: the point of
 * the command post is that everything it finds lands in the database and
 * therefore in the spreadsheet.
 */
export async function searchIndustry(businessId: string, formData: FormData) {
  const industry = String(formData.get("industry") ?? "").trim();
  const limit = Math.min(Number(formData.get("limit") ?? 25), 300);
  const crawl = formData.get("crawl") === "on";
  if (!industry) return;

  const r = await discoverIndustry(businessId, industry, { limit, crawl });

  // Open the websites we just found, without making the user wait for it.
  //
  // Search is fast; crawling is not. Kicking it off here rather than requiring
  // a second, separate click is the difference between a results page that
  // fills in contact details on its own and one that looks like the data does
  // not exist. Returns immediately — progress shows on the page.
  let enriching = 0;
  if (!crawl) {
    const { scheduleEnrichment } = await import("@/lib/jobs/enrich-queue");
    enriching = (await scheduleEnrichment(businessId, industry)).started;
  }

  // Only push to the Sheet now if nothing is about to fill in the contacts.
  //
  // Syncing immediately meant the Sheet showed 60 companies with every email
  // and phone column blank, because no website had been opened yet. That reads
  // as "the scraper found nothing", which is the opposite of what is happening
  // — and it misled twice before this. The crawl syncs the Sheet itself when it
  // finishes, so the Sheet now goes straight from old data to complete data
  // instead of passing through a state that looks like a failure.
  if (!enriching) await autoSync(businessId);
  refresh();
  // Without this the page looks identical after a search — only a counter moves,
  // which reads as "nothing happened".
  redirect(
    `/generator?industry=${encodeURIComponent(industry)}&found=${r.found}&saved=${r.created + r.crawled}` +
      `&skipped=${r.skippedKnown}${enriching ? `&enriching=${enriching}` : ""}`,
  );
}

/**
 * Search by company -> scrape it, classify it, and find who to link it with.
 * Accepts a domain or a name; a domain gets crawled, a name is looked up.
 */
export async function searchCompany(businessId: string, formData: FormData) {
  const input = String(formData.get("company") ?? "").trim();
  if (!input) return;

  const business = await db.business.findUniqueOrThrow({ where: { id: businessId }, include: { region: true } });
  const domain = registrableDomain(input);
  let companyId: string | null = null;

  if (domain) {
    const r = await ingestDomain(businessId, input, {});
    companyId = r.companyId ?? null;
    if (!companyId) {
      const existing = await db.company.findUnique({ where: { primaryDomain: domain } });
      companyId = existing?.id ?? null;
    }
  } else {
    const existing = await db.company.findFirst({
      where: { name: { contains: input, mode: "insensitive" } },
      orderBy: { lastResearchedAt: "desc" },
    });
    if (existing) companyId = existing.id;
    else {
      // Not known and not a domain — try discovery by name.
      for (const a of getSearchAdapters()) {
        const hits = await a.discover(input, business.region.name, 3).catch(() => []);
        const best = hits.find((h) => h.website) ?? hits[0];
        if (!best) continue;
        if (best.website) {
          const r = await ingestDomain(businessId, best.website, {});
          companyId = r.companyId ?? null;
        } else {
          const c = await db.company.create({
            data: {
              name: best.name, addressLine: best.address, regionId: business.regionId,
              countryCode: business.region.code, verification: "INFERRED", lastResearchedAt: new Date(),
            },
          });
          companyId = c.id;
        }
        break;
      }
    }
  }

  if (!companyId) {
    // Nothing found. Land back on the page rather than failing silently.
    redirect("/generator?notfound=1");
  }

  await classifyAndLink(businessId, companyId);
  await autoSync(businessId);
  refresh();
  // redirect() throws by design, so it must come after the writes.
  redirect(`/generator?company=${companyId}`);
}

export async function clearGeneratorResults(businessId: string) {
  await db.scrapeRun.deleteMany({ where: { businessId, mode: "search" } });
  refresh();
}

/** Connect an existing Google Sheet by URL or id. */
export async function connectSheet(businessId: string, formData: FormData) {
  const { parseSheetId } = await import("@/adapters/sheets");
  const raw = String(formData.get("sheet") ?? "").trim();
  const id = parseSheetId(raw);
  if (!id) redirect("/generator?sheeterror=" + encodeURIComponent("That does not look like a Sheets URL or id."));
  await db.business.update({
    where: { id: businessId },
    data: { sheetId: id, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit` },
  });
  await syncSheet(businessId);
}

/** Push the database into the connected Sheet, creating one if needed. */
export async function syncSheet(businessId: string) {
  const { syncBusinessSheet } = await import("@/adapters/sheets");
  const { buildExportData } = await import("@/lib/export-data");
  try {
    const data = await buildExportData(businessId);
    await syncBusinessSheet(businessId, data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    refresh();
    redirect("/generator?sheeterror=" + encodeURIComponent(msg.slice(0, 300)));
  }
  refresh();
}

export async function disconnectSheet(businessId: string) {
  await db.business.update({ where: { id: businessId }, data: { sheetId: null, sheetUrl: null, sheetSyncedAt: null } });
  refresh();
}

/** Draft both halves of an introduction for one company against one pairing. */
export async function draftPair(businessId: string, companyId: string, pairingId: string, side: "A" | "B") {
  const { draftIntroPair } = await import("@/agents/intro-emails");
  await draftIntroPair(businessId, companyId, pairingId, side);
  revalidatePath(`/generator`);
  redirect(`/generator?company=${companyId}&drafted=${pairingId}`);
}

/**
 * Rewrite the search plan for an industry.
 *
 * The strategist's previous phrasings are handed back as "avoid", so this
 * explores new vocabulary rather than paying for the same answer twice. Use it
 * when a search came back thin — a thin result is usually a vocabulary problem,
 * not a small market.
 */
export async function replanIndustry(businessId: string, formData: FormData) {
  const industry = String(formData.get("industry") ?? "").trim();
  if (!industry) return;

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  const { planQueries } = await import("@/agents/query-strategist");
  await planQueries(industry, business.region.name, { refresh: true, businessId });

  refresh();
  redirect(`/generator?industry=${encodeURIComponent(industry)}&replanned=1`);
}

/**
 * Fetch contact details for companies found in an industry.
 *
 * Discovery stores what Google returned — a name, a domain, sometimes a phone
 * from the snippet. The email is on the company's own site, which has to be
 * opened. That is ~10s per company, so this runs in bounded batches rather than
 * blocking a request for ten minutes; click it again for the next batch.
 */
export async function enrichIndustry(businessId: string, formData: FormData) {
  const industry = String(formData.get("industry") ?? "").trim();
  const batch = Math.min(Number(formData.get("batch") ?? 20), 40);
  if (!industry) return;

  const candidates = await db.company.findMany({
    where: {
      industry: { equals: industry, mode: "insensitive" },
      primaryDomain: { not: null },
      contacts: { none: { email: { not: null } } },
    },
    select: { id: true, name: true, websiteUrl: true, primaryDomain: true },
    take: batch,
  });

  const run = await db.scrapeRun.create({
    data: { businessId, mode: "enrich", query: `enrich: ${industry}` },
  });

  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(6);
  let emails = 0;
  let phones = 0;
  let crawled = 0;
  const skipped: string[] = [];

  await Promise.all(
    candidates.map((c) =>
      limit(async () => {
        try {
          const r = await ingestDomain(businessId, c.websiteUrl ?? `https://${c.primaryDomain}`, {
            runId: run.id,
            knownName: c.name,
          });
          if (r.skipped) skipped.push(`${c.primaryDomain}: ${r.skipped}`);
          else {
            crawled++;
            emails += r.emails;
            phones += r.phones;
          }
        } catch (e) {
          skipped.push(`${c.primaryDomain}: ${e instanceof Error ? e.message.slice(0, 80) : "failed"}`);
        }
      }),
    ),
  );

  const remaining = await db.company.count({
    where: {
      industry: { equals: industry, mode: "insensitive" },
      primaryDomain: { not: null },
      contacts: { none: { email: { not: null } } },
    },
  });

  await db.scrapeRun.update({
    where: { id: run.id },
    data: {
      status: "done",
      targetsAttempted: candidates.length,
      companiesCreated: crawled,
      finishedAt: new Date(),
      log: { industry, crawled, emails, phones, remaining, skipped: skipped.slice(0, 40) } as object,
    },
  });

  await autoSync(businessId);
  refresh();
  redirect(
    `/generator?industry=${encodeURIComponent(industry)}&enriched=${crawled}&emails=${emails}&phones=${phones}&remaining=${remaining}`,
  );
}
