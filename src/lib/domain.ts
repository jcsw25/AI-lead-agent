/**
 * Registrable-domain normalisation. This is the dedupe key for Company, so it
 * has to be stable: "https://WWW.Foo.com.sg/about" and "foo.com.sg" must agree.
 *
 * Handles the multi-part public suffixes that actually matter for the target
 * markets (SG, AU, UK, HK). A full Public Suffix List is worth adding when
 * discovery goes global — see docs/05-roadmap.md.
 */
const MULTI_PART_SUFFIXES = new Set([
  "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg", "per.sg",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.hk", "org.hk", "edu.hk", "gov.hk", "net.hk",
  "com.my", "net.my", "org.my", "edu.my", "gov.my",
  "co.id", "co.th", "co.nz", "co.jp", "com.cn", "com.ph", "com.vn",
]);

export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();

  if (host.includes("@")) host = host.split("@").pop()!;
  // OSM data contains "http://https://www.example.com" — strip repeatedly.
  while (/^[a-z]+:\/\//.test(host)) host = host.replace(/^[a-z]+:\/\//, "");
  host = host.split("/")[0].split("?")[0].split("#")[0];
  host = host.split(":")[0];
  host = host.replace(/^www\./, "").replace(/\.$/, "");

  if (!host || !host.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;

  const lastTwo = parts.slice(-2).join(".");
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (parts.length < take) return null;

  return parts.slice(-take).join(".");
}
