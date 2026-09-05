import { encrypt, decrypt, gmailConfigured, redirectUri } from "@/lib/gmail-auth";

const secret = JSON.stringify({ refreshToken: "1//0gFAKE-refresh-token", accessToken: "ya29.FAKE", expiresAt: Date.now() + 3600e3 });
const box = encrypt(secret);
const back = decrypt(box);

console.log(`round-trip ok        ${back === secret}`);
console.log(`stored form          ${box.slice(0, 34)}...  (${box.length} chars)`);
console.log(`plaintext leaked?    ${box.includes("refresh-token") ? "YES — BROKEN" : "no"}`);

// Tampering must fail loudly, not silently return garbage.
const parts = box.split(".");
const tampered = [parts[0], parts[1], parts[2].slice(0, -4) + "AAAA"].join(".");
try { decrypt(tampered); console.log("tamper detection      FAILED — accepted modified ciphertext"); }
catch { console.log("tamper detection      ok — rejected modified ciphertext"); }

console.log(`\ngmail client configured  ${gmailConfigured()}`);
console.log(`redirect URI to register ${redirectUri()}`);
