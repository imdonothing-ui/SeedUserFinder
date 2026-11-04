# EarlyProof demo video — spoken script (< 3 min), Magic Mirror cut

## Prep (before pressing record)
- `cd /Users/guanxs/SeedUserFinder && bun local/build-client.ts` (rebuild if App.tsx changed)
- `PORT=3107 bun local/server.ts` → open http://localhost:3107
- Muse API key saved in Step 0 → AI Setup (pill shows Live). Never type or paste the key on camera (only a •••• hint).
- Use profile **Magic Mirror (144)**: makeup AI coach for beginners. Round-2 plan (anchor "makeup"), 2 open forums + closed Reddit + 2 venues, 36 leads, 6 curious askers with quotes.
- Browser ~1280px. Commit first so the version pill reads clean, no "dirty".
- Do NOT open DevTools, the DB, or this file on camera.

## 0:00–0:25 — Problem + why I built it
Say: "AI made building cheap — anyone can ship an app in a weekend. So the bottleneck moved: it's no longer building, it's finding your first users. Founders guess where their people talk, or ask a chatbot that hallucinates channels with total confidence and remembers nothing. I built EarlyProof because I kept doing exactly that — so it hunts where people already complain about the problem, judges every candidate with evidence, and tracks the whole path from stranger to user."

## 0:25–0:50 — Profile (Step 1)
Show the Magic Mirror profile: audience "makeup beginners who feel overwhelmed", pain "tutorials move too fast, can't tell if my blending looks right", workaround "pausing YouTube every ten seconds". Say: "Three fields — audience, pain, workaround, plus the words they'd type. Everything downstream derives from this; nothing is reused across profiles. This one is my own product idea — an AI makeup coach that walks novices step by step."

## 0:50–1:20 — Channels (Step 2) + the funnel
Show the lineup: **MakeupTalk and Lipstick Alley open**, **Reddit closed until connected**, plus YouTube-comments and Facebook-group venues. Say: "Muse mapped where makeup beginners actually talk — two forums it can search right now, Reddit honestly closed until I connect it, and two join-by-hand venues. No hardcoded channel list: a dev-tool profile maps to Hacker News and GitHub instead." Press Search; point at the funnel strip as it lands: "Two channels searched, thirty-nine thousand threads found, thirty new — and six the model calls curious. That's the whole hunt in one glance."

## 1:20–2:05 — Threads (Step 3) + semantic matching
Scroll the results. Point at a semantic pill: "This 72 doesn't mean keyword overlap — it means the model judged this person's situation matches the pain. A paraphrase with zero shared words outranks a keyword-stuffed giveaway. That's matching people, not text." Open "makeup virgin needs help with bridal makeup": "Every verdict shows its confidence, its evidence, and a word-for-word quote. And the showcases — 'barbie inspired makeup look video tutorial' — get rejected as irrelevant with the evidence quoted, not hidden. Six rejections with reasons are as much the product as six finds."

## 2:05–2:40 — Replies → Tracker → Cohort (Steps 4–6) + close
Generate a draft for the bridal-makeup asker. Say: "Drafts are written in my voice, tone-checked, and outreach moves through Tracker into Cohort — replies, nudges, and a nightly Watcher that pings me when new seed users appear. And every time I overrule a verdict, the learning loop replays my corrections against the gate, so the system drifts toward my judgment." Close: "Profile to Cohort in six steps. Find people who already want what you're building — EarlyProof."

## Retake notes
- Search takes ~30–60s on the big forum pool; don't cut mid-run — the phase line ("Searching… / Synthesizing N") is part of the story.
- If Lipstick Alley 403s on camera, that's the funnel being honest: "0 found" row plus the channel note. Keep it in — or cut that hunt and show the MakeupTalk row only.
- Never type or paste the API key on camera.
