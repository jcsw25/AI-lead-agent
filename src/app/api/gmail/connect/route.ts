import { NextResponse } from "next/server";
import { currentBusiness } from "@/lib/business";
import { authorizeUrl, gmailConfigured } from "@/lib/gmail-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!gmailConfigured()) {
    return NextResponse.redirect(
      new URL("/settings?gmail=unconfigured", process.env.NEXTAUTH_URL ?? "http://localhost:3000"),
    );
  }
  const business = await currentBusiness();
  if (!business) return NextResponse.json({ error: "no business" }, { status: 400 });

  // The business id round-trips as `state` so the callback knows which tenant
  // authorised, and Google will only return it to our own redirect URI.
  return NextResponse.redirect(authorizeUrl(business.id));
}
