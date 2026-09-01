import { db } from "@/lib/db";

/**
 * Live connection checks.
 *
 * Every probe makes a real call. "The key is present in .env" is not a status —
 * a rotated key, an exhausted quota, a revoked OAuth grant and a typo all look
 * identical from the environment file, and each of them has already cost time
 * on this project. A rejected client secret was diagnosed by asking Google
 * rather than by re-reading the config, and that is the pattern here.
 *
 * Probes are chosen to be free wherever a free one exists. Only Serper has no
 * zero-cost endpoint, so its check spends one credit and is cached hard.
 */

export type ProbeStatus = "live" | "error" | "not_configured" | "degraded";

export type Probe = {
  key: string;
  name: string;
  status: ProbeStatus;
  detail: string;
  /** What this being down actually stops you doing. */
  impact: string;
  latencyMs?: number;
  cost?: string;
};

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
};

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// ---------------------------------------------------------------------------

async function probeAnthropic(): Promise<Probe> {
  const base = {
    key: "anthropic",
    name: "Anthropic",
    impact: "Query strategist, pairing generation and all email drafting stop. Discovery and scoring keep working.",
    cost: "free — model list endpoint",
  };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ...base, status: "not_configured", detail: "ANTHROPIC_API_KEY is not set in .env." };
  }
  try {
    // The models endpoint costs nothing and still proves the key is accepted.
    const { value: res, ms } = await timed(() =>
      fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(12_000),
      }),
    );
    if (res.status === 401) {
      return { ...base, status: "error", detail: "Key rejected (401). It may have been rotated or revoked.", latencyMs: ms };
    }
    if (!res.ok) {
      return { ...base, status: "error", detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`, latencyMs: ms };
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return {
      ...base,
      status: "live",
      detail: `Key accepted. ${json.data?.length ? `Newest model visible: ${json.data[0].id}.` : ""}`,
      latencyMs: ms,
    };
  } catch (e) {
    return { ...base, status: "error", detail: short(e) };
  }
}

async function probeSerper(): Promise<Probe> {
  const base = {
    key: "serper",
    name: "Serper (Google search)",
    impact: "Company discovery stops entirely. Everything already in the database is unaffected.",
    cost: "1 credit per check — cached for 30 minutes",
  };
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return { ...base, status: "not_configured", detail: "SERPER_API_KEY is not set in .env." };

  try {
    const { value: res, ms } = await timed(() =>
      fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: "connection check", gl: "sg", num: 1 }),
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (res.status === 401 || res.status === 403) {
      return { ...base, status: "error", detail: "Key rejected. Check it at serper.dev.", latencyMs: ms };
    }
    if (res.status === 429) {
      return { ...base, status: "error", detail: "Credits exhausted. Top up at serper.dev/dashboard.", latencyMs: ms };
    }
    if (!res.ok) return { ...base, status: "error", detail: `HTTP ${res.status}`, latencyMs: ms };
    const json = (await res.json()) as { credits?: number; organic?: unknown[] };
    return {
      ...base,
      status: "live",
      detail:
        `Search returned ${json.organic?.length ?? 0} result(s).` +
        (typeof json.credits === "number" ? ` Credits remaining on this call: ${json.credits}.` : ""),
      latencyMs: ms,
    };
  } catch (e) {
    return { ...base, status: "error", detail: short(e) };
  }
}

async function probeGoogleServiceAccount(): Promise<Probe> {
  const base = {
    key: "gcloud",
    name: "Google Cloud service account",
    impact: "The Sheet cannot be written. Nothing else depends on it.",
    cost: "free - token mint",
  };
  try {
    const { resolveCredentials, credentialSource, serviceAccountEmail, getAccessToken } = await import(
      "@/adapters/sheets"
    );
    if (!resolveCredentials()) {
      return {
        ...base,
        status: "not_configured",
        detail: "No credentials found. Set GOOGLE_APPLICATION_CREDENTIALS to the key file, or run gcloud auth.",
      };
    }
    // Minting a token proves the key is valid AND that the machine clock is
    // right - a service-account JWT is rejected outright if time has drifted,
    // which presents as an auth failure rather than a clock problem.
    const { ms } = await timed(getAccessToken);
    return {
      ...base,
      status: "live",
      detail: `Token minted from ${credentialSource()}${serviceAccountEmail() ? ` · ${serviceAccountEmail()}` : ""}.`,
      latencyMs: ms,
    };
  } catch (e) {
    return { ...base, status: "error", detail: short(e) };
  }
}

async function probeSheet(businessId: string): Promise<Probe> {
  const base = {
    key: "sheet",
    name: "Google Sheet",
    impact: "Data stays in the database and the app; only the shared spreadsheet goes stale.",
    cost: "free — metadata read",
  };
  const biz = await db.business.findUnique({
    where: { id: businessId },
    select: { sheetId: true, sheetUrl: true, sheetSyncedAt: true, sheetAutoSync: true },
  });
  if (!biz?.sheetId) {
    return { ...base, status: "not_configured", detail: "No Sheet connected. Connect one on the Generator page." };
  }
  try {
    const { getAccessToken } = await import("@/adapters/sheets");
    const token = await getAccessToken();
    const { value: res, ms } = await timed(() =>
      fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${biz.sheetId}?fields=properties.title,sheets.properties.title`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) },
      ),
    );
    if (res.status === 403) {
      return { ...base, status: "error", detail: "Access denied. Share the Sheet with the service account as Editor.", latencyMs: ms };
    }
    if (res.status === 404) {
      return { ...base, status: "error", detail: "Sheet not found — it may have been deleted or the id is wrong.", latencyMs: ms };
    }
    if (!res.ok) return { ...base, status: "error", detail: `HTTP ${res.status}`, latencyMs: ms };
    const j = (await res.json()) as { properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> };
    const stale = biz.sheetSyncedAt ? Date.now() - biz.sheetSyncedAt.getTime() > 24 * 36e5 : true;
    return {
      ...base,
      status: stale ? "degraded" : "live",
      detail:
        `"${j.properties?.title ?? "untitled"}" · tabs: ${(j.sheets ?? []).map((s) => s.properties?.title).filter(Boolean).join(", ")}` +
        ` · last synced ${biz.sheetSyncedAt ? biz.sheetSyncedAt.toLocaleString() : "never"}` +
        (biz.sheetAutoSync ? "" : " · auto-sync is OFF"),
      latencyMs: ms,
    };
  } catch (e) {
    return { ...base, status: "error", detail: short(e) };
  }
}

