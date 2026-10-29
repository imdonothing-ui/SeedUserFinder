# EarlyProof (SeedUserFinder)

EarlyProof is a tool for consumer founders who need their **first seed users** —
not traffic, not a tester pool. You describe who you're looking for, EarlyProof
searches the places those people already talk about their problem, has an LLM
read every candidate post and judge it against your profile, and drafts a
personal outreach reply for the people who fit. **Nothing is ever sent without
your approval of the exact text**, you connect with seed users directly, and
you track what they actually do in your product afterwards.

There is deliberately **no PMF score and no platform verdict**: EarlyProof
helps you find and reach the right people; whether you've found
product-market fit is your call, not the tool's.

## The workflow (four steps, in order)

1. **Create a target profile** — your product, the audience you're looking
   for, the pain they have, what they do today instead (their workaround),
   keywords in their own language, and the one core action a seed user should
   take in your product.
2. **Configure AI models (Muse)** — enter your Muse API key and Muse model
   names (a small/fast model and a large model) once, in the app's AI
   settings. This is a **must-have gate, not an option**: until Muse is
   configured, search, classification, drafting, feedback summaries, and
   next-experiment suggestions are all blocked server-side, and there is no
   rule-only fallback. The configuration persists — you're not asked again —
   and you can edit it any time from the AI settings tab.
3. **Search** — by default EarlyProof searches all *open* channels (Bluesky,
   Hacker News, GitHub — free public APIs, no account needed to search).
   *Closed* channels are only searched after you connect them yourself in the
   Channels tab. Before searching, Muse builds a **search-expansion plan**
   for your profile — query variants in people's own language, adjacent pains
   and audiences, and the communities where those people talk — and every
   expanded query is checked server-side against a domain anchor from your
   profile, so expansion widens *where* you look without drifting off-topic.
   If a search still synthesizes zero results, you get the next expansion
   suggestions and a one-click **Expand search and re-run**.
4. **Review synthesized results** — raw keyword hits are never shown as
   results. Every candidate that passes a light rule-based pre-filter is
   classified by Muse (**likely seed user / curious / irrelevant**) with a
   verbatim evidence quote from the post, the signals it matched, and a
   confidence level. Only those synthesized results appear in Step 4.
   Low-confidence and "irrelevant" leads are held for your review and can't
   be used for outreach until you clear them. A lead with no Muse verdict
   can't get a draft, can't be approved or posted, and can't become a trial
   invite — that's enforced in the server actions, not just hidden in the UI.

From there: generate a draft reply in your voice, edit it, approve the exact
text to post it (on channels that support posting), track each person through
the outreach funnel, send them a tagged invite link, and watch the seed
cohort's usage signals — started / did the core action / returned / paid /
referred — via a paste-in tracking snippet or a PostHog import. Muse can
also expand your profile's pain language, summarize seed-user feedback
(with verbatim quotes), and suggest the next experiment from real cohort
counts. Suggestions are advice, never a PMF verdict.

## Channels

| Channel | How it works |
| --- | --- |
| Bluesky | Live search (free AT Protocol). Connect your own account with an app password to post approved replies. |
| Hacker News | Live search via the free Algolia API. No posting API exists, so drafts are copy-and-send. For the built-in FirstFeedback profile, HN search is Ask HN help-request threads only (Show HN showcases excluded). |
| GitHub | Live search via the free public API. Connect a fine-grained personal access token to post approved issue comments; otherwise draft + open link. |
| Reddit (POC) | Optional closed channel: connect your own Reddit app (script or OAuth flow) to search subreddits and post approved comments. Internal proof-of-concept scope only — Reddit's free non-commercial terms do not cover a commercial launch. |
| Reddit / X (pasted link) | Paste a thread or post; EarlyProof drafts a reply you send from your own account. No paid APIs, no scraping. |
| Facebook Groups, Discord, Slack, LinkedIn, Instagram | Guided: record the community and person, EarlyProof drafts the message, you send it yourself. |
| Competitor reviews (App Store / G2 / Play) | Insight-only: paste review text and EarlyProof extracts the pain language to sharpen your profile. No outreach. |

## Tech stack

- **Client**: React 19 + Tailwind CSS v4 + TanStack Query, bundled with Bun
  via `@hatch/space-sdk`.
- **Server**: typed actions (`defineAction` + Zod) in
  `server/src/actions.ts`, run by the Muse web-artifact runtime. All LLM
  work (classification, expansion plans, drafts, summaries) runs through the
  runtime's model channel (`ctx.inference`) using the founder's configured
  Muse model tiers — small/fast for expansion, classification, and pain
  extraction; large for drafts and feedback summaries.
