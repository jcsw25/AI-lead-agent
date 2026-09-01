# AI Lead Generator Agent — setup

A local app that finds companies, works out what they need, and drafts the emails
to connect them. Everything runs on your own machine.

**This package contains no credentials and no data.** You supply your own keys,
and the database starts empty. Nothing here can send an email or spend money
until you configure it to.

---

## What you need first

- **Node.js 24 or later** — https://nodejs.org
- No database install. Postgres runs as WebAssembly inside the app.

Two API keys, both with free tiers. The app runs without either, but in a
reduced form:

| Key | What it does | Without it |
|---|---|---|
| **Anthropic** — [console.anthropic.com](https://console.anthropic.com) | Writes search queries, pairings and every email | Agents return clearly-marked simulated output |
| **Serper** — [serper.dev](https://serper.dev) (2,500 free credits, no card) | Finds companies via Google | Company discovery does not work |

---

## First run

```bash
npm install
```

Copy the environment template and open it:

```bash
cp .env.example .env
```

Paste your two keys into `ANTHROPIC_API_KEY` and `SERPER_API_KEY`. Leave
everything else as it is for now.

Then, in **two separate terminals**:

```bash
npm run db:dev
```

```bash
npm run dev
```

Leave the first one running — it is the database. The app is at
**http://localhost:3000**.

Finally, create the tables and seed the starting data:

```bash
npm run setup
```

---

## Try it

1. Open **Generator** and search an industry — `aircon servicing`, `dental clinic`,
   `commercial printing`. It finds around 60 companies in under a minute, then
   opens their websites in the background to pull out emails and phone numbers.
   Contact details fill in over the following couple of minutes.
2. Open **Needs**. Every company it found becomes a question worth asking, marked
   *suspected* — an inference, not a fact.
3. Open **Matchmake** and press *Find matches*. The agent reads the companies and
   argues for specific pairs, stating what each side gains.
4. Open **Approvals** to read drafted emails. **Nothing sends** while
   `EMAIL_ADAPTER` is `mock` — messages are recorded and go through the full
   compliance gate, but never leave the machine.

---

## The sidebar

Five pages are the actual job, in order:

| Page | What it is for |
|---|---|
| **Generator** | Find and scrape companies |
| **Needs** | What buyers said they want |
| **Matchmake** | Who should meet whom |
| **Approvals** | Read it, then send it |
| **Replies** | What came back |

**Admin** shows live connection checks, what has changed and what has been spent.
**Settings** is where the sender identity and mailbox go.

Everything under *Not in use* still works — it is superseded or diagnostic, and
kept rather than deleted.

---

## Sending for real (optional)

Only do this deliberately. Sending is live the moment `EMAIL_ADAPTER` is not
`mock`.

**Gmail** is the better option: it sends as you, replies thread normally, and the
app can read those replies back — which nothing else allows.

1. In your own Google Cloud project, enable the **Gmail API**
2. Configure the **OAuth consent screen** as *External*, leave it in **Testing**,
   and add your own address under **Test users**
3. Create an **OAuth client → Web application** with this exact redirect URI:
   ```
   http://localhost:3000/api/gmail/callback
   ```
4. Put the client ID and secret in `.env`, set `EMAIL_ADAPTER="gmail"`, and
   generate a `CREDENTIAL_SECRET`:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```
5. Restart, then press **Connect Gmail** on the Settings page

Set a reply-to address under Settings first — the compliance gate refuses to send
without one, deliberately.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The app on localhost:3000 |
| `npm run db:dev` | The database — start this first |
| `npm run backfill -- "<industry>"` | Find companies from the command line |
| `npm run enrich` | Open websites, pull out contacts |
| `npm run qualify` | Score and qualify everything. Free, no API calls |
| `npm run pair` | Generate A→B theses, then match companies |
| `npm run probe -- --limit 4` | Draft demand-probe emails |
| `npm run check` | Typecheck, schema validation, byte lint |
| `npm run db:studio` | Browse the database directly |

---

## Things that will catch you out

- **`npm run db:dev` must be running.** Everything else reports "can't reach
  database server" without it.
- **Restart `npm run dev` after any schema change.** The running server holds a
  database client generated before the change and pages fail with
  `Cannot read properties of undefined`.
- **Use `npm run db:push`, not `prisma migrate dev`.** There is no shadow
  database in this setup.
- **A first search shows no emails.** That is expected — finding companies and
  opening their websites are separate passes. Wait a couple of minutes.

---

## What is not included

- **`.env`** — credentials. Yours to create.
- **`.pgdata`** — the local database. Starts empty; your own searches fill it.
- **`node_modules`**, **`.next`** — reinstalled and rebuilt by the commands above.
