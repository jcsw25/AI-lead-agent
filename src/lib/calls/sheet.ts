import { db } from "@/lib/db";
import {
  ensureTab,
  formatCallsTab,
  getAccessToken,
  readTab,
  writeTab,
} from "@/adapters/sheets";
import { CALL_OUTCOMES, callQueue, logCall, type CallOutcome } from "@/lib/calls/queue";

/**
 * The Calls tab, in both directions.
 *
 * Every other tab in this Sheet is written by clear-then-write, so the Sheet
 * always matches the database and anything typed by hand is destroyed on the
 * next sync. That is correct for tabs the database owns and completely wrong
 * here: this tab exists to be typed into. A call gets logged in a car park
 * between jobs, on a phone, in the Sheets app — not in a web form on a laptop.
 *
 * So the rule is READ, MERGE, THEN WRITE, and the columns are split by owner:
 *
 *   The database owns   Company, Phone, Industry, Something to open with
 *   You own             Called on, Outcome, Notes, Call again on
 *
 * Where both have changed, YOURS WINS. You were on the phone; the database was
 * not. The only thing the database will overwrite in your columns is nothing at
 * all — it fills blanks and leaves anything you typed exactly as you left it.
 *
 * A row with no id in the key column is treated as a lead you added by hand.
 * That is a real workflow, not an error case: somebody gives you a number at a
 * job and you write it straight into the Sheet. It becomes a company, a contact
 * and a logged call.
 */

const TAB = "Calls";

/**
 * Column order. The key sits last, out of the way, because it is the one cell
 * that must survive and the first column is where hands land.
 */
const COLUMNS = [
  "Company",
  "Phone",
  "Industry",
  "Something to open with",
  "Called on",
  "Outcome",
  "Notes",
  "Call again on",
  "id — do not edit",
] as const;

const COL = {
  company: 0,
  phone: 1,
  industry: 2,
  opener: 3,
  calledOn: 4,
  outcome: 5,
  notes: 6,
  callAgain: 7,
  id: 8,
} as const;

/** Everything left of this is written by the database each sync. */
const READ_ONLY_THROUGH = 4;

export type CallSheetResult = {
  pulledIn: number;
  createdLeads: number;
  suppressed: number;
  rowsWritten: number;
  skipped: string[];
  url: string;
};

const cell = (row: string[], i: number) => (row[i] ?? "").trim();

const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

/**
 * Match a typed outcome to one of ours.
 *
 * The dropdown makes an exact match the normal case, but a row pasted from
 * elsewhere or edited on a phone keyboard will not always be exact — and an
 * unmatched outcome is a call that silently never gets recorded.
 */
function matchOutcome(raw: string): CallOutcome | null {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const target = flat(raw);
  if (!target) return null;
  return (
    CALL_OUTCOMES.find((o) => flat(o) === target) ??
    CALL_OUTCOMES.find((o) => flat(o).startsWith(target) || target.startsWith(flat(o))) ??
    null
  );
}

/**
 * Create a company and contact for a row typed in by hand.
 *
 * Deliberately minimal. A lead written into a spreadsheet at a job site has a
 * name and a number and nothing else, and inventing a website or an industry to
 * fill the row would put fabricated data next to real data with no way to tell
 * them apart later.
 */
