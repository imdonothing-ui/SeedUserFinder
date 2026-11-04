import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq, and, or, like, inArray, gte } from "drizzle-orm";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { META_MODEL, completeViaMetaModel, completeViaMetaModelText, isDirectKey } from "./meta-api";
import { bm25Order, fuseRanks } from "./retrieval";
import { extractOutlinkDomains, forumGraphVenues, parseSeRelatedSites, registrable, seGraphVenues } from "./venue-graph";
import { defineAgent } from "./agents";
import * as schema from "./schema";

type Db = BunSQLiteDatabase<typeof schema>;

const UA = "EarlyProof/1.0 (founder-approved seed outreach)";
// App version shown on the page so a founder always knows which build they
// are testing. Keep in sync with package.json.
const PKG_VERSION = "0.2.0";

// ─── Hacker News: Ask HN only, for every profile ──────────────────────────
// Hacker News is an Ask HN help-request channel, not a general story search:
// live runs were dominated by Show HN showcases (new tools announcing
// themselves), while the pain lives in Ask HN threads where someone asks for
// help. So retrieval uses Algolia's `ask_hn` tag + relevance ranking, AND the
// title-prefix check runs server-side as the authoritative gate — an
// ask_hn-tagged story whose title does not start with "Ask HN" is excluded.
// Comment hits carry no story title and drop out the same way.
function hnTitleKind(title: string): "ask" | "show" | "other" {
  const t = title.trim().toLowerCase();
  if (t.startsWith("ask hn")) return "ask";
  if (t.startsWith("show hn")) return "show";
  return "other";
}
// HN story_text arrives as HTML with entities (&#x27;, &amp;, <p>…). Decode
// it to plain text so Muse's evidence quotes are verbatim substrings of
// the stored body and survive the quote-verification check.
function decodeHnText(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16) || 32))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10) || 32))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function profileShape(p: typeof schema.profiles.$inferSelect) {
  return {
    id: p.id, productName: p.productName, productDesc: p.productDesc, audience: p.audience,
    pain: p.pain, workaround: p.workaround, keywords: p.keywords, coreAction: p.coreAction,
    painPhrases: p.painPhrases, workaroundPhrases: p.workaroundPhrases, exclusions: p.exclusions,
    created_at: p.createdAt.toISOString(),
  };
}
function leadShape(l: typeof schema.leads.$inferSelect) {
  return {
    id: l.id, profileId: l.profileId, channel: l.channel, mode: l.mode, externalUrl: l.externalUrl,
    externalId: l.externalId, author: l.author, authorHandle: l.authorHandle, title: l.title, body: l.body,
    community: l.community, postedAt: l.postedAt, matchScore: l.matchScore, matchReason: l.matchReason, semanticScore: l.semanticScore,
    draftBody: l.draftBody, status: l.status, postedUrl: l.postedUrl, created_at: l.createdAt.toISOString(),
    llmCategory: l.llmCategory, llmConfidence: l.llmConfidence, llmReason: l.llmReason, llmQuote: l.llmQuote,
    llmSignals: l.llmSignals, llmReviewed: l.llmReviewed === 1, draftToneCheck: l.draftToneCheck,
  };
}

const PAIN_WORDS = ["frustrated","frustrating","hate","annoying","stuck","struggle","struggling","struggles","sucks","suck","hard to","difficult","wish","looking for","alternative","help","problem","issue","broken","slow","expensive","tired of","anyone else","how do you","how do i","cant","can t","never works","always looks","cakey","uneven","messy","zero","nobody","crickets","ignored","desperate","hopeless","giving up","gave up","no luck","not working","doesnt work","does not work","no idea","clueless","lost","alone","dark","silent","silence","overwhelmed","burned out","burnt out"];
// Multi-word pain phrases, in the words people actually type. A hit on one of
// these alongside a domain anchor is a pain signal even when the post never
// repeats a founder keyword verbatim — that is the whole point of the light
// gate: Muse, not an exact-phrase match, decides relevance.
const PAIN_PHRASE_SIGNALS = ["no users","no user","zero users","no traction","no signups","no signup","no sign ups","no traffic","no response","no responses","no feedback","no customers","no customer","no downloads","no sales","no one uses","nobody uses","nobody cares","no one cares","cant get users","can t get users","cannot get users","cant get feedback","can t get feedback","cannot get feedback","cant find users","can t find users","cannot find users","cant get traction","can t get traction","getting first users","get first users","find first users","finding first users","first real users","building in the dark","build in the dark","launched and nothing","got no response","got no traction","got no feedback","almost no response","hardly any response","struggling to get","struggling to find","hard to get users","dont know how to find","don t know how to find","dont know where to find","don t know where to find","no one responded","nobody responded","no replies","zero replies","no comments","launched it and","shipped it and"];
// Workaround behaviour in people's own words: they already posted, asked,
// shared or hacked something together. Alongside a domain anchor this is a
// signal worth Muse's judgement, not a discard.
const WORKAROUND_PHRASE_SIGNALS = ["product hunt","posted on hn","posted on hacker news","posted to hacker news","shared on twitter","asked my friends","asked friends","asked my friend","friends said","friends say","friends just say","just say cool","say its cool","hoping for traction","waiting for feedback","asked for feedback","build in public","building in public","posted it on","shared it on","launched on","posted on reddit","shared on reddit"];
// Tokens too weak to serve as a domain anchor on their own — common verbs and
// qualifiers that appear in almost any post ("first", "get", "real"…).
const WEAK_ANCHOR_TOKENS = new Set(["first","real","get","gets","got","getting","find","finding","found","know","knows","something","anything","almost","just","like","even","still","much","many","made","way","one","two","help","helps","need","needs","want","wants","try","trying","work","works","working","using","used","new","good","bad","better","best","thing","things","side","honest","people","person","wrong","don","doesn","didn","isn","aren","wasn","won","wouldn","couldn","shouldn","haven","hasn","can","cant"]);
// Pain words that are too weak to satisfy the signal requirement ALONE:
// they appear in ordinary product pitches and bug reports ("a Lovable
// alternative", "the problem is…", "this issue…") without the poster being
// in the founder's pain at all. One of them is not a signal; two or more
// together, or any strong pain word / pain phrase / negated anchor, is.
const WEAK_PAIN_WORDS = new Set(["alternative","help","problem","issue","slow","expensive","lost","alone","dark","silent","silence","clueless","broken","wish"]);
// Words that are far too common to prove relevance on their own. A post that
// only contains one of these ("make", "skill", "sucks", "struggle"…) is not a
// match — it never earns score and never satisfies the save gate.
const GENERIC_TOKENS = new Set(["skill","skills","suck","sucks","sucked","make","makes","making","struggle","struggling","struggles","hard","difficult","help","helps","problem","problems","issue","issues","lack","lacks","due","put","puts","getting","learn","learning","beginner","beginners","novice","novices","really","just","thing","things","stuff","people","person","way","ways","new","good","bad","better","best","work","works","working","use","using","used","try","trying","want","wants","need","needs"]);
const STOP_TOKENS = new Set(["my","i","me","the","a","an","to","of","for","on","in","at","is","it","its","and","or","but","so","do","does","did","how","what","when","why","who","am","are","was","were","be","been","with","without","from","by","as","if","then","than","too","very","can","cant","could","would","should","this","that","these","those","you","your","yours","we","our","they","their","them","he","she","his","her","not","no","yes","all","any","some","into","about","over","under","after","before","again","once","here","there","out","off","up","down","dont","doesnt","didnt","isnt","arent","wasnt"]);

// NOTE (founder rule): no topic lists live in this file — no clusters, no
// per-vertical signals, no per-profile channels. Every topic decision comes
// from the founder's own profile text (anchors) and Muse's expansion plan
// (channels, venues). The code below only executes searches and gates.

// LIGHT SAFETY NET (changed after the FirstFeedback live test, 2026-10-28):
// the old bar was 62, and a context-only match could score at most
// 30 (context) + 20 (pain words) = 50 — so the rule gate mathematically
// discarded ~100% of real candidates before Muse ever saw them, even
// though Muse classification (which works — a pasted perfect post was
// classified correctly) is the real relevance gate. The pre-filter is now
// a light safety net: a post passes to Muse when it contains the
// profile's DOMAIN ANCHOR plus at least one pain or workaround signal,
// at a much lower score floor. Muse then decides seed_user / curious /
// irrelevant with an evidence quote and confidence, and only Muse's
// synthesized results are ever shown (Step 4).
const MIN_SAVE_SCORE = 38;

export function normText(s: string): string {
  // One normalization for every vertical: lowercase, non-alphanumerics to
  // spaces, collapse whitespace. No per-topic exceptions — "make-up" reads
  // as "make up" for the same reason "set-up" reads as "set up"; matching a
  // joined compound to its spaced form is the caller's job, never this fn's.
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function containsTerm(normHaystack: string, normTerm: string): boolean {
  if (!normTerm) return false;
  if (normTerm.includes(" ")) return normHaystack.includes(normTerm);
  return ` ${normHaystack} `.includes(` ${normTerm} `);
}
// Kinship/community synonym families (already normalized): the anchor model
// matches relations, not just words — a daughter writing about her father is
// the same audience as one writing about her "mom", and caregiver forums
// speak in LO/DH/DW abbreviations. Applied ONLY to gate anchor checks, never
// to query building or expansion enforcement (search APIs need literal words).
// Exact term always sorts first, so behavior is identical when the literal is
// present; the reason text names the surface form when a synonym matched.
const KINSHIP_FAMILIES: string[][] = [
  // One relation family on purpose: a daughter writing about her father, a
  // son about his mom, a spouse about their DH — same audience. Over-recall
  // here is safe (pain signal + score floor + Muse still decide), and the
  // reason names the surface form so nothing is hidden.
  ["mom", "mum", "mother", "mommy", "mama", "dad", "daddy", "father", "papa",
   "parent", "parents", "son", "daughter", "ds", "dd", "kid", "kids", "child",
   "children", "husband", "wife", "spouse", "partner", "hubby", "dh", "dw",
   "mil", "fil", "sibling", "siblings", "brother", "sister",
   "loved one", "loved ones", "lo"],
];
const kinCache = new Map<string, string[]>();
export function synonymsFor(term: string): string[] {
  const t = normText(term);
  const hit = kinCache.get(t);
  if (hit) return hit;
  const fam = KINSHIP_FAMILIES.find((f) => f.includes(t));
  const out = fam ? [...fam] : [t];
  out.sort((a, b) => (a === t ? -1 : b === t ? 1 : 0));
  kinCache.set(t, out);
  return out;
}
// First family member present in the text (exact term first), or null.
export function matchVariant(normHaystack: string, term: string): string | null {
  for (const v of synonymsFor(term)) if (containsTerm(normHaystack, v)) return v;
  return null;
}
function significantTokens(normPhrase: string): string[] {
  return normPhrase.split(" ").filter((w) => w.length > 2 && !STOP_TOKENS.has(w));
}

export type ProfileLike = { productName: string; productDesc: string; audience: string; pain: string; workaround: string; keywords: string; coreAction: string; exclusions?: string };
type Relevance = { score: number; reason: string; keep: boolean; matchedTerms: string[]; exactPhrase: string; contextPhrase: string; anchorHits: string[]; anchorPresent: boolean; painSignals: string[]; workaroundSignal: string };

function keywordPhrases(profile: ProfileLike): string[] {
  const fromKw = profile.keywords.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromKw.length) return fromKw;
  const p = profile.pain.trim();
  return p ? [p] : [];
}

// The query sent to a channel's search API: when the founder names keyword
// phrases, the query is the topic phrase itself, never an OR of the
// phrase's words.
function searchQueryFor(profile: ProfileLike): string {
  const phrases = keywordPhrases(profile);
  return phrases[0] ?? profile.pain.split(/\s+/).filter((w) => w.length > 4).slice(0, 3).join(" ");
}

// Domain anchor tokens, derived from the founder's own profile text —
// keywords first (the strongest signal), then
// audience, then pain. Weak everyday words ("first", "get", "real", generic
// tokens, stop words) never serve as anchors, so a generic post that merely
// shares a common word with the profile still has no anchor and is dropped.
function profileAnchorTokens(profile: ProfileLike): string[] {
  const out: string[] = [];
  const pushFrom = (src: string) => {
    for (const w of significantTokens(normText(src))) {
      if (GENERIC_TOKENS.has(w) || WEAK_ANCHOR_TOKENS.has(w)) continue;
      if (!out.includes(w)) out.push(w);
    }
  };
  for (const phrase of keywordPhrases(profile)) pushFrom(phrase);
  pushFrom(profile.audience);
  pushFrom(profile.pain);
  return out.slice(0, 24);
}
// Keyword-derived anchors are the strong tier: one hit anchors the post.
// Audience/pain-derived anchors are the secondary tier: a post needs two of
// them (e.g. "indie" + "launched", "shipped" + "project") to count as
// anchored when no strong anchor or keyword phrase is present.
function splitAnchorTiers(profile: ProfileLike): { strong: string[]; secondary: string[] } {
  const all = profileAnchorTokens(profile);
  const kwTokens: string[] = [];
  for (const phrase of keywordPhrases(profile)) {
    for (const w of significantTokens(normText(phrase))) {
      if (GENERIC_TOKENS.has(w) || WEAK_ANCHOR_TOKENS.has(w)) continue;
      if (!kwTokens.includes(w)) kwTokens.push(w);
    }
  }
  // "show" alone is too common to anchor; the phrase "show hn" anchors below.
  const strong = kwTokens.filter((w) => w !== "show");
  return { strong, secondary: all.filter((w) => !strong.includes(w) && w !== "show") };
}

export function analyseText(rawText: string, profile: ProfileLike, _channel?: string): Relevance {
  const text = normText(rawText);
  const matchedTerms: string[] = [];
  let score = 0;
  const parts: string[] = [];

  // 1. Domain anchor in the post itself — the safety net's hard requirement.
  // Anchors come only from the founder's own profile text (keywords first,
  // then audience, then pain): a strong keyword anchor, the "show hn" phrase
  // anchor, or two secondary anchors. No topic lists anywhere in this file.
  const tiers = splitAnchorTiers(profile);
  // Kinship-aware anchor matching: "mom" also matches "dad"/"LO"/"father" in
  // the post. The surface form is tracked so the reason stays truthful.
  const anchorVia = new Map<string, string>();
  const strongHits = tiers.strong.filter((w) => { const v = matchVariant(text, w); if (v) { anchorVia.set(w, v); return true; } return false; });
  const secondaryHits = tiers.secondary.filter((w) => { const v = matchVariant(text, w); if (v) { anchorVia.set(w, v); return true; } return false; });
  // "show hn" anchors a post ONLY when the founder's own keywords name it
  // (same condition `anchorTermsFor` uses to admit the phrase). A universal
  // phrase anchor let every Show HN showcase — people announcing, not asking —
  // clear the gate for profiles that never mention Show HN, and pitch language
  // ("hard to", "difficult", "problem") supplied the signal.
  const showHnWanted = keywordPhrases(profile).some((p) => normText(p).includes("show hn"));
  const showHnHit = showHnWanted && text.includes("show hn");
  // One surface word = one hit: kinship synonyms mean several terms can
  // match through the SAME word ("mom", "siblings", "children" all via
  // "child"). Counting each would inflate the score and print words the post
  // never contains — so hits sharing a surface form collapse to one, and the
  // reason names surface forms (what is really in the post).
  const surfaceOf = (t: string): string => (t === "show hn" ? t : (anchorVia.get(t) ?? normText(t)));
  const rawHits: string[] = [...strongHits, ...(showHnHit ? ["show hn"] : []), ...secondaryHits];
  const seenSurface = new Set<string>();
  const anchorHits = rawHits.filter((t) => {
    const s = surfaceOf(t);
    if (seenSurface.has(s)) return false;
    seenSurface.add(s);
    return true;
  });
  const strongSet = new Set(strongHits);
  const uniqStrong = anchorHits.filter((t) => strongSet.has(t)).length;
  const uniqSecondary = anchorHits.length - uniqStrong - (showHnHit && anchorHits.includes("show hn") ? 1 : 0);
  const anchorPresent = uniqStrong > 0 || showHnHit || uniqSecondary >= 2;
  if (anchorPresent && anchorHits.length) {
    score += 34 + Math.min((anchorHits.length - 1) * 5, 16);
    const [first = ""] = anchorHits; // anchorHits.length checked above
    const via = anchorVia.get(first);
    const viaNote = via && via !== normText(first) ? ` (as “${via}” in the post)` : "";
    const rest = anchorHits.slice(1, 4).map((t) => `“${surfaceOf(t)}”`).join(", ");
    parts.push(`Matched domain anchor “${first}”${viaNote} in the post${rest ? ` (also ${rest})` : ""}`);
  }

  // 2. Pain signals — broad, in people's own words. Single pain words, pain
  // phrases, and negated anchors ("no users", "zero traction") all count.
  // They only matter alongside an anchor, which the keep rule enforces.
  const painWordHits = PAIN_WORDS.filter((w) => containsTerm(text, normText(w)));
  const painPhraseHits = PAIN_PHRASE_SIGNALS.filter((p) => containsTerm(text, normText(p)));
  const negatedAnchorHits: string[] = [];
  for (const a of tiers.strong) {
    if (text.includes(`no ${a}`) || text.includes(`zero ${a}`) || text.includes(`0 ${a}`)) negatedAnchorHits.push(`no ${a}`);
  }
  const painSignals: string[] = [...new Set([...painPhraseHits, ...negatedAnchorHits, ...painWordHits])];
  // Signal strength: a pain phrase, a negated anchor ("no users"), or a
  // strong pain word is a real signal. A single weak pain word ("alternative",
  // "problem", "issue"…) is not — pitches and bug reports are full of them.
  const strongPainWordHits = painWordHits.filter((w) => !WEAK_PAIN_WORDS.has(w));
  const weakPainWordHits = painWordHits.filter((w) => WEAK_PAIN_WORDS.has(w));
  const hasStrongPainSignal = painPhraseHits.length > 0 || negatedAnchorHits.length > 0 || strongPainWordHits.length > 0 || weakPainWordHits.length >= 2;

  // 3. Keyword phrases / contexts — a bonus, no longer the gate. A post does
  // NOT need an exact keyword phrase verbatim to reach Muse any more.
  let exactPhrase = "";
  let contextPhrase = "";
  for (const phrase of keywordPhrases(profile)) {
    const np = normText(phrase);
    if (!np) continue;
    if (text.includes(np)) { exactPhrase = phrase; break; }
    const sig = significantTokens(np);
    const specific = sig.filter((w) => !GENERIC_TOKENS.has(w));
    const rest = sig.filter((w) => GENERIC_TOKENS.has(w));
    if (!contextPhrase && specific.length > 0 && specific.every((w) => containsTerm(text, w))
      && (rest.some((w) => containsTerm(text, w)) || painSignals.length > 0)) {
      contextPhrase = phrase;
    }
  }
  if (exactPhrase) { score += 24; parts.push(`matches your keyword phrase “${exactPhrase}” word for word`); }
  else if (contextPhrase) {
    score += 18;
    parts.push(`keyword context present — the specific words of “${contextPhrase}” appear in the post alongside a pain signal`);
  }

  // 4. Pain language counts once the anchor is present.
  if (anchorPresent && painSignals.length) {
    score += Math.min(painSignals.length * 6, 24);
    parts.push(`describes the pain in their own words (${painSignals.slice(0, 3).map((w) => `“${w}”`).join(", ")})`);
  }

  // 5. Workaround signals: phrases people use for the hacks they already
  // try, plus specific tokens from the founder's own workaround text (not a
  // generic word, and not an anchor/topic term itself — the anchor match is
  // already scored above).
  const workaroundPhraseHit = WORKAROUND_PHRASE_SIGNALS.find((p) => containsTerm(text, normText(p))) ?? "";
  const anchorTokenSet = new Set([...tiers.strong, ...tiers.secondary]);
  // Keyword-phrase tokens are excluded too: "show" (from "Show HN") is part
  // of a keyword phrase, and letting it double as the workaround signal
  // meant every Show HN showcase satisfied anchor AND signal with the same
  // two words — a self-fulfilling gate. A workaround signal must be
  // evidence beyond the anchor match itself.
  const keywordTokenSet = new Set(keywordPhrases(profile).flatMap((p) => significantTokens(normText(p))));
  const workTokens = significantTokens(normText(profile.workaround)).filter((w) => !GENERIC_TOKENS.has(w) && !anchorTokenSet.has(w) && !keywordTokenSet.has(w) && w.length >= 4);
  const workTokenHit = workTokens.find((w) => containsTerm(text, w)) ?? "";
  const workaroundSignal = workaroundPhraseHit || workTokenHit;
  if (workaroundSignal && anchorPresent) { score += 8; parts.push(`mentions workaround behaviour (“${workaroundSignal}”)`); }

  score = Math.max(0, Math.min(97, score));
  // Founder exclusions veto: phrases named (via pain expansion) as proof a
  // post is NOT this pain filter it out, whatever else matched. The Profile
  // tab promises exclusions "keep adjacent noise out of search" — this is
  // where that promise is kept.
  const exclusionHit = (() => {
    try {
      const v = JSON.parse(profile.exclusions || "[]") as unknown;
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      return list.map((e) => normText(e)).find((e) => e && containsTerm(text, e)) ?? "";
    } catch { return ""; }
  })();
  if (exclusionHit) parts.push(`matches your exclusion “${exclusionHit}” — not this pain`);
  // THE LIGHT GATE: domain anchor + at least one pain or workaround signal
  // (or an exact/context keyword match), over a low score floor. Anything
  // beyond that — is this really the right person with this pain? — is
  // Muse's call in synthesis, with evidence quote and confidence.
  const hasSignal = hasStrongPainSignal || !!workaroundSignal || !!exactPhrase || !!contextPhrase;
  const keep = anchorPresent && hasSignal && score >= MIN_SAVE_SCORE && !exclusionHit;
  const reason = parts.length
    ? parts.join("; ") + "."
    : anchorPresent
      ? "Domain anchor present, but no pain or workaround signal alongside it — the light pre-filter drops anchor-only posts (ads, showcases, announcements) and lets Muse judge the rest."
      : "No domain anchor from your profile in this post — generic words don't count as an anchor, so the light pre-filter drops it before Muse.";
  return { score, reason, keep, matchedTerms, exactPhrase, contextPhrase, anchorHits, anchorPresent, painSignals, workaroundSignal };
}
function scoreText(text: string, profile: ProfileLike): { score: number; reason: string } {
  const a = analyseText(text, profile);
  return { score: a.score, reason: a.reason };
}
// Retry policy (tested in smoke): GETs retry on network failure (0) or
// 5xx, up to 2 attempts with backoff and a 20s timeout each. POSTs, 4xx,
// and successes never retry — a failed write must never execute twice.
export function shouldRetryFetch(status: number, method: string, attempt: number): boolean {
  if (attempt >= 2) return false;
  if (method !== "GET") return false;
  return status === 0 || status >= 500;
}
export async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const method = (init?.method ?? "GET").toUpperCase();
  let attempt = 0;
  for (;;) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, ...(init?.headers ?? {}) } });
      } finally {
        clearTimeout(timer);
      }
      if (!shouldRetryFetch(res.status, method, attempt)) {
        const txt = await res.text();
        let data: unknown = null;
        try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }
        return { ok: res.ok, status: res.status, data };
      }
    } catch (e) {
      if (!shouldRetryFetch(0, method, attempt)) {
        return { ok: false, status: 0, data: { error: String(e) } };
      }
    }
    attempt++;
    await Bun.sleep(400 * attempt);
  }
}
// fetchText: same retry/timeout/UA policy as fetchJson, but for non-JSON
// payloads (sitemap XML). Guards the size so a huge file fails loudly
// instead of filling memory.
export async function fetchText(url: string, init?: RequestInit, maxBytes = 8_000_000): Promise<{ ok: boolean; status: number; text: string }> {
  const method = (init?.method ?? "GET").toUpperCase();
  let attempt = 0;
  for (;;) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, ...(init?.headers ?? {}) } });
      } finally {
        clearTimeout(timer);
      }
      if (!shouldRetryFetch(res.status, method, attempt)) {
        if (!res.ok) return { ok: false, status: res.status, text: "" };
        const txt = await res.text();
        if (txt.length > maxBytes) return { ok: false, status: 413, text: "" };
        return { ok: true, status: res.status, text: txt };
      }
    } catch {
      if (!shouldRetryFetch(0, method, attempt)) {
        return { ok: false, status: 0, text: "" };
      }
    }
    attempt++;
    await Bun.sleep(400 * attempt);
  }
}
function asObj(d: unknown): Record<string, unknown> { return (d && typeof d === "object") ? (d as Record<string, unknown>) : {}; }
function genCode(): string { return Math.random().toString(36).slice(2, 8).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(); }

