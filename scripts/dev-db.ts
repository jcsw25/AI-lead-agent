/**
 * Local development database.
 *
 * Runs PGlite (Postgres compiled to WASM) and exposes it over the real Postgres
 * wire protocol on localhost, so Prisma and psql connect to it exactly as they
 * would to a normal server. Nothing is installed, nothing leaves this machine,
 * and data persists in ./.pgdata between restarts.
 *
 *   npm run db:dev        # start it (leave running)
 *
 * PGlite serves one connection at a time, so DATABASE_URL must pin
 * connection_limit=1. See .env.example.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const DATA_DIR = process.env.DEV_DB_DIR ?? "./.pgdata";

const db = await PGlite.create({ dataDir: DATA_DIR });

// maxConnections defaults to 1, which means the Next.js dev server holds the only
// slot and `prisma studio` or any script is refused with a misleading "can't reach
// database". Queries are still serialised internally; this just allows several
// clients to hold an idle connection at once.
const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: "127.0.0.1",
  maxConnections: Number(process.env.DEV_DB_MAX_CONNECTIONS ?? 60),
  // Scripts that crash before $disconnect leak their connection. Without a
  // reaper those accumulate until the server refuses everything and the app
  // reports "can't reach database server" while still listening on the port.
  //
  // Ten minutes, not two: a web search takes ~80s and the connection sits idle
  // for all of it. A short timeout kills live work mid-run.
  idleTimeout: Number(process.env.DEV_DB_IDLE_TIMEOUT_MS ?? 600_000),
});

setInterval(() => {
  const s = server.getStats?.();
  if (s && s.activeConnections > s.maxConnections * 0.8) {
    console.warn(`  connections ${s.activeConnections}/${s.maxConnections} — nearing the limit`);
  }
}, 30_000).unref();
await server.start();

console.log(`
  Local Postgres ready
    postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?connection_limit=1
    data: ${DATA_DIR}   (delete this folder to reset)

  Leave this running. Ctrl+C to stop.
`);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
