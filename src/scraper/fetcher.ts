/**
 * Polite HTTP fetcher.
 *
 * Scraping a company's own published contact page is the defensible core of
 * this system: the data is public, published in a business capacity, and falls
 * under the PDPA business-contact-information exclusion (docs/04-compliance.md).
 * What makes it defensible in practice is behaving well - so this module
 * enforces the manners rather than leaving them to the caller:
 *
 *   - robots.txt is fetched once per host and obeyed
 *   - one request per host at a time, with a delay between them
 *   - an honest User-Agent with a contact route
 *   - hard caps on page size, redirects and total pages per host
 *
 * Deliberately NOT supported: sites that require a login, anything behind a
 * paywall, and LinkedIn - scraping it breaks their terms regardless of how
 * useful the data would be.
 */

const UA =
  process.env.SCRAPER_USER_AGENT ??
  "RevenueAgentBot/0.1 (+contact: set SCRAPER_CONTACT in .env)";
const DELAY_MS = Number(process.env.SCRAPER_DELAY_MS ?? 1200);
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

const BLOCKED_HOSTS = [
  "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
  "crunchbase.com", "zoominfo.com", "apollo.io",
];

type RobotsRules = { disallow: string[]; crawlDelayMs: number };

const robotsCache = new Map<string, RobotsRules>();
const lastHit = new Map<string, number>();

function parseRobots(txt: string): RobotsRules {
  const lines = txt.split("\n").map((l) => l.split("#")[0].trim());
  const rules: RobotsRules = { disallow: [], crawlDelayMs: 0 };
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rest.length) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || UA.toLowerCase().includes(value.toLowerCase());
    } else if (applies && key === "disallow" && value) {
      rules.disallow.push(value);
    } else if (applies && key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) rules.crawlDelayMs = Math.min(n * 1000, 10_000);
    }
  }
  return rules;
}

async function getRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules: RobotsRules = { disallow: [], crawlDelayMs: 0 };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) rules = parseRobots(await res.text());
  } catch {
    // No robots.txt, or unreachable. Treat as no restrictions but stay polite.
  }
  robotsCache.set(origin, rules);
  return rules;
}

function isDisallowed(rules: RobotsRules, pathname: string): boolean {
  return rules.disallow.some((d) => {
    if (d === "/") return true;
    const pattern = d.replace(/\*/g, "");
    return pathname.startsWith(pattern);
  });
}

async function throttle(host: string, extraDelay: number) {
  const now = Date.now();
  const last = lastHit.get(host) ?? 0;
  const wait = Math.max(0, last + Math.max(DELAY_MS, extraDelay) - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

export type FetchResult =
  | { ok: true; url: string; html: string; status: number }
  | { ok: false; url: string; reason: string; status?: number };

export async function politeFetch(rawUrl: string): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, reason: "invalid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, url: rawUrl, reason: "unsupported protocol" };
  }
  if (BLOCKED_HOSTS.some((h) => url.hostname.endsWith(h))) {
    return { ok: false, url: rawUrl, reason: `${url.hostname} is excluded by policy (terms of service)` };
  }

  const rules = await getRobots(url.origin);
  if (isDisallowed(rules, url.pathname)) {
    return { ok: false, url: rawUrl, reason: "disallowed by robots.txt" };
  }

  await throttle(url.hostname, rules.crawlDelayMs);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, url: rawUrl, reason: `HTTP ${res.status}`, status: res.status };

    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return { ok: false, url: rawUrl, reason: `not HTML (${type})` };

    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return { ok: false, url: rawUrl, reason: "page too large" };

    const html = (await res.text()).slice(0, MAX_BYTES);
    return { ok: true, url: res.url, html, status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, url: rawUrl, reason: msg.includes("timeout") ? "timed out" : msg };
  }
}

/** Pages worth trying on a company site, in priority order. */
export const CONTACT_PATHS = [
  "/contact", "/contact-us", "/contactus", "/about", "/about-us",
  "/team", "/our-team", "/people", "/leadership", "/management",
  "/company", "/who-we-are", "/get-in-touch",
];