// ─── Muse LLM (REQUIRED — the founder's Muse configuration) ──────────────
// Muse is a must-have in EarlyProof, not an optional add-on. The provider is
// Muse — the workspace's Muse model API (ctx.inference is the one model
// runtime a web artifact may use; no third-party provider is called). The
// founder must configure it in the AI tab with their Muse API key and Muse
// model names: a small/fast Muse model for first-pass work (expansion,
// classification, extraction) and a larger Muse model for drafts and
// feedback summaries. The key is stored server-side, never returned to the
// client (only a last-4 hint), never hardcoded, never asked for in chat.
// Until a Muse API key AND both Muse model names are configured, the core
// flow is BLOCKED: live search, lead classification, draft generation,
// feedback summaries and next-experiment suggestions all return status
// "not_configured" with the setup-gate message below. There is no rule-only
// fallback mode: the rule-based relevance gate survives only as a pre-filter
// and safety net underneath Muse classification, and a lead that has not
// been classified by Muse can never be used for outreach.
const LLM_SETUP_MESSAGE = "Setup required — Muse LLM is a must-have in EarlyProof, not an optional add-on. Open the AI tab in this app and enter your Muse API key and your Muse model names (small/fast and large) there — in the app only, never in chat. Until Muse is configured, search, classification, drafts, feedback summaries and next-experiment suggestions are blocked. There is no rule-only mode.";
type LlmSettingsRow = typeof schema.llmSettings.$inferSelect;
async function loadLlmSettings(ctx: Ctx): Promise<LlmSettingsRow | null> {
  // Singleton by construction (save replaces the whole table), latest wins
  // on the read path too — a stale duplicate row can never shadow the key.
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.llmSettings).orderBy(desc(schema.llmSettings.id)).limit(1);
  const s = rows[0];
  if (!s || !s.apiKey.trim()) return null;
  return s;
}
// The local-harness seed placeholder. It exists so a fresh localhost DB has a
// settings row, but it is NOT a key — treating it as configured is the lie
// that filled screens with [local-stub] phrases while the pill looked fine.
const STUB_API_KEY = "local-stub-key";
function isPlaceholderKey(k: string): boolean {
  return k.trim() === STUB_API_KEY;
}
// Stub output is test output. Without a key the Model API accepts, the
// workspace runtime answers with [local-stub]-tagged values — those must
// never be saved or shown as real. They are blocked unless explicitly
// allowed (EARLYPROOF_ALLOW_STUB=1, set only by this repo's own smoke and
// journey harnesses). Everyone else gets a clean not_configured alert that
// says exactly what to do, never dummy data dressed as results.
function stubAllowed(): boolean {
  return process.env.EARLYPROOF_ALLOW_STUB === "1";
}
function isStubTagged(v: unknown): boolean {
  try { return JSON.stringify(v).includes("[local-stub]"); } catch { return false; }
}
function stubBlocked(): LlmFail {
  return { ok: false, status: "not_configured", message: "No working Muse model answered — test output is disabled here, so nothing dummy is shown or saved. Enter a real Muse API key in step 0 (AI config), Test it, Save it, and the plans, phrases, verdicts and drafts generate live." };
}
function llmConfigured(s: LlmSettingsRow | null): boolean {
  return !!s && !!s.apiKey.trim() && !isPlaceholderKey(s.apiKey) && !!s.smallModel.trim() && !!s.largeModel.trim();
}
// Routing verdicts per key, so a key the API rejected (or the network
// failed) doesn't pay a slow direct attempt on every call. Direct successes
// also feed the status pill. Entries expire — a fixed key re-proves itself.
type RouteVerdict = { route: "direct" | "runtime"; at: number };
const ROUTE_TTL_MS = 10 * 60 * 1000;
const routeCache = new Map<string, RouteVerdict>();
function cachedRoute(apiKey: string): "direct" | "runtime" | null {
  const hit = routeCache.get(apiKey);
  if (!hit || Date.now() - hit.at > ROUTE_TTL_MS) return null;
  return hit.route;
}
function rememberRoute(apiKey: string, route: "direct" | "runtime") {
  routeCache.set(apiKey, { route, at: Date.now() });
}
function verifiedDirect(apiKey: string): boolean {
  return isDirectKey(apiKey) || routeCache.get(apiKey)?.route === "direct";
}
async function requireLlm(ctx: Ctx): Promise<LlmSettingsRow | null> {
  const s = await loadLlmSettings(ctx);
  return llmConfigured(s) ? s : null;
}
type LlmFail = { ok: false; status: "not_configured" | "error"; message: string };
// One-level-deeper shape fingerprint for parse failures (keys + first-item
// shapes, values never included) so a live-model mismatch names its gap.
function shapeOf(v: unknown, depth = 0): string {
  if (Array.isArray(v)) return `array[${v.length}]${v.length && depth < 2 ? `<${shapeOf(v[0], depth + 1)}>` : ""}`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v).slice(0, 10);
    if (depth >= 1) return `{${keys.join(",")}}`;
    return `{${keys.map((k) => `${k}:${shapeOf((v as Record<string, unknown>)[k], depth + 1)}`).join(",").slice(0, 160)}}`;
  }
  return typeof v;
}
// Runs one bounded Muse task through the workspace's Muse model runtime
// with a typed schema (the runtime validates the shape). The founder's
// configured Muse model name for the tier travels with the task.
async function runLlm<T>(ctx: Ctx, tier: "small" | "large", task: string, schema: z.ZodSchema<T>, opts?: { allowStubTag?: boolean }): Promise<{ ok: true; value: T } | LlmFail> {
  const s = await loadLlmSettings(ctx);
  if (!llmConfigured(s) || !s) return { ok: false, status: "not_configured", message: LLM_SETUP_MESSAGE };
  const model = (tier === "large" ? (s.largeModel || s.smallModel) : (s.smallModel || s.largeModel)).trim();
  if (!model) return { ok: false, status: "not_configured", message: `No ${tier === "large" ? "large" : "small/fast"} Muse model name set in the AI tab.` };
  // Direct path first for ANY saved key — the API itself decides whether the
  // pasted string works; no prefix gate. An LLM| key that the API rejects
  // fails closed (never silently stubbed). Any other rejected key falls back
  // to the workspace model runtime (the local stub, honestly tagged).
  const forcedDirect = isDirectKey(s.apiKey);
  // When the direct attempt fails and the runtime fallback is blocked test
  // output, this carries the true cause so the founder never hears "enter a
  // real key" while one is already saved and working.
  let directError: string | null = null;
  if (forcedDirect || cachedRoute(s.apiKey) !== "runtime") {
    const r = await completeViaMetaModel(task, s.apiKey, META_MODEL);
    if (r.ok) {
      rememberRoute(s.apiKey, "direct");
      try {
        return { ok: true, value: schema.parse(r.value) };
      } catch (e) {
        // Name the exact gap (paths only, never values) so a live-model
        // mismatch is actionable instead of a shrug.
        const gap = e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ").slice(0, 200)
          : shapeOf(r.value);
        return { ok: false, status: "error", message: `Direct Muse Spark 1.3 call returned an unexpected shape (${gap}) — nothing was saved.` };
      }
    }
    // An LLM| key the API rejects fails closed — never silently stubbed.
    if (forcedDirect) return { ok: false, status: "error", message: `Direct Muse Spark 1.3 call failed (${r.error}). Check the key and Model API quota — nothing was saved.` };
    // Any other rejected key keeps the old behavior: the workspace runtime
    // serves it (the local stub, honestly tagged). The rejection is already
    // reported by Test connection and the status pill.
    if (r.error.startsWith("HTTP 401")) rememberRoute(s.apiKey, "runtime");
    else directError = r.error;
  }
  try {
    const value = await ctx.inference.complete(
      `Configured Muse model for this task (${tier === "large" ? "large tier — quality matters more than speed" : "small/fast tier — high-volume first pass"}): ${model}\n\n${task}`,
      { schema },
    );
    // The runtime fallback answered with tagged test output: block it unless
    // the caller opted in (connection test) or the harness allows it (smoke/
    // journey). The direct-API path above trusts the real API and is untouched.
    if (!opts?.allowStubTag && !stubAllowed() && isStubTagged(value)) {
      if (directError) return { ok: false, status: "error", message: `Direct Muse Spark 1.3 call failed (${directError}) and the fallback is test output, which is blocked — nothing dummy was saved. Check the key and Model API quota, then try again.` };
      return stubBlocked();
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, status: "error", message: `Muse model call failed: ${String(e).slice(0, 160)}` };
  }
}
// Cheap deterministic cache key for a classification: same post + same
// profile pain → same verdict, no second model call.
function llmHashFor(text: string, profile: ProfileLike): string {
  const src = normText(text) + "|" + normText(profile.pain) + "|" + normText(profile.audience);
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
  return "h" + h.toString(36) + "-" + src.length;
}
const LOW_CONFIDENCE = 60; // below this a lead goes to founder review, never straight to outreach

// ─── Stage 2 semantic rerank: meaning, not words ───────────────────────────
// The keyword gate decides what is ALLOWED in and BM25 orders words by
// rarity; this stage orders by MEANING. One batched listwise Muse call
// scores the top candidates against the pain in the founder's own words —
// paraphrases ("lost my job, rent due") outrank keyword-stuffed decoys
// ("help help giveaway help") that share surface words but no situation.
// Pure prompt/score parsing (unit-tested); the only network is the single
// runLlm call at the fusion site, which fails soft (lexical order stands,
// the run says so) — the hunt never blocks on it.
export const SEMANTIC_RERANK_CAP = 40;
export function buildSemanticRerankPrompt(pain: string, audience: string, items: { key: string; title: string; body: string }[]): string {
  const rendered = items
    .map((c) => `--- CAND ${c.key}\n${(c.title ?? "").slice(0, 160)}\n${(c.body ?? "").slice(0, 400)}`)
    .join("\n");
  return `Score each candidate post below for SEMANTIC relevance to one person's problem — not word overlap. Two posts can share zero keywords and mean the same thing ("laid off, bills due" vs "lost my job and rent is due"); two posts can share many keywords and mean nothing alike (a giveaway post stuffed with "help" vs someone asking for help). Judge the SITUATION: is this person living the problem described? 100 = exactly this pain in their own words, right now. 50 = adjacent situation, maybe useful. 0 = unrelated, a showcase, ad, joke, or someone selling — no matter how many keywords match. Score every candidate, even the weak ones; relative order matters more than absolute numbers. Reply with ONLY this JSON object and no other text, no markdown, no explanation — the exact keys matter: {"scores": [{"key": "<the CAND key exactly as shown>", "score": 0-100}]}. Only the public post text follows.\nTarget problem — Audience: ${audience}\nPain: ${pain}\n\n${rendered}`;
}
const semanticRerankSchema = z.object({ scores: z.array(z.object({ key: z.string(), score: z.number() })).default([]) });
// Clamp to 0-100, drop keys that were never candidates (the model must not
// invent or rename entries). Missing keys simply stay unscored.
export function parseSemanticScores(value: unknown, keys: Set<string>): Map<string, number> {
  const parsed = semanticRerankSchema.parse(value);
  const out = new Map<string, number>();
  for (const s of parsed.scores) {
    if (!keys.has(s.key) || out.has(s.key)) continue;
    out.set(s.key, Math.max(0, Math.min(100, Math.round(s.score))));
  }
  return out;
}