async function probeGmail(businessId: string): Promise<Probe> {
  const base = {
    key: "gmail",
    name: "Gmail (send + replies)",
    impact: "No email can be sent and no replies can be read. Everything else keeps working.",
    cost: "free — profile read",
  };
  try {
    const { activeMailbox, accessTokenFor, gmailConfigured } = await import("@/lib/gmail-auth");
    if (!gmailConfigured()) {
      return { ...base, status: "not_configured", detail: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set." };
    }
    const mailbox = await activeMailbox(businessId);
    if (!mailbox) {
      return { ...base, status: "not_configured", detail: "No mailbox connected. Connect one in Settings." };
    }
    const token = await accessTokenFor(mailbox.id);
    const { value: res, ms } = await timed(() =>
      fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(12_000),
      }),
    );
    if (!res.ok) {
      return { ...base, status: "error", detail: `HTTP ${res.status} — the grant may have been revoked. Reconnect in Settings.`, latencyMs: ms };
    }
    const j = (await res.json()) as { emailAddress?: string };
    const adapter = process.env.EMAIL_ADAPTER ?? "mock";
    return {
      ...base,
      status: adapter === "gmail" ? "live" : "degraded",
      detail:
        `Authorised as ${j.emailAddress}. Token refresh works.` +
        (adapter === "gmail" ? "" : ` EMAIL_ADAPTER is "${adapter}", so nothing actually sends.`),
      latencyMs: ms,
    };
  } catch (e) {
    return { ...base, status: "error", detail: short(e) };
  }
}

async function probeDatabase(): Promise<Probe> {
  const base = {
    key: "database",
    name: "Database (PGlite)",
    impact: "Nothing works without it.",
    cost: "free",
  };
  try {
    const { ms } = await timed(() => db.$queryRaw`SELECT 1`);
    const companies = await db.company.count();
    return { ...base, status: "live", detail: `Reachable · ${companies} companies stored.`, latencyMs: ms };
  } catch (e) {
    return { ...base, status: "error", detail: `${short(e)} — is "npm run db:dev" running?` };
  }
}

/** Run every probe. Failures are reported, never thrown. */
export async function runHealthChecks(businessId: string): Promise<Probe[]> {
  const results = await Promise.allSettled([
    probeDatabase(),
    probeAnthropic(),
    probeSerper(),
    probeGoogleServiceAccount(),
    probeSheet(businessId),
    probeGmail(businessId),
  ]);
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          key: `probe-${i}`,
          name: "Unknown probe",
          status: "error" as const,
          detail: short(r.reason),
          impact: "unknown",
        },
  );
}
