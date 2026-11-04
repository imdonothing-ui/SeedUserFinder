# EarlyProof demo video — shot script (< 3 min)

## Prep (before pressing record)
- `cd /Users/guanxs/SeedUserFinder && bun local/build-client.ts` (already built; rebuild if App.tsx changed)
- `PORT=3107 bun local/server.ts` → open http://localhost:3107 (a server is already up on 3107 — reuse it)
- Muse API key saved in Step 0 → AI Setup (pill shows Live, not Offline). Key itself never appears on screen (only a •••• hint).
- Use profile **plantexpert** (id 111): full loop state already live — round-4 plan (anchor "plant"), SE + Reddit lineup, 3 synthesized leads.
- Browser window ~1280px wide. Version pill is top-right; record with a committed tree so it reads `0.2.0 · <sha>` without "dirty".
- Do NOT open DevTools, the DB, or this file on camera.

## Shots (total ~2:30)
### 0:00–0:15 — Hook
Say: "Building is cheap now — finding your first users is the bottleneck. EarlyProof finds seed users where they already complain about the problem, with AI verdicts and evidence you can act on."

### 0:15–0:45 — Profile (Step 1)
Show the plantexpert profile: audience "people who don't know what disease their plant has", pain, and the keywords. Say: "Three fields — audience, pain, workaround, plus the words they'd type. Everything downstream derives from this; nothing is reused across profiles."

### 0:45–1:15 — Channels (Step 2)
Show the lineup: **Stack Exchange open**, **Reddit POC closed until connected**. Point at the status checklist (Target locked / Web search / Muse plan). Say: "Muse maps where plant people talk and a live web search verifies it. Reddit needs your OAuth, so it's honestly closed — never faked."

### 1:15–2:00 — Threads (Step 3)
Scroll to "What the search will run" (round 4, anchor "plant", 7 queries). Press **Search**. While it runs: "Queries times channels — then Muse synthesizes every candidate before anything is shown." Show the 3 results with verdicts (seed_user 90/95/90) and verbatim evidence quotes. Open one lead: "Every verdict shows its evidence and quote."

### 2:00–2:30 — Replies → Tracker → Cohort (Steps 4–6)
Generate a draft for the strongest lead (large model writes it; tone check included). Show Tracker/Cohort briefly: "Outreach, replies, and cohort events tracked per lead." Close: "Profile → Channels → Threads → Replies → Tracker → Cohort. Live verdicts, no dummy data — without a real key every AI step says so instead of faking it."

## Retake notes
- Search takes ~15–30s live; don't cut mid-run — the phase line ("Searching… / Synthesizing N") is part of the story.
- If web search is throttled, the UI says so ("the web check was throttled, so this lineup is Muse's plan only") — that's honesty, keep it in.
- Never type or paste the API key on camera.
