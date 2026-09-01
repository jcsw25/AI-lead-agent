/**
 * Email adapters. One interface, three implementations, chosen by EMAIL_ADAPTER.
 *
 *   mock    - writes to the DB, no network. Default.
 *   resend  - API key, send from your own domain. Simplest real sending.
 *   gmail   - OAuth, sends from your actual mailbox so replies thread naturally.
 *
 * Nothing here decides WHETHER to send. That is the send gate's job
 * (src/lib/gate.ts) and there is no path to a provider that bypasses it.
 */

export type OutboundEmail = {
  to: string;
  toName?: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
};

export type SendResult = { providerMessageId: string; providerThreadId?: string; provider: string };

export type InboundEmail = {
  providerMessageId: string;
  providerThreadId?: string;
  fromEmail: string;
  subject: string;
  text: string;
  receivedAt: Date;
  inReplyTo?: string;
};

export interface EmailAdapter {
  readonly name: string;
  readonly canReceive: boolean;
  send(email: OutboundEmail): Promise<SendResult>;
  fetchSince?(cursor: string | null): Promise<{ messages: InboundEmail[]; cursor: string | null }>;
}

// ---------------------------------------------------------------------------

class MockAdapter implements EmailAdapter {
  readonly name = "mock";
  readonly canReceive = false;
  async send(email: OutboundEmail): Promise<SendResult> {
    // Guard rail: sample data uses reserved TLDs. If a mock send is somehow
    // pointed at a real address, fail loudly rather than pretending.
    if (!/\.(test|example|invalid|localhost)$/.test(email.to.split("@")[1] ?? "")) {
      console.warn(`[mock] would send to a real-looking address: ${email.to}`);
    }
    return { providerMessageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, provider: "mock" };
  }
}

class ResendAdapter implements EmailAdapter {
  readonly name = "resend";
  readonly canReceive = false; // inbound needs a webhook; see docs
  constructor(private apiKey: string) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${email.fromName} <${email.fromEmail}>`,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        headers: email.headers,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { id: string };
    return { providerMessageId: json.id, provider: "resend" };
  }
}

/**
 * Gmail. Sends as the authenticated user, so replies land in their real inbox
 * and thread properly - which matters more for cold outreach than any
 * deliverability trick.
 *
 * You do NOT need Google to verify the app: you are the only user. Create an
 * OAuth client in your own Google Cloud project, leave it in Testing, add
 * yourself as a test user. See docs/08-going-live.md.
 */
class GmailAdapter implements EmailAdapter {
  readonly name = "gmail";
  readonly canReceive = true;
  constructor(private accessToken: string) {}

  private static rfc822(e: OutboundEmail): string {
    const lines = [
      `From: ${e.fromName} <${e.fromEmail}>`,
      `To: ${e.toName ? `${e.toName} <${e.to}>` : e.to}`,
      `Subject: ${e.subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      ...Object.entries(e.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
      "",
      e.text,
    ];
    return Buffer.from(lines.join("\r\n")).toString("base64url");
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: GmailAdapter.rfc822(email) }),
    });
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { id: string; threadId: string };
    return { providerMessageId: json.id, providerThreadId: json.threadId, provider: "gmail" };
  }

  async fetchSince(cursor: string | null) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", cursor ? `is:inbox after:${cursor}` : "is:inbox newer_than:7d");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${await res.text()}`);
    const list = (await res.json()) as { messages?: Array<{ id: string }> };

    const messages: InboundEmail[] = [];
    for (const m of list.messages ?? []) {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!r.ok) continue;
      const full = (await r.json()) as {
        id: string; threadId: string; internalDate: string; snippet: string;
        payload: { headers: Array<{ name: string; value: string }> };
      };
      const h = (n: string) => full.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
      messages.push({
        providerMessageId: full.id,
        providerThreadId: full.threadId,
        fromEmail: (h("from").match(/<(.+?)>/)?.[1] ?? h("from")).toLowerCase(),
        subject: h("subject"),
        text: full.snippet,
        receivedAt: new Date(Number(full.internalDate)),
        inReplyTo: h("in-reply-to") || undefined,
      });
    }
    return { messages, cursor: String(Math.floor(Date.now() / 1000)) };
  }
}

export function getEmailAdapter(opts?: { accessToken?: string }): EmailAdapter {
  const which = process.env.EMAIL_ADAPTER ?? "mock";
  if (which === "resend") {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("EMAIL_ADAPTER=resend but RESEND_API_KEY is not set.");
    return new ResendAdapter(key);
  }
  if (which === "gmail") {
    const token = opts?.accessToken;
    if (!token) throw new Error("EMAIL_ADAPTER=gmail but no access token was supplied for this mailbox.");
    return new GmailAdapter(token);
  }
  return new MockAdapter();
}

export const isLiveSending = () => (process.env.EMAIL_ADAPTER ?? "mock") !== "mock";
