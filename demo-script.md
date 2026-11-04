# EarlyProof demo video — spoken script, Magic Mirror cut (~4 min)

## Before you press record
- `cd /Users/guanxs/SeedUserFinder && bun local/build-client.ts` (only needed if App.tsx changed)
- Start the app: `PORT=3107 bun local/server.ts`, then open http://localhost:3107
- Muse key saved (AI Setup shows Live). Never show the key on camera.
- Use the **Magic Mirror** profile (id 144). Do NOT press Search on camera — the results below are already in from the last hunt, and a re-hunt would correctly report 0 new.
- Browser ~1280px. Commit first so the version label reads clean.
- Don't open DevTools, the database, or this file while recording.

## 1. What it is (2 sentences)
Say this: "Building an app is easy now — finding your first users is the hard part. EarlyProof hunts down people who are already complaining about your problem, judges each one with evidence, and tracks them from stranger to user."

## 2. The architecture (30 seconds)
Say this: "Under the hood it's an agentic pipeline — a team of small AI agents, not one big prompt. A Scout maps where your people talk. Searchers fan out and search every channel at the same time. A Judge reads every candidate and sorts it: seed user, curious, or irrelevant. And every agent has a validator — a strict checker on its output. One retry, then it fails openly instead of saving junk. No key, no data — it says so instead of making things up."

## 3. Step 0 — AI config
Show the AI Setup tab: the saved key (hint only), the Live pill, the pinned model. Say this: "Setup is one step, done once. You paste a single key, the pill flips to Live, and every step downstream — plans, hunts, verdicts, drafts — runs on it. Without it the whole flow stays honestly blocked; there is no fake demo mode."

## 4. Step 1 — Profile
Show the Magic Mirror profile. Read the fields on screen. Say this: "Everything starts from three fields: who your users are, what hurts, and what they do about it today — plus the words they'd type. Mine is Magic Mirror, an AI makeup coach for beginners. Audience: makeup beginners who feel overwhelmed. Pain: tutorials move too fast, can't tell if my blending looks right. Workaround: pausing YouTube every ten seconds. Nothing carries over between profiles — each one gets its own plan, its own channels, its own hunt."

## 5. Step 2 — Channels
Show the lineup. Count on screen. Say this: "Muse mapped four places makeup beginners talk. Three are open and searchable right now: MakeupTalk, Lipstick Alley, and Mumsnet's beauty board. One is closed: Reddit's beginner-help community, which needs my login before it opens — the app won't pretend otherwise. Plus one join-by-hand venue, a YouTube tutorial's comments. Note what isn't here: no Hacker News, no GitHub. A dev tool would map those instead — the plan picks per product, nothing is hardcoded."

## 6. Step 3 — Threads
Show the funnel strip, then the leads. Say this: "The last hunt searched two forums and found about thirty-nine thousand threads. Thirty were new, and the Judge read every one. The funnel shows it in one glance: found, new, and the verdicts." Scroll to the three seed users. Say this: "'Never wore makeup before, help.' 'Makeup help for dummies.' 'Help me get started using makeup.' Real beginners, in their own words, each with a score for what the post means — not which keywords it contains — plus a word-for-word quote as proof." Open a showcase rejection. Say this: "And the tutorials get rejected openly — marked irrelevant, reason shown. Honest rejections are as much the product as the finds."

## 7. Step 4 — Replies
Pick the bridal-makeup asker and generate a draft. Say this: "I pick a real asker and generate a reply in my voice — tone-checked, and nothing posts itself. I approve the exact text first."

## 8. Step 5 — Tracker
Show the Tracker with 36 leads sitting at New. Say this: "Every lead lands here. Approve a draft and it moves forward; replies, nudges, and follow-ups live on the lead. This board is empty of progress today because I haven't sent anything yet — that's the honest starting point, not a demo trick."

## 9. Step 6 — Cohort, then close
Show the empty Cohort. Say this: "Cohort is where tagged invites track whether seed users actually use the thing — signals only, whether it counts as product-market fit is my call. Nothing here yet, because nothing's been sent." To close, say this: "Six steps, from describing your users to following up with them. Go find the people who already want what you're building."
