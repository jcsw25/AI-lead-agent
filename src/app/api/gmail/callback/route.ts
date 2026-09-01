import { NextResponse } from "next/server";
import { completeConnection } from "@/lib/gmail-auth";

export const dynamic = "force-dynamic";

const base = () => process.env.NEXTAUTH_URL ?? "http://localhost:3000";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/settings?gmail=denied&detail=${encodeURIComponent(error)}`, base()));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL("/settings?gmail=missing_code", base()));
  }

  try {
    const { address } = await completeConnection(state, code);
    return NextResponse.redirect(new URL(`/settings?gmail=connected&address=${encodeURIComponent(address)}`, base()));
  } catch (e) {
    const detail = e instanceof Error ? e.message : "connection failed";
    return NextResponse.redirect(new URL(`/settings?gmail=error&detail=${encodeURIComponent(detail.slice(0, 200))}`, base()));
  }
}
