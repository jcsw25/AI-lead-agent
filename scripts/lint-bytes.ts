/**
 * Fail if any source file contains a raw control character.
 *
 * This exists because it happened three times. Patching files with a Python
 * heredoc turned every `\b` in a regex into a literal backspace (0x08), so
 * word-boundary anchors silently became "match a backspace character". The
 * result compiles, passes typecheck, is invisible in grep and in an editor, and
 * quietly breaks every regex it touches — the UEN and address extractors ran
 * against 435 companies in that state.
 *
 * Cheap to check, so it runs with the rest of the checks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXTS = [".ts", ".tsx", ".prisma", ".json", ".md"];
const SKIP = new Set(["node_modules", ".next", ".git", ".pgdata"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

const offenders: Array<{ file: string; line: number; code: number }> = [];
for (const file of walk(".")) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const ch of line) {
      const c = ch.charCodeAt(0);
      // Tab is fine. Everything else below 0x20 is not.
      if (c < 32 && c !== 9 && c !== 13) offenders.push({ file, line: i + 1, code: c });
    }
  });
}

if (offenders.length) {
  console.error(`Found ${offenders.length} raw control characters in source:`);
  for (const o of offenders.slice(0, 20)) {
    console.error(`  ${o.file}:${o.line}  0x${o.code.toString(16).padStart(2, "0")}` +
      (o.code === 8 ? "  (backspace — almost certainly a mangled \b in a regex)" : ""));
  }
  process.exit(1);
}
console.log("no control characters in source");