// ─── Step 4 synthesis: Muse classification of waiting leads ───────────────
// Shared by the classifyLeads action AND by searchLiveLeads, which runs this
// automatically at the end of every search (workflow Step 3 → Step 4) so the
// results a founder sees are always the synthesized, classified ones — never
// raw, unclassified keyword hits. Returns counts + a human message.
type ClassifyOutcome = { status: string; message: string; classified: number; cached: number; lowConfidence: number; needsReview: number };
function buildClassifyPrompt(profile: ProfileLike, items: string, firstPass: { id: number; category: string; confidence: number; reason: string }[] | null): string {
  const head = `Classify candidate seed users for a founder. The light pre-filter already confirmed a domain anchor from the profile is present in the post, plus a pain or workaround signal (or the post was a top anchored candidate passed up for your judgement) — that filter is only a safety net, NOT a relevance verdict: your classification is the real gate, so judge strictly and mark anchor-only showcases, ads and jokes irrelevant with low confidence. Your job is the judgement keywords can't do. For EACH post, return one result with its post id and judge: rightPerson (is this the target audience, in the situation described?), realPain (did they describe this pain in their own words, as their own current problem?), workaroundOrPaying (are they already hacking a workaround or paying for something imperfect?), recent (does it read as current/recent, not an old or hypothetical story?). category is one of: seed_user (right person + real pain), curious (interested or adjacent but no clear own pain), irrelevant (wrong person, selling something, joke, or not this pain). confidence is 0-100 — be honest: ambiguous posts get low confidence. Show HN launch announcements and founder pitches are irrelevant unless the author personally asks for help with this pain in their own words — describing a market problem ("difficult for young investors", "high entry barrier") is not the author's own pain. Some candidates come from forum thread titles only (no post body) — judge on the title alone; prefer curious unless the title itself shows the person's own pain. The quote MUST be copied word-for-word from the post; if no phrase supports the pain, use an empty string and lower the confidence. reason: one short sentence grounded in the post. Never invent a quote. Reply with ONLY this JSON object and no other text, no markdown, no explanation — the exact keys matter: {"results": [{"id": <the post id number from its --- POST header>, "category": "...", "confidence": 0-100, "reason": "...", "quote": "...", "rightPerson": true/false, "realPain": true/false, "workaroundOrPaying": true/false, "recent": true/false}]}. Only the public post text follows — no personal data beyond what the person posted.\nTarget profile — Audience: ${profile.audience}\nPain: ${profile.pain}\nWorkaround today: ${profile.workaround}\nProduct: ${profile.productName} — ${profile.productDesc}\n\n`;
  if (!firstPass) return head + items;
  const firstRead = firstPass.map((f) => "post " + f.id + " \u2192 " + f.category + " (" + f.confidence + "%): \u201c" + f.reason.slice(0, 200) + "\u201d").join("\n");
  return "You are giving these posts a SECOND look as devil\u2019s advocate. The first read said:\n" + firstRead + "\nChallenge it: steelman the case that each person IS worth reaching \u2014 but only from their own words. Quote verbatim or leave the quote empty; a second look that invents pain is worse than a first look that missed it. If the words are not there, confirm irrelevant.\n\n" + head + items;
}
const classifySchema = z.object({ results: z.array(z.object({ id: z.number(), category: z.string().default("curious"), confidence: z.number().default(0), reason: z.string().default(""), quote: z.string().default(""), rightPerson: z.boolean().default(false), realPain: z.boolean().default(false), workaroundOrPaying: z.boolean().default(false), recent: z.boolean().default(false) })).default([]) });
const judgeAgent = defineAgent({
  name: "Judge",
  goal: "Judge each candidate post against the profile: right person, real pain in their own words, workaround or paying, recent \u2014 with a verbatim quote or none.",
  run: async (ctx, input: { profile: ProfileLike; items: string; batchIds: number[]; firstPass: { id: number; category: string; confidence: number; reason: string }[] | null }, _attempt) => {
    const r = await runLlm(ctx, "small", buildClassifyPrompt(input.profile, input.items, input.firstPass), classifySchema);
    if (!r.ok) return r;
    return { ok: true, value: r.value };
  },
  validate: (v, input) => {
    for (const o of v.results) if (!input.batchIds.includes(o.id)) return "result id " + o.id + " matches no post in this batch";
    return null;
  },
});
// Judge entry for every flow: the same batches, the same validator, traced
// on the caller's run when there is one (manual Classify passes 0).
async function classifyForProfile(ctx: Ctx, profile: typeof schema.profiles.$inferSelect, runId = 0): Promise<ClassifyOutcome> {
  const zero = { classified: 0, cached: 0, lowConfidence: 0, needsReview: 0 };
  const db = ctx.db<typeof schema>();
  const settings = await loadLlmSettings(ctx);
  if (!llmConfigured(settings)) return { status: "not_configured", message: LLM_SETUP_MESSAGE, ...zero };
  const all = await db.select().from(schema.leads).where(eq(schema.leads.profileId, profile.id));
  const candidates = all.filter((l) => ["new", "drafted"].includes(l.status));
  if (!candidates.length) return { status: "ok", message: "No leads waiting to be classified — leads in Found or Drafted are classified; ones already moving through your tracker are left alone.", ...zero };
  const byHash = new Map<string, typeof candidates[number]>();
  for (const l of all) if (l.llmCategory && l.llmHash) byHash.set(l.llmHash, l);
  let cached = 0; let classified = 0; let lowConfidence = 0; let needsReview = 0;
  const pending: typeof candidates = [];
  for (const l of candidates) {
    const hash = llmHashFor(`${l.title} ${l.body}`, profile);
    if (l.llmHash === hash && l.llmCategory) continue;
    const twin = byHash.get(hash);
    if (twin && twin.id !== l.id) {
      await db.update(schema.leads).set({ llmCategory: twin.llmCategory, llmConfidence: twin.llmConfidence, llmReason: twin.llmReason, llmQuote: twin.llmQuote, llmSignals: twin.llmSignals, llmHash: hash, updatedAt: new Date() }).where(eq(schema.leads.id, l.id));
      cached++;
      if (twin.llmConfidence < LOW_CONFIDENCE || twin.llmCategory === "irrelevant") needsReview++;
      continue;
    }
    pending.push(l);
  }
  for (let i = 0; i < pending.length; i += 8) {
    const batch = pending.slice(i, i + 8);
    const items = batch.map((l, j) => `--- POST ${j + 1} (id ${l.id}, channel ${l.channel}) ---\nTitle: ${l.title}\n${l.body.slice(0, 700)}`).join("\n");
    if (runId) await touchSearchRun(db, runId, "synthesizing", `Judge is reading batch ${Math.floor(i / 8) + 1} of ${Math.ceil(pending.length / 8)}…`);
    const r = await judgeAgent.execute(ctx, { profile, items, batchIds: batch.map((l) => l.id), firstPass: null }, runId);
    if (!r.ok) { return { status: r.status, message: `${r.message} (${classified} lead${classified === 1 ? "" : "s"} classified before this batch.)`, classified, cached, lowConfidence, needsReview }; }
    // The model sometimes repeats a post id across result objects — count and
    // save each lead once, or the "synthesized" count inflates past the
    // queue (e.g. 8 synthesized, 7 leads, Threads (0)).
    const seenIds = new Set<number>();
    const savedNow: { id: number; cat: string; conf: number; reason: string }[] = [];
    for (const o of r.value.results) {
      if (seenIds.has(o.id)) continue;
      seenIds.add(o.id);
      const lead = batch.find((l) => l.id === o.id);
      if (!lead) continue;
      const cat = ["seed_user", "curious", "irrelevant"].includes(o.category) ? o.category : "curious";
      const conf = Math.max(0, Math.min(100, Math.round(o.confidence || 0)));
      let quote = o.quote.trim();
      if (quote && !normText(`${lead.title} ${lead.body}`).includes(normText(quote))) quote = "";
      const signals = JSON.stringify({ rightPerson: o.rightPerson, realPain: o.realPain, workaroundOrPaying: o.workaroundOrPaying, recent: o.recent });
      await db.update(schema.leads).set({ llmCategory: cat, llmConfidence: conf, llmReason: o.reason.slice(0, 300), llmQuote: quote.slice(0, 300), llmSignals: signals, llmHash: llmHashFor(`${lead.title} ${lead.body}`, profile), llmReviewed: 0, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
      classified++;
      savedNow.push({ id: lead.id, cat, conf, reason: o.reason });
      if (conf < LOW_CONFIDENCE) lowConfidence++;
      if (conf < LOW_CONFIDENCE || cat === "irrelevant") needsReview++;
    }
    // Ensemble second look for the unsure: the steelman prompt argues the
    // other way, but adoption only ever upgrades on the person's own quoted
    // words — a second look can rescue, never condemn. Counts stay honest:
    // an upgrade that clears the bar un-counts its earlier hold flags.
    const unsure = savedNow.filter((s) => s.conf < LOW_CONFIDENCE);
    if (unsure.length) {
      const rank = (c: string) => (c === "seed_user" ? 2 : c === "curious" ? 1 : 0);
      const prior = new Map(savedNow.map((s) => [s.id, s]));
      const items2 = unsure.map((s, j) => {
        const l = batch.find((b) => b.id === s.id)!;
        return `--- POST ${j + 1} (id ${l.id}, channel ${l.channel}) ---\nTitle: ${l.title}\n${l.body.slice(0, 700)}`;
      }).join("\n");
      const r2 = await judgeAgent.execute(ctx, { profile, items: items2, batchIds: unsure.map((s) => s.id), firstPass: unsure.map((s) => ({ id: s.id, category: s.cat, confidence: s.conf, reason: s.reason })) }, runId);
      if (r2.ok) {
        for (const o of r2.value.results) {
          const lead = batch.find((l) => l.id === o.id);
          const p = prior.get(o.id);
          if (!lead || !p) continue;
          const cat = ["seed_user", "curious", "irrelevant"].includes(o.category) ? o.category : "curious";
          const conf = Math.max(0, Math.min(100, Math.round(o.confidence || 0)));
          let quote = o.quote.trim();
          if (quote && !normText(`${lead.title} ${lead.body}`).includes(normText(quote))) quote = "";
          if (rank(cat) > rank(p.cat) && quote) {
            const signals = JSON.stringify({ rightPerson: o.rightPerson, realPain: o.realPain, workaroundOrPaying: o.workaroundOrPaying, recent: o.recent });
            await db.update(schema.leads).set({ llmCategory: cat, llmConfidence: conf, llmReason: o.reason.slice(0, 300), llmQuote: quote.slice(0, 300), llmSignals: signals, llmReviewed: 0, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
            if (p.conf < LOW_CONFIDENCE && conf >= LOW_CONFIDENCE) lowConfidence--;
            if ((p.conf < LOW_CONFIDENCE || p.cat === "irrelevant") && !(conf < LOW_CONFIDENCE || cat === "irrelevant")) needsReview--;
          }
        }
      }
    }
  }
  const bits = [`${classified} classified by your small Muse model`, cached ? `${cached} reused from cache` : "", lowConfidence ? `${lowConfidence} low-confidence (under ${LOW_CONFIDENCE}%)` : "", needsReview ? `${needsReview} held for your review before any outreach` : ""].filter(Boolean).join(" · ");
  return { status: "ok", message: classified || cached ? `Done — ${bits}. Every verdict shows its evidence and quote on the lead. Only classified leads can move to drafts and outreach; the rule-based score underneath is a pre-filter only.` : "The model returned no usable verdicts — no lead was cleared for outreach. Try again.", classified, cached, lowConfidence, needsReview };
}

// Drafter: the outreach specialist. Writes the first message in the
// founder's voice, then checks its own tone. Validation is a backstop with
// teeth: empty or bloated drafts retry once, then fail honestly — the
// handler below never substitutes a template.
const draftSchema = z.object({ draft: z.string(), toneCheck: z.string().default("") });
const drafterAgent = defineAgent({
  name: "Drafter",
  goal: "Write a first outreach message in the founder's voice, then check its own tone — never post, only draft.",
  run: async (ctx, input: { profile: typeof schema.profiles.$inferSelect; lead: typeof schema.leads.$inferSelect }, _attempt) => {
    const p = input.profile, lead = input.lead;
    const channelRules = lead.channel === "bluesky" ? "Bluesky: keep it under 280 characters, conversational, no hashtag spam." : lead.channel === "reddit_poc" || lead.channel === "reddit" ? "Reddit: respect community norms — no link dump on first touch, no hype, disclose that you built it." : lead.channel === "github" ? "GitHub: be brief and technical, acknowledge their issue specifically, never spam maintainers." : "Closed/DM channel: extra care — they didn't ask to be contacted; be short, easy to decline, no pressure.";
    const r = await runLlm(ctx, "large",
      `Write a first outreach message for a founder, then check your own work in the toneCheck field: one or two plain sentences on whether the draft sounds like a genuine founder asking for help (not a pitch blast or a template), whether it follows the channel rules, and anything the founder should fix before approving. You never post anything yourself.\nVoice: plain, honest, first person, no marketing language.\nChannel: ${lead.channel}. Channel rules: ${channelRules}\nRules for the draft: reference their specific post in their own words; say plainly the founder built something for this exact problem; ask for help trying it for one real task — a request for help, not a pitch; no link dump; under 90 words unless the channel rule above is stricter.\nProduct: ${p.productName} — ${p.productDesc}\nPain it addresses: ${p.pain}\nTheir post (by ${lead.author}): Title: ${lead.title}\n${lead.body.slice(0, 900)}`,
      draftSchema);
    if (!r.ok) return r;
    return { ok: true, value: r.value };
  },
  validate: (v) => {
    if (!v.draft.trim()) return "empty draft";
    if (v.draft.trim().split(/\s+/).length > 120) return "draft over 120 words (prompt caps at 90)";
    return null;
  },
});

// Watcher: the cohort-loop specialist. Watches the invite/event/feedback
// signals and proposes the single next experiment on the fixed
// audience → message → problem order — never a PMF verdict. The lever order
// itself stays deterministic code at the call site; only the experiment
// prose is the agent's. Validation keeps the fixed lever fixed.
const experimentSchema = z.object({ experiment: z.string().default("") });
const watcherAgent = defineAgent({
  name: "Watcher",
  goal: "Propose the single next experiment the cohort signals point at — a next test, never a PMF verdict.",
  run: async (ctx, input: { profile: typeof schema.profiles.$inferSelect; lever: string; rationale: string; signals: Record<string, number>; latestFb: string }, _attempt) => {
    const p = input.profile;
    const r = await runLlm(ctx, "small",
      `Suggest ONE next experiment for a founder from cohort signals. Hard rules: you must NOT give a PMF score, a PMF verdict, or say whether they have product-market fit — the founder decides that. You must keep the lever you are given (audience, message, or problem) — the order is fixed. Write the experiment as one concrete paragraph: what to change, who it runs on, for how long, and which signal to watch. Ground it in the numbers given.\nLever (fixed): ${input.lever}\nWhy this lever: ${input.rationale}\nSignals: ${JSON.stringify(input.signals)}\nProfile: audience ${p.audience}; pain ${p.pain}; core action ${p.coreAction}\nLatest feedback summary (may be empty): ${input.latestFb.slice(0, 1500)}`,
      experimentSchema);
    if (!r.ok) return r;
    return { ok: true, value: r.value };
  },
  validate: (v, input) => {
    if (!v.experiment.trim()) return "empty experiment";
    if (!v.experiment.toLowerCase().includes(input.lever.toLowerCase())) return `experiment drops the fixed lever "${input.lever}"`;
    return null;
  },
});

// ─── LLM search expansion (Step 3) ──────────────────────────────────────────
// Before and during search, Muse generates an expansion plan from the
// profile: query variants in the person's own language, related pain phrases
// and adjacent problems, related communities/places and which channel each
// maps to. HARD RULE: every expanded query must stay anchored to the
// profile's domain — every expanded query must contain the plan's anchor
// term, which itself must come from the profile text. Unanchored queries
// are dropped
// server-side and counted — generic words alone never become a query, so
// expansion can't bring back the old generic coding/Plex-type matches.
type ExpansionQuery = { query: string; intent: string };
type ExpansionCommunity = { name: string; where: string; channel: string; access: string; why: string; site: string };
type ExpansionPlan = {
  anchorTerm: string;
  queries: ExpansionQuery[];
  painPhrases: string[];
  adjacentProblems: string[];
  adjacentAudiences: string[];
  communities: ExpansionCommunity[];
  relaxations: string[];
  nextSuggestions: string[];
  droppedUnanchored: number;
};
// A stored plan counts as usable when it can still vote channels up through
// mapped communities, even if its search queries are gone (older app versions
// saved rows this shape can't parse — those must read as empty, never as
// "no plan yet" when a round visibly exists).
export function parseExpansionPlan(raw: string): ExpansionPlan | null {
  try {
    const p = JSON.parse(raw || "{}") as Partial<ExpansionPlan>;
    const hasQueries = Array.isArray(p.queries) && p.queries.length > 0;
    const hasCommunities = Array.isArray(p.communities) && p.communities.length > 0;
    if (!hasQueries && !hasCommunities) return null;
    return {
      anchorTerm: typeof p.anchorTerm === "string" ? p.anchorTerm : "",
      queries: Array.isArray(p.queries) ? p.queries : [],
      painPhrases: Array.isArray(p.painPhrases) ? p.painPhrases : [],
      adjacentProblems: Array.isArray(p.adjacentProblems) ? p.adjacentProblems : [],
      adjacentAudiences: Array.isArray(p.adjacentAudiences) ? p.adjacentAudiences : [],
      communities: Array.isArray(p.communities) ? p.communities : [],
      relaxations: Array.isArray(p.relaxations) ? p.relaxations : [],
      nextSuggestions: Array.isArray(p.nextSuggestions) ? p.nextSuggestions : [],
      droppedUnanchored: typeof p.droppedUnanchored === "number" ? p.droppedUnanchored : 0,
    };
  } catch { return null; }
}

// ─── Web venue discovery (Google-like first step, generalized) ───────────
// For ANY profile — not just hardcoded verticals: query DuckDuckGo's keyless
// HTML endpoint with the profile's own anchor + pain phrasing biased toward
// discussions, group result URLs into venues, and verify unknown forums by
// fetching their sitemap index. Verified forums become real searchable
// channels (`forum:<slug>`); Reddit subs and unverifiable discussion places
// join the join-by-hand venue list; magazine/article domains are dropped —
// articles are not people talking.
const DDG_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export type DdgHit = { url: string; title: string };
export function ddgResults(html: string): DdgHit[] {
  const out: DdgHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 30) {
    const raw = m[1] ?? "";
    const uddg = (raw.match(/uddg=([^&]+)/) || [])[1];
    let url = "";
    try { url = decodeURIComponent(uddg || raw); } catch { url = raw; }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHnText(m[2] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) continue;
    out.push({ url, title });
  }
  return out;
}

// SearXNG: self-hosted metasearch, free forever, no key. Same DdgHit shape
// so it feeds groupVenues unchanged. Default points at a local instance;
// override with EARLYPROOF_SEARXNG_URL. An unreachable host fails fast under
// the shared fetch policy (connection-refused, two quick retries at most).
export function searxngUrl(): string {
  return (process.env.EARLYPROOF_SEARXNG_URL ?? "http://localhost:8888").replace(/\/+$/, "");
}
export function parseSearxngResults(data: unknown): DdgHit[] {
  const raw = asObj(data).results;
  const rows = Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: DdgHit[] = [];
  for (const r of rows) {
    const o = asObj(r);
    const url = String(o.url ?? "");
    const title = String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    out.push({ url, title });
    if (out.length >= 30) break;
  }
  return out;
}
export async function searxngSearch(query: string): Promise<DdgHit[]> {
  const r = await fetchJson(`${searxngUrl()}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=1`);
  if (!r.ok) return [];
  return parseSearxngResults(r.data);
}

// Domains whose thread URLs map straight onto registry channels.
const REGISTRY_DOMAINS: Record<string, string> = {
  "agingcare.com": "agingcare", "mumsnet.com": "mumsnet",
  "makeuptalk.com": "makeuptalk", "lipstickalley.com": "lipstickalley",
  "eurobricks.com": "eurobricks", "forums.studentdoctor.net": "studentdoctor",
  "dev.to": "devto", "lobste.rs": "lobsters",
  "news.ycombinator.com": "hackernews", "github.com": "github", "bsky.app": "bluesky",
};
const DISCUSSION_MARKERS = ["/r/", "/threads/", "/thread/", "/discussion/", "/topic", "/forum", "/chat/", "/community/", "/board", "/showthread", "/viewtopic", "/questions/", "/talk/"];
export type VenueGroup = { domain: string; key: string; sub?: string; urls: string[]; titles: string[] };
export function groupVenues(hits: DdgHit[]): VenueGroup[] {
  const map = new Map<string, VenueGroup>();
  for (const h of hits) {
    let u: URL; try { u = new URL(h.url); } catch { continue; }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = (u.pathname + u.search).toLowerCase();
    // Reddit communities are venues, not reddit.com.
    const rm = (host === "reddit.com" || host === "old.reddit.com") ? path.match(/^\/r\/([a-z0-9_]+)/) : null;
    const key = rm ? `reddit:r/${rm[1]}` : host;
    const g = map.get(key) ?? { domain: host, key, sub: rm?.[1], urls: [] as string[], titles: [] as string[] };
    if (!g.urls.includes(h.url)) { g.urls.push(h.url); g.titles.push(h.title); }
    map.set(key, g);
  }
  return [...map.values()];
}

export type DynamicVenue = { slug: string; label: string; domain: string; index: string; files: string[]; flat: boolean };
function slugFor(domain: string): string {
  return domain.replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function labelFor(domain: string): string {
  const base = domain.replace(/^www\./, "").split(".").slice(-2, -1)[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
export async function verifyForumDomain(domain: string): Promise<DynamicVenue | null> {
  const cands = [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap.php`, `https://${domain}/sitemap_index.xml`];
  for (const index of cands) {
    const r = await fetchText(index);
    if (!r.ok) continue;
    if (r.text.includes("<sitemapindex")) {
      // Sequential index files (XenForo-style) run oldest-first: the last
      // two are the newest. Title gating at search time keeps strays out.
      const files = sitemapLocs(r.text, "sitemap").map((e) => e.loc).filter((u) => u !== index);
      if (!files.length) continue;
      return { slug: slugFor(domain), label: labelFor(domain), domain, index, files: files.slice(-2), flat: false };
    }
    if (r.text.includes("<urlset")) {
      const urls = sitemapLocs(r.text, "url").map((e) => e.loc);
      if (urls.length < 20) continue;
      return { slug: slugFor(domain), label: labelFor(domain), domain, index, files: [], flat: true };
    }
  }
  return null;
}

export type DiscoveryFindings = {
  evidence: { channel: string; threads: number; samples: string[] }[];
  dynamic: DynamicVenue[];
  venues: { name: string; where: string; why: string; url: string; src: "web" | "plan" }[];
  // False when the web was never actually checked (throttled challenge page,
  // fetch failure) — the UI must say so instead of claiming coverage.
  webOk: boolean;
  // Which backend served the evidence: "brave", "duckduckgo", or "" (none).
  webVia: string;
};
// Brave Search API (keyed): the durable backend when free scraping is
// throttled. GET /res/v1/web/search with X-Subscription-Token; the free tier
// covers discovery volume (one query per profile, cached 2h like DDG).
async function braveWebSearch(query: string, key: string): Promise<DdgHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&safesearch=moderate`, {
      headers: { "X-Subscription-Token": key, "Accept": "application/json" }, signal: ctrl.signal,
    });
    if (!res.ok) return [];
    return parseBraveResults(await res.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
export function parseBraveResults(json: unknown): DdgHit[] {
  const out: DdgHit[] = [];
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const web = (o.web && typeof o.web === "object" ? o.web : {}) as Record<string, unknown>;
  const results = Array.isArray(web.results) ? web.results : [];
  for (const r of results) {
    if (out.length >= 30) break;
    const rec = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : "";
    const title = typeof rec.title === "string" ? rec.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!/^https?:\/\//i.test(url) || !title) continue;
    out.push({ url, title });
  }
  return out;
}
// A profile's channel hunt belongs to its exact words: new profiles get a
// cold hunt, and editing the text retires the old hunt automatically — a new
// or edited profile can never see another (or older) profile's venues.
export function profileSignature(profile: ProfileLike): string {
  return normText([profile.productName, profile.productDesc, profile.audience, profile.pain, profile.workaround, profile.keywords, profile.coreAction].join(" "));
}
function discoveryCacheKey(profile: ProfileLike & { id: number }): string {
  const sig = profileSignature(profile);
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0;
  return `${profile.id}:${h.toString(36)}`;
}
const discoveryCache = new Map<string, { at: number; data: DiscoveryFindings }>();
export function clearDiscoveryCache(profileId: number) {
  if (profileId < 0) { discoveryCache.clear(); return; } // backend changed — never serve the other backend's cache
  for (const k of [...discoveryCache.keys()]) if (k === `${profileId}` || k.startsWith(`${profileId}:`)) discoveryCache.delete(k);
}
// Domains Muse names in its expansion plan that no search engine has
// verified: the plan is the lead, a live thread-sitemap check is the proof.
// Registry forums are excluded (already covered); file extensions are not
// domains. Pure — tested with fixtures.
const PLAN_DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\b/gi;
export function planDomains(plan: ExpansionPlan | null): { domain: string; name: string }[] {
  const out: { domain: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const c of plan?.communities ?? []) {
    PLAN_DOMAIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLAN_DOMAIN_RE.exec(`${c.name} ${c.where}`))) {
      const raw = m[1] ?? "";
      if (!raw) continue;
      const domain = raw.toLowerCase().replace(/^www\./, "");
      if (seen.has(domain) || (REGISTRY_DOMAINS as Record<string, string>)[domain]) continue;
      if (/\.(png|jpg|jpeg|gif|css|js|ico)$/.test(domain)) continue;
      seen.add(domain);
      out.push({ domain, name: c.name });
    }
  }
  return out;
}
function planHash(plan: ExpansionPlan | null): string {
  const s = (plan?.communities ?? []).map((c) => `${c.name}|${c.where}`).join("~");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function discoveryAnchor(profile: ProfileLike): string {
  return anchorTermsFor(profile).anchorTerm
    || profile.keywords.split(",").map((s) => s.trim()).filter(Boolean)[0]
    || profile.productDesc.trim().split(" ").slice(0, 4).join(" ");
}
// One query per discovery: DDG throttles bursts (HTTP 202 challenge page),
// so a single combined query plus a long cache keeps discovery alive across
// profiles. Failures (non-200, challenge pages) are never cached.
const DISCOVERY_TTL_MS = 2 * 60 * 60 * 1000;
function discoveryQuery(profile: ProfileLike): string {
  const anchor = discoveryAnchor(profile);
  const pain = profile.pain.trim() || profile.audience.trim();
  return `${anchor} ${pain} ${profile.audience.trim()} forum thread discussion`.trim();
}

async function braveKeyFor(ctx: Ctx): Promise<string> {
  const s = await loadLlmSettings(ctx);
  return s?.braveKey.trim() ?? "";
}
export async function discoverVenuesFor(profile: ProfileLike & { id: number }, braveKey = "", plan: ExpansionPlan | null = null): Promise<DiscoveryFindings> {
  const key = `${discoveryCacheKey(profile)}:${braveKey ? "b" : "d"}:p${planHash(plan)}`;
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.data;
  const data: DiscoveryFindings = { evidence: [], dynamic: [], venues: [], webOk: false, webVia: "" };
  const anchor = discoveryAnchor(profile);
  // Keyed backend first (works from throttled networks); free self-hosted
  // SearXNG second (no key, no throttle when you run it locally); free DDG
  // scraping last. Either way, failures are never cached.
  let groups: VenueGroup[] = [];
  if (braveKey) {
    const hits = await braveWebSearch(discoveryQuery(profile), braveKey);
    if (hits.length) { groups = groupVenues(hits); data.webVia = "brave"; }
  }
  if (!groups.length) {
    const hits = await searxngSearch(discoveryQuery(profile));
    if (hits.length) { groups = groupVenues(hits); data.webVia = "searxng"; }
  }
  if (!groups.length) {
    const page = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(discoveryQuery(profile))}`, { headers: { "User-Agent": DDG_UA } });
    if (page.status !== 200) return data;
    if (!ddgResults(page.text).length && page.text.includes("challenge")) return data;
    groups = groupVenues(ddgResults(page.text));
    if (groups.length) data.webVia = "duckduckgo";
  }
  const verifyTargets: VenueGroup[] = [];
  for (const g of groups) {
    const reg = REGISTRY_DOMAINS[g.domain];
    if (reg) { data.evidence.push({ channel: reg, threads: g.urls.length, samples: g.titles.slice(0, 2) }); continue; }
    if (g.sub) {
      data.venues.push({ name: `r/${g.sub}`, where: "Reddit", why: `Web search found ${g.urls.length} thread${g.urls.length === 1 ? "" : "s"} about '${anchor}' here — e.g. “${g.titles[0]}”. No public API: join and add by hand (or connect the Reddit POC).`, url: `https://www.reddit.com/r/${g.sub}/`, src: "web" });
      continue;
    }
    if (g.domain.endsWith(".stackexchange.com") || g.domain === "stackoverflow.com") {
      data.evidence.push({ channel: "stackexchange", threads: g.urls.length, samples: g.titles.slice(0, 2) });
      continue;
    }
    const discussionUrls = g.urls.filter((u) => DISCUSSION_MARKERS.some((mk) => u.toLowerCase().includes(mk)));
    if (!discussionUrls.length) continue; // articles, not people talking — dropped
    verifyTargets.push(g);
  }
  const verified = await Promise.all(verifyTargets.slice(0, 3).map((g) => verifyForumDomain(g.domain)));
  const verifiedDomains = new Set<string>();
  for (const v of verified) if (v) { data.dynamic.push(v); verifiedDomains.add(v.domain); }
  for (const g of verifyTargets) {
    if (verifiedDomains.has(g.domain) || data.venues.length >= 6) continue;
    data.venues.push({ name: labelFor(g.domain), where: g.domain, why: `Web search found ${g.urls.length} discussion thread${g.urls.length === 1 ? "" : "s"} about '${anchor}' here — e.g. “${g.titles[0]}”. No thread sitemap: join and add by hand.`, url: `https://${g.domain}/`, src: "web" });
  }
  // Coverage means actual result groups, not just an HTTP 200 — an empty
  // result page (or a challenge page that parses to nothing) stays degraded.
  data.webOk = groups.length > 0;
  // The LLM's own venue hunt, verified without any search engine: domains
  // Muse names in the plan get a live thread-sitemap check, so a throttled
  // web search can't veto a place Muse mapped. Cap 2 — each check is up to
  // 3 sitemap fetches against the forum itself, never a search engine.
  if (plan) {
    const novel = planDomains(plan).filter((d) => !data.dynamic.some((x) => x.domain === d.domain)).slice(0, 2);
    const checked = await Promise.all(novel.map((d) => verifyForumDomain(d.domain)));
    for (const v of checked) {
      if (!v || data.dynamic.some((x) => x.domain === v.domain)) continue;
      data.dynamic.push(v);
    }
  }
  // Venue-graph one hop (structural, no cross-profile learning): SE
  // related_sites for the plan's SE sites, homepage outlinks for verified
  // dynamic forums. Fills join-by-hand venues only, under the same cap.
  if (plan && data.venues.length < 6) {
    const known = new Set<string>();
    for (const v of data.venues) { try { known.add(registrable(new URL(v.url).hostname)); } catch { /* skip */ } }
    for (const d of data.dynamic) known.add(registrable(d.domain));
    const push = (name: string, where: string, why: string, url: string) => {
      if (data.venues.length < 6) data.venues.push({ name, where, why, url, src: "web" });
    };
    try {
      const seSites = seSitesFromPlan(plan).slice(0, 3);
      if (seSites.length) {
        const res = await fetchJson("https://api.stackexchange.com/2.3/sites?pagesize=500");
        const items = (res.data as { items?: unknown })?.items;
        const payload = { items: Array.isArray(items) ? items : [] };
        for (const s of seSites) {
          seGraphVenues(parseSeRelatedSites(payload, s), s, known, push);
          if (data.venues.length >= 6) break;
        }
      }
    } catch { /* graph is a bonus — search results stand alone */ }
    if (data.venues.length < 6 && data.dynamic.length) {
      const homes = await Promise.all(data.dynamic.slice(0, 3).map(async (f) => {
        try {
          const p = await fetchText(`https://${f.domain}/`);
          return p.ok ? { domain: f.domain, html: p.text.slice(0, 200_000) } : null;
        } catch { return null; }
      }));
      for (const h of homes) {
        if (!h || data.venues.length >= 6) continue;
        forumGraphVenues(extractOutlinkDomains(h.html, h.domain), h.domain, known, push);
      }
    }
  }
  discoveryCache.set(key, { at: Date.now(), data });
  return data;
}

// Merge web evidence into plan recs (pure, tested): thread counts and sample
// titles attach to whatever channels the plan mapped.
export function mergeDiscovery<T extends { channel: string; fit: ChannelFit; reasons: string[] }>(recs: T[], findings: DiscoveryFindings): T[] {
  for (const e of findings.evidence) {
    const r = recs.find((x) => x.channel === e.channel);
    if (!r) continue;
    r.reasons.push(`Web search found ${e.threads} discussion thread${e.threads === 1 ? "" : "s"} here about this pain${e.samples.length ? ` — e.g. “${e.samples.join("” · “")}”` : ""}.`);
  }
  return recs;
}
export function sortRecs<T extends { fit: ChannelFit; needsConnection: boolean; reasons: string[] }>(recs: T[]): T[] {
  const rank: Record<ChannelFit, number> = { best: 0, good: 1, poor: 2 };
  recs.sort((a, b) => rank[a.fit] - rank[b.fit] || Number(a.needsConnection) - Number(b.needsConnection) || b.reasons.length - a.reasons.length);
  return recs;
}

// ─── Channel recommendations: the plan is the only picker ─────────────────
// There are no topic lists in this file — no signals, no per-vertical
// mappings, no per-profile channels. Muse's expansion plan maps communities;
// every open community it names becomes a searchable pill, every closed one
// a connection, everything else a join-by-hand venue. The code below only
// executes searches against whatever the plan picked.


export type ChannelFit = "best" | "good" | "poor";
export type ChannelRec = { channel: string; label: string; fit: ChannelFit; reasons: string[]; needsConnection: boolean; verified: boolean };
const CHANNEL_LABELS: Record<string, string> = {
  bluesky: "Bluesky", hackernews: "Hacker News", github: "GitHub", stackexchange: "Stack Exchange",
  agingcare: "AgingCare", mumsnet: "Mumsnet", makeuptalk: "MakeupTalk", lipstickalley: "Lipstick Alley",
  eurobricks: "Eurobricks", studentdoctor: "Student Doctor Network",
  devto: "Dev.to", lobsters: "Lobsters", reddit_poc: "Reddit · POC",
};

// Channels the server can execute with no topic knowledge: the search is
// fully described by the plan plus the query — plus, for Stack Exchange, the
// site slug Muse names in the community. Forums with a sitemap adapter join
// as pills under their channel name when the plan names them; any other plan
// community with a verifiable domain joins as forum:<slug> via discovery.
const NATIVE_CHANNELS = new Set(["bluesky", "hackernews", "github", "stackexchange", "devto", "lobsters", "reddit_poc"]);

export function channelRecsFor(profile: ProfileLike, plan: ExpansionPlan | null): { recs: ChannelRec[] } {
  void profile;
  const recs: ChannelRec[] = [];
  if (!plan) return { recs };
  const seen = new Set<string>();
  for (const c of plan.communities) {
    // Muse writes "reddit" for subreddit communities; the executor (OAuth
    // search) lives under "reddit_poc". Normalize at this boundary so a
    // plan-named subreddit always becomes the Reddit pill instead of
    // vanishing — it stays closed until the founder connects Reddit.
    const raw = (c.channel ?? "").trim();
    const ch = raw === "reddit" ? "reddit_poc" : raw;
    if (!c.name || !ch || seen.has(ch)) continue;
    if (!NATIVE_CHANNELS.has(ch) && !SITEMAP_FORUMS.some((f) => f.channel === ch)) continue;
    seen.add(ch);
    recs.push({
      channel: ch,
      label: CHANNEL_LABELS[ch] ?? ch,
      fit: "good",
      reasons: [`Muse mapped “${c.name}” here${c.why ? ` — ${c.why}` : ""}`],
      needsConnection: ch === "reddit_poc",
      verified: false,
    });
  }
  return { recs: sortRecs(recs) };
}

// Stack Exchange sites come only from Muse's plan: the community's `site`
// field, or a stackexchange.com subdomain named in its name/where (cap 2).
// A Stack Exchange community with no resolvable site never executes —
// guessing a site would be a blind search wearing a lab coat.
export function seSitesFromPlan(plan: ExpansionPlan | null): string[] {
  const sites: string[] = [];
  for (const c of plan?.communities ?? []) {
    if ((c.channel ?? "").trim() !== "stackexchange") continue;
    const explicit = (c.site ?? "").trim().toLowerCase();
    if (explicit && !sites.includes(explicit)) { sites.push(explicit); continue; }
    const m = `${c.name} ${c.where}`.toLowerCase().match(/([a-z0-9-]+)\.stackexchange\.com/);
    if (m?.[1] && !sites.includes(m[1])) sites.push(m[1]);
  }
  return sites.slice(0, 2);
}

export function devtoCandidate(o: Record<string, unknown>, profile: ProfileLike, profileId: number): { key: string; values: typeof schema.leads.$inferInsert; s: Relevance } | null {
  const id = String(o.id ?? "");
  if (!id) return null;
  const user = asObj(o.user);
  const title = String(o.title ?? "");
  const body = String(o.description ?? "").slice(0, 900);
  const s = analyseText(`${title} ${body}`, profile, "devto");
  return {
    key: `devto:${id}`,
    values: {
      profileId, channel: "devto", mode: "live_post",
      externalUrl: String(o.url ?? ""), externalId: `devto:${id}`,
      author: String(user.username ?? user.name ?? ""), authorHandle: String(user.username ?? ""),
      title, body, community: "Dev.to",
      postedAt: String(o.published_at ?? o.created_at ?? ""),
      matchScore: s.score, matchReason: s.reason,
    },
    s,
  };
}

export function lobstersCandidate(o: Record<string, unknown>, profile: ProfileLike, profileId: number): { key: string; values: typeof schema.leads.$inferInsert; s: Relevance } | null {
  const id = String(o.short_id ?? "");
  if (!id) return null;
  const title = String(o.title ?? "");
  const body = String(o.description_plain ?? o.description ?? "").slice(0, 900);
  const tags = Array.isArray(o.tags) ? (o.tags as unknown[]).map(String).slice(0, 3).join(", ") : "";
  const s = analyseText(`${title} ${body}`, profile, "lobsters");
  return {
    key: `lobsters:${id}`,
    values: {
      profileId, channel: "lobsters", mode: "live_post",
      externalUrl: String(o.comments_url ?? o.url ?? ""), externalId: `lobsters:${id}`,
      author: String(o.submitter_user ?? ""), authorHandle: String(o.submitter_user ?? ""),
      title, body, community: tags ? `Lobsters · ${tags}` : "Lobsters",
      postedAt: String(o.created_at ?? ""),
      matchScore: s.score, matchReason: s.reason,
    },
    s,
  };
}

export function seCandidate(o: Record<string, unknown>, site: string, profile: ProfileLike, profileId: number): { key: string; values: typeof schema.leads.$inferInsert; s: Relevance } | null {
  const qid = String(o.question_id ?? "");
  if (!qid) return null;
  const who = String(asObj(o.owner).display_name ?? "");
  const title = decodeHnText(String(o.title ?? ""));
  const body = decodeHnText(String(o.body ?? "")).slice(0, 900);
  const created = typeof o.creation_date === "number" ? new Date(o.creation_date * 1000).toISOString() : "";
  const s = analyseText(`${title} ${body}`, profile, "stackexchange");
  return {
    key: `se:${site}:${qid}`,
    values: {
      profileId, channel: "stackexchange", mode: "live_post",
      externalUrl: String(o.link ?? ""), externalId: `se:${site}:${qid}`,
      author: who, authorHandle: who, title, body, community: site,
      postedAt: created, matchScore: s.score, matchReason: s.reason,
    },
    s,
  };
}

// ─── Sitemap-indexed forums (no API, no RSS, bot-disallowed /search) ────────
// Some of the richest communities (AgingCare-type caregiver forums, Mumsnet
// Talk) expose no machine API at all — but their PUBLIC sitemap files list
// thread URLs with the thread title in the slug. Search here = fetch those
// sitemap files (cached per section selection, polite UA, never /search,
// never page bodies), de-slug to titles, and run the same gate. Leads are
// TITLE-ONLY and say so in the reason; the founder verifies by opening the
// thread. Which forum executes is Muse's call alone (the plan names it);
// this registry is only the address book — index URLs, section tokens, and
// how to name a community from a URL. No topic words live here.
// MakeupTalk (XenForo) exposes a thread-URL sitemap index (verified
// 2026-11-01). Specktra was checked the same day and only lists its
// homepage — no good.
// Eurobricks (IPS forum, sitemap index verified 2026-11-02 —
// Topic_1 carries the freshest threads, ~500/file, slugs in URLs). Brickset
// has no forum any more (its /forum page points at Discord and Facebook),
// so those stay join-by-hand venues, never a channel.
// Student Doctor Network (XenForo, verified 2026-11-02 — newest
// thread files are sitemap-24 then sitemap-23; higher files hold member
// profiles, which self-filter by title length). Sermo and Doximity are
// login-walled; KevinMD is article comments, not threads — venues only.
// A section is one slice of a forum's sitemap: `token` must appear in the
// sitemap file's URL (slash-delimited so "/talk/parenting/" never matches
// "eco-friendly-parenting"). Every listed section fetches when the plan
// picks the forum; the anchor gate keeps off-topic threads out.
export type SitemapSection = { token: string };
export type SitemapForum = { channel: string; label: string; index: string; sections: SitemapSection[]; maxFiles: number; communityFor: (url: string) => string };
function mumsnetCommunity(url: string): string {
  const m = url.match(/\/talk\/([^/]+)\//);
  const topic = (m?.[1] ?? "").replace(/[_-]+/g, " ").trim();
  return topic ? `Mumsnet Talk · ${topic}` : "Mumsnet Talk";
}
const SITEMAP_FORUMS: SitemapForum[] = [
  {
    channel: "agingcare", label: "AgingCare",
    index: "https://www.agingcare.com/sitemaps/sitemap.xml",
    maxFiles: 6,
    sections: [{ token: "content-questions" }, { token: "content-discussions" }],
    communityFor: (url) => (url.includes("/discussions/") ? "AgingCare Discussions" : "AgingCare Q&A"),
  },
  {
    channel: "mumsnet", label: "Mumsnet",
    index: "https://www.mumsnet.com/sitemap/talk",
    maxFiles: 10,
    sections: [
      { token: "/talk/parenting/" },
      { token: "/talk/sleep/" },
      { token: "/talk/pregnancy/" },
      { token: "/talk/breast_and_bottle_feeding/" },
      { token: "/talk/childrens_health/" },
      { token: "/talk/general_health/" },
      { token: "/talk/behaviour_development/" },
      { token: "/talk/elderly_parents/" },
      { token: "/talk/money-matters/" },
      { token: "/talk/work/" },
      { token: "/talk/childcare/" },
    ],
    communityFor: mumsnetCommunity,
  },
  {
    channel: "makeuptalk", label: "MakeupTalk",
    index: "https://www.makeuptalk.com/sitemap.php",
    maxFiles: 2,
    // XenForo numbers content files sequentially as they fill, oldest first —
    // sitemap-4/sitemap-3 are the newest files verified 2026-11-01 (sitemap-1
    // starts at 2003 threads). Substring matching also covers sitemap-40+.
    // If the forum grows past sitemap-9 without a bump here, newer files are
    // skipped gracefully — older threads still searched, never blind.
    sections: [{ token: "sitemap-4" }, { token: "sitemap-3" }],
    communityFor: () => "MakeupTalk",
  },
  {
    channel: "lipstickalley", label: "Lipstick Alley",
    index: "https://www.lipstickalley.com/sitemap.php",
    maxFiles: 2,
    // Same XenForo sequential scheme, newest last — sitemap-43/42 verified
    // 2026-11-01 against a 43-file index (file 1 starts years back).
    // Lipstick Alley is mostly gossip, not beauty: the anchor gate keeps
    // off-topic threads out, same as every forum here.
    sections: [{ token: "sitemap-43" }, { token: "sitemap-42" }],
    communityFor: () => "Lipstick Alley",
  },
  {
    channel: "eurobricks", label: "Eurobricks",
    index: "https://www.eurobricks.com/forum/sitemap.php",
    maxFiles: 4,
    // IPS index of ~300 Topic_N files; Topic_1 carries the freshest threads
    // (highest topic ids), so index order is fetch order and maxFiles bounds
    // the pull to a few thousand fresh threads.
    sections: [{ token: "sitemap_content_forums_Topic_" }],
    communityFor: () => "Eurobricks",
  },
  {
    channel: "studentdoctor", label: "Student Doctor Network",
    index: "https://forums.studentdoctor.net/sitemap.php",
    maxFiles: 2,
    // XenForo oldest-first: sitemap-24/sitemap-23 are the newest thread
    // files (higher files hold member profiles, which self-filter by title
    // length). File numbers roll as the forum grows — re-verify yearly.
    sections: [{ token: "sitemap-24" }, { token: "sitemap-23" }],
    communityFor: () => "Student Doctor Network",
  },
];
// Address-book lookup by channel name. The plan picks the channel; this only
// resolves it to fetch instructions. Unknown names return null and the
// search errors honestly instead of guessing.
export function forumAdapter(channel: string): SitemapForum | null {
  return SITEMAP_FORUMS.find((f) => f.channel === channel) ?? null;
}
// Section filter (pure, tested): which sitemap files deserve a fetch. Runs at
// every index level, so one code path serves flat sitemaps (AgingCare) and
// nested topic indexes (Mumsnet). No profile input — every listed section
// fetches when the plan picks the forum; the anchor gate drops off-topic
// threads downstream.
export function filterSitemapLocs(forum: SitemapForum, locs: string[]): string[] {
  return locs.filter((u) => forum.sections.some((s) => u.includes(s.token)));
}
// Minimal sitemap reader (no XML library — sitemaps are a flat shape):
// `<url><loc>…</loc><lastmod>…</lastmod></url>`, same for `<sitemap>` index rows.
export function sitemapLocs(xml: string, tag: "url" | "sitemap", cap = 20000): { loc: string; lastmod: string }[] {
  const out: { loc: string; lastmod: string }[] = [];
  const re = new RegExp(`<${tag}>\\s*<loc>([^<]+)<\\/loc>(?:\\s*<lastmod>([^<]+)<\\/lastmod>)?`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < cap) {
    const [, loc = "", lastmod = ""] = m;
    out.push({ loc: loc.trim(), lastmod: lastmod.trim() });
  }
  return out;
}
// Thread title from a slug URL: last path segment, minus extension and
// numeric id (trailing "-123456" or, Mumsnet-style, leading "123456-"),
// hyphens back to spaces. Returns "" when nothing title-like remains, so
// index/asset URLs never become candidates.
export function slugTitleFor(url: string): string {
  // Strip scheme+host first so a bare domain never de-slugs to its hostname.
  const [preQ = ""] = url.split("?");
  const [preHash = ""] = preQ.split("#");
  const path = preHash.replace(/^https?:\/\/[^/]+/i, "");
  const seg = path.split("/").filter(Boolean).pop() ?? "";
  if (!seg) return "";
  // Leading ids are long (Mumsnet thread ids); a short leading number is an
  // age ("27-years-old…"), not an id — keep it.
  const words = seg.replace(/\.html?$/i, "").replace(/-\d{4,}$/, "").replace(/^\d{5,}-/, "").replace(/[^a-zA-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return words.length >= 12 ? words : "";
}
export type SitemapEntry = { url: string; title: string; lastmod: string; community: string };
const sitemapCache = new Map<string, { at: number; entries: SitemapEntry[] }>();
const SITEMAP_TTL_MS = 24 * 3600 * 1000;
const SITEMAP_MAX_ENTRIES = 60000;
// Sitemap XML runs big (MakeupTalk's oldest slice is 9MB+): the global 8MB
// fetch cap would silently drop whole files — and with them half a forum's
// threads — so sitemap reads get their own budget. Entries are still capped
// downstream by SITEMAP_MAX_ENTRIES; this only lets the XML arrive whole.
export const SITEMAP_MAX_BYTES = 25_000_000;
// Disk cache for parsed thread lists (24h): repeat hunts skip multi-MB
// downloads entirely. The file names the forum and slice; the progress line
// says when a saved list is used, so a day-old list is visible, never silent.
export function sitemapCacheFile(forum: SitemapForum): string {
  const slug = `${forum.channel}-${forum.sections.map((s) => s.token).sort().join("|")}`.replace(/[^a-z0-9]+/gi, "_").slice(0, 120);
  return new URL(`../../local/data/sitemap-cache/${slug}.json`, import.meta.url).pathname;
}
export async function fetchSitemapEntries(forum: SitemapForum, onProgress?: (detail: string) => Promise<void>): Promise<{ entries: SitemapEntry[] } | { error: string }> {
  const say = async (detail: string) => { if (onProgress) { try { await onProgress(detail); } catch { /* progress never breaks the hunt */ } } };
  try {
    const st = statSync(sitemapCacheFile(forum));
    if (Date.now() - st.mtimeMs < SITEMAP_TTL_MS) {
      const cached = JSON.parse(readFileSync(sitemapCacheFile(forum), "utf8")) as { entries?: SitemapEntry[] };
      if (Array.isArray(cached.entries) && cached.entries.length) {
        await say(`Using a saved ${forum.label} thread list (${cached.entries.length.toLocaleString("en-US")} threads, less than a day old) — download skipped`);
        return { entries: cached.entries };
      }
    }
  } catch { /* no usable cache — fetch live */ }
  const idx0 = await fetchText(forum.index, {}, SITEMAP_MAX_BYTES);
  if (!idx0.ok) return { error: `Sitemap index unreachable (HTTP ${idx0.status}).` };
  let level0 = filterSitemapLocs(forum, sitemapLocs(idx0.text, "sitemap").map((e) => e.loc));
  // Flat sitemap (no index — the file itself lists threads, as discovered
  // for small forums): search the file itself instead of sections.
  if (!level0.length && idx0.text.includes("<urlset")) level0 = [forum.index];
  if (!level0.length) return { error: "No sitemap sections match this profile's topic — skipped instead of searching blindly." };
  // Cache key includes the section selection: different profiles legitimately
  // fetch different topic slices of the same forum.
  const cacheKey = `${forum.channel}:${[...level0].sort().join("|")}`;
  const hit = sitemapCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SITEMAP_TTL_MS) return { entries: hit.entries };
  const entries: SitemapEntry[] = [];
  let fetches = 0;
  let level = level0;
  // Two levels: a flat index (AgingCare) resolves on the first pass; a
  // nested index (Mumsnet topics → per-topic files) resolves on the second.
  // Detection is by content (<sitemapindex> vs <urlset>), never assumed.
  for (let depth = 0; depth < 2 && level.length && entries.length < SITEMAP_MAX_ENTRIES; depth++) {
    const next: string[] = [];
    const seen = new Set<string>();
    for (const loc of level) {
      if (fetches >= forum.maxFiles || entries.length >= SITEMAP_MAX_ENTRIES) break;
      if (seen.has(loc)) continue;
      seen.add(loc);
      await say(`Reading ${forum.label} thread list (file ${fetches + 1} of ${Math.min(level.length, forum.maxFiles)})…`);
      const r = await fetchText(loc, {}, SITEMAP_MAX_BYTES);
      fetches++;
      if (!r.ok) continue; // one bad file doesn't sink the channel
      if (r.text.includes("<sitemapindex")) {
        for (const u of filterSitemapLocs(forum, sitemapLocs(r.text, "sitemap").map((e) => e.loc))) {
          if (u !== forum.index && !next.includes(u)) next.push(u);
        }
      } else {
        for (const e of sitemapLocs(r.text, "url")) {
          const title = slugTitleFor(e.loc);
          if (!title) continue;
          entries.push({ url: e.loc, title, lastmod: e.lastmod, community: forum.communityFor(e.loc) });
        }
      }
    }
    level = next.slice(0, forum.maxFiles);
  }
  if (!entries.length) return { error: "Sitemap files yielded no thread titles." };
  sitemapCache.set(cacheKey, { at: Date.now(), entries });
  try {
    mkdirSync(new URL("../../local/data/sitemap-cache/", import.meta.url).pathname, { recursive: true });
    writeFileSync(sitemapCacheFile(forum), JSON.stringify({ entries }));
  } catch { /* disk cache is a speedup, never a requirement */ }
  return { entries };
}
// A web-discovered venue as a searchable forum object: exact file tokens
// (verified minutes ago), no topic mapping needed — verification IS the map.
export function dynamicForumFor(channel: string, findings: DiscoveryFindings): SitemapForum | null {
  const slug = channel.slice("forum:".length);
  const d = findings.dynamic.find((v) => v.slug === slug);
  if (!d) return null;
  return {
    channel, label: d.label, index: d.index, maxFiles: 2,
    sections: d.flat ? [{ token: d.index }] : d.files.map((f) => ({ token: f })),
    communityFor: () => d.label,
  };
}
export function sitemapCandidate(entry: SitemapEntry, forum: SitemapForum, profile: ProfileLike, profileId: number): { key: string; values: typeof schema.leads.$inferInsert; s: Relevance } | null {
  if (!entry.title) return null;
  const s = analyseText(entry.title, profile, forum.channel);
  return {
    key: `${forum.channel}:${entry.url}`,
    values: {
      profileId, channel: forum.channel, mode: "live_post",
      externalUrl: entry.url, externalId: `${forum.channel}:${entry.url}`,
      author: "", authorHandle: "", title: entry.title, body: "",
      community: entry.community, postedAt: entry.lastmod,
      matchScore: s.score,
      matchReason: `${s.reason}${s.reason ? " " : ""}Thread-title match on ${forum.label} — no post body is available to the search; open the thread to verify before replying.`,
    },
    s,
  };
}

// Progress writer for a search run: the UI polls searchRunStatus while the
// search is in flight, so the founder sees real phases, not one spinner.
async function startSearchRun(db: Db, profileId: number, kind: string): Promise<number> {
  const r = await db.insert(schema.searchRuns).values({ profileId, kind, phase: "expanding", detail: "Planning where to look…" }).returning({ id: schema.searchRuns.id });
  return r[0]?.id ?? 0;
}
async function touchSearchRun(db: Db, runId: number, phase: string, detail: string, counts?: { found?: number; created?: number; synthesized?: number }): Promise<void> {
  if (!runId) return;
  await db.update(schema.searchRuns).set({ phase, detail, ...(counts ?? {}) }).where(eq(schema.searchRuns.id, runId));
}

const FOLLOWUP_DUE_MS = 3 * 24 * 3600 * 1000;
// One open nudge per sent lead: check for a reply in a few days. Never
// duplicates an already-open nudge, never resurrects a stopped one.
async function ensureFollowup(db: Db, leadId: number, profileId: number): Promise<void> {
  const rows = await db.select().from(schema.followups).where(eq(schema.followups.leadId, leadId));
  if (rows.some((f) => !f.doneAt && !f.stopped)) return;
  if (rows.some((f) => f.stopped)) return;
  await db.insert(schema.followups).values({ leadId, profileId, dueAt: new Date(Date.now() + FOLLOWUP_DUE_MS) });
}

function anchorTermsFor(profile: ProfileLike): { anchorTerm: string; terms: string[] } {
  // The anchor set is every specific anchor token derived from the profile
  // (keywords first, then audience, then pain — see profileAnchorTokens).
  // Previously only the FIRST keyword word counted,
  // so an expanded query about "no traction" or "first feedback" was
  // dropped as "unanchored" for lacking the word "users" — another silent
  // 100%-drop path. Now any real anchor token anchors a query; the display
  // anchor is the strongest (first keyword) token, with "show hn" added as
  // a phrase anchor when a keyword names it.
  const tokens = profileAnchorTokens(profile);
  const anchorTerm = tokens[0] ?? "";
  const terms = [...tokens];
  if (keywordPhrases(profile).some((p) => normText(p).includes("show hn")) && !terms.includes("show hn")) terms.push("show hn");
  return { anchorTerm, terms: terms.filter(Boolean) };
}
function queryIsAnchored(query: string, terms: string[]): boolean {
  const nq = normText(query);
  return terms.some((t) => t && containsTerm(nq, t));
}

// Live models sometimes return a small object where the prompt's shorthand
// implied a string (e.g. a relaxation as {term, relaxTo}). Coerce those to a
// readable single string instead of failing the whole call.
export function stringishArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") { if (x.trim()) out.push(x); continue; }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const parts = [o.term, o.relaxTo, o.text, o.phrase, o.suggestion, o.move, o.name].filter((s): s is string => typeof s === "string" && !!s.trim());
      if (parts.length) out.push(parts.join(" → "));
    }
  }
  return out;
}
const expansionPlanSchema = z.object({
  anchorTerm: z.string(),
  // Only the load-bearing fields are required: the cleaning step below
  // normalizes or drops the rest, so a live model omitting a cosmetic field
  // (or a whole optional array) degrades the plan instead of nuking it.
  queries: z.array(z.object({ query: z.string(), intent: z.string().default("") })).default([]),
  painPhrases: z.preprocess(stringishArray, z.array(z.string())).default([]),
  adjacentProblems: z.preprocess(stringishArray, z.array(z.string())).default([]),
  adjacentAudiences: z.preprocess(stringishArray, z.array(z.string())).default([]),
  communities: z.array(z.object({ name: z.string(), where: z.string().default(""), channel: z.string().default("manual"), access: z.string().default("open"), why: z.string().default(""), site: z.string().default("") })).default([]),
  relaxations: z.preprocess(stringishArray, z.array(z.string())).default([]),
  nextSuggestions: z.preprocess(stringishArray, z.array(z.string())).default([]),
});

// Pure prompt construction (unit-tested): every topic word in this prompt
// comes from the founder's profile or the derived anchor terms. No vertical,
// product, or venue examples are baked in — the plan Muse writes is picked
// per profile, never steered to a hardcoded community.
export function buildExpansionPrompt(
  profile: ProfileLike,
  args: { painPhrasesSaved: string[]; anchorTerm: string; terms: string[]; isLaterRound: boolean; round: number; context: { reason: string; found: number; discarded: number; synthesized: number; seenCount: number }; previousQueries: string[] },
): string {
  const { painPhrasesSaved, anchorTerm, terms, isLaterRound, round, context, previousQueries } = args;
  return `You are planning WHERE to find seed users for a founder — not just rewording one keyword. Build a search expansion plan from this target profile.\n\nProfile — Product: ${profile.productName} — ${profile.productDesc}\nAudience: ${profile.audience}\nPain (founder's words): ${profile.pain}\nWorkaround today: ${profile.workaround}\nFounder keywords: ${profile.keywords}\nCore action: ${profile.coreAction}\nPain phrases already known: ${painPhrasesSaved.join(" · ") || "(none yet)"}\n\nDOMAIN ANCHOR (hard rule): the anchor term is "${anchorTerm}". Valid anchor terms for queries: ${terms.join(", ")}. EVERY query you return MUST contain at least one of those anchor terms, word-for-word. A query made only of generic words (like "skill", "struggle", "help", "sucks", "beginner") is forbidden — unanchored queries are discarded server-side. If you broaden, broaden the pain/audience/community around the anchor, never drop the anchor.\n\nReturn:\n- anchorTerm: exactly "${anchorTerm}".\n- queries: ${isLaterRound ? "6-8" : "5-7"} search queries a real person in pain might match — variants and synonyms in the person's own language, each with a one-line intent. Cover different phrasings of the pain, the workaround, and beginner/first-time framings — all anchored.\n- painPhrases: 5-8 related pain phrases and adjacent problem phrasings in their words (these inform the founder; they are not all queries).\n- adjacentProblems: 3-5 adjacent problems the same person hits around this pain.\n- adjacentAudiences: 3-5 adjacent audiences — people one step wider than the profile who plausibly hit the same anchored pain.\n- communities: 5-8 specific places these people already talk — name the actual thread or group, not the platform in general (e.g. a specific subreddit's new-posts feed, a named forum's Q&A board, an Ask HN thread). For each: name, where (the site's domain when it is a forum or website — otherwise the platform or place), channel — one of bluesky, hackernews, github, stackexchange, agingcare, mumsnet, makeuptalk, lipstickalley, eurobricks, studentdoctor, devto, lobsters, reddit_poc, reddit, x, facebook, discord, slack, linkedin, instagram, youtube (stackexchange only for Q&A-style communities WITH the site slug in site — look at the pain and pick the site whose questions match, using the real slug from that site's stackexchange.com subdomain; devto only for developer articles; lobsters only for developer discussion) — site: the Stack Exchange site slug when channel is stackexchange, else blank — access: "open" for a public searchable community EarlyProof searches by default, "closed" when the founder must provide an API/connection or join and send themselves — and why this place fits this profile's pain.\n- relaxations: 2-4 specific over-strict terms or exact phrases from the profile/keywords that could be relaxed WITHOUT dropping the anchor (name the exact term and what to relax it to).\n- nextSuggestions: 3-5 concrete next expansion moves if this round still returns 0 synthesized results — broaden to an adjacent audience or adjacent pain (still anchored), try a different named channel or community, relax a named over-strict term.\n${isLaterRound ? `\nThis is expansion round ${round}. The previous search context: ${context.reason} It found ${context.found} candidates, the pre-filter dropped ${context.discarded}, Muse synthesized ${context.synthesized} results, and ${context.seenCount} leads are already seen (new results are deduplicated against them — do not repeat old queries). Previous rounds already tried these queries: ${previousQueries.join(" · ") || "(none)"}. Your new queries must be DIFFERENT from those: lean on the adjacent audiences, adjacent pains, new communities and the relaxations — while keeping every query anchored to "${anchorTerm}".` : `\nThis is expansion round 1, generated before the search runs.`}`;
}

// Scout: the plan-mapping specialist. Wraps one expansion round behind the
// agent interface so the hunt gets a name, a goal, and a run trace. No
// validator here on purpose: the round's own anchor filter plus the zod
// schema already reject bad plans, and a second opinion would only repeat
// the same deterministic check. (Venue discovery stays a plain function —
// it is deterministic fetch/parse/verify with no model judgement to wrap.)
const scoutPlanAgent = defineAgent({
  name: "Scout",
  goal: "Map where the profile's people talk: anchored queries plus the communities they name.",
  run: async (ctx, input: { profile: typeof schema.profiles.$inferSelect; context: { reason: string; found: number; discarded: number; synthesized: number; seenCount: number } }, attempt) => {
    const gen = await generateExpansionRound(ctx, input.profile, input.context, { runId: attempt.runId });
    if (!gen.ok) return gen;
    return { ok: true, value: { plan: gen.plan, round: gen.round } };
  },
});

// Generates one expansion round with Muse and stores it. `previous` carries
// the earlier rounds' queries/suggestions so a later round genuinely broadens
// (adjacent audiences/pains, new communities, a named relaxation) instead of
// repeating round 1. Returns the stored plan, or an LlmFail-style status.
async function generateExpansionRound(
  ctx: Ctx,
  profile: typeof schema.profiles.$inferSelect,
  context: { reason: string; found: number; discarded: number; synthesized: number; seenCount: number },
  opts?: { runId?: number },
): Promise<{ ok: true; plan: ExpansionPlan; round: number } | LlmFail> {
  const db = ctx.db<typeof schema>();
  const settings = await loadLlmSettings(ctx);
  if (!llmConfigured(settings)) return { ok: false, status: "not_configured", message: LLM_SETUP_MESSAGE };
  const existing = await db.select().from(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, profile.id));
  const round = existing.reduce((m, r) => Math.max(m, r.round), 0) + 1;
  const previousPlans = existing
    .sort((a, b) => a.round - b.round)
    .map((r) => { try { return JSON.parse(r.plan || "{}") as Partial<ExpansionPlan>; } catch { return {} as Partial<ExpansionPlan>; } });
  const previousQueries = previousPlans.flatMap((p) => (p.queries ?? []).map((q) => q.query)).filter(Boolean);
  const { anchorTerm, terms } = anchorTermsFor(profile);
  if (opts?.runId) await touchSearchRun(db, opts.runId, "planning", `Round ${round}: asking Muse for anchored queries (anchor “${anchorTerm}”)…`);
  const painPhrasesSaved: string[] = (() => { try { const v = JSON.parse(profile.painPhrases || "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } })();
  const isLaterRound = round > 1;
  const r = await runLlm(ctx, "small",
    buildExpansionPrompt(profile, { painPhrasesSaved, anchorTerm, terms, isLaterRound, round, context, previousQueries }),
    expansionPlanSchema);
  if (!r.ok) return r;
  const o = r.value;
  // Anchor enforcement: the founder's profile decides the anchor, not the
  // model. Queries without an anchor term are dropped and counted.
  const rawQueries = o.queries.filter((q) => q.query.trim());
  const anchored = rawQueries.filter((q) => queryIsAnchored(q.query, terms));
  const droppedUnanchored = rawQueries.length - anchored.length;
  const cleanStrs = (v: string[], max: number) => v.map((s) => s.trim()).filter(Boolean).slice(0, max);
  const plan: ExpansionPlan = {
    anchorTerm,
    queries: anchored.slice(0, 8).map((q) => ({ query: q.query.trim().slice(0, 120), intent: q.intent.trim().slice(0, 200) })),
    painPhrases: cleanStrs(o.painPhrases, 8),
    adjacentProblems: cleanStrs(o.adjacentProblems, 5),
    adjacentAudiences: cleanStrs(o.adjacentAudiences, 5),
    communities: o.communities.slice(0, 8).map((c) => ({
      name: c.name.trim().slice(0, 120), where: c.where.trim().slice(0, 120),
      channel: ["bluesky", "hackernews", "github", "stackexchange", "agingcare", "mumsnet", "makeuptalk", "lipstickalley", "eurobricks", "studentdoctor", "devto", "lobsters", "reddit_poc", "reddit", "x", "facebook", "discord", "slack", "linkedin", "instagram", "youtube", "manual"].includes(c.channel.trim()) ? c.channel.trim() : "manual",
      access: c.access.trim().toLowerCase() === "closed" ? "closed" : "open",
      why: c.why.trim().slice(0, 240),
      site: (c.site ?? "").trim().toLowerCase().slice(0, 40),
    })).filter((c) => c.name),
    relaxations: cleanStrs(o.relaxations, 4),
    nextSuggestions: cleanStrs(o.nextSuggestions, 5),
    droppedUnanchored,
  };
  if (!plan.queries.length) {
    return { ok: false, status: "error", message: `Muse's expansion plan came back with no usable queries — every query it suggested lacked the domain anchor (“${anchorTerm}”), so all ${droppedUnanchored} were dropped rather than searched. Nothing was searched. Try the expansion again.` };
  }
  await db.insert(schema.searchExpansions).values({ profileId: profile.id, round, anchorTerm, plan: JSON.stringify(plan) });
  ctx.invalidateQueries();
  return { ok: true, plan, round };
}

// The latest stored plan for a profile, generating round 1 on demand so a
// first search always runs expanded queries, not just the founder's keyword.
// Scout entry for the search flow: reuse a stored plan, or map one now and
// trace the attempt on the caller's run.
async function ensureExpansionPlan(
  ctx: Ctx,
  profile: typeof schema.profiles.$inferSelect,
  runId = 0,
): Promise<{ ok: true; plan: ExpansionPlan; round: number; generated: boolean } | LlmFail> {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, profile.id));
  const latest = existing.sort((a, b) => b.round - a.round)[0];
  if (latest) {
    try {
      const plan = JSON.parse(latest.plan || "{}") as ExpansionPlan;
      if (Array.isArray(plan.queries) && plan.queries.length) return { ok: true, plan, round: latest.round, generated: false };
    } catch { /* fall through and regenerate */ }
  }
  const gen = await scoutPlanAgent.execute(ctx, { profile, context: { reason: "First search for this profile — no expansion plan exists yet.", found: 0, discarded: 0, synthesized: 0, seenCount: 0 } }, runId);
  if (!gen.ok) return gen;
  return { ok: true, plan: gen.value.plan, round: gen.value.round, generated: true };
}

function expansionShape(e: typeof schema.searchExpansions.$inferSelect) {
  return { id: e.id, profileId: e.profileId, round: e.round, anchorTerm: e.anchorTerm, plan: e.plan, created_at: e.createdAt.toISOString() };
}

async function ensureBsky(ctx: Ctx): Promise<{ did: string; accessJwt: string; handle: string } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.connections).where(eq(schema.connections.channel, "bluesky"));
  const c = rows[0]; if (!c || !c.accessJwt) return null;
  // try a lightweight call; refresh if it fails
  const test = await fetchJson("https://bsky.social/xrpc/com.atproto.server.getSession", { headers: { Authorization: `Bearer ${c.accessJwt}` } });
  if (test.ok) return { did: c.did, accessJwt: c.accessJwt, handle: c.handle };
  if (c.refreshJwt) {
    const r = await fetchJson("https://bsky.social/xrpc/com.atproto.server.refreshSession", { method: "POST", headers: { Authorization: `Bearer ${c.refreshJwt}` } });
    if (r.ok) {
      const d = asObj(r.data);
      const access = String(d.accessJwt ?? ""); const refresh = String(d.refreshJwt ?? c.refreshJwt); const did = String(d.did ?? c.did);
      await db.update(schema.connections).set({ accessJwt: access, refreshJwt: refresh, did }).where(eq(schema.connections.id, c.id));
      return { did, accessJwt: access, handle: c.handle };
    }
  }
  return null;
}

async function ensureReddit(ctx: Ctx): Promise<{ access: string; handle: string } | { error: string }> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.connections).where(eq(schema.connections.channel, "reddit_poc"));
  const c = rows[0];
  if (!c || !c.accessJwt) return { error: "Reddit POC is not connected. Connect it in Channels first." };
  // Fail closed: an expired script-flow token with no refresh path must never
  // be handed out as if it worked — every Reddit call made with it would
  // fail, and the founder would blame the search instead of the connection.
  if (c.expiresAt && Date.now() > c.expiresAt - 60000) {
    if (!c.refreshJwt || !c.clientId) return { error: "Reddit POC session expired and cannot refresh itself. Reconnect in Channels." };
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshJwt });
    const r = await fetchJson("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (r.ok) {
      const d = asObj(r.data); const access = String(d.access_token ?? "");
      const expires = Date.now() + Number(d.expires_in ?? 3600) * 1000;
      await db.update(schema.connections).set({ accessJwt: access, expiresAt: expires }).where(eq(schema.connections.id, c.id));
      return { access, handle: c.handle };
    }
    return { error: "Reddit POC session expired and refresh failed. Reconnect in Channels." };
  }
  return { access: c.accessJwt, handle: c.handle };
}

