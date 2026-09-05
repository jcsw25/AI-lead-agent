/**
 * Google Sheets sync.
 *
 * The database stays the source of truth and the Sheet is a always-current
 * view of it. That direction matters: suppression and opt-outs must be
 * authoritative in Postgres, because the send gate reads them there. A row
 * deleted only in a spreadsheet would still get emailed.
 *
 * Requires an OAuth access token with the `spreadsheets` scope. Same Google
 * Cloud project and same consent flow as the Gmail adapter — see
 * docs/08-going-live.md. Until that flow is wired to a button, use
 * `npm run export:xlsx` and import the file.
 */

import { createSign } from "node:crypto";

/**
 * Service-account authentication.
 *
 * Chosen over user OAuth deliberately: no consent screen, no redirect flow, no
 * refresh-token expiry, and it works from a background job. The trade is that
 * the service account is a robot with its own identity — so you share the Sheet
 * with its email address, exactly as you would with a colleague.
 *
 * Signed here with node:crypto rather than pulling in googleapis, which is a
 * very large dependency for one JWT and three REST calls.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: { token: string; expiresAt: number } | null = null;

type Creds =
  | { kind: "service_account"; email: string; key: string }
  | { kind: "user"; clientId: string; clientSecret: string; refreshToken: string };

/**
 * Where gcloud writes Application Default Credentials.
 * Windows uses APPDATA; everything else uses ~/.config.
 */
function adcPath(): string {
  if (process.env.CLOUDSDK_CONFIG) return join(process.env.CLOUDSDK_CONFIG, "application_default_credentials.json");
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "gcloud", "application_default_credentials.json");
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * Credential resolution, in order of preference:
 *
 *   1. GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY  (pasted into .env)
 *   2. GOOGLE_APPLICATION_CREDENTIALS                     (path to a key file)
 *   3. Application Default Credentials from gcloud        (no key file at all)
 *
 * Option 3 exists because many organizations enforce
 * `iam.disableServiceAccountKeyCreation`, which makes options 1 and 2
 * impossible without weakening an org policy. It is also the better fit for an
 * app running on one person's machine: nothing to leak, and the Sheet ends up
 * owned by the user rather than by a robot account with no Drive UI.
 */
/**
 * A private key stored in .env carries literal backslash-n sequences, because
 * .env cannot hold real newlines. A key read from a JSON file may have either.
 * Normalise both to real newlines, which is what the signer needs.
 */
function unescapeKey(k: string | undefined): string | undefined {
  return k?.replace(/\\n/g, "\n");
}

export function resolveCredentials(): Creds | null {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = unescapeKey(process.env.GOOGLE_PRIVATE_KEY);
  if (email && key) return { kind: "service_account", email, key };

  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file && existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    if (j.client_email && j.private_key) {
      return { kind: "service_account", email: j.client_email, key: unescapeKey(j.private_key)! };
    }
  }

  const adc = adcPath();
  if (existsSync(adc)) {
    const j = JSON.parse(readFileSync(adc, "utf8")) as Record<string, string>;
    if (j.type === "authorized_user" && j.refresh_token) {
      return { kind: "user", clientId: j.client_id, clientSecret: j.client_secret, refreshToken: j.refresh_token };
    }
    if (j.client_email && j.private_key) {
      return { kind: "service_account", email: j.client_email, key: unescapeKey(j.private_key)! };
    }
  }
  return null;
}

export function serviceAccountEmail(): string | null {
  const c = resolveCredentials();
  return c?.kind === "service_account" ? c.email : null;
}

export function credentialSource(): "service_account" | "gcloud" | null {
  const c = resolveCredentials();
  if (!c) return null;
  return c.kind === "service_account" ? "service_account" : "gcloud";
}

export function sheetsConfigured(): boolean {
  return resolveCredentials() !== null;
}

