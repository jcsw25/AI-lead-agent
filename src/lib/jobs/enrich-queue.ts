import pLimit from "p-limit";
import { db } from "@/lib/db";
import { ingestDomain } from "@/scraper/ingest";

/**
 * Enrichment that starts itself after a search.
 *
 * Discovery and enrichment have to stay separate — search is ~0.5s per company
 * and opening a website is ~10s — but making the human remember to run the
 * second one was a real failure. A catering search returned 60 companies with
 * zero emails, the data looked simply absent, and the 52 unopened websites were
 * invisible unless you happened to navigate to that industry's results page.
 *
 * So the search now schedules the crawl instead of waiting to be asked. It runs
 * behind the redirect: the results appear immediately and contact details fill
 * in over the next minute or two.
 *
 * Deliberately in-process and single-flight rather than a real queue. pg-boss
 * is a dependency and would survive restarts, but this runs inside one long
 * `next dev` process on a laptop; a background worker would be more moving
 * parts than the problem needs. The cost is that a restart kills a running
 * crawl — which the existing stale-run reaper already marks failed, and which
 * is recoverable by pressing the button.
 */

/** One crawl at a time across the whole process. */
let running: Promise<void> | null = null;

export type EnrichProgress = {
  runId: string;
  industry: string;
  total: number;
  done: number;
  emails: number;
  phones: number;
  /** Set once the Sheet has been written, so the UI can show a real light. */
  sheetSynced: boolean;
  sheetError?: string;
  finished: boolean;
};

const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY ?? 6);
/** Cap per search so one broad industry cannot occupy the crawler for an hour. */
const MAX_PER_RUN = Number(process.env.ENRICH_MAX_PER_RUN ?? 120);

/** Companies in this industry that have a website nobody has opened yet. */
export async function pendingEnrichment(industry: string): Promise<number> {
  return db.company.count({
    where: {
      industry: { equals: industry, mode: "insensitive" },
      primaryDomain: { not: null },
      siteAudit: null,
    },
  });
}

/** The crawl currently running, if any, with its progress. */
export async function currentEnrichment(businessId: string): Promise<EnrichProgress | null> {
  const run = await db.scrapeRun.findFirst({
    where: { businessId, mode: "enrich" },
    orderBy: { startedAt: "desc" },
  });
  if (!run) return null;
  const log = (run.log as Partial<EnrichProgress> | null) ?? {};

  // Whether the Sheet is current is derived, not remembered. The flag below is
  // written after the sync, and that write failed silently once — leaving a
  // grey light over a Sheet that had in fact been updated. Comparing the
  // Sheet's own timestamp against when the crawl started cannot drift, because
  // both are facts rather than bookkeeping.
  const biz = await db.business.findUnique({
    where: { id: businessId },
    select: { sheetId: true, sheetAutoSync: true, sheetSyncedAt: true },
  });
  const syncedAfterRun = Boolean(
    biz?.sheetSyncedAt && biz.sheetSyncedAt.getTime() >= run.startedAt.getTime(),
  );
  const sheetUnavailable = !biz?.sheetId ? "no Sheet connected" : !biz.sheetAutoSync ? "auto-sync is off" : undefined;

  return {
    runId: run.id,
    industry: (run.query ?? "").replace(/^enrich:\s*/, ""),
    total: run.targetsAttempted ?? 0,
    done: log.done ?? 0,
    emails: log.emails ?? 0,
    phones: log.phones ?? 0,
    sheetSynced: Boolean(log.sheetSynced) || syncedAfterRun,
    sheetError: log.sheetError ?? sheetUnavailable,
    finished: run.status !== "running",
  };
}

/**
 * Start crawling this industry's un-opened websites. Returns immediately.
 *
 * Safe to call on every search: it no-ops when a crawl is already running or
 * when there is nothing left to open.
 */
export async function scheduleEnrichment(businessId: string, industry: string): Promise<{ started: number }> {
  if (running) return { started: 0 };

  const targets = await db.company.findMany({
    where: {
      industry: { equals: industry, mode: "insensitive" },
      primaryDomain: { not: null },
      siteAudit: null,
    },
    select: { id: true, name: true, websiteUrl: true, primaryDomain: true },
    take: MAX_PER_RUN,
  });
  if (!targets.length) return { started: 0 };

  const run = await db.scrapeRun.create({
    data: {
      businessId,
      mode: "enrich",
      query: `enrich: ${industry}`,
      targetsAttempted: targets.length,
      log: { done: 0, emails: 0, phones: 0 } as object,
    },
  });

  running = (async () => {
    const limit = pLimit(CONCURRENCY);
    let done = 0;
    let emails = 0;
    let phones = 0;
    let crawled = 0;
    const skipped: string[] = [];

    await Promise.all(
      targets.map((t) =>
        limit(async () => {
          try {
            const r = await ingestDomain(businessId, t.websiteUrl ?? `https://${t.primaryDomain}`, {
              runId: run.id,
              knownName: t.name,
            });
            if (r.skipped) skipped.push(`${t.primaryDomain}: ${r.skipped}`);
            else {
              crawled++;
              emails += r.emails;
              phones += r.phones;
            }
          } catch (e) {
            skipped.push(`${t.primaryDomain}: ${e instanceof Error ? e.message.slice(0, 80) : "failed"}`);
          }
          done++;
          // Write progress periodically so the page can show it without
          // hammering the database on every single site.
          if (done % 5 === 0 || done === targets.length) {
            await db.scrapeRun
              .update({ where: { id: run.id }, data: { log: { done, emails, phones } as object } })
              .catch(() => {});
          }
        }),
      ),
    );

    await db.scrapeRun.update({
      where: { id: run.id },
      data: {
        status: "done",
        companiesCreated: crawled,
        finishedAt: new Date(),
        log: { done, emails, phones, crawled, skipped: skipped.slice(0, 40) } as object,
      },
    });

    // Keep the Sheet in step with what was just found, and record whether it
    // worked. The UI shows a light for this, and a light that is green when
    // the write actually failed is worse than no light.
    let sheetSynced = false;
    let sheetError: string | undefined;
    try {
      const b = await db.business.findUnique({
        where: { id: businessId },
        select: { sheetId: true, sheetAutoSync: true },
      });
      if (b?.sheetId && b.sheetAutoSync) {
        const { syncBusinessSheet } = await import("@/adapters/sheets");
        const { buildExportData } = await import("@/lib/export-data");
        await syncBusinessSheet(businessId, await buildExportData(businessId));
        sheetSynced = true;
      } else {
        sheetError = b?.sheetId ? "auto-sync is off" : "no Sheet connected";
      }
    } catch (e) {
      sheetError = e instanceof Error ? e.message.slice(0, 140) : "sync failed";
      console.error("[enrich] sheet sync failed:", sheetError);
    }

    try {
      await db.scrapeRun.update({
        where: { id: run.id },
        data: { log: { done, emails, phones, crawled, sheetSynced, sheetError, skipped: skipped.slice(0, 40) } as object },
      });
    } catch (e) {
      // Not swallowed. This write failing is why a completed sync once showed
      // a grey light, and a silent catch made it impossible to see.
      console.error("[enrich] could not record the sheet result:", e instanceof Error ? e.message : e);
    }
  })()
    .catch((e) => {
      console.error("[enrich] run failed:", e instanceof Error ? e.message : e);
      return db.scrapeRun
        .update({
          where: { id: run.id },
          data: { status: "failed", error: e instanceof Error ? e.message.slice(0, 500) : "failed", finishedAt: new Date() },
        })
        .then(() => undefined);
    })
    .finally(() => {
      running = null;
    });

  return { started: targets.length };
}
