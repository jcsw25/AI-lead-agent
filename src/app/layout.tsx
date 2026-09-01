import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Lead Generator Agent",
  description: "Find companies, learn what they need, and introduce them to someone who can help.",
};

/**
 * The sidebar is the job, in order.
 *
 * The test for inclusion is narrow on purpose: is this page on the shortest
 * path from "no companies" to "an introduction that earns a commission"? Five
 * pages are. Find companies, ask what they need, find who can supply it, send
 * the email, read the reply.
 *
 * Everything under "Not in use" still works and still holds its data. It is
 * either superseded by something above or purely diagnostic. Kept rather than
 * deleted — a page nobody opens costs nothing, a deleted one that turns out to
 * matter costs a rebuild — but it should not compete for attention with the
 * work.
 */
const ESSENTIAL = [
  { href: "/generator", label: "Generator", hint: "find and scrape companies" },
  { href: "/needs", label: "Needs", hint: "what buyers said they want" },
  { href: "/matchmake", label: "Matchmake", hint: "who should meet whom" },
  { href: "/approvals", label: "Approvals", hint: "read it, then send it" },
  { href: "/replies", label: "Replies", hint: "what came back" },
];

const SYSTEM = [
  { href: "/admin", label: "Admin", hint: "connections, changes, spend" },
  { href: "/settings", label: "Settings", hint: "sender, mailbox, sheet" },
];

const PARKED = [
  { href: "/qualified", label: "Qualified", hint: "scoring detail; Needs already ranks by grade" },
  { href: "/introductions", label: "Introductions", hint: "fills once a need is confirmed" },
  { href: "/", label: "Opportunity Centre", hint: "original dashboard" },
  { href: "/pairings", label: "Pairings", hint: "managed automatically now" },
  { href: "/industries", label: "Industries", hint: "superseded by the query strategist" },
  { href: "/prospects", label: "Prospects", hint: "superseded by Needs" },
  { href: "/outreach", label: "Outreach", hint: "superseded by Approvals" },
  { href: "/leads", label: "Supplier leads", hint: "superseded by Introductions" },
  { href: "/suppliers", label: "Suppliers", hint: "fills once a supplier signs" },
  { href: "/runs", label: "Agent runs", hint: "diagnostic; spend is on Admin" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">
          <aside className="sidebar">
            <div className="brand">
              <b>AI Lead Generator</b>
              <span>Agent</span>
            </div>

            <nav className="nav">
              {ESSENTIAL.map((l) => (
                <Link key={l.href} href={l.href} title={l.hint}>
                  {l.label}
                </Link>
              ))}

              <div className="nav-group">System</div>
              {SYSTEM.map((l) => (
                <Link key={l.href} href={l.href} title={l.hint}>
                  {l.label}
                </Link>
              ))}

              <div className="nav-group parked">Not in use</div>
              {PARKED.map((l) => (
                <Link key={l.href} href={l.href} className="parked-link" title={l.hint}>
                  {l.label}
                </Link>
              ))}
            </nav>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
