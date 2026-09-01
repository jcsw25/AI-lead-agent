import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Gmail OAuth: connection, encrypted credential storage, and token refresh.
 *
 * Gmail rather than a transactional sender because of what happens AFTER the
 * send. Replies to jasoncsw25@gmail.com land in that inbox whatever we send
 * through; only Gmail lets the system read them back. Without that the reply
 * rate, the outcome data, and the entire learning loop are invisible — the
 * system would send forever and never learn anything.
 *
 * Scopes are the minimum that allows both: send, and read for reply matching.
 */

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function gmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(): string {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base}/api/gmail/callback`;
}

// ---------------------------------------------------------------------------
// Credential encryption
// ---------------------------------------------------------------------------

/**
 * A refresh token is a long-lived key to someone's mailbox. Storing it as
 * plaintext in a column means anyone with read access to the database — a
 * backup, a screenshot of Prisma Studio, a support session — has the ability to
 * send mail as them indefinitely. Encrypting it does not make the database
 * safe, but it does mean the token is not sitting in the clear.
 *
 * The key comes from CREDENTIAL_SECRET. Without it, nothing can be stored,
 * which is the correct failure: a missing key must not silently downgrade to
 * plaintext.
 */
function key(): Buffer {
  const secret = process.env.CREDENTIAL_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "CREDENTIAL_SECRET is not set (min 16 chars). Add it to .env — it encrypts the mailbox refresh token.",
    );
  }
  return scryptSync(secret, "revenue-agent-mailbox", 32);
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split(".");
  if (!iv || !tag || !data) throw new Error("Stored credential is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export function authorizeUrl(state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  // Needed to receive a refresh token at all — without both, Google returns
  // only a one-hour access token and the connection dies silently overnight.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`Google token endpoint: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json;
}

/** Exchange the one-time code for tokens and store the mailbox. */
export async function completeConnection(businessId: string, code: string) {
  const tokens = await tokenRequest({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and connect again.",
    );
  }

  // Which mailbox did they actually authorise? Ask rather than assume — the
  // account they pick may not be the one in the send policy.
  const who = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!who.ok) throw new Error(`Could not read the authorised account: ${who.status}`);
  const { email } = (await who.json()) as { email: string };

  const credential = encrypt(
    JSON.stringify({
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    }),
  );

  const mailbox = await db.mailbox.upsert({
    where: { businessId_address: { businessId, address: email } },
    create: { businessId, provider: "gmail", address: email, credentialRef: credential, isActive: true },
    update: { credentialRef: credential, isActive: true, provider: "gmail" },
  });

  return { mailboxId: mailbox.id, address: email };
}

/**
 * A usable access token for this mailbox, refreshed if needed.
 *
 * Access tokens last an hour. Anything that sends must call this rather than
 * reading credentialRef directly, or sending works during setup and fails
 * quietly the next day.
 */
export async function accessTokenFor(mailboxId: string): Promise<string> {
  const mailbox = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
  if (!mailbox.credentialRef) throw new Error(`Mailbox ${mailbox.address} has no stored credential.`);

  const cred = JSON.parse(decrypt(mailbox.credentialRef)) as {
    refreshToken: string;
    accessToken: string;
    expiresAt: number;
  };

  // Refresh a minute early rather than racing the expiry.
  if (cred.accessToken && cred.expiresAt > Date.now() + 60_000) return cred.accessToken;

  const tokens = await tokenRequest({
    refresh_token: cred.refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    grant_type: "refresh_token",
  });

  await db.mailbox.update({
    where: { id: mailboxId },
    data: {
      credentialRef: encrypt(
        JSON.stringify({
          refreshToken: cred.refreshToken, // refresh tokens are not reissued
          accessToken: tokens.access_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        }),
      ),
    },
  });

  return tokens.access_token;
}

/** The mailbox outbound mail should go through, if one is connected. */
export async function activeMailbox(businessId: string) {
  return db.mailbox.findFirst({
    where: { businessId, provider: "gmail", isActive: true },
  });
}

export async function disconnectMailbox(businessId: string, mailboxId: string) {
  await db.mailbox.updateMany({
    where: { id: mailboxId, businessId },
    data: { isActive: false, credentialRef: null },
  });
}
