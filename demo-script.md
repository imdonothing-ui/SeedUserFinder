# EarlyProof demo video — spoken script (< 3 min), Magic Mirror cut

## Before you press record
- Rebuild: `cd /Users/guanxs/SeedUserFinder && bun local/build-client.ts` (only needed if App.tsx changed)
- Start the app: `PORT=3107 bun local/server.ts`, then open http://localhost:3107
- Make sure your Muse key is saved in Step 0 (AI Setup shows Live). Never show the key on camera.
- Use the **Magic Mirror** profile: a makeup helper for beginners. It already has a plan, two forums ready to search, and real results.
- Make the browser about 1280 pixels wide. Commit your code first so the version label looks clean.
- Don't open DevTools, the database, or this file while recording.

## 0:00–0:25 — The problem
Say this: "Building an app is easy now. Anyone can put one together in a weekend. The hard part is finding your first users — the people who already have the problem you're solving. Most founders guess where those people hang out, or ask a chatbot that makes up answers with total confidence and forgets everything the next day. I kept doing that, so I built EarlyProof. It goes looking for people who are already complaining about the problem, checks each one carefully, and keeps track of all of them."

## 0:25–0:50 — The profile
Show the Magic Mirror profile. Say this: "Everything starts here, with three simple things: who your users are, what hurts, and what they do about it today. Plus the words they'd actually type. This one is my own idea — a makeup coach that walks beginners through it step by step. Nothing carries over between profiles. Each one gets its own plan, its own channels, its own hunt."

## 0:50–1:20 — Where to look: an agentic pipeline
Show the channels list: two makeup forums ready to search, Reddit honestly marked closed until it's connected, and two groups you'd join by hand. Say this: "Under the hood this is an agentic pipeline — meaning a team of small AI agents, not one big prompt. A Scout agent maps where these people talk. Searcher agents fan out across the channels. A Judge agent reads every candidate. And every agent has a validator — a strict checker on its output. If an agent returns garbage, it gets one retry, then the run fails openly instead of saving junk. That's why this app never shows you faked results. No key, no data — it says so instead of making things up." Press Search. When the numbers land, point at them. Say this: "Two channels searched, about thirty-nine thousand posts found, thirty new ones kept, six that look like real users. The whole hunt in one glance."

## 1:20–2:05 — The results: semantic matching, not keyword matching
Scroll through the results. Point at one of the high scores. Say this: "This is semantic matching — the model scores what the post means, not which words it contains. Technically it's a listwise rerank: the model reads the top candidates side by side and grades each against the pain, and that grade gets fused with two word-based signals. In plain terms: someone describing the same struggle in totally different words still ranks high, and a post stuffed with keywords but no real problem sinks. Matching people, not text." Open the one about bridal makeup. Say this: "Every verdict is grounded in a verbatim quote — the person's exact words, copied word for word, or an empty quote with low confidence when the words aren't there. And the ones that don't fit get rejected openly — a makeup video showcase is marked irrelevant, with the reason shown. Six honest rejections are as much the product as six real finds."

## 2:05–2:40 — Replying, tracking, and the learning loop, then close
Write a reply for the bridal makeup post. Say this: "Replies are written in my voice and tone-checked. Then everything moves into a tracker — who I contacted, who answered, who needs a nudge — plus a nightly Watcher that pings me when new seed users appear. And there's a learning loop: every time I overrule a verdict, the app replays my corrections against its own rules and tells me where they disagree — so the system drifts toward my judgment over time instead of away from it." To close, say this: "Six steps, from describing your users to following up with them. Go find the people who already want what you're building."
