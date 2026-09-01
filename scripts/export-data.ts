/** CLI wrapper — the query logic lives in src/lib/export-data.ts. */
import { writeFileSync } from "node:fs";
import { buildExportData } from "../src/lib/export-data";
import { db } from "../src/lib/db";

const data = await buildExportData();
writeFileSync("export-data.json", JSON.stringify(data, null, 1));
console.log(`introductions=${data.introductions.length} companies=${data.companies.length} pairings=${data.pairings.length}`);
await db.$disconnect();
