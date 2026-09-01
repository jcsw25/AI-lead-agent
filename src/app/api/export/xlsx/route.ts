import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Regenerates the workbook from the current database, then returns it.
 *
 * Runs the same two scripts as `npm run export:xlsx` so there is exactly one
 * export implementation — a second one would drift from the first.
 */
function run(cmd: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-600) || `exit ${code}`))));
  });
}

export async function GET() {
  const cwd = process.cwd();
  try {
    await run("npx", ["tsx", "scripts/export-data.ts"], cwd);
    await run("python", ["scripts/build_workbook.py"], cwd);
  } catch (e) {
    return new Response(
      `Export failed: ${e instanceof Error ? e.message : String(e)}\n\n` +
        `The workbook build needs Python with openpyxl (pip install openpyxl).\n` +
        `The CSV export at /api/export/leads has no such dependency.`,
      { status: 500, headers: { "Content-Type": "text/plain" } },
    );
  }

  const buf = await readFile(path.join(cwd, "pair-database.xlsx"));
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="pair-database-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