async function createManualLead(name: string, phone: string, industry: string) {
  const existing = await db.contact.findFirst({
    where: { phone, company: { name: { equals: name, mode: "insensitive" } } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const company = await db.company.create({
    data: {
      name: name.slice(0, 200),
      industry: industry || null,
      // No domain: this lead did not come from a website, and a fabricated one
      // would collide with the dedupe key that every scraped company uses.
      primaryDomain: null,
      verification: "UNVERIFIED",
      description: "Added by hand in the Calls tab of the Google Sheet.",
    },
  });
  const contact = await db.contact.create({
    data: {
      companyId: company.id,
      fullName: name.slice(0, 120),
      phone,
      jobTitle: "General enquiries",
      verification: "UNVERIFIED",
    },
  });
  return contact.id;
}

/**
 * Pull what you typed into the Sheet back into the database, then write the
 * queue back out.
 */
export async function syncCallsTab(businessId: string): Promise<CallSheetResult> {
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId } });
  if (!business.sheetId) {
    throw new Error("No Google Sheet connected. Connect one in Settings first.");
  }

  const token = await getAccessToken();
  const sheetId = await ensureTab(token, business.sheetId, TAB);

  const out: CallSheetResult = {
    pulledIn: 0,
    createdLeads: 0,
    suppressed: 0,
    rowsWritten: 0,
    skipped: [],
    url: `https://docs.google.com/spreadsheets/d/${business.sheetId}/edit`,
  };

  // ---- 1. read what is there now -----------------------------------------
  const existing = await readTab(token, business.sheetId, TAB);
  const body = existing.slice(1); // drop the header

  /** Human columns, keyed by contact id, so they survive the write-back. */
  const kept = new Map<string, { calledOn: string; outcome: string; notes: string; callAgain: string }>();

  // ---- 2. pull in everything you typed ------------------------------------
  for (const row of body) {
    const id = cell(row, COL.id);
    const outcomeRaw = cell(row, COL.outcome);
    const notes = cell(row, COL.notes);
    const human = {
      calledOn: cell(row, COL.calledOn),
      outcome: outcomeRaw,
      notes,
      callAgain: cell(row, COL.callAgain),
    };

    let contactId = id;

    // A row with no id is a lead you added yourself.
    if (!contactId) {
      const name = cell(row, COL.company);
      const phone = cell(row, COL.phone);
      if (!name && !phone) continue; // a blank row is not an error
      if (!phone) {
        out.skipped.push(`"${name}" has no phone number`);
        continue;
      }
      contactId = await createManualLead(name || phone, phone, cell(row, COL.industry));
      out.createdLeads++;
    }

    // Your columns, held aside so the write-back does not flatten them.
    kept.set(contactId, human);

    if (!outcomeRaw) continue;

    // Already recorded? The tab is synced repeatedly and one logged call must
    // not become three.
    //
    // One row is one contact, showing the latest state of that relationship —
    // so calling the same firm again next month updates this record rather than
    // adding a second. That is the honest limit of a one-row-per-company view;
    // the full history lives on the Calls page in the app.
    const already = await db.message.findFirst({
      where: { businessId, contactId, channel: "PHONE" },
      select: { id: true, outcome: true, bodyText: true },
    });
    if (already) {
      // You changed your mind about how it went, or added notes afterwards.
      if (already.outcome !== outcomeRaw || (notes && already.bodyText !== notes)) {
        const matched = matchOutcome(outcomeRaw);
        await db.message.update({
          where: { id: already.id },
          data: { outcome: matched ?? outcomeRaw, bodyText: notes || already.bodyText },
        });
        out.pulledIn++;
      }
      continue;
    }

    const outcome = matchOutcome(outcomeRaw);
    if (!outcome) {
      out.skipped.push(`"${cell(row, COL.company)}" — could not read the outcome "${outcomeRaw}"`);
      continue;
    }

    await logCall(businessId, contactId, outcome, notes);
    out.pulledIn++;
    if (outcome === "Asked not to be contacted") out.suppressed++;
  }

  // ---- 3. write the tab back ----------------------------------------------
  // Everyone still to call, plus everyone already called, so the tab is the
  // whole picture rather than a to-do list that erases its own history.
  const queue = await callQueue(businessId, { limit: 200 });

  const logged = await db.message.findMany({
    where: { businessId, channel: "PHONE", direction: "OUTBOUND" },
    orderBy: { sentAt: "desc" },
    select: {
      contactId: true,
      outcome: true,
      bodyText: true,
      sentAt: true,
      contact: {
        select: {
          phone: true,
          company: { select: { name: true, industry: true } },
        },
      },
    },
  });

  const rows: (string | number)[][] = [];

  for (const q of queue) {
    const human = kept.get(q.contactId);
    rows.push([
      q.company,
      q.phone,
      q.industry ?? "",
      q.observation ?? (q.reportViews > 0 ? "Opened their report — lead with that" : ""),
      human?.calledOn ?? "",
      human?.outcome ?? "",
      human?.notes ?? "",
      human?.callAgain ?? "",
      q.contactId,
    ]);
  }

  const inQueue = new Set(queue.map((q) => q.contactId));
  for (const m of logged) {
    if (!m.contactId || inQueue.has(m.contactId)) continue;
    const human = kept.get(m.contactId);
    rows.push([
      m.contact?.company.name ?? "",
      m.contact?.phone ?? "",
      m.contact?.company.industry ?? "",
      "",
      human?.calledOn || isoDay(m.sentAt),
      m.outcome ?? "",
      m.bodyText ?? "",
      human?.callAgain ?? "",
      m.contactId,
    ]);
  }

  await writeTab(token, business.sheetId, {
    title: TAB,
    headers: [...COLUMNS],
    rows,
  });
  await formatCallsTab(token, business.sheetId, sheetId, {
    outcomes: CALL_OUTCOMES,
    outcomeColumn: COL.outcome,
    readOnlyThrough: READ_ONLY_THROUGH,
    idColumn: COL.id,
  });

  out.rowsWritten = rows.length;
  return out;
}
