/** Prove the Gmail connection works end to end. Prints no secrets. */
import { db } from "@/lib/db";
import { accessTokenFor, activeMailbox, decrypt, encrypt } from "@/lib/gmail-auth";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const mailbox = await activeMailbox(biz.id);
if (!mailbox) { console.error("No active Gmail mailbox."); process.exit(1); }

console.log(`mailbox            ${mailbox.address}`);
console.log(`provider / active  ${mailbox.provider} / ${mailbox.isActive}`);

// 1. the stored blob decrypts and holds what it should
const cred = JSON.parse(decrypt(mailbox.credentialRef!)) as { refreshToken: string; accessToken: string; expiresAt: number };
console.log(`\nstored credential`);
console.log(`  decrypts         yes`);
console.log(`  refresh token    present (${cred.refreshToken.length} chars, starts "1//": ${cred.refreshToken.startsWith("1//")})`);
console.log(`  access token     expires ${new Date(cred.expiresAt).toLocaleTimeString()}`);
console.log(`  ciphertext leaks plaintext? ${mailbox.credentialRef!.includes(cred.refreshToken) ? "YES — BROKEN" : "no"}`);

// 2. the live token actually works against Gmail
const token = await accessTokenFor(mailbox.id);
const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { Authorization: `Bearer ${token}` },
});
const p = (await prof.json()) as { emailAddress?: string; messagesTotal?: number; error?: { message: string } };
console.log(`\nGmail API`);
console.log(`  profile call     ${prof.status} ${prof.ok ? "ok" : p.error?.message ?? ""}`);
if (prof.ok) console.log(`  authorised as    ${p.emailAddress}  (${p.messagesTotal} messages in mailbox)`);

// 3. force a refresh — this is the path that breaks silently after an hour
console.log(`\nforcing a token refresh...`);
await db.mailbox.update({
  where: { id: mailbox.id },
  data: { credentialRef: encrypt(JSON.stringify({ ...cred, accessToken: "", expiresAt: 0 })) },
});
const fresh = await accessTokenFor(mailbox.id);
const prof2 = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { Authorization: `Bearer ${fresh}` },
});
console.log(`  refreshed token  ${fresh === token ? "SAME — refresh did not run" : "new token issued"}`);
console.log(`  works on Gmail   ${prof2.status} ${prof2.ok ? "ok" : "FAILED"}`);

// 4. scopes: can we send as well as read?
const scopeCheck = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(fresh)}`);
const si = (await scopeCheck.json()) as { scope?: string };
const scopes = (si.scope ?? "").split(" ").map((s) => s.replace("https://www.googleapis.com/auth/", ""));
console.log(`\ngranted scopes     ${scopes.join(", ")}`);
console.log(`  can send         ${scopes.includes("gmail.send")}`);
console.log(`  can read replies ${scopes.includes("gmail.readonly")}`);

await db.$disconnect();