/** gcloud user credentials: swap the refresh token for an access token. */
async function tokenFromUser(c: Extract<Creds, { kind: "user" }>): Promise<{ token: string; ttl: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (body.includes("invalid_scope") || body.includes("insufficient")) {
      throw new Error(
        "gcloud credentials exist but lack the Sheets scope. Re-run: " +
          "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive.file",
      );
    }
    throw new Error(`Google auth ${res.status}: ${body}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { token: j.access_token, ttl: j.expires_in };
}

/** Service account: sign a JWT and exchange it. */
async function tokenFromServiceAccount(c: Extract<Creds, { kind: "service_account" }>): Promise<{ token: string; ttl: number }> {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: c.email, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now,
  })}`;

  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signature = signer.sign(c.key, "base64url");
  } catch {
    throw new Error(
      "GOOGLE_PRIVATE_KEY could not be used to sign. Copy the private_key value from the " +
        "service account JSON exactly as it appears — including the BEGIN/END lines and the " +
        "literal \n sequences — and wrap it in double quotes.",
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { token: j.access_token, ttl: j.expires_in };
}

export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const creds = resolveCredentials();
  if (!creds) {
    throw new Error(
      "No Google credentials found. Either set GOOGLE_SERVICE_ACCOUNT_EMAIL and " +
        "GOOGLE_PRIVATE_KEY in .env, or run: " +
        "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive.file",
    );
  }

  const { token, ttl } = creds.kind === "user" ? await tokenFromUser(creds) : await tokenFromServiceAccount(creds);
  cached = { token, expiresAt: Date.now() + ttl * 1000 };
  return token;
}

/** Accepts a full Sheets URL or a bare id. */
export function parseSheetId(input: string): string | null {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  const trimmed = input.trim();
  return /^[a-zA-Z0-9-_]{20,}$/.test(trimmed) ? trimmed : null;
}

const API = "https://sheets.googleapis.com/v4/spreadsheets";

export type SheetTab = { title: string; headers: string[]; rows: (string | number | null)[][] };

async function call(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && path !== "") {
      throw new Error(
        `Sheets 403 — the service account cannot reach that Sheet. Share it with the ` +
          `service account address as Editor (not Viewer), then try again. Raw: ${body.slice(0, 200)}`,
      );
    }
    throw new Error(`Sheets ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Creates a spreadsheet owned by the caller.
 *
 * Frequently fails with 403 for service accounts: they have no Drive storage of
 * their own, so there is nowhere to put the file. The reliable route is for a
 * human to create the Sheet and share it with the service account as Editor —
 * which is better anyway, since the human then owns the file and can see it in
 * their own Drive.
 */
export async function createSpreadsheet(token: string, title: string, tabs: SheetTab[]) {
  const json = (await call("", token, {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: tabs.map((t, i) => ({
        properties: { sheetId: i, title: t.title, gridProperties: { frozenRowCount: 1 } },
      })),
    }),
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
      throw new Error(
        "This service account cannot create a Sheet — service accounts have no Drive storage of their own. " +
          "Create a blank Google Sheet yourself, share it with the service account address as Editor, " +
          "then paste its URL into the Connect field. The app will fill it in.",
      );
    }
    throw e;
  })) as { spreadsheetId: string; spreadsheetUrl: string };

  await pushTabs(token, json.spreadsheetId, tabs);
  return { spreadsheetId: json.spreadsheetId, url: json.spreadsheetUrl };
}

/**
 * Replaces the contents of each tab. Clear-then-write rather than append, so
 * the Sheet always matches the database exactly and re-running is idempotent.
 */
export async function pushTabs(token: string, spreadsheetId: string, tabs: SheetTab[]) {
  for (const t of tabs) {
    await call(`/${spreadsheetId}/values/${encodeURIComponent(t.title)}:clear`, token, { method: "POST", body: "{}" });
  }

  await call(`/${spreadsheetId}/values:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: tabs.map((t) => ({
        range: `${t.title}!A1`,
        values: [t.headers, ...t.rows.map((r) => r.map((c) => (c === null ? "" : c)))],
      })),
    }),
  });

  // Formatting needs the real sheetIds, which are not 0..n on a Sheet that was
  // created by hand or had tabs added later.
  const meta = (await call(`/${spreadsheetId}?fields=sheets.properties`, token)) as {
    sheets?: Array<{ properties: { title: string; sheetId: number } }>;
  };
  const idByTitle = new Map((meta.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));

  await call(`/${spreadsheetId}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({
      requests: tabs.flatMap((t) => {
        const id = idByTitle.get(t.title);
        if (id === undefined) return [];
        return [
        {
          repeatCell: {
            range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.06, green: 0.39, blue: 0.4 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        { updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        ];
      }),
    }),
  });

  return { spreadsheetId, tabs: tabs.map((t) => t.title) };
}

/** Turns the same JSON the workbook builder consumes into Sheets tabs. */
export function tabsFromExport(data: {
  introductions: Record<string, unknown>[];
  companies: Record<string, unknown>[];
  pairings: Record<string, unknown>[];
}): SheetTab[] {
  const tab = (title: string, rows: Record<string, unknown>[], cols: [string, string][]): SheetTab => ({
    title,
    headers: cols.map(([, label]) => label),
    rows: rows.map((r) =>
      cols.map(([key]) => {
        const v = r[key];
        if (v === undefined || v === null || v === "") return "";
        return typeof v === "number" ? v : String(v);
      }),
    ),
  });

  return [
    tab("Introductions", data.introductions, [
      ["real", "Data"], ["status", "Status"],
      ["a_name", "Company A (supplier)"], ["a_website", "A website"], ["a_person", "A contact person"],
      ["a_title", "A title"], ["a_email", "A email"], ["a_phone", "A phone"], ["a_provides", "What A provides"],
      ["b_name", "Company B (buyer)"], ["b_website", "B website"], ["b_industry", "B industry"],
      ["b_person", "B contact person"], ["b_title", "B title"], ["b_email", "B email"], ["b_phone", "B phone"],
      ["b_address", "B address"], ["why_now", "Why B buys now"], ["timing", "Timing window"],
      ["deal", "Deal size"], ["rate", "Commission %"], ["commission", "Est. commission"], ["source", "Source"],
    ]),
    tab("Companies", data.companies, [
      ["real", "Data"], ["name", "Company"], ["role", "Role"], ["website", "Website"], ["domain", "Domain"],
      ["industry", "Industry"], ["size", "Size"], ["person", "Contact person"], ["title", "Title"],
      ["email", "Email"], ["phone", "Phone"], ["all_contacts", "All emails found"], ["address", "Address"],
      ["city", "City"], ["verified", "Data verified"], ["source_url", "Source URL"], ["scraped", "Scraped"],
    ]),
    tab("Pairings", data.pairings, [
      ["a_industry", "Industry A (recruit)"], ["b_industry", "Industry B (sell to)"], ["lane", "Lane"],
      ["what_a_has", "What A has"], ["what_b_needs", "What B needs"], ["trigger", "Why now (trigger)"],
      ["timing", "Timing window"], ["reach_a", "Reach A"], ["reach_b", "Reach B"],
      ["deal_low", "Deal low"], ["deal_high", "Deal high"], ["rate", "Commission %"],
      ["score", "Score"], ["status", "Status"],
    ]),
  ];
}


/**
 * Read a tab back, as rows of strings.
 *
 * The push side of this file is deliberately destructive — clear-then-write, so
 * the Sheet always matches the database. That is right for tabs the database
 * owns, and exactly wrong for one a human types into: the Calls tab is meant to
 * be edited by hand, so it has to be read before it is written or the first
 * sync eats the morning's notes.
 *
 * Returns [] rather than throwing when the tab does not exist yet, since "not
 * created" and "empty" mean the same thing to the caller.
 */
export async function readTab(
  token: string,
  spreadsheetId: string,
  title: string,
): Promise<string[][]> {
  try {
    const json = (await call(
      `/${spreadsheetId}/values/${encodeURIComponent(title)}?majorDimension=ROWS`,
      token,
    )) as { values?: string[][] };
    return json.values ?? [];
  } catch (e) {
    if (e instanceof Error && /\b400\b|Unable to parse range/i.test(e.message)) return [];
    throw e;
  }
}

/** Create a tab if it is missing. Safe to call every sync. */
export async function ensureTab(token: string, spreadsheetId: string, title: string) {
  const meta = (await call(`/${spreadsheetId}?fields=sheets.properties`, token)) as {
    sheets?: Array<{ properties: { title: string; sheetId: number } }>;
  };
  const found = (meta.sheets ?? []).find((x) => x.properties.title === title);
  if (found) return found.properties.sheetId;

  const made = (await call(`/${spreadsheetId}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] }),
  })) as { replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> };
  return made.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
}