- **Data**: SQLite via Drizzle ORM. Schema in `server/src/schema.ts`,
  migrations in `drizzle/`.

## Project layout

```
client/
  index.html          entry page
  build.mjs           client bundle (SDK-owned Bun build)
  src/
    App.tsx           the whole UI: Steps 1–4, tracker, cohort, channels, AI settings
    api.ts            typed action client (types imported from the server)
    main.tsx          React entry
    theme.css         design tokens (light/dark)
server/
  src/
    actions.ts        all server actions: profiles, search, expansion,
                      Muse synthesis, drafts, approve-and-post, invites,
                      cohort events, channel connections, LLM settings
    schema.ts         Drizzle schema (see Data model below)
drizzle/              SQL migrations 0001–0004
space.json            Muse web-artifact metadata (name, slug, runtime)
package.json          scripts and dependencies
.env.example          every credential the app uses — names and placeholders only
```

## Running it

EarlyProof is a **Muse web artifact** (TypeScript space): it runs inside the
Muse artifact runtime, which provides the action host, the SQLite database,
and the model channel. To work on the code locally with
[Bun](https://bun.sh) ≥ 1.3:

```sh
bun install
bun run typecheck   # type-check client and server
bun run build       # build server actions + client bundle
```

There is no standalone dev server in this repo — the built client
(`client/dist/index.html`, per `space.json`) and the compiled actions are
served by the Muse web-artifact runtime.

## Configuration — no secrets in this repo

**This repository contains no secrets and no user data.** There are no API
keys, app passwords, tokens, profiles, leads, or database contents in the
code. Every credential is entered by the founder **in the app's own settings
UI at runtime**, is stored server-side in the app's database, and is never
returned to the client (settings reads expose only "configured / not
configured" and a masked last-4 hint where applicable). `.env.example` lists
every credential field with placeholder values for reference.

| Setting (entered in-app) | Where | What it's for |
| --- | --- | --- |
| Muse API key + small/large model names | AI settings tab | **Required.** Gates the whole core flow (Step 2). |
| Bluesky handle + app password | Channels tab | Search Bluesky posts and post approved replies. The app password itself is not stored — only the session tokens from login are kept. |
| GitHub personal access token (fine-grained) | Channels tab | Optional. Post approved comments on GitHub issues. |
| Reddit app client ID / secret (+ account password for the script flow, or an OAuth code) | Channels tab | Optional. Reddit POC closed channel (see the non-commercial note above). |
| PostHog host, project ID, personal API key | Cohort / PostHog settings | Optional. Import cohort events for your tagged seed users instead of (or alongside) the tracking snippet. |

If you fork this to run outside the Muse artifact runtime, treat
`.env.example` as the checklist of credentials your host must supply through
its own secret store — never commit real values.

## Data model

All state is founder-entered or returned by the channel APIs above; a fresh
install starts empty.

- `profiles` — target profiles (Step 1) plus LLM pain-language expansions.
- `leads` — candidate posts and their Muse verdict, evidence quote,
  confidence, signals, draft, and funnel status.
- `connections` — per-channel connection state and session tokens.
- `llm_settings` — the founder's Muse configuration (single row).
- `search_expansions` — Muse's expansion plans, one row per round.
- `insights` — pain language extracted from pasted reviews / posts.
- `invites` — tagged invite links, one per converted seed user.
- `cohort_events` — seed-cohort usage signals (started / core / returned /
  paid / referred) from manual logging, the snippet, or PostHog.
- `posthog_configs` — per-profile PostHog connection + event-name mapping.
- `feedback_entries`, `llm_summaries` — verbatim seed-user feedback and the
  summaries / next-experiment suggestions Muse wrote from it.

## Guardrails (enforced in code, not just copy)

- **Muse is must-have**: no configuration → the core actions return
  `not_configured`. No silent rule-only or template fallback anywhere.
- **Approve-first posting**: a reply posts only when the founder approves
  that exact draft text, on that exact lead. No auto-posting, no auto-DMs,
  no fake personas.
- **Synthesis before display**: Step 4 shows only Muse-classified leads;
  unclassified leads can't be drafted, approved, posted, moved into
  outreach, or invited.
- **Evidence or it didn't happen**: classification and summary quotes are
  verified as verbatim substrings of the source post/feedback, or dropped.
- **No PMF score**: cohort signals are reported as counts for the founder to
  judge. The tool never declares product-market fit.
- **Free APIs only**: Bluesky AT Protocol, Hacker News Algolia, and GitHub
  public search. No paid Reddit Data API or X API; no scraping.