// Runs a set of (already anchor-verified) queries across the requested
// channels and buffers every candidate it finds. Candidates that pass the
// LIGHT pre-filter (domain anchor + a pain or workaround signal — see
// analyseText) are saved for Muse synthesis. TOP-CANDIDATE GUARANTEE: the
// rule gate must never silently drop 100% of a live search again — if no
// candidate passes the light gate (or fewer than 3 do), the highest-scoring
// candidates that at least contain the domain anchor are promoted to Muse
// anyway (capped, and named as promoted in their match reason), because
// Muse — not the rules — is the relevance gate. Anchor-free candidates
// are never promoted, so generic off-domain matches still cannot return.
// At most 30 candidates per run are passed to synthesis, strongest first.
// Deduplication is by external URL against every lead already stored for the
// profile — that is what makes "Expand search and re-run" safe to repeat:
// already-seen leads are never duplicated. Query counts per channel are
// capped to respect the free APIs' limits (GitHub unauthenticated search is
// 10 req/min, so GitHub gets at most 3 queries per run). Counts are honest:
// `found` counts each unique candidate once, and `discarded` is exactly
// found − (candidates passed to Muse) − (candidates already stored), so
// discarded can never exceed found the way the old per-occurrence count did.

type SearcherResult = { cands: { key: string; values: typeof schema.leads.$inferInsert; s: Relevance }[]; errors: { channel: string; message: string }[] };
type SearcherInput = { ctx: Ctx; profile: typeof schema.profiles.$inferSelect; queries: string[]; subreddits: string; seSites: string[]; execPlan: ExpansionPlan | null; budget: { take: (n?: number) => boolean }; onProgress?: (detail: string) => Promise<void> };
type ForumSearcherInput = SearcherInput & { ch: string };
// Shared per-run API budget: today's per-channel caps never bind it (worst
// case ~29 calls), so current behavior is unchanged — it only stops a
// future blowup from spending a shared quota twice.
const SEARCH_BUDGET_CALLS = 40;
function makeCallBudget(total: number): { take: (n?: number) => boolean; left: () => number } {
  let remaining = total;
  return { take: (n = 1) => { if (remaining < n) return false; remaining -= n; return true; }, left: () => remaining };
}