/** Write one tab without clearing the rest of the spreadsheet. */
export async function writeTab(token: string, spreadsheetId: string, tab: SheetTab) {
  await call(`/${spreadsheetId}/values/${encodeURIComponent(tab.title)}:clear`, token, {
    method: "POST",
    body: "{}",
  });
  await call(
    `/${spreadsheetId}/values/${encodeURIComponent(`${tab.title}!A1`)}?valueInputOption=USER_ENTERED`,
    token,
    { method: "PUT", body: JSON.stringify({ values: [tab.headers, ...tab.rows] }) },
  );
}

/**
 * Dress a hand-edited tab: header styling, frozen row, a dropdown on one
 * column, and grey text on the columns the database owns.
 *
 * The dropdown matters more than it looks. Outcomes are matched back by exact
 * string, so a typed "no answer" against an expected "No answer" is a row that
 * silently does nothing — a picker removes the whole class of problem.
 */
export async function formatCallsTab(
  token: string,
  spreadsheetId: string,
  sheetId: number,
  opts: { outcomes: readonly string[]; outcomeColumn: number; readOnlyThrough: number; idColumn: number },
) {
  await call(`/${spreadsheetId}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.06, green: 0.39, blue: 0.4 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        // The columns the database owns, greyed so it is visible at a glance
        // which cells are safe to type in and which get overwritten.
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: opts.readOnlyThrough },
            cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 0.42, green: 0.46, blue: 0.51 } } } },
            fields: "userEnteredFormat.textFormat.foregroundColor",
          },
        },
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: opts.outcomeColumn,
              endColumnIndex: opts.outcomeColumn + 1,
            },
            rule: {
              condition: { type: "ONE_OF_LIST", values: opts.outcomes.map((o) => ({ userEnteredValue: o })) },
              showCustomUi: true,
              strict: false,
            },
          },
        },
        // The key column, narrowed and greyed. It is how a row finds its way
        // back to a record; losing it turns an edit into a new lead.
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: opts.idColumn, endColumnIndex: opts.idColumn + 1 },
            cell: { userEnteredFormat: { textFormat: { fontSize: 8, foregroundColor: { red: 0.7, green: 0.73, blue: 0.76 } } } },
            fields: "userEnteredFormat.textFormat",
          },
        },
      ],
    }),
  });
}

// ---------------------------------------------------------------------------
// One-call sync used by the app.
// ---------------------------------------------------------------------------

/**
 * Pushes the current database state into the connected Sheet.
 *
 * Clear-then-write, so the Sheet always matches the database exactly and
 * re-running is idempotent. Anything typed into these tabs by hand is
 * overwritten on the next sync — notes belong in the app, which is also where
 * the send gate reads suppression from.
 */
export async function syncBusinessSheet(
  businessId: string,
  exportData: {
    introductions: Record<string, unknown>[];
    companies: Record<string, unknown>[];
    pairings: Record<string, unknown>[];
  },
  opts: { title?: string } = {},
): Promise<{ sheetId: string; url: string; rows: number; created: boolean }> {
  const { db } = await import("@/lib/db");
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId } });

  const token = await getAccessToken();
  const tabs = tabsFromExport(exportData);
  let sheetId = business.sheetId;
  let created = false;

  if (!sheetId) {
    const made = await createSpreadsheet(token, opts.title ?? `${business.name} — pair database`, tabs);
    sheetId = made.spreadsheetId;
    created = true;
  } else {
    // Ensure every tab exists before writing — a Sheet created by hand has one
    // tab called "Sheet1" and writing to a missing range is a 400.
    const meta = (await call(`/${sheetId}?fields=sheets.properties`, token)) as {
      sheets?: Array<{ properties: { title: string; sheetId: number } }>;
    };
    const have = new Set((meta.sheets ?? []).map((s) => s.properties.title));
    const missing = tabs.filter((t) => !have.has(t.title));
    if (missing.length) {
      await call(`/${sheetId}:batchUpdate`, token, {
        method: "POST",
        body: JSON.stringify({
          requests: missing.map((t) => ({ addSheet: { properties: { title: t.title } } })),
        }),
      });
    }
    await pushTabs(token, sheetId, tabs);
  }

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  await db.business.update({
    where: { id: businessId },
    data: { sheetId, sheetUrl: url, sheetSyncedAt: new Date() },
  });

  return {
    sheetId,
    url,
    rows: tabs.reduce((n, t) => n + t.rows.length, 0),
    created,
  };
}
