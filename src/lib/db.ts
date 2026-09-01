import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * PGlite serves one connection at a time, so a dropped dev server can leave the
 * app unable to reach it. Surface that as a readable message rather than a
 * Prisma stack trace, since the fix is always the same: start `npm run db:dev`.
 */
export async function dbReady(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