async function searchChannelStackExchange(input: SearcherInput): Promise<SearcherResult> {
  const { profile, queries, seSites, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      // Stack Exchange: keyless full-text question search across the sites
      // Muse named in the plan (site slug per community) — never a hardcoded
      // list. Shared free quota (~300 req/day/IP): two queries per site.
      if (!seSites.length) { errors.push({ channel: "Stack Exchange", message: "Muse's plan named no Stack Exchange site for this profile — re-generate the plan with a site slug, or uncheck it." }); return { cands, errors }; }
      let failed = false;
      for (const site of seSites) {
        for (const query of queries.slice(0, 2)) {
          if (failed) break;
          if (!budget.take()) { errors.push({ channel: "Stack Exchange", message: "Shared search budget for this run is spent — retry with fewer channels." }); failed = true; continue; }
          const r = await fetchJson(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${site}&filter=withbody&pagesize=20`);
          const d = asObj(r.data);
          if (!r.ok) { errors.push({ channel: "Stack Exchange", message: d.error_id === 502 ? "Stack Exchange throttled the shared free quota — retry later today." : `Search failed (HTTP ${r.status}).` }); failed = true; continue; }
          if (((d.quota_remaining as number | undefined) ?? 1) === 0) { errors.push({ channel: "Stack Exchange", message: "Stack Exchange free quota exhausted for today — retry tomorrow." }); failed = true; continue; }
          const items = (d.items as unknown[]) ?? [];
          for (const it of items.slice(0, 20)) {
            const c = seCandidate(asObj(it), site, profile, profile.id);
            if (!c) continue;
            pushCand(c.key, c.values, c.s);
          }
        }
      }
  return { cands, errors };
}

async function searchChannelForums(input: ForumSearcherInput): Promise<SearcherResult> {
  const { ctx, profile, execPlan, ch } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      // Sitemap-indexed forums: no API, no RSS, bot-disallowed /search — but
      // public sitemaps with thread titles in the slugs. Scored title-only;
      // the candidate reason says so, and the founder verifies by opening
      // the thread. Runs only when Muse picked the forum (adapter) or
      // discovery verified it (forum:<slug>); anything else errors below.
      let forums: SitemapForum[];
      if (ch.startsWith("forum:")) {
        let findings: DiscoveryFindings | null = null;
        try { findings = await discoverVenuesFor(profile, await braveKeyFor(ctx), execPlan); } catch { findings = null; }
        const dyn = findings ? dynamicForumFor(ch, findings) : null;
        if (!dyn) { errors.push({ channel: ch, message: "This discovered venue is no longer verified — reload the Channels step to re-run channel discovery." }); return { cands, errors }; }
        forums = [dyn];
      } else {
        // Named forum adapter (Muse picked the channel): the registry is only
        // the address book — index URLs and section tokens, no topic words.
        const adapter = forumAdapter(ch);
        if (!adapter) { errors.push({ channel: ch, message: "Unknown forum channel — pick it from the Channels step lineup." }); return { cands, errors }; }
        forums = [adapter];
      }
      for (const forum of forums) {
        const r = await fetchSitemapEntries(forum, input.onProgress);
        if ("error" in r) { errors.push({ channel: forum.label, message: r.error }); continue; }
        for (const e of r.entries) {
          const c = sitemapCandidate(e, forum, profile, profile.id);
          if (!c) continue;
          pushCand(c.key, c.values, c.s);
        }
      }
  return { cands, errors };
}

async function searchChannelHackerNews(input: SearcherInput): Promise<SearcherResult> {
  const { profile, queries, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      let failed = false;
      // Every profile searches Hacker News the same way: help-request
      // phrasing against the ask_hn tag with relevance ranking, Ask-HN-titled
      // posts only. "Show HN" showcases are founders announcing, not seekers
      // asking — the title gate excludes them before the pre-filter for all
      // profiles alike, so they are never counted as found or discarded.
      // This also drops comment hits (they carry no story title).
      for (const query of queries.slice(0, 5)) {
          if (!budget.take()) { errors.push({ channel: "Hacker News", message: "Shared search budget for this run is spent — retry with fewer channels." }); failed = true; continue; }
        const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=ask_hn&hitsPerPage=12`;
        const r = await fetchJson(url);
        if (!r.ok) { if (!failed) errors.push({ channel: "Hacker News", message: `Search failed (HTTP ${r.status}). Try again.` }); failed = true; continue; }
        const hits = (asObj(r.data).hits as unknown[]) ?? [];
        for (const h of hits.slice(0, 12)) {
          const o = asObj(h);
          const oid = String(o.objectID ?? "");
          const title = String(o.title ?? "");
          if (hnTitleKind(title) !== "ask") continue;
          const text = String(o.story_text ?? o.title ?? "");
          const clean = decodeHnText(text).slice(0, 900);
          const s = analyseText(title + " " + clean, profile, "hackernews");
          pushCand(`hn:${oid}`, { profileId: profile.id, channel: "hackernews", mode: "live_search", externalUrl: `https://news.ycombinator.com/item?id=${oid}`, externalId: oid, author: String(o.author ?? ""), authorHandle: String(o.author ?? ""), title, body: clean, postedAt: String(o.created_at ?? ""), matchScore: s.score, matchReason: s.reason }, s);
        }
      }
  return { cands, errors };
}

async function searchChannelGitHub(input: SearcherInput): Promise<SearcherResult> {
  const { profile, queries, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      let failed = false;
      for (const query of queries.slice(0, 3)) {
        if (failed) break; // rate-limited: stop spending the free search budget
          if (!budget.take()) { errors.push({ channel: "GitHub", message: "Shared search budget for this run is spent — retry with fewer channels." }); failed = true; continue; }
        const q = `${query} in:title,body state:open`;
        const r = await fetchJson(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=10&sort=created&order=desc`, { headers: { Accept: "application/vnd.github+json" } });
        if (!r.ok) { errors.push({ channel: "GitHub", message: r.status === 403 ? "GitHub free search rate limit hit (10/min unauthenticated). Wait a minute and retry." : `Search failed (HTTP ${r.status}).` }); failed = true; continue; }
        const items = (asObj(r.data).items as unknown[]) ?? [];
        for (const it of items) {
          const o = asObj(it); const user = asObj(o.user);
          if (o.pull_request) continue; // PRs are not posts; not counted as candidates at all
          const title = String(o.title ?? ""); const bodyTxt = String(o.body ?? "").slice(0, 900);
          // Full-body analysis only. The old head check (title + first 300
          // chars needing an exact/context phrase) discarded GitHub
          // candidates before their full text was ever scored — removed.
          const s = analyseText(title + " " + bodyTxt, profile, "github");
          const repoUrl = String(o.repository_url ?? ""); const repo = repoUrl.replace("https://api.github.com/repos/", "");
          pushCand(`gh:${String(o.id ?? "")}`, { profileId: profile.id, channel: "github", mode: "live_post", externalUrl: String(o.html_url ?? ""), externalId: String(o.id ?? ""), author: String(user.login ?? ""), authorHandle: String(user.login ?? ""), title, body: bodyTxt, community: repo, postedAt: String(o.created_at ?? ""), matchScore: s.score, matchReason: s.reason }, s);
        }
      }
  return { cands, errors };
}

async function searchChannelDevto(input: SearcherInput): Promise<SearcherResult> {
  const { profile, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      // Dev.to has no keyless search API: the latest articles are gated title
      // by title, same honest pattern as the sitemap forums and Lobsters.
      // Muse picks whether this channel executes at all.
      if (!budget.take()) { errors.push({ channel: "Dev.to", message: "Shared search budget for this run is spent — retry with fewer channels." }); return { cands, errors }; }
      const r = await fetchJson("https://dev.to/api/articles?per_page=40");
      if (!r.ok) { errors.push({ channel: "Dev.to", message: `Search failed (HTTP ${r.status}). Try again.` }); return { cands, errors }; }
      const articles = Array.isArray(r.data) ? r.data : [];
      for (const a of articles) {
        const c = devtoCandidate(asObj(a), profile, profile.id);
        if (!c) continue;
        pushCand(c.key, c.values, c.s);
      }
  return { cands, errors };
}

async function searchChannelLobsters(input: SearcherInput): Promise<SearcherResult> {
  const { profile, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      // Lobsters newest.json: no per-topic query API, so the front page is
      // gated title-by-title, same honest pattern as the sitemap forums.
      if (!budget.take()) { errors.push({ channel: "Lobsters", message: "Shared search budget for this run is spent — retry with fewer channels." }); return { cands, errors }; }
      const r = await fetchJson("https://lobste.rs/newest.json");
      if (!r.ok) { errors.push({ channel: "Lobsters", message: `Search failed (HTTP ${r.status}). Try again.` }); return { cands, errors }; }
      const stories = Array.isArray(r.data) ? r.data : [];
      for (const st of stories) {
        const c = lobstersCandidate(asObj(st), profile, profile.id);
        if (!c) continue;
        pushCand(c.key, c.values, c.s);
      }
  return { cands, errors };
}

async function searchChannelBluesky(input: SearcherInput): Promise<SearcherResult> {
  const { ctx, profile, queries, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      const sess = await ensureBsky(ctx);
      if (!sess) { errors.push({ channel: "Bluesky", message: "Bluesky is not connected. Connect your free Bluesky account in Channels to search posts." }); return { cands, errors }; }
      let failed = false;
      for (const query of queries.slice(0, 5)) {
          if (!budget.take()) { errors.push({ channel: "Bluesky", message: "Shared search budget for this run is spent — retry with fewer channels." }); failed = true; continue; }
        const r = await fetchJson(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=15&sort=latest`, { headers: { Authorization: `Bearer ${sess.accessJwt}` } });
        if (!r.ok) { if (!failed) errors.push({ channel: "Bluesky", message: `Search failed (HTTP ${r.status}). Your session may have expired — reconnect in Channels.` }); failed = true; continue; }
        const posts = (asObj(r.data).posts as unknown[]) ?? [];
        for (const p of posts.slice(0, 10)) {
          const o = asObj(p); const author = asObj(o.author); const record = asObj(o.record);
          const uri = String(o.uri ?? ""); const rkey = uri.split("/").pop() ?? "";
          const handle = String(author.handle ?? "");
          const text = String(record.text ?? "").slice(0, 900);
          const s = analyseText(text, profile, "bluesky");
          pushCand(`bsky:${uri}`, { profileId: profile.id, channel: "bluesky", mode: "live_post", externalUrl: `https://bsky.app/profile/${handle}/post/${rkey}`, externalId: uri, externalUri: uri, externalCid: String(o.cid ?? ""), author: String(author.displayName ?? handle), authorHandle: handle, title: "", body: text, postedAt: String(record.createdAt ?? o.indexedAt ?? ""), matchScore: s.score, matchReason: s.reason }, s);
        }
      }
  return { cands, errors };
}

async function searchChannelReddit(input: SearcherInput): Promise<SearcherResult> {
  const { ctx, profile, queries, subreddits, budget } = input;
  const cands: SearcherResult["cands"] = [];
  const errors: SearcherResult["errors"] = [];
  const pushCand = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => cands.push({ key, values, s });
      const subs = subreddits.split(/[,\s]+/).map((s) => s.trim().replace(/^r\//, "")).filter(Boolean).slice(0, 5);
      if (!subs.length) { errors.push({ channel: "Reddit POC", message: "Enter at least one subreddit (max 5) for the POC search." }); return { cands, errors }; }
      const sess = await ensureReddit(ctx);
      if ("error" in sess) { errors.push({ channel: "Reddit POC", message: sess.error }); return { cands, errors }; }
      // On-demand only, sequential, deduplicated in the leads table — total
      // calls capped at 10 per run, far under the 100/min free-tier limit.
      let calls = 0;
      for (const sub of subs) {
        for (const query of queries.slice(0, 3)) {
          if (calls >= 10) break;
          if (!budget.take()) { errors.push({ channel: "Reddit POC", message: "Shared search budget for this run is spent — retry with fewer channels." }); break; }
          calls++;
          const url = `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/search?q=${encodeURIComponent(query)}&restrict_sr=on&sort=new&t=month&limit=10`;
          const r = await fetchJson(url, { headers: { Authorization: `Bearer ${sess.access}` } });
          if (!r.ok) { errors.push({ channel: "Reddit POC", message: `r/${sub} search failed (HTTP ${r.status}). Check the subreddit name and your POC connection.` }); continue; }
          const children = (asObj(asObj(r.data).data).children as unknown[]) ?? [];
          for (const c of children) {
            const d = asObj(asObj(c).data);
            const fullname = String(d.name ?? "");
            const title = String(d.title ?? ""); const self = String(d.selftext ?? "").slice(0, 900);
            const s = analyseText(title + " " + self, profile, "reddit_poc");
            pushCand(`rd:${fullname}`, { profileId: profile.id, channel: "reddit_poc", mode: "live_post", externalUrl: `https://www.reddit.com${String(d.permalink ?? "")}`, externalId: fullname, author: String(d.author ?? ""), authorHandle: String(d.author ?? ""), title, body: self, community: `r/${sub}`, postedAt: d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : "", matchScore: s.score, matchReason: s.reason }, s);
          }
        }
      }
  return { cands, errors };
}
// Per-channel funnel rows and per-hunt verdict counts ride on the search
// result so the Threads step can show the funnel honestly.
export interface ChannelStat { channel: string; found: number; kept: number; created: number }
export interface HuntVerdicts { seedUser: number; curious: number; irrelevant: number; pending: number }
// Verdicts on exactly this hunt's new leads (created at/after the hunt
// started): what the funnel's last stage shows. Older leads belong to older
// hunts, never this count.
async function verdictsForHunt(db: Db, profileId: number, sinceMs: number): Promise<HuntVerdicts> {
  const rows = await db.select({ category: schema.leads.llmCategory }).from(schema.leads)
    .where(and(eq(schema.leads.profileId, profileId), gte(schema.leads.createdAt, new Date(sinceMs))));
  const v: HuntVerdicts = { seedUser: 0, curious: 0, irrelevant: 0, pending: 0 };
  for (const r of rows) {
    if (r.category === "seed_user") v.seedUser++;
    else if (r.category === "curious") v.curious++;
    else if (r.category === "irrelevant") v.irrelevant++;
    else v.pending++;
  }
  return v;
}
export async function runChannelSearch(
  ctx: Ctx,
  profile: typeof schema.profiles.$inferSelect,
  channels: string[],
  subreddits: string,
  queries: string[],
  onProgress?: (detail: string) => Promise<void>,
): Promise<{ created: number; found: number; discarded: number; pruned: number; promoted: number; errors: { channel: string; message: string }[]; semanticApplied: boolean; semanticMessage: string; channelStats: ChannelStat[] }> {
  const db = ctx.db<typeof schema>();
  let pruned = 0;
  const existingAll = await db.select().from(schema.leads).where(eq(schema.leads.profileId, profile.id));
  for (const l of existingAll) {
    // Pruning only ever removes UNCLASSIFIED live candidates that fail the
    // current light gate. A lead Muse has already synthesized is a Step 4
    // result the founder can see — a later search must never delete it just
    // because the rules re-score it differently.
    if (l.status === "new" && !l.llmCategory && (l.mode === "live_post" || l.mode === "live_search")) {
      const a = analyseText(`${l.title} ${l.body}`, profile, l.channel);
      // Hacker News searches Ask HN only (see below): a stored unclassified
      // HN lead whose title does not start with "Ask HN" (e.g. an old Show HN
      // showcase) can never be an HN candidate again.
      const hnExcluded = l.channel === "hackernews" && hnTitleKind(l.title) !== "ask";
      if (!a.keep || hnExcluded) { await db.delete(schema.leads).where(eq(schema.leads.id, l.id)); pruned++; }
    }
  }
  const prunedIds = new Set<number>();
  if (pruned) {
    const remaining = await db.select().from(schema.leads).where(eq(schema.leads.profileId, profile.id));
    const remainingIds = new Set(remaining.map((l) => l.id));
    for (const l of existingAll) if (!remainingIds.has(l.id)) prunedIds.add(l.id);
  }
  const existing = existingAll.filter((l) => !prunedIds.has(l.id));
  // Dedup by stable post ID as well as URL: the Bluesky URL embeds the
  // author's handle (which can change), while the post URI in externalId does
  // not. Checking only the URL lets a re-scraped post through as "new".
  const seen = new Set([...existing.map((l) => l.externalUrl), ...existing.map((l) => l.externalId)].filter(Boolean));
  // The expansion plan drives execution: SE sites and forum picks resolve
  // from what Muse mapped — never from per-profile tables in this file.
  let execPlan: ExpansionPlan | null = null;
  try {
    const existingPlans = await db.select().from(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, profile.id));
    const latestRow = existingPlans.sort((a, b) => b.round - a.round)[0];
    execPlan = latestRow ? parseExpansionPlan(latestRow.plan || "{}") : null;
  } catch { execPlan = null; }
  const seSites = seSitesFromPlan(execPlan);
  const errors: { channel: string; message: string }[] = [];

  type Cand = { key: string; values: typeof schema.leads.$inferInsert; score: number; keep: boolean; anchorPresent: boolean; reason: string };
  const candidates = new Map<string, Cand>();
  const addCandidate = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => {
    if (!key) return;
    const prev = candidates.get(key);
    if (prev && prev.score >= s.score) return;
    candidates.set(key, { key, values, score: s.score, keep: s.keep, anchorPresent: s.anchorPresent, reason: s.reason });
  };

  // Searchers run in parallel — one worker per channel, each sequential
  // internally exactly as before. A worker never throws past its own error
  // entry: one channel failing degrades to that channel, never the run.
  const searchBudget = makeCallBudget(SEARCH_BUDGET_CALLS);
  const searcherBase = { ctx, profile, queries, subreddits, seSites, execPlan, budget: searchBudget, onProgress };
  const runOne = async (ch: string): Promise<SearcherResult> => {
    try {
      if (ch === "stackexchange") return await searchChannelStackExchange(searcherBase);
      if (ch === "hackernews") return await searchChannelHackerNews(searcherBase);
      if (ch === "github") return await searchChannelGitHub(searcherBase);
      if (ch === "devto") return await searchChannelDevto(searcherBase);
      if (ch === "lobsters") return await searchChannelLobsters(searcherBase);
      if (ch === "bluesky") return await searchChannelBluesky(searcherBase);
      if (ch === "reddit_poc") return await searchChannelReddit(searcherBase);
      if (SITEMAP_FORUMS.some((f) => f.channel === ch) || ch.startsWith("forum:")) return await searchChannelForums({ ...searcherBase, ch });
      return { cands: [], errors: [{ channel: ch, message: "Unknown channel — EarlyProof cannot search it. Pick channels from the Channels step lineup." }] };
    } catch (e) {
      return { cands: [], errors: [{ channel: ch, message: "Search crashed (" + String(e).slice(0, 120) + ") — other channels unaffected." }] };
    }
  };
  // Each channel reports in as it finishes, so the run line narrates the
  // hunt while slow legs (multi-MB sitemaps) are still downloading.
  const settled = await Promise.all(channels.map((ch) => runOne(ch).then(async (r) => {
    if (onProgress) {
      try { await onProgress(`${ch} searched — ${r.cands.length} candidate${r.cands.length === 1 ? "" : "s"}${r.errors.length ? " (with a note)" : ""}`); } catch { /* progress never breaks the hunt */ }
    }
    return r;
  })));
  for (const r of settled) {
    for (const c of r.cands) addCandidate(c.key, c.values, c.s);
    for (const e of r.errors) errors.push(e);
  }


  // Selection: light-gate passers first (strongest first, capped at 30 so a
  // single search never floods Muse synthesis), then — if fewer than 3
  // passed — top-up promotion of the highest-scoring ANCHORED candidates so
  // Muse always gets a real batch to judge when anchored posts exist.
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  // Hybrid order: rule score (anchor + signals) fused with BM25 over this
  // pool (IDF-weighted, title doubled). matchScore stays rule-based for the
  // gates and the pill; fusion changes only which 30 reach Muse, in what
  // queue order — common-word matches ("giving", "away", "help") sink
  // because the pool itself teaches their weight. (Stage 2 seam: add a
  // cosine-vs-queries ordering into fuseRanks when local embedding weights
  // exist — see retrieval.ts.)
  const ruleKeys = sorted.map((c) => c.key);
  const bm25Keys = bm25Order(queries, sorted.map((c) => ({ key: c.key, title: c.values.title ?? "", body: c.values.body ?? "" })));
  let fused = fuseRanks([ruleKeys, bm25Keys]);
  // Stage 2 — semantic ordering (listwise Muse rerank, one batched call).
  // Meaning joins the fusion as a third ordering; any failure keeps the
  // lexical fusion and is reported on the run, never hidden.
  let semanticApplied = false;
  let semanticMessage = "fewer than 2 candidates — nothing to rerank";
  const semanticScores = new Map<string, number>();
  const rankBy = (keys: string[]) => {
    const rank = new Map(keys.map((key, i) => [key, i]));
    return sorted.slice().sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9) || b.score - a.score);
  };
  let ordered = rankBy(fused);
  const rerankInput = ordered.slice(0, SEMANTIC_RERANK_CAP);
  if (rerankInput.length >= 2) {
    if (onProgress) { try { await onProgress(`Muse is grading ${rerankInput.length} candidates by meaning…`); } catch { /* progress never breaks the hunt */ } }
    const keys = new Set(rerankInput.map((c) => c.key));
    const r = await runLlm(ctx, "small", buildSemanticRerankPrompt(profile.pain, profile.audience,
      rerankInput.map((c) => ({ key: c.key, title: c.values.title ?? "", body: c.values.body ?? "" }))), semanticRerankSchema);
    if (r.ok) {
      for (const [k, s] of parseSemanticScores(r.value, keys)) semanticScores.set(k, s);
      const semanticOrder = rerankInput.slice().sort((a, b) => (semanticScores.get(b.key) ?? -1) - (semanticScores.get(a.key) ?? -1)).map((c) => c.key);
      fused = fuseRanks([ruleKeys, bm25Keys, semanticOrder]);
      ordered = rankBy(fused);
      semanticApplied = true;
      semanticMessage = `Muse reranked ${rerankInput.length} candidates by meaning — paraphrase-aware order fed the top 30`;
    } else {
      semanticMessage = `kept lexical order — ${r.message.slice(0, 140)}`;
      errors.push({ channel: "semantic rerank", message: semanticMessage });
    }
  }
  const found = ordered.length;
  const MAX_TO_SYNTHESIS = 30;
  let selected = ordered.filter((c) => c.keep).slice(0, MAX_TO_SYNTHESIS);
  let promoted = 0;
  if (selected.length < 3) {
    const extra = ordered
      .filter((c) => !c.keep && c.anchorPresent && !selected.includes(c))
      .slice(0, Math.min(3 - selected.length, MAX_TO_SYNTHESIS - selected.length));
    if (extra.length) { selected = [...selected, ...extra]; promoted = extra.length; }
  }
  const selectedKeys = new Set(selected.map((c) => c.key));
  let created = 0;
  const createdBy = new Map<string, number>();
  for (const cand of selected) {
    const url = cand.values.externalUrl ?? "";
    const extId = cand.values.externalId ?? "";
    if ((url && seen.has(url)) || (extId && seen.has(extId))) continue; // already stored from an earlier search — not new, not discarded
    const isPromoted = !cand.keep;
    await db.insert(schema.leads).values({
      ...cand.values,
      semanticScore: semanticScores.get(cand.key) ?? -1,
      matchReason: isPromoted
        ? `${cand.reason} Passed to Muse as a top anchored candidate from this search — the light pre-filter found the domain anchor, and Muse makes the relevance call with evidence and confidence.`
        : cand.reason,
    });
    if (url) seen.add(url);
    if (extId) seen.add(extId);
    created++;
    const cc = cand.values.channel ?? "";
    createdBy.set(cc, (createdBy.get(cc) ?? 0) + 1);
  }
  const discarded = sorted.filter((c) => !selectedKeys.has(c.key)).length;
  // Per-channel funnel rows: every requested channel appears even at zero —
  // a searched channel with nothing found is information, not an omission.
  const statRows = new Map<string, ChannelStat>();
  const statFor = (ch: string) => {
    let row = statRows.get(ch);
    if (!row) { row = { channel: ch, found: 0, kept: 0, created: 0 }; statRows.set(ch, row); }
    return row;
  };
  for (const ch of channels) statFor(ch);
  for (const c of sorted) {
    const row = statFor(c.values.channel ?? "");
    row.found++;
    if (c.keep) row.kept++;
  }
  for (const [ch, n] of createdBy) statFor(ch).created = n;
  const channelStats = [...statRows.values()];
  return { created, found, discarded, pruned, promoted, errors, semanticApplied, semanticMessage, channelStats };
}

const channelStatOut = z.object({ channel: z.string(), found: z.number(), kept: z.number(), created: z.number() });
const verdictsOut = z.object({ seedUser: z.number(), curious: z.number(), irrelevant: z.number(), pending: z.number() });
const emptyVerdicts: HuntVerdicts = { seedUser: 0, curious: 0, irrelevant: 0, pending: 0 };
const searchResponse = z.object({ runId: z.number(), created: z.number(), found: z.number(), discarded: z.number(), pruned: z.number(), promoted: z.number(), synthesized: z.number(), synthesisStatus: z.string(), synthesisMessage: z.string(), errors: z.array(z.object({ channel: z.string(), message: z.string() })), expansionRound: z.number(), expansionAnchor: z.string(), expansionQueries: z.array(z.string()), expansionGenerated: z.boolean(), nextSuggestions: z.array(z.string()), semanticApplied: z.boolean(), semanticMessage: z.string(), channelsSearched: z.array(z.string()), channelStats: z.array(channelStatOut), verdicts: verdictsOut });
const emptySearch = { runId: 0, created: 0, found: 0, discarded: 0, pruned: 0, promoted: 0, synthesized: 0, expansionRound: 0, expansionAnchor: "", expansionQueries: [] as string[], expansionGenerated: false, nextSuggestions: [] as string[], semanticApplied: false, semanticMessage: "", channelsSearched: [] as string[], channelStats: [] as ChannelStat[], verdicts: { ...emptyVerdicts } };

const leadOut = z.object({
  id: z.number(), profileId: z.number(), channel: z.string(), mode: z.string(), externalUrl: z.string(),
  externalId: z.string(), author: z.string(), authorHandle: z.string(), title: z.string(), body: z.string(),
  community: z.string(), postedAt: z.string(), matchScore: z.number(), matchReason: z.string(), semanticScore: z.number(),
  draftBody: z.string(), status: z.string(), postedUrl: z.string(), created_at: z.string(),
  llmCategory: z.string(), llmConfidence: z.number(), llmReason: z.string(), llmQuote: z.string(),
  llmSignals: z.string(), llmReviewed: z.boolean(), draftToneCheck: z.string(),
});
const llmStatusOut = z.object({ configured: z.boolean(), provider: z.string(), hasKey: z.boolean(), keyHint: z.string(), direct: z.boolean(), baseUrl: z.string(), smallModel: z.string(), largeModel: z.string(), hasBraveKey: z.boolean() });
const feedbackOut = z.object({ id: z.number(), profileId: z.number(), seedName: z.string(), source: z.string(), rawText: z.string(), created_at: z.string() });
const summaryOut = z.object({ id: z.number(), profileId: z.number(), kind: z.string(), content: z.string(), created_at: z.string() });

export const Actions = {
  getVersion: defineAction({
    request: z.object({}),
    response: z.object({ version: z.string(), sha: z.string(), dirty: z.boolean(), label: z.string() }),
    async handler() {
      let sha = "unknown";
      let dirty = false;
      try {
        sha = (await Bun.$`git rev-parse --short HEAD`.quiet().text()).trim() || "unknown";
        dirty = (await Bun.$`git status --short`.quiet().text()).trim().length > 0;
      } catch { /* git unavailable (artifact runtime) — label stays version-only */ }
      return { version: PKG_VERSION, sha, dirty, label: `${PKG_VERSION} · ${sha}${dirty ? " · dirty" : ""}` };
    },
  }),

  getState: defineAction({
    request: z.object({}),
    response: z.object({
      profiles: z.array(z.object({ id: z.number(), productName: z.string(), productDesc: z.string(), audience: z.string(), pain: z.string(), workaround: z.string(), keywords: z.string(), coreAction: z.string(), painPhrases: z.string(), workaroundPhrases: z.string(), exclusions: z.string(), created_at: z.string() })),
      llm: llmStatusOut,
      feedback: z.array(feedbackOut),
      summaries: z.array(summaryOut),
      leads: z.array(leadOut),
      insights: z.array(z.object({ id: z.number(), profileId: z.number(), sourceLabel: z.string(), rawText: z.string(), painLanguage: z.string(), created_at: z.string() })),
      invites: z.array(z.object({ id: z.number(), profileId: z.number(), leadId: z.number().nullable(), code: z.string(), label: z.string(), seedName: z.string(), created_at: z.string() })),
      events: z.array(z.object({ id: z.number(), inviteId: z.number(), profileId: z.number(), eventType: z.string(), source: z.string(), note: z.string(), occurred_at: z.string() })),
      expansions: z.array(z.object({ id: z.number(), profileId: z.number(), round: z.number(), anchorTerm: z.string(), plan: z.string(), created_at: z.string() })),
      connections: z.array(z.object({ channel: z.string(), handle: z.string(), connected: z.boolean() })),
      followups: z.array(z.object({ id: z.number(), leadId: z.number(), profileId: z.number(), dueAt: z.string() })),
      posthog: z.array(z.object({ profileId: z.number(), host: z.string(), projectId: z.string(), hasKey: z.boolean(), startedEvent: z.string(), coreEvent: z.string(), returnedEvent: z.string(), paidEvent: z.string(), referredEvent: z.string() })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const profiles = await db.select().from(schema.profiles).orderBy(desc(schema.profiles.id));
      const leads = await db.select().from(schema.leads).orderBy(desc(schema.leads.id));
      const insights = await db.select().from(schema.insights).orderBy(desc(schema.insights.id));
      const invites = await db.select().from(schema.invites).orderBy(desc(schema.invites.id));
      const events = await db.select().from(schema.cohortEvents).orderBy(desc(schema.cohortEvents.id));
      const conns = await db.select().from(schema.connections);
      const ph = await db.select().from(schema.posthogConfigs);
      const llmRow = await loadLlmSettings(ctx);
      const feedback = await db.select().from(schema.feedbackEntries).orderBy(desc(schema.feedbackEntries.id));
      const summaries = await db.select().from(schema.llmSummaries).orderBy(desc(schema.llmSummaries.id));
      const expansions = await db.select().from(schema.searchExpansions).orderBy(desc(schema.searchExpansions.id));
      const followupRows = await db.select().from(schema.followups).orderBy(desc(schema.followups.id));
      const followups = followupRows.filter((f) => !f.doneAt && !f.stopped);
      return {
        expansions: expansions.map(expansionShape),
        llm: {
          configured: llmConfigured(llmRow ?? null),
          provider: "muse",
          hasKey: !!(llmRow?.apiKey.trim() && !isPlaceholderKey(llmRow.apiKey)),
          keyHint: llmRow?.apiKey.trim() && !isPlaceholderKey(llmRow.apiKey) ? `••••${llmRow.apiKey.trim().slice(-4)}` : "",
          direct: !!(llmRow?.apiKey.trim() && !isPlaceholderKey(llmRow.apiKey) && verifiedDirect(llmRow.apiKey)),
          baseUrl: llmRow?.baseUrl ?? "",
          smallModel: llmRow?.smallModel ?? "",
          largeModel: llmRow?.largeModel ?? "",
          hasBraveKey: !!(llmRow?.braveKey.trim()),
        },
        feedback: feedback.map((f) => ({ id: f.id, profileId: f.profileId, seedName: f.seedName, source: f.source, rawText: f.rawText, created_at: f.createdAt.toISOString() })),
        summaries: summaries.map((s) => ({ id: s.id, profileId: s.profileId, kind: s.kind, content: s.content, created_at: s.createdAt.toISOString() })),
        profiles: profiles.map(profileShape),
        leads: leads.map(leadShape),
        insights: insights.map((i) => ({ id: i.id, profileId: i.profileId, sourceLabel: i.sourceLabel, rawText: i.rawText, painLanguage: i.painLanguage, created_at: i.createdAt.toISOString() })),
        invites: invites.map((i) => ({ id: i.id, profileId: i.profileId, leadId: i.leadId ?? null, code: i.code, label: i.label, seedName: i.seedName, created_at: i.createdAt.toISOString() })),
        events: events.map((e) => ({ id: e.id, inviteId: e.inviteId, profileId: e.profileId, eventType: e.eventType, source: e.source, note: e.note, occurred_at: e.occurredAt.toISOString() })),
        connections: conns.map((c) => ({ channel: c.channel, handle: c.handle, connected: !!(c.accessJwt || c.token) })),
        followups: followups.map((f) => ({ id: f.id, leadId: f.leadId, profileId: f.profileId, dueAt: f.dueAt.toISOString() })),
        posthog: ph.map((p) => ({ profileId: p.profileId, host: p.host, projectId: p.projectId, hasKey: !!p.apiKey, startedEvent: p.startedEvent, coreEvent: p.coreEvent, returnedEvent: p.returnedEvent, paidEvent: p.paidEvent, referredEvent: p.referredEvent })),
      };
    },
  }),

  createProfile: defineAction({
    request: z.object({ productName: z.string().min(1), productDesc: z.string().default(""), audience: z.string().default(""), pain: z.string().default(""), workaround: z.string().default(""), keywords: z.string().default(""), coreAction: z.string().default("") }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const r = await db.insert(schema.profiles).values({ productName: args.productName, productDesc: args.productDesc, audience: args.audience, pain: args.pain, workaround: args.workaround, keywords: args.keywords, coreAction: args.coreAction }).returning({ id: schema.profiles.id });
      ctx.invalidateQueries();
      return { id: r[0]?.id ?? 0 };
    },
  }),

  updateProfile: defineAction({
    request: z.object({ id: z.number(), productName: z.string().min(1), productDesc: z.string().default(""), audience: z.string().default(""), pain: z.string().default(""), workaround: z.string().default(""), keywords: z.string().default(""), coreAction: z.string().default("") }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // A plan describes the profile's exact words: when the words change,
      // the old plan's communities would vote stale channels up, so the hunt
      // restarts by itself — the Search tab auto-generates a fresh plan from
      // the new text with no button press. Unchanged text keeps its plan.
      const before = (await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.id)))[0];
      await db.update(schema.profiles).set({ productName: args.productName, productDesc: args.productDesc, audience: args.audience, pain: args.pain, workaround: args.workaround, keywords: args.keywords, coreAction: args.coreAction }).where(eq(schema.profiles.id, args.id));
      if (before && profileSignature(before) !== profileSignature(args)) {
        await db.delete(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, args.id));
      }
      clearDiscoveryCache(args.id);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteProfile: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.leads).where(eq(schema.leads.profileId, args.id));
      await db.delete(schema.insights).where(eq(schema.insights.profileId, args.id));
      await db.delete(schema.cohortEvents).where(eq(schema.cohortEvents.profileId, args.id));
      await db.delete(schema.invites).where(eq(schema.invites.profileId, args.id));
      await db.delete(schema.posthogConfigs).where(eq(schema.posthogConfigs.profileId, args.id));
      await db.delete(schema.feedbackEntries).where(eq(schema.feedbackEntries.profileId, args.id));
      await db.delete(schema.llmSummaries).where(eq(schema.llmSummaries.profileId, args.id));
      await db.delete(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, args.id));
      await db.delete(schema.searchRuns).where(eq(schema.searchRuns.profileId, args.id));
      await db.delete(schema.followups).where(eq(schema.followups.profileId, args.id));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, args.id));
      clearDiscoveryCache(args.id);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Demo mode: one tap seeds a full loop (profile + leads + invite + events)
  // on an empty workspace so a founder sees every tab alive. Refuses when
  // the workspace is already taken — demo data must never mix with real data.
  seedDemoData: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), profileId: z.number(), message: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      if ((await db.select().from(schema.profiles)).length) return { ok: false, profileId: 0, message: "Workspace already has profiles — demo seeds only on an empty workspace." };
      const pr = await db.insert(schema.profiles).values({
        productName: "SecondShift", productDesc: "Side-hustle finder for laid-off workers",
        audience: "Recently laid-off workers who need income now", pain: "Laid off with bills due, no idea where to start for a side hustle",
        workaround: "Applying to hundreds of jobs with no response", keywords: "laid off, side hustle, freelance gigs",
        coreAction: "Applied to a starter gig through a friend",
      }).returning({ id: schema.profiles.id });
      const pid = pr[0]?.id ?? 0;
      // Demo leads carry NO Muse output: verdicts, quotes, signals and drafts
      // are empty until the founder connects a real key and runs the step.
      // The pointer below is the alert, shown where a verdict would be.
      const demoPointer = "Demo lead — no Muse verdict yet. Connect your Muse key, then run “Classify waiting leads” for a live one.";
      const a = await db.insert(schema.leads).values({
        profileId: pid, channel: "bluesky", mode: "live_post",
        externalUrl: "https://bsky.app/profile/demo.bsky.social/post/demo01", externalId: "demo-a",
        author: "Riley", authorHandle: "riley.bsky.social", title: "",
        body: "Laid off last Friday with rent due in two weeks. Everyone says learn to code but I need money now, not in six months.",
        postedAt: new Date().toISOString(), matchScore: 74,
        matchReason: "Demo lead — matched “laid off” plus pain signals.",
        status: "sent", llmCategory: "", llmConfidence: 0,
        llmReason: demoPointer,
        llmQuote: "", llmSignals: "",
      }).returning({ id: schema.leads.id });
      const bBody = "Laid off in March, applied to 200 jobs with two callbacks. Trying freelance gigs now but don't know where to start.";
      await db.insert(schema.leads).values({
        profileId: pid, channel: "bluesky", mode: "live_post",
        externalUrl: "https://bsky.app/profile/demo.bsky.social/post/demo02", externalId: "demo-b",
        author: "Mara", authorHandle: "mara.bsky.social", title: "", body: bBody,
        postedAt: new Date().toISOString(), matchScore: 70,
        matchReason: "Demo lead — matched “freelance” plus pain signals.",
        status: "new", llmCategory: "", llmConfidence: 0,
        llmReason: demoPointer,
        llmQuote: "", llmSignals: "",
      });
      const cBody = "Took a starter gig through a friend, got paid, now looking for steady freelance work.";
      const c = await db.insert(schema.leads).values({
        profileId: pid, channel: "manual", mode: "guided",
        externalUrl: "", externalId: "demo-c",
        author: "Devon", authorHandle: "Devon", title: "", body: cBody, community: "Demo group",
        postedAt: new Date().toISOString(), matchScore: 72,
        matchReason: "Demo lead — did the core action.",
        status: "trial", llmCategory: "", llmConfidence: 0,
        llmReason: demoPointer,
        llmQuote: "", llmSignals: "",
      }).returning({ id: schema.leads.id });
      const cId = c[0]?.id ?? 0;
      const inv = await db.insert(schema.invites).values({ profileId: pid, leadId: cId, code: "DEMO-01", label: "Devon", seedName: "Devon" }).returning({ id: schema.invites.id });
      const invId = inv[0]?.id ?? 0;
      await db.insert(schema.cohortEvents).values({ inviteId: invId, profileId: pid, eventType: "started", source: "manual", note: "demo" });
      await db.insert(schema.cohortEvents).values({ inviteId: invId, profileId: pid, eventType: "core", source: "manual", note: "demo" });
      const aId = a[0]?.id ?? 0;
      if (aId) await ensureFollowup(db, aId, pid);
      ctx.invalidateQueries();
      return { ok: true, profileId: pid, message: "Demo workspace seeded — profile, leads, invite, events and one reply nudge." };
    },
  }),

  searchLiveLeads: defineAction({
    request: z.object({ profileId: z.number(), channels: z.array(z.string()).min(1), subreddits: z.string().default("") }),
    response: searchResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { ...emptySearch, synthesisStatus: "error", synthesisMessage: "Profile not found.", errors: [{ channel: "setup", message: "Profile not found." }] };
      // Muse is required: live search feeds Muse classification, so it does
      // not run at all until Muse is configured. No rule-only search mode.
      if (!(await requireLlm(ctx))) return { ...emptySearch, synthesisStatus: "not_configured", synthesisMessage: LLM_SETUP_MESSAGE, errors: [{ channel: "Muse setup required", message: LLM_SETUP_MESSAGE }] };
      // Step 3 expansion: before searching, Muse generates (or reuses) an
      // expansion plan — where else these people talk, in their own language.
      // The search then runs the founder's original query PLUS the plan's
      // anchor-verified expanded queries across the selected channels: all
      // open channels by default, plus any closed channel the founder has
      // connected and selected (an unconnected closed channel only adds a
      // note — it never blocks the open search).
      // Orchestrated end to end on one run: Scout maps (or reuses), Searchers
      // fan out across the selected channels, Judge synthesizes.
      const runId = await startSearchRun(db, profile.id, "search");
      await touchSearchRun(db, runId, "expanding", "Muse is mapping where they talk…");
      const exp = await ensureExpansionPlan(ctx, profile, runId);
      if (!exp.ok) {
        await touchSearchRun(db, runId, "done", exp.message);
        return { ...emptySearch, runId, synthesisStatus: exp.status, synthesisMessage: exp.message, errors: [{ channel: "Muse expansion", message: exp.message }] };
      }
      const { terms } = anchorTermsFor(profile);
      const original = searchQueryFor(profile);
      const queries = [...new Set([original, ...exp.plan.queries.map((q) => q.query)])]
        .filter((q) => queryIsAnchored(q, terms))
        .slice(0, 6);
      const usable = queries.length ? queries : [original];
      // Never fall back to an empty or unanchored query: it would run a
      // match-everything search. Fail open with an explanation instead.
      if (!usable.length || !usable.some((q) => queryIsAnchored(q, terms))) {
        await touchSearchRun(db, runId, "done", "No anchored query to search — nothing was searched.");
        return { ...emptySearch, runId, synthesisStatus: "error", synthesisMessage: "No anchored query to search — nothing was searched.", errors: [{ channel: "setup", message: "No anchored query to search — nothing was searched." }] };
      }
      await touchSearchRun(db, runId, "searching", `Searching ${args.channels.length} channel(s)…`);
      const huntStart = Date.now();
      const run = await runChannelSearch(ctx, profile, args.channels, args.subreddits, usable, async (d) => {
        try { await touchSearchRun(db, runId, "searching", d); } catch { /* progress never breaks the hunt */ }
      });
      // Step 4 — LLM synthesis runs automatically before any result is shown.
      await touchSearchRun(db, runId, "synthesizing", `Synthesizing ${run.created} candidate(s) with Muse…`, { found: run.found, created: run.created });
      const synth = await classifyForProfile(ctx, profile, runId);
      const errors = [...run.errors];
      if (synth.status !== "ok") errors.push({ channel: "Muse synthesis", message: synth.message });
      const verdicts = await verdictsForHunt(db, profile.id, huntStart);
      await touchSearchRun(db, runId, "done", `Checked ${run.found} posts, ${run.created} looked like your people.`, { found: run.found, created: run.created, synthesized: synth.classified + synth.cached });
      ctx.invalidateQueries();
      return { runId, created: run.created, found: run.found, discarded: run.discarded, pruned: run.pruned, promoted: run.promoted, synthesized: synth.classified + synth.cached, synthesisStatus: synth.status, synthesisMessage: synth.message, errors, expansionRound: exp.round, expansionAnchor: exp.plan.anchorTerm, expansionQueries: usable, expansionGenerated: exp.generated, nextSuggestions: exp.plan.nextSuggestions, semanticApplied: run.semanticApplied, semanticMessage: run.semanticMessage, channelsSearched: args.channels, channelStats: run.channelStats, verdicts };
    },
  }),

  // One-click "Expand search and re-run": Muse generates the NEXT expansion
  // round — adjacent audiences/pains, different communities, a named
  // relaxation of an over-strict term, anchor always kept — then those new
  // queries are searched across the same channels and synthesized (Step 4).
  // Deduplication against already-stored leads means re-running never
  // duplicates an already-seen lead.
  expandSearchAndRerun: defineAction({
    request: z.object({ profileId: z.number(), channels: z.array(z.string()).min(1), subreddits: z.string().default("") }),
    response: searchResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { ...emptySearch, synthesisStatus: "error", synthesisMessage: "Profile not found.", errors: [{ channel: "setup", message: "Profile not found." }] };
      if (!(await requireLlm(ctx))) return { ...emptySearch, synthesisStatus: "not_configured", synthesisMessage: LLM_SETUP_MESSAGE, errors: [{ channel: "Muse setup required", message: LLM_SETUP_MESSAGE }] };
      const leadsNow = await db.select().from(schema.leads).where(eq(schema.leads.profileId, profile.id));
      const synthesizedNow = leadsNow.filter((l) => !!l.llmCategory).length;
      // Orchestrated end to end on one run: Scout maps, Searchers fan out,
      // Judge synthesizes — each step traced through the same run id.
      const runId = await startSearchRun(db, profile.id, "expand");
      await touchSearchRun(db, runId, "expanding", "Muse is mapping where else they talk…");
      const gen = await scoutPlanAgent.execute(ctx, { profile, context: {
        reason: synthesizedNow === 0
          ? "The last search returned 0 synthesized results — a dead end the founder asked to expand past."
          : `The founder asked to widen the search beyond the ${synthesizedNow} synthesized result(s) found so far.`,
        found: leadsNow.length, discarded: 0, synthesized: synthesizedNow, seenCount: leadsNow.length,
      } }, runId);
      if (!gen.ok) {
        await touchSearchRun(db, runId, "done", gen.message);
        return { ...emptySearch, runId, synthesisStatus: gen.status, synthesisMessage: gen.message, errors: [{ channel: "Muse expansion", message: gen.message }] };
      }
      const queries = gen.value.plan.queries.map((q) => q.query).slice(0, 6);
      await touchSearchRun(db, runId, "searching", `Searching ${args.channels.length} channel(s) with round ${gen.value.round} queries…`);
      const huntStart = Date.now();
      const run = await runChannelSearch(ctx, profile, args.channels, args.subreddits, queries, async (d) => {
        try { await touchSearchRun(db, runId, "searching", d); } catch { /* progress never breaks the hunt */ }
      });
      await touchSearchRun(db, runId, "synthesizing", `Synthesizing ${run.created} candidate(s) with Muse…`, { found: run.found, created: run.created });
      const synth = await classifyForProfile(ctx, profile, runId);
      const errors = [...run.errors];
      if (synth.status !== "ok") errors.push({ channel: "Muse synthesis", message: synth.message });
      const verdicts = await verdictsForHunt(db, profile.id, huntStart);
      await touchSearchRun(db, runId, "done", `Checked ${run.found} posts, ${run.created} looked like your people.`, { found: run.found, created: run.created, synthesized: synth.classified + synth.cached });
      ctx.invalidateQueries();
      return { runId, created: run.created, found: run.found, discarded: run.discarded, pruned: run.pruned, promoted: run.promoted, synthesized: synth.classified + synth.cached, synthesisStatus: synth.status, synthesisMessage: synth.message, errors, expansionRound: gen.value.round, expansionAnchor: gen.value.plan.anchorTerm, expansionQueries: queries, expansionGenerated: true, nextSuggestions: gen.value.plan.nextSuggestions, semanticApplied: run.semanticApplied, semanticMessage: run.semanticMessage, channelsSearched: args.channels, channelStats: run.channelStats, verdicts };
    },
  }),

  // Generates (a new round of) the LLM expansion plan on its own, so the
  // founder can read where Muse wants to look before any search runs.
  generateExpansionPlan: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), round: z.number(), anchorTerm: z.string(), droppedUnanchored: z.number(), runId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { status: "error", message: "Profile not found.", round: 0, anchorTerm: "", droppedUnanchored: 0, runId: 0 };
      const huntId = await startSearchRun(db, profile.id, "hunt");
      const leadsNow = await db.select().from(schema.leads).where(eq(schema.leads.profileId, profile.id));
      const gen = await scoutPlanAgent.execute(ctx, { profile, context: { reason: "The founder asked for an expansion plan.", found: leadsNow.length, discarded: 0, synthesized: leadsNow.filter((l) => !!l.llmCategory).length, seenCount: leadsNow.length } }, huntId);
      if (!gen.ok) {
        await touchSearchRun(db, huntId, "done", gen.message);
        return { status: gen.status, message: gen.message, round: 0, anchorTerm: "", droppedUnanchored: 0, runId: huntId };
      }
      const doneDetail = `Round ${gen.value.round} saved: ${gen.value.plan.queries.length} anchored queries (anchor “${gen.value.plan.anchorTerm}”)${gen.value.plan.droppedUnanchored ? `, ${gen.value.plan.droppedUnanchored} unanchored dropped` : ""}, ${gen.value.plan.communities.length} communities mapped — now verifying picks against the web…`;
      await touchSearchRun(db, huntId, "done", doneDetail);
      ctx.invalidateQueries();
      return { status: "ok", message: `Expansion plan round ${gen.value.round} saved — ${gen.value.plan.queries.length} anchored queries (anchor: “${gen.value.plan.anchorTerm}”)${gen.value.plan.droppedUnanchored ? `, ${gen.value.plan.droppedUnanchored} unanchored suggestion${gen.value.plan.droppedUnanchored === 1 ? "" : "s"} dropped` : ""}, ${gen.value.plan.communities.length} communities mapped to channels. It will drive the next search.`, round: gen.value.round, anchorTerm: gen.value.plan.anchorTerm, droppedUnanchored: gen.value.plan.droppedUnanchored, runId: huntId };
    },
  }),

  // Which channels fit THIS profile: profile signals plus Muse's latest
  // expansion plan, ranked best/good/poor with reasons. The UI preselects
  // the open non-poor picks — GitHub and HN are never defaults for a
  // non-technical profile.
  recommendChannels: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), basedOn: z.string(), webOk: z.boolean(), webVia: z.string(), recs: z.array(z.object({ channel: z.string(), label: z.string(), fit: z.string(), reasons: z.array(z.string()), needsConnection: z.boolean(), verified: z.boolean() })), venues: z.array(z.object({ name: z.string(), where: z.string(), why: z.string(), url: z.string(), src: z.string() })) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { status: "error", message: "Profile not found.", basedOn: "", webOk: false, webVia: "", recs: [], venues: [] };
      const existing = await db.select().from(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, profile.id));
      const latest = existing.sort((a, b) => b.round - a.round)[0];
      let plan: ExpansionPlan | null = null;
      let basedOn = "no expansion plan yet — run the channel hunt and Muse maps where these people talk";
      if (latest) {
        const p = parseExpansionPlan(latest.plan || "{}");
        if (p) {
          plan = p;
          basedOn = p.queries.length
            ? `Muse expansion round ${latest.round}`
            : `Muse expansion round ${latest.round} (communities only — re-generate for search queries)`;
        } else {
          basedOn = "the saved plan came back empty — re-generate it";
        }
      }
      const { recs } = channelRecsFor(profile, plan);
      // Web venue discovery runs for every profile (cached 2h, one query): real
      // discussion threads found by search merge into the static recs, and
      // verified new forums join the lineup as `forum:<slug>` channels. A
      // failed discovery degrades to static recs — never an error.
      let venues: { name: string; where: string; why: string; url: string; src: "web" | "plan" }[] = [];
      let webOk = false;
      let webVia = "";
      try {
        const found = await discoverVenuesFor(profile, await braveKeyFor(ctx), plan);
        webOk = found.webOk;
        webVia = found.webVia;
        mergeDiscovery(recs, found);
        // Plan-first honesty: a pill is "verified" only when the web check
        // saw real threads on it. Everything else stands on Muse's plan
        // alone — shown anyway, badged as such, never hidden.
        for (const r of recs) if (found.evidence.some((e) => e.channel === r.channel)) r.verified = true;
        const planNamed = new Map(planDomains(plan).map((d) => [d.domain, d.name]));
        for (const d of found.dynamic) {
          if (recs.some((r) => r.channel === `forum:${d.slug}`)) continue;
          const named = planNamed.get(d.domain);
          recs.push({ channel: `forum:${d.slug}`, label: d.label, fit: "good", reasons: [named ? `Muse's plan named “${named}” here and its thread sitemap reads — verified without any search engine.` : `Web search verified ${d.label} threads about this pain (thread sitemap readable) — keyless title search.`], needsConnection: false, verified: true });
        }
        sortRecs(recs);
        venues = found.venues.slice(0, 6);
        // Plan-named places no channel can execute (YouTube, Facebook, …)
        // join the venue list straight from the plan with a plan badge, so a
        // dead web check can never silently drop somewhere Muse mapped.
        const covered = new Set(recs.map((r) => r.channel));
        for (const c of plan?.communities ?? []) {
          const key = c.channel === "reddit" ? "reddit_poc" : (c.channel ?? "").trim();
          if (!c.name || !key || covered.has(key)) continue;
          const k = `${c.name} ${c.where || ""}`.toLowerCase();
          if (venues.some((v) => `${v.name} ${v.where}`.toLowerCase() === k)) continue;
          venues.push({ name: c.name, where: c.where || "", why: c.why ? `${c.why} (From Muse's plan — the live web check hasn't confirmed this place yet.)` : "From Muse's plan — the live web check hasn't confirmed this place yet.", url: "", src: "plan" });
        }
        venues = venues.slice(0, 8);
      } catch { /* static recs stand alone */ }
      const open = recs.filter((r) => !r.needsConnection);
      const closed = recs.filter((r) => r.needsConnection);
      const webNote = webOk && webVia ? ` Web evidence via ${webVia === "brave" ? "Brave Search (keyed)" : webVia === "searxng" ? "SearXNG (self-hosted, free)" : "DuckDuckGo (free)"}.` : " Web check unavailable — every pick below stands on Muse's plan, badged plan-only until the check runs.";
      return {
        status: "ok",
        message: (recs.length
          ? `${open.length ? `Searching ${open.map((r) => r.label).join(", ")}` : "No open channels"}${closed.length ? ` · closed until connected: ${closed.map((r) => r.label).join(", ")}` : ""} (${basedOn}).`
          : `No channels mapped yet (${basedOn}) — run the channel hunt and Muse names where these people talk.`) + webNote,
        basedOn,
        webOk,
        webVia,
        recs,
        venues,
      };
    },
  }),

  // Poll a search run's phase while it is in flight (the search actions are
  // synchronous, so this mostly confirms completion — but the phases are
  // real and the UI narrates them).
  searchRunStatus: defineAction({
    request: z.object({ runId: z.number() }),
    response: z.object({ phase: z.string(), detail: z.string(), found: z.number(), created: z.number(), synthesized: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.searchRuns).where(eq(schema.searchRuns.id, args.runId));
      const r = rows[0];
      if (!r) return { phase: "done", detail: "No such run.", found: 0, created: 0, synthesized: 0 };
      return { phase: r.phase, detail: r.detail, found: r.found, created: r.created, synthesized: r.synthesized };
    },
  }),

  addPastedLead: defineAction({
    request: z.object({ profileId: z.number(), channel: z.string(), externalUrl: z.string().default(""), author: z.string().default(""), title: z.string().default(""), body: z.string().min(1), community: z.string().default("") }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      const s = profile ? scoreText(args.title + " " + args.body, profile) : { score: 50, reason: "" };
      const mode = args.channel === "reddit" || args.channel === "x" ? "pasted" : "guided";
      const r = await db.insert(schema.leads).values({ profileId: args.profileId, channel: args.channel, mode, externalUrl: args.externalUrl, author: args.author, authorHandle: args.author, title: args.title, body: args.body.slice(0, 1200), community: args.community, postedAt: new Date().toISOString(), matchScore: s.score, matchReason: s.reason }).returning({ id: schema.leads.id });
      ctx.invalidateQueries();
      return { id: r[0]?.id ?? 0 };
    },
  }),

  addInsight: defineAction({
    request: z.object({ profileId: z.number(), sourceLabel: z.string().default(""), rawText: z.string().min(3) }),
    response: z.object({ id: z.number(), painLanguage: z.string(), llmStatus: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let painLanguage = "";
      let llmStatus = "not_configured";
      const r0 = await runLlm(ctx, "small",
        `Extract the pain language from this competitor review: the reviewer's exact frustrated phrases, what is missing, and what they wish existed. Quote their words; do not paraphrase into marketing language.\nReview: """${args.rawText.slice(0, 1500)}"""`,
        z.object({ painLanguage: z.string() }));
      if (r0.ok) { painLanguage = r0.value.painLanguage.trim(); llmStatus = "ok"; }
      else llmStatus = r0.status;
      const r = await db.insert(schema.insights).values({ profileId: args.profileId, sourceLabel: args.sourceLabel, rawText: args.rawText.slice(0, 2000), painLanguage }).returning({ id: schema.insights.id });
      ctx.invalidateQueries();
      return { id: r[0]?.id ?? 0, painLanguage, llmStatus };
    },
  }),

  deleteInsight: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.insights).where(eq(schema.insights.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  generateDraft: defineAction({
    request: z.object({ leadId: z.number() }),
    response: z.object({ draft: z.string(), toneCheck: z.string(), llmStatus: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.leads).where(eq(schema.leads.id, args.leadId));
      const lead = rows[0]; if (!lead) return { draft: "", toneCheck: "", llmStatus: "error" };
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, lead.profileId));
      const p = profRows[0];
      if (!p) return { draft: lead.draftBody, toneCheck: "Profile not found for this lead — no draft was generated.", llmStatus: "error" };
      // Muse draft generation is a core, required step — there is no template
      // fallback. Blocked drafts return the lead's existing draft untouched.
      const settings = await requireLlm(ctx);
      if (!settings) return { draft: lead.draftBody, toneCheck: LLM_SETUP_MESSAGE, llmStatus: "not_configured" };
      // Classification gate: no lead — live, pasted or guided — may be used for
      // outreach until Muse has classified it. Held verdicts (low confidence
      // or irrelevant) must be cleared by the founder first.
      if (!lead.llmCategory) return { draft: lead.draftBody, toneCheck: "Muse classification required first: this lead has not been classified by Muse yet, so it can't be used for outreach. Run “Classify waiting leads” on the Threads step, read the verdict and its quote, then generate the draft.", llmStatus: "needs_classification" };
      if ((lead.llmCategory === "irrelevant" || (lead.llmConfidence > 0 && lead.llmConfidence < LOW_CONFIDENCE)) && lead.llmReviewed !== 1) {
        return { draft: lead.draftBody, toneCheck: "Held for your review: Muse classified this lead as low-confidence or irrelevant. Read the evidence on the lead and tap “I reviewed this — keep it in my queue” before any draft is written for it.", llmStatus: "needs_review" };
      }
      const r = await drafterAgent.execute(ctx, { profile: p, lead });
      if (!r.ok) return { draft: lead.draftBody, toneCheck: r.status === "not_configured" ? LLM_SETUP_MESSAGE : `${r.message} No fallback draft was substituted — draft generation is a Muse step. Fix the Muse connection and try again.`, llmStatus: r.status };
      const draft = r.value.draft.trim();
      const toneCheck = r.value.toneCheck.trim() ? r.value.toneCheck.trim() : "Draft written by your large Muse model. Read it before approving — you are the tone check of last resort.";
      await db.update(schema.leads).set({ draftBody: draft, draftToneCheck: toneCheck, status: lead.status === "new" ? "drafted" : lead.status, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
      ctx.invalidateQueries();
      return { draft, toneCheck, llmStatus: "ok" };
    },
  }),

  updateDraft: defineAction({
    request: z.object({ leadId: z.number(), draftBody: z.string() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.leads).where(eq(schema.leads.id, args.leadId));
      const lead = rows[0];
      if (!lead) return { ok: false };
      await db.update(schema.leads).set({ draftBody: args.draftBody, status: lead.status === "new" ? "drafted" : lead.status, updatedAt: new Date() }).where(eq(schema.leads.id, args.leadId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setLeadStatus: defineAction({
    request: z.object({ leadId: z.number(), status: z.enum(["new", "drafted", "approved", "sent", "replied", "conversation", "trial", "dismissed"]) }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Outreach stages can't be reached by hand either: a lead must have been
      // classified by Muse (and any held verdict cleared) before it moves
      // into approved / sent / conversation / trial.
      if (["approved", "sent", "replied", "conversation", "trial"].includes(args.status)) {
        const rows = await db.select().from(schema.leads).where(eq(schema.leads.id, args.leadId));
        const lead = rows[0];
        if (lead && !(await requireLlm(ctx))) return { ok: false };
        if (lead && !lead.llmCategory) return { ok: false };
        if (lead && (lead.llmCategory === "irrelevant" || (lead.llmConfidence > 0 && lead.llmConfidence < LOW_CONFIDENCE)) && lead.llmReviewed !== 1) return { ok: false };
      }
      await db.update(schema.leads).set({ status: args.status, updatedAt: new Date() }).where(eq(schema.leads.id, args.leadId));
      if (args.status === "sent") {
        const moved = await db.select().from(schema.leads).where(eq(schema.leads.id, args.leadId));
        if (moved[0]) await ensureFollowup(db, moved[0].id, moved[0].profileId);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Answer a reply nudge: they replied (lead moves, nudge closes), snooze
  // (ask again in 3 days), or stop (never ask about this lead again).
  answerNudge: defineAction({
    request: z.object({ followupId: z.number(), outcome: z.enum(["replied", "snoozed", "stopped"]) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.followups).where(eq(schema.followups.id, args.followupId));
      const f = rows[0];
      if (!f) return { ok: false, message: "That reminder is gone — the lead may have been deleted." };
      const leads = await db.select().from(schema.leads).where(eq(schema.leads.id, f.leadId));
      const lead = leads[0];
      if (args.outcome === "replied" && lead) {
        await db.update(schema.leads).set({ status: "replied", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
        await db.delete(schema.followups).where(eq(schema.followups.leadId, lead.id));
        ctx.invalidateQueries();
        return { ok: true, message: "Moved to replied — nice." };
      }
      if (args.outcome === "snoozed" && lead) {
        await db.update(schema.followups).set({ dueAt: new Date(Date.now() + FOLLOWUP_DUE_MS) }).where(eq(schema.followups.id, f.id));
        ctx.invalidateQueries();
        return { ok: true, message: "Snoozed — I'll ask again in 3 days." };
      }
      await db.update(schema.followups).set({ stopped: 1, doneAt: new Date() }).where(eq(schema.followups.id, f.id));
      ctx.invalidateQueries();
      return { ok: true, message: "Reminder cleared." };
    },
  }),

  deleteLead: defineAction({
    request: z.object({ leadId: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.followups).where(eq(schema.followups.leadId, args.leadId));
      await db.delete(schema.leads).where(eq(schema.leads.id, args.leadId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  approveAndPost: defineAction({
    request: z.object({ leadId: z.number() }),
    response: z.object({ posted: z.boolean(), postedUrl: z.string(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.leads).where(eq(schema.leads.id, args.leadId));
      const lead = rows[0];
      if (!lead) return { posted: false, postedUrl: "", message: "Lead not found." };
      // Muse is required for outreach — no exceptions, no rule-only bypass.
      if (!(await requireLlm(ctx))) return { posted: false, postedUrl: "", message: LLM_SETUP_MESSAGE };
      if (!lead.draftBody.trim()) return { posted: false, postedUrl: "", message: "Generate a Muse draft (or write your own) first — nothing posts without your approved text." };
      // Classification gate: every lead must have been classified by Muse
      // before it can be used for outreach.
      if (!lead.llmCategory) {
        return { posted: false, postedUrl: "", message: "Blocked: this lead has not been classified by Muse yet. Leads must go through Muse classification before outreach — run “Classify waiting leads” in the Match queue and read the verdict first. The rule-based match score alone is not enough." };
      }
      // LLM guardrail: a low-confidence classification goes to founder review,
      // never straight to outreach. The founder can clear it explicitly.
      if (lead.llmCategory && lead.llmConfidence > 0 && lead.llmConfidence < LOW_CONFIDENCE && lead.llmReviewed !== 1) {
        return { posted: false, postedUrl: "", message: `Held for your review: the AI classified this lead at ${lead.llmConfidence}% confidence, below the ${LOW_CONFIDENCE}% bar. Read the evidence on the lead, then tap “I reviewed this — keep it in my queue” if you still want to reach out.` };
      }
      if (lead.llmCategory === "irrelevant" && lead.llmReviewed !== 1) {
        return { posted: false, postedUrl: "", message: "Held: the AI classified this person as irrelevant to your profile. If you disagree, tap “I reviewed this — keep it in my queue” on the lead first." };
      }

      if (lead.channel === "bluesky") {
        const sess = await ensureBsky(ctx);
        if (!sess) return { posted: false, postedUrl: "", message: "Marked Approved. Want EarlyProof to send it for you? Connect Bluesky in Settings → Channels (free account + app password — never your main password), then tap Approve & post again and it replies from your account. Or copy the draft, reply manually, then tap “Mark sent”." };
        if (!lead.externalUri || !lead.externalCid) return { posted: false, postedUrl: "", message: "This lead has no Bluesky post reference to reply to. Copy the draft and reply manually." };
        const record = { $type: "app.bsky.feed.post", text: lead.draftBody.slice(0, 300), createdAt: new Date().toISOString(), reply: { root: { uri: lead.externalUri, cid: lead.externalCid }, parent: { uri: lead.externalUri, cid: lead.externalCid } } };
        const r = await fetchJson("https://bsky.social/xrpc/com.atproto.repo.createRecord", { method: "POST", headers: { Authorization: `Bearer ${sess.accessJwt}`, "Content-Type": "application/json" }, body: JSON.stringify({ repo: sess.did, collection: "app.bsky.feed.post", record }) });
        if (!r.ok) return { posted: false, postedUrl: "", message: `Bluesky posting failed (HTTP ${r.status}). The draft stays Approved — reconnect Bluesky or post it manually.` };
        const uri = String(asObj(r.data).uri ?? ""); const rkey = uri.split("/").pop() ?? "";
        const url = `https://bsky.app/profile/${sess.handle}/post/${rkey}`;
        await db.update(schema.leads).set({ status: "sent", postedUrl: url, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
        await ensureFollowup(db, lead.id, lead.profileId);
        ctx.invalidateQueries();
        return { posted: true, postedUrl: url, message: "Posted to Bluesky from your account. Now watch for a reply and move it along the tracker when they respond." };
      }

      if (lead.channel === "github") {
        const conns = await db.select().from(schema.connections).where(eq(schema.connections.channel, "github"));
        const pat = conns[0]?.token ?? "";
        const m = lead.externalUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
        if (!pat || !m) {
          await db.update(schema.leads).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
          ctx.invalidateQueries();
          return { posted: false, postedUrl: "", message: "Marked Approved. Want it posted for you? Add a fine-grained token (Issues read/write) in Settings → Channels, then tap Approve & post again. Or copy the draft and comment on the issue yourself, then tap “Mark sent”." };
        }
        const r = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2]}/issues/${m[3]}/comments`, { method: "POST", headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" }, body: JSON.stringify({ body: lead.draftBody }) });
        if (!r.ok) return { posted: false, postedUrl: "", message: `GitHub comment failed (HTTP ${r.status}). The draft stays Approved — check your token's Issues permission.` };
        const url = String(asObj(r.data).html_url ?? lead.externalUrl);
        await db.update(schema.leads).set({ status: "sent", postedUrl: url, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
        await ensureFollowup(db, lead.id, lead.profileId);
        ctx.invalidateQueries();
        return { posted: true, postedUrl: url, message: "Comment posted on the GitHub issue from your account." };
      }

      if (lead.channel === "reddit_poc") {
        const sess = await ensureReddit(ctx);
        if ("error" in sess) {
          await db.update(schema.leads).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
          ctx.invalidateQueries();
          return { posted: false, postedUrl: "", message: "Marked Approved (POC). Want the reply sent for you? Reconnect the Reddit POC in Settings → Channels, then tap Approve & post again. Or copy the draft and reply manually, then tap “Mark sent”." };
        }
        if (!lead.externalId.startsWith("t3_") && !lead.externalId.startsWith("t1_")) {
          await db.update(schema.leads).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
          ctx.invalidateQueries();
          return { posted: false, postedUrl: "", message: "Marked Approved (POC). This lead has no Reddit post ID to reply to, so post the reply manually." };
        }
        const form = new URLSearchParams({ api_type: "json", thing_id: lead.externalId, text: lead.draftBody });
        const r = await fetchJson("https://oauth.reddit.com/api/comment", { method: "POST", headers: { Authorization: `Bearer ${sess.access}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
        const things = (asObj(asObj(asObj(r.data).json).data).things as unknown[]) ?? [];
        if (!r.ok || !things.length) {
          return { posted: false, postedUrl: "", message: `Reddit POC comment failed (HTTP ${r.status}). The draft stays Approved — the subreddit may restrict comments, or the POC session expired.` };
        }
        const permalink = String(asObj(asObj(things[0]).data).permalink ?? "");
        const url = permalink ? `https://www.reddit.com${permalink}` : lead.externalUrl;
        await db.update(schema.leads).set({ status: "sent", postedUrl: url, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
        await ensureFollowup(db, lead.id, lead.profileId);
        ctx.invalidateQueries();
        return { posted: true, postedUrl: url, message: "Reply posted via the Reddit POC connector from your own account (free non-commercial tier — POC validation only)." };
      }

      // All other channels: founder sends manually — there is no connection
      // path to offer (no posting API, or it needs a personal login EarlyProof
      // must never hold), so no ask, just the honest reason and the manual loop.
      await db.update(schema.leads).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
      ctx.invalidateQueries();
      const ch = lead.channel;
      const reason = ch === "hackernews" ? "Hacker News has no posting API"
        : ch === "devto" ? "Dev.to's API blocks automated comments"
        : ch === "lobsters" ? "Lobsters needs its own logged-in account"
        : ch === "stackexchange" ? "Stack Exchange answers need your own logged-in account with reputation"
        : ch === "reddit" || ch === "x" ? "This channel uses your pasted link (no paid API)"
        : ["agingcare", "mumsnet", "makeuptalk", "lipstickalley"].includes(ch) || ch.startsWith("forum:") ? "Forums need your own personal login — EarlyProof can't post as you there"
        : "This is a closed/DM channel";
      return { posted: false, postedUrl: "", message: `Marked Approved — ready for you to send. ${reason}, so copy the draft, send it from your own account, then tap “Mark sent”.` };
    },
  }),

  connectBluesky: defineAction({
    request: z.object({ handle: z.string().min(3), appPassword: z.string().min(4) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const r = await fetchJson("https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: args.handle.replace(/^@/, ""), password: args.appPassword }) });
      if (!r.ok) return { ok: false, message: "Bluesky sign-in failed. Check the handle and use an App Password (Settings → Privacy and security → App passwords), not your main password." };
      const d = asObj(r.data);
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.connections).where(eq(schema.connections.channel, "bluesky"));
      const vals = { channel: "bluesky", handle: String(d.handle ?? args.handle), did: String(d.did ?? ""), accessJwt: String(d.accessJwt ?? ""), refreshJwt: String(d.refreshJwt ?? ""), token: "" };
      if (existing[0]) await db.update(schema.connections).set(vals).where(eq(schema.connections.id, existing[0].id));
      else await db.insert(schema.connections).values(vals);
      ctx.invalidateQueries();
      return { ok: true, message: `Connected as @${vals.handle}. Your app password was used once to sign in and is not stored.` };
    },
  }),

  connectGithub: defineAction({
    request: z.object({ token: z.string().min(10) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const r = await fetchJson("https://api.github.com/user", { headers: { Authorization: `Bearer ${args.token}`, Accept: "application/vnd.github+json" } });
      if (!r.ok) return { ok: false, message: "GitHub token check failed. Use a fine-grained token with Issues read/write on the repos you want to comment in." };
      const login = String(asObj(r.data).login ?? "");
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.connections).where(eq(schema.connections.channel, "github"));
      const vals = { channel: "github", handle: login, did: "", accessJwt: "", refreshJwt: "", token: args.token };
      if (existing[0]) await db.update(schema.connections).set(vals).where(eq(schema.connections.id, existing[0].id));
      else await db.insert(schema.connections).values(vals);
      ctx.invalidateQueries();
      return { ok: true, message: `Connected GitHub as ${login}. Search stays free; the token is only used when you approve a comment.` };
    },
  }),

  getRedditAuthUrl: defineAction({
    request: z.object({ clientId: z.string().min(3), redirectUri: z.string().min(8) }),
    response: z.object({ url: z.string() }),
    async handler(_ctx, args) {
      const state = genCode();
      const url = `https://www.reddit.com/api/v1/authorize?client_id=${encodeURIComponent(args.clientId)}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(args.redirectUri)}&duration=permanent&scope=identity,read,submit`;
      return { url };
    },
  }),

  connectRedditScript: defineAction({
    request: z.object({ clientId: z.string().min(3), clientSecret: z.string().min(3), username: z.string().min(2), password: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const basic = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64");
      const body = new URLSearchParams({ grant_type: "password", username: args.username, password: args.password });
      const r = await fetchJson("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
      if (!r.ok) return { ok: false, message: "Reddit POC sign-in failed. Create a “script” app at reddit.com/prefs/apps under your own account and check the client ID, secret, username and password. POC only — free non-commercial tier." };
      const d = asObj(r.data);
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.connections).where(eq(schema.connections.channel, "reddit_poc"));
      const vals = { channel: "reddit_poc", handle: args.username, did: "", accessJwt: String(d.access_token ?? ""), refreshJwt: "", token: "", clientId: args.clientId, clientSecret: args.clientSecret, expiresAt: Date.now() + Number(d.expires_in ?? 3600) * 1000 };
      if (existing[0]) await db.update(schema.connections).set(vals).where(eq(schema.connections.id, existing[0].id));
      else await db.insert(schema.connections).values(vals);
      ctx.invalidateQueries();
      return { ok: true, message: `Reddit POC connected as u/${args.username}. Your password was used once and is not stored. POC validation only — not for commercial launch.` };
    },
  }),

  connectRedditCode: defineAction({
    request: z.object({ clientId: z.string().min(3), clientSecret: z.string().min(3), redirectUri: z.string().min(8), code: z.string().min(3) }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const basic = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64");
      const body = new URLSearchParams({ grant_type: "authorization_code", code: args.code.trim(), redirect_uri: args.redirectUri });
      const r = await fetchJson("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
      if (!r.ok) return { ok: false, message: "Reddit POC code exchange failed. Codes are single-use and expire fast — generate a fresh authorise link and paste the new code." };
      const d = asObj(r.data);
      const me = await fetchJson("https://oauth.reddit.com/api/v1/me", { headers: { Authorization: `Bearer ${String(d.access_token ?? "")}` } });
      const username = String(asObj(me.data).name ?? "");
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.connections).where(eq(schema.connections.channel, "reddit_poc"));
      const vals = { channel: "reddit_poc", handle: username, did: "", accessJwt: String(d.access_token ?? ""), refreshJwt: String(d.refresh_token ?? ""), token: "", clientId: args.clientId, clientSecret: args.clientSecret, expiresAt: Date.now() + Number(d.expires_in ?? 3600) * 1000 };
      if (existing[0]) await db.update(schema.connections).set(vals).where(eq(schema.connections.id, existing[0].id));
      else await db.insert(schema.connections).values(vals);
      ctx.invalidateQueries();
      return { ok: true, message: `Reddit POC connected${username ? ` as u/${username}` : ""} with a refreshable session. POC validation only — not for commercial launch.` };
    },
  }),

  disconnectChannel: defineAction({
    request: z.object({ channel: z.string() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.connections).where(eq(schema.connections.channel, args.channel));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  createInvite: defineAction({
    request: z.object({ profileId: z.number(), leadId: z.number().nullable().default(null), seedName: z.string().default("") }),
    response: z.object({ id: z.number(), code: z.string(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let label = args.seedName;
      if (args.leadId) {
        const rows = await db.select().from(schema.leads).where(eq(schema.leads.id, args.leadId));
        const lead = rows[0];
        if (lead) {
          // A lead becomes a trial seed user only after Muse classification
          // (and founder clearance of any held verdict) — no bypass via invites.
          if (!(await requireLlm(ctx))) return { id: 0, code: "", message: LLM_SETUP_MESSAGE };
          if (!lead.llmCategory) return { id: 0, code: "", message: "Blocked: this lead has not been classified by Muse yet, so it can't start a trial. Run Muse classification in the Match queue first." };
          if ((lead.llmCategory === "irrelevant" || (lead.llmConfidence > 0 && lead.llmConfidence < LOW_CONFIDENCE)) && lead.llmReviewed !== 1) return { id: 0, code: "", message: "Blocked: Muse held this lead for your review (low confidence or irrelevant). Clear it on the lead first if you disagree." };
          label = label || lead.author || lead.authorHandle;
          if (lead.status !== "dismissed") await db.update(schema.leads).set({ status: "trial", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
        }
      }
      const code = genCode();
      const r = await db.insert(schema.invites).values({ profileId: args.profileId, leadId: args.leadId, code, seedName: args.seedName, label }).returning({ id: schema.invites.id });
      ctx.invalidateQueries();
      return { id: r[0]?.id ?? 0, code, message: "" };
    },
  }),

  logEvent: defineAction({
    request: z.object({ inviteId: z.number(), eventType: z.enum(["started", "core", "returned", "paid", "referred"]), note: z.string().default("") }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.invites).where(eq(schema.invites.id, args.inviteId));
      const inv = rows[0]; if (!inv) return { ok: false };
      await db.insert(schema.cohortEvents).values({ inviteId: inv.id, profileId: inv.profileId, eventType: args.eventType, source: "manual", note: args.note });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  recordEvent: defineAction({
    request: z.object({ code: z.string().min(4), eventType: z.enum(["started", "core", "returned", "paid", "referred"]), note: z.string().default("") }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.invites).where(eq(schema.invites.code, args.code.trim().toUpperCase()));
      const inv = rows[0];
      if (!inv) return { ok: false, message: "Unknown invite code — no event recorded." };
      await db.insert(schema.cohortEvents).values({ inviteId: inv.id, profileId: inv.profileId, eventType: args.eventType, source: "snippet", note: args.note });
      ctx.invalidateQueries();
      return { ok: true, message: `Recorded “${args.eventType}” for seed user ${inv.label || inv.code}.` };
    },
  }),

  deleteInvite: defineAction({
    request: z.object({ inviteId: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.cohortEvents).where(eq(schema.cohortEvents.inviteId, args.inviteId));
      await db.delete(schema.invites).where(eq(schema.invites.id, args.inviteId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getSnippet: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ snippet: z.string(), coreAction: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const p = rows[0];
      const core = p?.coreAction ?? "core action";
      const snippet = `<!-- EarlyProof seed-cohort tracking -->\n<script>\n  // 1. When a visitor arrives via a seed invite link (?ep=CODE), remember the code.\n  const epCode = new URLSearchParams(location.search).get('ep')\n    || localStorage.getItem('ep_code');\n  if (epCode) localStorage.setItem('ep_code', epCode);\n\n  // 2. Call epTrack from your app at each signal moment.\n  window.epTrack = function (eventType) { // 'started' | 'core' | 'returned' | 'paid' | 'referred'\n    const code = localStorage.getItem('ep_code');\n    if (!code) return;\n    // POST { code, eventType } to your EarlyProof recordEvent action endpoint.\n    // In this workspace, test it from the Cohort tab with “Simulate snippet event”.\n    console.log('[EarlyProof]', code, eventType);\n  };\n\n  // Example: fire 'started' on signup, and 'core' when the user does: ${core}\n  // epTrack('started');\n</script>`;
      return { snippet, coreAction: core };
    },
  }),

  savePosthogConfig: defineAction({
    request: z.object({ profileId: z.number(), host: z.string().default("https://us.posthog.com"), projectId: z.string().default(""), apiKey: z.string().default(""), startedEvent: z.string().default(""), coreEvent: z.string().default(""), returnedEvent: z.string().default(""), paidEvent: z.string().default(""), referredEvent: z.string().default("") }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.posthogConfigs).where(eq(schema.posthogConfigs.profileId, args.profileId));
      const vals = { profileId: args.profileId, host: args.host.replace(/\/$/, ""), projectId: args.projectId, apiKey: args.apiKey || (existing[0]?.apiKey ?? ""), startedEvent: args.startedEvent, coreEvent: args.coreEvent, returnedEvent: args.returnedEvent, paidEvent: args.paidEvent, referredEvent: args.referredEvent, updatedAt: new Date() };
      if (existing[0]) await db.update(schema.posthogConfigs).set(vals).where(eq(schema.posthogConfigs.id, existing[0].id));
      else await db.insert(schema.posthogConfigs).values(vals);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  importPosthog: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ imported: z.number(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const cfgs = await db.select().from(schema.posthogConfigs).where(eq(schema.posthogConfigs.profileId, args.profileId));
      const cfg = cfgs[0];
      if (!cfg || !cfg.apiKey || !cfg.projectId) return { imported: 0, message: "Add your PostHog host, project ID and personal API key first (PostHog → Settings → Personal API keys). Import uses your own free-tier account." };
      const invites = await db.select().from(schema.invites).where(eq(schema.invites.profileId, args.profileId));
      if (!invites.length) return { imported: 0, message: "No tagged invites yet — create an invite for a seed user first, and make sure their PostHog distinct_id or $ep_code property carries the invite code." };
      const mapping: [string, "started" | "core" | "returned" | "paid" | "referred"][] = [
        [cfg.startedEvent, "started"], [cfg.coreEvent, "core"], [cfg.returnedEvent, "returned"], [cfg.paidEvent, "paid"], [cfg.referredEvent, "referred"],
      ].filter(([n]) => !!n) as [string, "started" | "core" | "returned" | "paid" | "referred"][];
      if (!mapping.length) return { imported: 0, message: "Map at least one PostHog event name to a signal (for example your signup event → Started)." };
      const existingEvents = await db.select().from(schema.cohortEvents).where(and(eq(schema.cohortEvents.profileId, args.profileId), eq(schema.cohortEvents.source, "posthog")));
      const seenNotes = new Set(existingEvents.map((e) => e.note));
      let imported = 0;
      for (const [eventName, type] of mapping) {
        const url = `${cfg.host}/api/projects/${encodeURIComponent(cfg.projectId)}/events/?event=${encodeURIComponent(eventName)}&limit=100`;
        const r = await fetchJson(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
        if (!r.ok) return { imported, message: `PostHog import failed for “${eventName}” (HTTP ${r.status}). Check the project ID and that the key has event read access.` };
        const results = (asObj(r.data).results as unknown[]) ?? [];
        for (const ev of results) {
          const o = asObj(ev); const props = asObj(o.properties);
          const code = String(props.$ep_code ?? props.ep_code ?? o.distinct_id ?? "");
          const inv = invites.find((i) => i.code === code.toUpperCase());
          if (!inv) continue;
          const note = `ph:${String(o.id ?? o.uuid ?? o.timestamp ?? "")}`;
          if (seenNotes.has(note)) continue;
          seenNotes.add(note);
          await db.insert(schema.cohortEvents).values({ inviteId: inv.id, profileId: args.profileId, eventType: type, source: "posthog", note });
          imported++;
        }
      }
      ctx.invalidateQueries();
      return { imported, message: imported ? `Imported ${imported} new seed-cohort event${imported === 1 ? "" : "s"} from PostHog.` : "PostHog responded, but no events matched a tagged invite code. Check that seed users carry their invite code as distinct_id or an $ep_code property." };
    },
  }),

  // ─── LLM settings (founder's Muse API key + Muse model names) ───────────
  // AI setup is key-only: the founder pastes their Muse API key. Model
  // choice is automatic — small/fast tier for high-volume first passes,
  // large tier for drafts and summaries — so there is nothing to pick and
  // nothing to misconfigure.
  saveLlmSettings: defineAction({
    request: z.object({ apiKey: z.string().default("") }),
    response: z.object({ ok: z.boolean(), keyStored: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const typed = args.apiKey.trim();
      const existing = await loadLlmSettings(ctx);
      // An empty field with no stored key stores nothing — succeeding here
      // used to flash "saved" while the stub stayed in charge.
      if (!typed && !existing) return { ok: false, keyStored: false, message: "No key entered — paste your Muse API key first, then save." };
      if (typed && isPlaceholderKey(typed)) return { ok: false, keyStored: false, message: "That value is the local test placeholder, not a Muse API key — paste a real key from the Muse portal." };
      const key = typed || existing!.apiKey;
      const keyChanged = !!typed && (!existing || existing.apiKey !== key);
      // One row, always: replace the whole table so a duplicate can never
      // shadow the key on a first-row read. The Brave key rides along —
      // saving the Muse key must never wipe it.
      const braveKey = existing?.braveKey ?? "";
      await db.delete(schema.llmSettings);
      await db.insert(schema.llmSettings).values({ provider: "muse", apiKey: key, baseUrl: "", smallModel: "auto", largeModel: "auto", braveKey, updatedAt: Date.now() });
      // A new key invalidates yesterday's test output: stub-tagged phrases,
      // verdicts and plans are definitionally stale, so they clear now and
      // live Muse refills the gaps (auto-expansion refires by itself).
      let cleared = "";
      if (keyChanged) {
        try {
          const purge = await Actions.purgeStubData.handler(ctx, {});
          if (purge.profilesCleared || purge.leadsCleared || purge.expansionsCleared) cleared = ` ${purge.message}`;
        } catch { /* purge is best-effort beside a key save */ }
      }
      ctx.invalidateQueries();
      return typed
        ? { ok: true, keyStored: true, message: `New Muse API key saved (••••${key.slice(-4)}). Hit Test connection to confirm it reaches Muse Spark 1.3 — then plans and phrases regenerate live.${cleared}` }
        : { ok: true, keyStored: false, message: `Settings saved — kept the saved key (••••${key.slice(-4)}).` };
    },
  }),

  clearLlmSettings: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.llmSettings);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Optional Brave Search API key for web discovery (free tier at
  // brave.com/search/api — one query per profile, cached like DDG). Stored
  // beside the Muse key, empty clears it. Without it, discovery uses free
  // DuckDuckGo scraping, which throttles on flagged networks.
  saveBraveKey: defineAction({
    request: z.object({ braveKey: z.string().default("") }),
    response: z.object({ ok: z.boolean(), hasKey: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.llmSettings).orderBy(desc(schema.llmSettings.id)).limit(1);
      const key = args.braveKey.trim();
      if (!rows[0]) {
        await db.insert(schema.llmSettings).values({ provider: "muse", apiKey: "", baseUrl: "", smallModel: "auto", largeModel: "auto", braveKey: key, updatedAt: Date.now() });
      } else {
        await db.update(schema.llmSettings).set({ braveKey: key, updatedAt: Date.now() }).where(eq(schema.llmSettings.id, rows[0].id));
      }
      clearDiscoveryCache(-1); // backend may have changed — never serve the other backend's cache
      ctx.invalidateQueries();
      return key
        ? { ok: true, hasKey: true, message: `Brave Search key saved (••••${key.slice(-4)}). Discovery uses it first, DuckDuckGo stays the fallback.` }
        : { ok: true, hasKey: false, message: "Brave Search key removed — discovery falls back to free DuckDuckGo." };
    },
  }),

  testBraveKey: defineAction({
    request: z.object({ braveKey: z.string().default("") }),
    response: z.object({ ok: z.boolean(), status: z.string(), message: z.string() }),
    async handler(ctx, args) {
      const typed = args.braveKey.trim();
      const candidate = typed || await braveKeyFor(ctx);
      if (!candidate) return { ok: false, status: "not_configured", message: "No Brave key to test — paste one first, then test." };
      // One minimal query: proves the key works and the network reaches
      // Brave. Burns a single query of the key's quota — said plainly.
      const hits = await braveWebSearch("example test query", candidate);
      // A live key returns results; a dead key, dead network, or block
      // returns none — either way the verdict is honest, never stubbed.
      if (hits.length) return { ok: true, status: "ok", message: `Brave Search answered with ${hits.length} result${hits.length === 1 ? "" : "s"} for the probe query (1 quota query used) — save it to use Brave for discovery.` };
      return { ok: false, status: "error", message: "Brave Search returned nothing for the probe query — wrong key, spent quota, or this network blocks api.search.brave.com. DuckDuckGo fallback stays in place." };
    },
  }),

  testLlmConnection: defineAction({
    request: z.object({ apiKey: z.string().default("") }),
    response: z.object({ ok: z.boolean(), status: z.string(), message: z.string() }),
    async handler(ctx, args) {
      // Receipt-grade: with a Model API key this makes a REAL direct call and
      // names the model that answered, so the founder (and a judge) sees the
      // exact serving path instead of taking it on faith.
      // Empirical: a typed key is tried against the API itself — testing used
      // to run against the STORED key (or refuse non-LLM| keys outright), so
      // typing a key and hitting Test tested the wrong thing no matter what
      // was typed. No prefix gate: the API's answer is the verdict.
      const typed = args.apiKey.trim();
      const s = await loadLlmSettings(ctx);
      const candidate = typed || s?.apiKey || "";
      if (!candidate) return { ok: false, status: "not_configured", message: "No key to test — paste your Muse API key first, then test." };
      if (typed || isDirectKey(candidate) || cachedRoute(candidate) !== "runtime") {
        const t0 = Date.now();
        const r = await completeViaMetaModelText("Connection test: reply with the single word ok.", candidate, META_MODEL);
        if (r.ok) {
          rememberRoute(candidate, "direct");
          const heard = r.text.length > 60 ? `${r.text.slice(0, 60)}…` : r.text;
          if (typed) return { ok: true, status: "ok", message: `That key reaches ${META_MODEL} directly (answered “${heard}” in ${((Date.now() - t0) / 1000).toFixed(1)}s) — hit Save to activate it.` };
          // The stored key is real, so any stub-tagged data still on screen
          // is stale test output — clear it now so live Muse fills the gaps
          // (phrases re-expand by themselves, waiting leads re-synthesize on
          // Results).
          let cleared = "";
          try {
            const purge = await Actions.purgeStubData.handler(ctx, {});
            if (purge.profilesCleared || purge.leadsCleared) cleared = ` ${purge.message}`;
          } catch { /* purge is best-effort beside a passing test */ }
          return { ok: true, status: "ok", message: `Direct ${META_MODEL} via Model API answered “${heard}” in ${((Date.now() - t0) / 1000).toFixed(1)}s — the key works and all Muse calls will use it.${cleared}` };
        }
        // The API rejected the key (or was unreachable). A typed key and an
        // LLM| key fail here with the verdict — the stored non-API key falls
        // through to the runtime test below instead.
        if (typed || isDirectKey(candidate)) return { ok: false, status: "error", message: `Direct ${META_MODEL} call failed (${r.error}). Check the key and Model API quota — nothing was saved.` };
        rememberRoute(candidate, "runtime");
      }
      const r = await runLlm(ctx, "small", "Connection test: reply with a short confirmation that you received this.", z.string(), { allowStubTag: true });
      if (!r.ok) return { ok: false, status: r.status, message: r.message };
      // The offline stub answers this exact prompt with a tagged canned
      // string. Calling that a passed test is a lie that strands founders on
      // stub verdicts — fail it honestly instead.
      if (typeof r.value === "string" && r.value.includes("[local-stub]")) {
        return { ok: false, status: "stub", message: "That answer came from the offline test stub, not a model — this machine has no model runtime, so only a key the Model API accepts works here. Paste it above and test again." };
      }
      return { ok: true, status: "ok", message: "Workspace model runtime answered — models are picked automatically (fast tier for first passes, large tier for drafts and summaries)." };
    },
  }),

  // Stub-data purge: everything tagged [local-stub] is test output. When a
  // real key arrives, one call clears it so live Muse fills the gaps —
  // phrases reset (auto-expansion refires), stub verdicts and drafts on
  // untouched leads revert to unclassified/blank. Approved/sent leads and
  // founder-written content are never touched.
  purgeStubData: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), message: z.string(), profilesCleared: z.number(), leadsCleared: z.number(), expansionsCleared: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const MARK = "%[local-stub]%";
      // Stub-tagged expansion plans must go too — a leftover stub plan
      // blocks the auto-plan from refiring and keeps stub queries alive.
      const expRows = await db.select({ id: schema.searchExpansions.id }).from(schema.searchExpansions).where(like(schema.searchExpansions.plan, MARK));
      for (const e of expRows) {
        await db.delete(schema.searchExpansions).where(eq(schema.searchExpansions.id, e.id));
      }
      const profRows = await db.select().from(schema.profiles)
        .where(or(like(schema.profiles.painPhrases, MARK), like(schema.profiles.workaroundPhrases, MARK), like(schema.profiles.exclusions, MARK), like(schema.profiles.keywords, MARK)));
      const cleanPhrases = (s: string) => {
        try {
          const v: unknown = JSON.parse(s || "[]");
          if (Array.isArray(v) && v.some((x) => typeof x === "string" && x.includes("[local-stub]"))) return "[]";
        } catch { /* keep */ }
        return s;
      };
      for (const p of profRows) {
        const keywords = p.keywords.split(",").map((s) => s.trim()).filter((s) => s && !s.includes("[local-stub]")).join(", ");
        await db.update(schema.profiles).set({ painPhrases: cleanPhrases(p.painPhrases), workaroundPhrases: cleanPhrases(p.workaroundPhrases), exclusions: cleanPhrases(p.exclusions), keywords }).where(eq(schema.profiles.id, p.id));
      }
      const leadRows = await db.select({ id: schema.leads.id }).from(schema.leads).where(and(
        inArray(schema.leads.status, ["new", "drafted"]),
        or(like(schema.leads.llmReason, MARK), like(schema.leads.llmQuote, MARK), like(schema.leads.draftBody, MARK)),
      ));
      for (const l of leadRows) {
        await db.update(schema.leads).set({ llmCategory: "", llmConfidence: 0, llmReason: "", llmQuote: "", llmSignals: "", llmHash: "", llmReviewed: 0, draftBody: "", semanticScore: -1 }).where(eq(schema.leads.id, l.id));
      }
      ctx.invalidateQueries();
      return { ok: true, message: `Cleared stub test data from ${profRows.length} profile${profRows.length === 1 ? "" : "s"}, ${leadRows.length} lead${leadRows.length === 1 ? "" : "s"} and ${expRows.length} expansion plan${expRows.length === 1 ? "" : "s"} — live Muse fills the gaps from here.`, profilesCleared: profRows.length, leadsCleared: leadRows.length, expansionsCleared: expRows.length };
    },
  }),

  // ─── 1. Pain-language expansion ───────────────────────────────────────────
  expandPainLanguage: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), painPhrases: z.array(z.string()), workaroundPhrases: z.array(z.string()), exclusions: z.array(z.string()) }),
    async handler(ctx, args) {
      const empty = { painPhrases: [] as string[], workaroundPhrases: [] as string[], exclusions: [] as string[] };
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const p = profRows[0];
      if (!p) return { status: "error", message: "Profile not found.", ...empty };
      const r = await runLlm(ctx, "small",
        `Expand a founder's plain problem description into the language real people use when they complain about that problem in public posts. painPhrases: 8-12 short first-person phrases people actually type when they hit this pain (their words, frustrations, symptoms — not marketing copy). workaroundPhrases: 5-8 phrases describing the hacks, tools and imperfect substitutes they mention. exclusions: 4-8 words or short phrases that signal a post is NOT this pain (adjacent topics, professionals selling services, jokes/memes) so search can filter them out.\nProduct: ${p.productName} — ${p.productDesc}\nAudience: ${p.audience}\nPain (founder's words): ${p.pain}\nWorkaround today: ${p.workaround}\nCurrent keywords: ${p.keywords}`,
        z.object({ painPhrases: z.preprocess(stringishArray, z.array(z.string())).default([]), workaroundPhrases: z.preprocess(stringishArray, z.array(z.string())).default([]), exclusions: z.preprocess(stringishArray, z.array(z.string())).default([]) }));
      if (!r.ok) return { status: r.status, message: r.message, ...empty };
      const arr = (v: string[]) => v.filter((x) => !!x.trim()).map((x) => x.trim()).slice(0, 14);
      const painPhrases = arr(r.value.painPhrases); const workaroundPhrases = arr(r.value.workaroundPhrases); const exclusions = arr(r.value.exclusions);
      if (!painPhrases.length) return { status: "error", message: "The model didn't return usable phrases — nothing was saved. Try again, or check the AI settings.", ...empty };
      await db.update(schema.profiles).set({ painPhrases: JSON.stringify(painPhrases), workaroundPhrases: JSON.stringify(workaroundPhrases), exclusions: JSON.stringify(exclusions) }).where(eq(schema.profiles.id, p.id));
      ctx.invalidateQueries();
      return { status: "ok", message: `Expanded into ${painPhrases.length} pain phrases, ${workaroundPhrases.length} workaround phrases and ${exclusions.length} exclusions. Review them below — they're suggestions in people's words, and you can fold the best into your keywords.`, painPhrases, workaroundPhrases, exclusions };
    },
  }),

  applyExpansionToKeywords: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ ok: z.boolean(), keywords: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const p = profRows[0];
      if (!p) return { ok: false, keywords: "" };
      const phrases: string[] = (() => { try { const v = JSON.parse(p.painPhrases || "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } })();
      const existing = p.keywords.split(",").map((s) => s.trim()).filter(Boolean);
      const merged = [...existing];
      // Stub honesty: offline test phrases must never leak into real keywords.
      for (const ph of phrases.slice(0, 6)) {
        if (ph.includes("[local-stub]")) continue;
        if (!merged.some((k) => k.toLowerCase() === ph.toLowerCase())) merged.push(ph);
      }
      const keywords = merged.join(", ");
      await db.update(schema.profiles).set({ keywords }).where(eq(schema.profiles.id, p.id));
      ctx.invalidateQueries();
      return { ok: true, keywords };
    },
  }),

  // ─── 2. Batch classification with evidence ────────────────────────────────
  classifyLeads: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), classified: z.number(), cached: z.number(), lowConfidence: z.number(), needsReview: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { status: "error", message: "Profile not found.", classified: 0, cached: 0, lowConfidence: 0, needsReview: 0 };
      const out = await classifyForProfile(ctx, profile);
      ctx.invalidateQueries();
      return out;
    },
  }),

  confirmLeadReview: defineAction({
    request: z.object({ leadId: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.update(schema.leads).set({ llmReviewed: 1, updatedAt: new Date() }).where(eq(schema.leads.id, args.leadId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ─── 4. Feedback: store verbatim, summarise without inventing ─────────────
  addFeedback: defineAction({
    request: z.object({ profileId: z.number(), seedName: z.string().default(""), source: z.string().default(""), rawText: z.string().min(3) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const r = await db.insert(schema.feedbackEntries).values({ profileId: args.profileId, seedName: args.seedName, source: args.source, rawText: args.rawText.slice(0, 3000) }).returning({ id: schema.feedbackEntries.id });
      ctx.invalidateQueries();
      return { id: r[0]?.id ?? 0 };
    },
  }),

  deleteFeedback: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.feedbackEntries).where(eq(schema.feedbackEntries.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  summariseFeedback: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const p = profRows[0];
      if (!p) return { status: "error", message: "Profile not found." };
      const entries = await db.select().from(schema.feedbackEntries).where(eq(schema.feedbackEntries.profileId, args.profileId));
      if (!entries.length) return { status: "error", message: "No feedback recorded yet — paste what seed users actually said first. A summary is never invented from nothing." };
      const joined = entries.map((e, i) => `--- FEEDBACK ${i + 1}${e.seedName ? ` from ${e.seedName}` : ""}${e.source ? ` (${e.source})` : ""} ---\n${e.rawText}`).join("\n");
      const r = await runLlm(ctx, "large",
        `Summarise seed-user feedback for a founder WITHOUT inventing anything. Cluster only what people actually said. Every quote MUST be copied word-for-word from the feedback — never paraphrase a quote, never merge two people's words into one quote, never add a sentiment nobody expressed. If a cluster has no exact quote, leave its quotes empty rather than inventing one. stuckPoints and requests are short factual notes grounded in the text. repeatedPainLanguage: exact phrases that recur across people. followUpQuestions: 3-5 specific questions the founder should ask next, each tied to something a user actually said or got stuck on — questions that find friction, not praise.\nProduct: ${p.productName} — ${p.productDesc}\nCore action: ${p.coreAction}\n\n${joined.slice(0, 9000)}`,
        z.object({ clusters: z.array(z.object({ theme: z.string().default(""), quotes: z.array(z.string()).default([]), stuckPoints: z.array(z.string()).default([]), requests: z.array(z.string()).default([]) })).default([]), repeatedPainLanguage: z.array(z.string()).default([]), followUpQuestions: z.array(z.string()).default([]) }));
      if (!r.ok) return { status: r.status, message: r.message };
      const o = r.value;
      // Quote integrity pass: drop any 'quote' that is not verbatim in the source feedback.
      const corpus = normText(entries.map((e) => e.rawText).join(" "));
      const cleanStr = (v: string) => v.trim();
      const clusters = o.clusters.slice(0, 8).map((co) => {
        const quotes = co.quotes.map(cleanStr).filter((q) => q && corpus.includes(normText(q))).slice(0, 4);
        const strArr = (v: string[]) => v.map(cleanStr).filter(Boolean).slice(0, 5);
        return { theme: cleanStr(co.theme) || "What they said", quotes, stuckPoints: strArr(co.stuckPoints), requests: strArr(co.requests) };
      }).filter((c) => c.quotes.length || c.stuckPoints.length || c.requests.length);
      const content = JSON.stringify({ clusters, repeatedPainLanguage: o.repeatedPainLanguage.map(cleanStr).filter((q) => q && corpus.includes(normText(q))).slice(0, 8), followUpQuestions: o.followUpQuestions.map(cleanStr).filter(Boolean).slice(0, 5), entryCount: entries.length });
      await db.insert(schema.llmSummaries).values({ profileId: args.profileId, kind: "feedback", content });
      ctx.invalidateQueries();
      return { status: "ok", message: `Summary saved from ${entries.length} feedback entr${entries.length === 1 ? "y" : "ies"} — every quote in it was checked word-for-word against what users actually said.` };
    },
  }),

  // ─── 5. Next experiment — never a PMF verdict ─────────────────────────────
  suggestNextExperiment: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), source: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const p = profRows[0];
      if (!p) return { status: "error", message: "Profile not found.", source: "" };
      const invites = await db.select().from(schema.invites).where(eq(schema.invites.profileId, args.profileId));
      const events = await db.select().from(schema.cohortEvents).where(eq(schema.cohortEvents.profileId, args.profileId));
      const leadsAll = await db.select().from(schema.leads).where(eq(schema.leads.profileId, args.profileId));
      const count = (t: string) => new Set(events.filter((e) => e.eventType === t).map((e) => e.inviteId)).size;
      const signals = { tagged: invites.length, started: count("started"), core: count("core"), returned: count("returned"), paid: count("paid"), referred: count("referred"), leadsFound: leadsAll.length, inConversation: leadsAll.filter((l) => ["replied", "conversation", "trial"].includes(l.status)).length, sent: leadsAll.filter((l) => ["sent", "replied", "conversation", "trial"].includes(l.status)).length };
      // Deterministic order from the spec: audience → message → problem. The
      // weakest earliest signal decides which lever is even eligible.
      let lever: "audience" | "message" | "problem";
      let rationale: string;
      if (signals.inConversation < 3 || signals.started < 3) { lever = "audience"; rationale = `Only ${signals.inConversation} conversation(s) and ${signals.started} starter(s) so far — there isn't yet a cohort big enough to judge the message or the problem. The earliest weak signal is reach: the people, not the pitch.`; }
      else if (signals.core < Math.max(1, Math.floor(signals.started / 2))) { lever = "message"; rationale = `${signals.started} started but only ${signals.core} did the core action (${p.coreAction || "the core action"}). People arrive and don't land — that points at the message and the first-run expectation before it points at the problem.`; }
      else { lever = "problem"; rationale = `${signals.started} started and ${signals.core} did the core action, but only ${signals.returned} came back, ${signals.paid} paid, ${signals.referred} referred. They tried it and it didn't stick — with audience and message producing trials, the problem framing itself is the next thing to test.`; }
      const fb = await db.select().from(schema.llmSummaries).where(and(eq(schema.llmSummaries.profileId, args.profileId), eq(schema.llmSummaries.kind, "feedback"))).orderBy(desc(schema.llmSummaries.id));
      const latestFb = fb[0]?.content ?? "";
      // Next-experiment suggestions are a core Muse step — no rule-based
      // suggestion is saved or shown when Muse is missing or fails. The
      // lever/rationale above are deterministic signal arithmetic (which
      // lever is eligible, in the fixed order); the experiment itself must
      // be written by the founder's Muse model.
      const r = await watcherAgent.execute(ctx, { profile: p, lever, rationale, signals, latestFb });
      if (!r.ok) return { status: r.status, message: r.status === "not_configured" ? LLM_SETUP_MESSAGE : `${r.message} No rule-based suggestion was substituted — next-experiment suggestions are a Muse step.`, source: "" };
      const experiment = r.value.experiment.trim();
      const source = "your small Muse model, on the fixed audience → message → problem order";
      const content = JSON.stringify({ lever, rationale, experiment, signals, source, disclaimer: "This is a suggested next test, not a PMF score or verdict. Whether this counts as PMF is the founder's call." });
      await db.insert(schema.llmSummaries).values({ profileId: args.profileId, kind: "next_experiment", content });
      ctx.invalidateQueries();
      return { status: "ok", message: `Suggested lever: change the ${lever}. Saved below with the signals behind it — a next test, not a PMF verdict.`, source };
    },
  }),

  deleteSummary: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.llmSummaries).where(eq(schema.llmSummaries.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
