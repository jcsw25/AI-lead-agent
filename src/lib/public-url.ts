/**
 * The base URL a stranger can actually reach.
 *
 * Report links go out in email, so `localhost:3000` in one is not a small bug:
 * it is a dead link in the only message a prospect will ever open, and it
 * cannot be recalled once sent. So the value is required rather than defaulted,
 * and drafting fails loudly here instead of silently producing an email that
 * looks fine and works for nobody.
 *
 * Set PUBLIC_BASE_URL in .env once the domain exists. Until then, a tunnel
 * (ngrok, cloudflared) pointed at the dev server works for testing.
 */
export function publicBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "PUBLIC_BASE_URL is not set, so a report link would point at a machine nobody else can reach. " +
        "Add PUBLIC_BASE_URL=https://yourdomain.sg to .env (or a tunnel URL while testing).",
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Whether report links can be generated at all. */
export function publicUrlConfigured(): boolean {
  return Boolean(process.env.PUBLIC_BASE_URL?.trim());
}
