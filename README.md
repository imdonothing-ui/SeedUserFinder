# EarlyProof — find your first seed users where they already complain

**Meta Global AI Developer Hackathon · Startup track · Build for Your World**

As AI makes building cheap, the bottleneck is no longer code — it's finding
users and product-market fit. EarlyProof finds your first seed users where
they already talk about the pain, has Muse read every candidate and judge it
against your profile, drafts a personal outreach reply, and tracks what those
people actually do in your product afterwards.

Asking any LLM to search gives you a list. EarlyProof runs the loop: anchored
matching, Muse verdicts with evidence, approve-first outreach, reply nudges,
and cohort tracking.

## Demo

🎬 Demo video (under 3 min) — link added at submission. Script: create a
profile → live Willow×AgingCare search → DawnFeed×Mumsnet generality check →
Muse verdict, draft, approve → reply nudge and cohort.

## Live proof (real runs, keyless channels)

| Profile | Channel | Threads scanned | Leads kept |
|---|---|---|---|
| Willow (dementia caregiver app) | AgingCare Q&A + Discussions | 49,920 | 30 |
| DawnFeed (night feeds) | Mumsnet Talk (parenting + sleep) | 31,050 | 30 |
| Willow | Mumsnet (elderly_parents + parenting) | 25,762 | 30 |
| Dev tooling | AgingCare, Mumsnet | 0 fetched | skipped, never blind |

## Built with Meta

- **Muse Spark 1.3** (`muse-spark-1.3`) does every Muse call: expansion plans,
  lead classification, drafts, feedback summaries (`server/src/actions.ts`
  via `runLlm`: fast tier for high-volume first passes, large tier for drafts
  and summaries).
- **Direct Model API path** (`server/src/meta-api.ts`): a key starting with
  `LLM|` calls `POST https://api.meta.ai/v1/responses` straight through —
  endpoint, Bearer [REDACTED] and pinned model id verified live (bogus key → HTTP
  401). Any other key is served by the workspace model runtime. The AI tab's
  Test-connection button reports the exact serving path and model.
- **Built with Muse Code**, powered by Muse Spark.

## How it works

1. **Target profile (3 fields)** — product, what it does, whose pain.
2. **AI setup (key only)** — paste the Model API key; models are automatic.
3. **Search open channels, picked per profile** — Bluesky, Hacker News,
   GitHub, Stack Exchange (per-profile site mapping), AgingCare and Mumsnet
   (sitemap-title search for forums with no API — always labeled title-only).
   Channels that don't fit the profile are deselected with reasons, never
   searched blindly.
4. **Muse synthesis before display** — verdicts carry evidence quotes and
   confidence; low-confidence items are held for review, never scored as PMF.
5. **Approve-first outreach, reply nudges, cohort tracking** — nothing is
   ever sent without approving the exact text; sent leads get a 3-day reply
   nudge (replied / snooze / stop); tagged invites feed a per-seed cohort.

## Run it locally

```sh
sh local/setup.sh            # deps (stub links @hatch/space-sdk)
bun local/build-client.ts    # client → local/dist
bun local/server.ts          # → http://localhost:3107 (PORT= to override)
bun local/smoke.ts           # 78 in-process checks, no port needed
bun run typecheck             # tsc client + server
```

`local/data/app.db` is yours (gitignored) — delete it to reset. Muse calls
are answered by `local/inference-stub.ts` (`[local-stub]` tagged) unless you
paste a real key. See `local/README.md`.

## Layout

- `server/src/actions.ts` — all actions: gate, search, synthesis, outreach, cohort
- `server/src/meta-api.ts` — direct Muse Spark 1.3 path (Model API)
- `server/src/schema.ts` + `drizzle/` — SQLite schema and migrations
- `client/src/App.tsx` — the full UI (version pill in the header shows the tested build)
- `local/` — localhost harness, offline stub, smoke suite, frozen gate corpus
