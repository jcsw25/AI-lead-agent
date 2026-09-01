import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { redirectUri } from "@/lib/gmail-auth";

export const dynamic = "force-dynamic";

/** Pull replies from the connected mailbox and classify them. */
async function checkReplies(businessId: string) {
  "use server";
  const { pollReplies } = await import("@/lib/outreach/replies");
  try {
    await pollReplies(businessId);
  } catch (e) {
    console.error("[replies]", e instanceof Error ? e.message : e);
  }
  revalidatePath("/settings");
  revalidatePath("/approvals");
}

/**
 * Drop the stored credential. Note this does not revoke Google's grant — the
 * user has to do that at myaccount.google.com/permissions, and the UI says so
 * rather than implying a disconnect here is a full revocation.
 */
async function disconnectGmail(businessId: string, formData: FormData) {
  "use server";
  const mailboxId = String(formData.get("mailboxId") ?? "");
  if (!mailboxId) return;
  const { disconnectMailbox } = await import("@/lib/gmail-auth");
  await disconnectMailbox(businessId, mailboxId);
  revalidatePath("/settings");
}

async function saveIdentity(businessId: string, formData: FormData) {
  "use server";
  const v = (k: string) => String(formData.get(k) ?? "").trim() || null;
  const n = (k: string, d: number) => Number(formData.get(k) ?? d) || d;
  const bizName = String(formData.get("businessName") ?? "").trim();
  if (bizName) await db.business.update({ where: { id: businessId }, data: { name: bizName } });

  await db.sendPolicy.upsert({
    where: { businessId },
    update: {
      senderName: v("senderName"),
      senderContactEmail: v("senderContactEmail"),
      senderContactPhone: v("senderContactPhone"),
      senderPostalAddr: v("senderPostalAddr"),
      dailySendCap: n("dailySendCap", 100),
      onThresholdCross: String(formData.get("onThresholdCross") ?? "block"),
    },
    create: {
      businessId,
      senderName: v("senderName"),
      senderContactEmail: v("senderContactEmail"),
      senderContactPhone: v("senderContactPhone"),
      senderPostalAddr: v("senderPostalAddr"),
      dailySendCap: n("dailySendCap", 100),
      onThresholdCross: String(formData.get("onThresholdCross") ?? "block"),
    },
  });
  revalidatePath("/settings");
  revalidatePath("/outreach");
  revalidatePath("/");
  revalidatePath("/generator");
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="row">
      <div>
        <b>{label}</b>
        <div className="muted">{detail}</div>
      </div>
      <span className={`lane ${ok ? "lane-TRIGGER" : "lane-CONTRARIAN"}`}>{ok ? "READY" : "NOT SET"}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const policy = await db.sendPolicy.findUnique({ where: { businessId: business.id } });
  const adapter = process.env.EMAIL_ADAPTER ?? "mock";
  const hasResend = Boolean(process.env.RESEND_API_KEY);
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID);
  const hasSecret = Boolean(process.env.GOOGLE_CLIENT_SECRET && process.env.CREDENTIAL_SECRET);
  const mailbox = await db.mailbox.findFirst({
    where: { businessId: business.id, provider: "gmail", isActive: true },
  });
  const redirect = redirectUri();

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Settings</p>
        <h1>Going live</h1>
        <p className="sub">
          Three switches take this out of demo mode. Each one is independent — you can turn on real research
          without turning on real sending.
        </p>
      </div>

      <h2>Status</h2>
      <div className="card">
        <Status
          ok={hasApiKey()}
          label="1 · Research and copy"
          detail={
            hasApiKey()
              ? "ANTHROPIC_API_KEY is set. Agents search the web and write real copy."
              : "Set ANTHROPIC_API_KEY in .env. Without it every agent returns labelled sample output."
          }
        />
        <Status
          ok={adapter !== "mock"}
          label="2 · Sending"
          detail={
            adapter === "mock"
              ? "EMAIL_ADAPTER=mock. Messages pass the gate and are recorded, but nothing leaves this machine."
              : `EMAIL_ADAPTER=${adapter}${adapter === "resend" && !hasResend ? " — but RESEND_API_KEY is missing" : ""}`
          }
        />
        <Status
          ok={Boolean(policy?.senderContactEmail)}
          label="3 · Sender identity"
          detail={
            policy?.senderContactEmail
              ? `${policy.senderName} · ${policy.senderContactEmail}`
              : "Required before any real send — the Spam Control Act requires a working contact route on every commercial message."
          }
        />
      </div>

      <h2>Sender identity</h2>
      <p className="muted" style={{ marginTop: "-.4rem" }}>
        Appended to every outbound email along with a one-click unsubscribe. Not optional: an unsolicited
        commercial message must carry an accurate way to reach you.
      </p>
      <div className="card">
        <form action={saveIdentity.bind(null, business.id)} className="callform">
          <label>
            Your business name <span className="muted">— shown as the sender and used across the app</span>
            <input name="businessName" defaultValue={business.name} required />
          </label>
          <div className="two-up">
            <label>Sender name<input name="senderName" defaultValue={policy?.senderName ?? business.name} /></label>
            <label>Reply-to email<input name="senderContactEmail" type="email" defaultValue={policy?.senderContactEmail ?? ""} placeholder="you@yourdomain.com" /></label>
          </div>
          <div className="two-up">
            <label>Contact phone<input name="senderContactPhone" defaultValue={policy?.senderContactPhone ?? ""} placeholder="+65 …" /></label>
            <label>Daily send cap<input name="dailySendCap" type="number" min={1} max={2000} defaultValue={policy?.dailySendCap ?? 100} /></label>
          </div>
          <label>Postal address<input name="senderPostalAddr" defaultValue={policy?.senderPostalAddr ?? ""} /></label>
          <label>
            When a batch would cross the bulk threshold
            <select name="onThresholdCross" defaultValue={policy?.onThresholdCross ?? "block"}>
              <option value="block">Block and warn me (recommended)</option>
              <option value="comply">Send anyway with an &lt;ADV&gt; prefix (EDM mode)</option>
            </select>
          </label>
          <button className="btn" type="submit">Save</button>
        </form>
      </div>

      <h2>Connecting a mailbox</h2>
      <div className="grid two">
        <article className="card play">
          <div className="play-top">
            <div>
              <h3>Resend</h3>
              <span className="motion">Fastest · sends from your own domain</span>
            </div>
            <span className={`lane ${hasResend ? "lane-TRIGGER" : "lane-ADJACENT"}`}>{hasResend ? "KEY SET" : "NOT SET"}</span>
          </div>
          <p>
            An API key and a verified domain — about ten minutes. Best deliverability control, but replies land
            in whatever inbox that domain points at, and reply detection needs an inbound webhook.
          </p>
          <ol className="phases">
            <li>Create a key at resend.com and verify your sending domain (SPF + DKIM).</li>
            <li>Put <code>RESEND_API_KEY</code> and <code>EMAIL_ADAPTER=resend</code> in <code>.env</code>.</li>
            <li>Restart the dev server.</li>
          </ol>
        </article>

        <article className="card play">
          <div className="play-top">
            <div>
              <h3>Gmail</h3>
              <span className="motion">Sends as you · replies thread naturally</span>
            </div>
            <span className={`lane ${hasGoogle ? "lane-TRIGGER" : "lane-ADJACENT"}`}>{hasGoogle ? "CLIENT SET" : "NOT SET"}</span>
          </div>
          <p>
            Better for cold outreach: the email comes from a real person at a real domain with history, and
            replies arrive in your actual inbox where the classifier can read them.
          </p>
          <ol className="phases">
            <li>Create an OAuth client in your own Google Cloud project.</li>
            <li>Leave it in <b>Testing</b> and add yourself as a test user — you are the only user, so Google does not need to verify the app.</li>
            <li>Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>EMAIL_ADAPTER=gmail</code>.</li>
          </ol>
          {mailbox ? (
            <>
              <p style={{ marginTop: "0.5rem" }}>
                <b>Connected:</b> {mailbox.address}
                {mailbox.lastSyncedAt && (
                  <span className="muted"> · replies last checked {mailbox.lastSyncedAt.toLocaleString()}</span>
                )}
              </p>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <form action={checkReplies.bind(null, business.id)}>
                  <button className="btn" type="submit">Check for replies</button>
                </form>
                <form action={disconnectGmail.bind(null, business.id)}>
                  <input type="hidden" name="mailboxId" value={mailbox.id} />
                  <button className="btn ghost" type="submit">Disconnect</button>
                </form>
              </div>
            </>
          ) : hasGoogle && hasSecret ? (
            <a className="btn" href="/api/gmail/connect">Connect Gmail</a>
          ) : (
            <p className="muted">
              Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and{" "}
              <code>CREDENTIAL_SECRET</code> in <code>.env</code>, restart, and a Connect button appears here.
              The redirect URI to register is <code>{redirect}</code>.
            </p>
          )}
        </article>
      </div>
    </>
  );
}
