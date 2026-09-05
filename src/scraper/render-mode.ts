/**
 * How a page delivers its content, and therefore whether an absence can be
 * believed.
 *
 * This exists because of a specific, embarrassing failure. The audit reported
 * that xmachina.biz had no enquiry form, no email link and unrendered
 * `{{ pageTitle }}` placeholders. Opened in a browser it is a complete,
 * professional site with a contact form and a published address. The crawler
 * had read the pre-hydration HTML and reported what was missing from it as
 * though it were missing from the site.
 *
 * The old check — large HTML with almost no text — missed it entirely, because
 * the page ships plenty of text and only hydrates the interactive parts. That
 * is the common shape of a modern site, so the check was wrong about exactly
 * the sites it most needed to catch.
 *
 * The consequence is not cosmetic. "No enquiry form" is a scoring input and the
 * opening line of the outreach email. Told to a company that has one, it is
 * instantly discrediting — the precise opposite of the checkable claim the copy
 * depends on.
 *
 * So: absence is only ever asserted from a page we can prove was fully
 * delivered. Everywhere else the finding is "could not verify", which is
 * honest and still useful.
 */

export type RenderMode = "static" | "hydrated" | "spa";

export type RenderVerdict = {
  mode: RenderMode;
  /** Whether "we did not find X" can be trusted to mean "X is not there". */
  reliable: boolean;
  /** What led to the verdict, for the audit record. */
  signals: string[];
};

/** Framework roots that mean the real page is assembled in the browser. */
const FRAMEWORK_SHELLS: Array<[RegExp, string]> = [
  [/__NEXT_DATA__/, "Next.js hydration payload"],
  [/id=["']__next["']/, "Next.js root"],
  [/id=["']__nuxt["']/, "Nuxt root"],
  [/data-reactroot/, "React root"],
  [/id=["']root["'][^>]*>\s*<\/div>/, "empty React/Vue root element"],
  [/id=["']app["'][^>]*>\s*<\/div>/, "empty app root element"],
  [/ng-version=/, "Angular"],
  [/data-svelte-h|__sveltekit/, "SvelteKit"],
  [/window\.__remixContext/, "Remix"],
  [/<div[^>]+data-barba/, "Barba SPA router"],
  [/wixapps|_wixCssStates|wix-dropdown/i, "Wix"],
  [/data-wf-page|webflow/i, "Webflow"],
];

/** Template bindings that never got substituted in the HTML we received. */
const UNRENDERED_BINDING = /\{\{\s*[\w.$]+\s*\}\}/;

export function detectRenderMode(html: string, visibleText: string): RenderVerdict {
  const signals: string[] = [];

  for (const [re, name] of FRAMEWORK_SHELLS) {
    if (re.test(html)) {
      signals.push(name);
      break;
    }
  }

  // The clearest tell of all: we are looking at a template, not a page.
  const binding = html.match(UNRENDERED_BINDING);
  if (binding) signals.push(`unrendered binding ${binding[0]}`);

  // A page that tells the visitor to enable JavaScript is telling us too.
  if (/<noscript>[^<]*(enable|turn on)[^<]*javascript/i.test(html)) {
    signals.push("noscript notice requires JavaScript");
  }

  // Lots of markup, very little to read: the classic empty shell.
  const thin = html.length > 20_000 && visibleText.length < 800;
  if (thin) signals.push("large HTML with almost no text");

  // A page of this size with no form and no contact link at all is more likely
  // to be waiting on hydration than to be a business with no way to reach it.
  const noInteractive = !/<form[\s>]/i.test(html) && !/mailto:|tel:/i.test(html);
  if (noInteractive && html.length > 30_000) {
    signals.push("no form and no contact link anywhere in a large document");
  }

  if (thin || binding) {
    return { mode: "spa", reliable: false, signals };
  }
  if (signals.length > 0) {
    // Content is present but the interactive parts are assembled in the
    // browser. Positives still count; absences do not.
    return { mode: "hydrated", reliable: false, signals };
  }
  return { mode: "static", reliable: true, signals: ["fully delivered in the HTML response"] };
}
