import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq, and } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { META_MODEL, completeViaMetaModel, isDirectKey } from "./meta-api";
import * as schema from "./schema";

type Db = BunSQLiteDatabase<typeof schema>;

const UA = "EarlyProof/1.0 (founder-approved seed outreach)";
// App version shown on the page so a founder always knows which build they
// are testing. Keep in sync with package.json.
const PKG_VERSION = "0.2.0";

// ─── FirstFeedback Hacker News retune (2026-10-29) ─────────────────────────
// For the FirstFeedback profile ONLY, Hacker News is an Ask HN help-request
// channel, not a general story search. The previous live runs were dominated
// by Show HN showcases (new tools announcing themselves), which Muse
// correctly classified irrelevant — the pain lives in Ask HN threads where a
// solo developer asks for help getting first users. Rules for this profile:
//   • HN queries are the help-request phrases below (plus the founder's
//     original pain phrases), never the generic expansion queries.
//   • Only a story whose TITLE starts with "Ask HN" is a candidate.
//     "Show HN" titles — and every other title — are excluded before the
//     pre-filter, so they never count as found/discarded candidates.
//   • Retrieval uses Algolia's `ask_hn` tag + relevance ranking (both
//     verified live 2026-10-29: tags=ask_hn returns Ask HN stories, and
//     relevance surfaces the actual help posts that search_by_date buried
//     under newer Show HN posts), AND the title-prefix check runs
//     server-side as the authoritative gate — an ask_hn-tagged story whose
//     title does not start with "Ask HN" is still excluded.
// Other profiles and other channels (Bluesky, GitHub) are untouched.
const FIRSTFEEDBACK_HN_HELP_QUERIES = [
  "how did you get your first users",
  "launched to crickets",
  "no traction",
  "no response",
  "validate demand for my side project",
  "need feedback on my project",
  "I launched my app and got zero users",
  "I don't know where to find my first users",
  "I posted it everywhere and still got no traction",
];
function isFirstFeedbackProfile(profile: ProfileLike): boolean {
  return normText(profile.productName) === "firstfeedback";
}
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
    community: l.community, postedAt: l.postedAt, matchScore: l.matchScore, matchReason: l.matchReason,
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
const WEAK_ANCHOR_TOKENS = new Set(["first","real","get","gets","got","getting","find","finding","found","know","knows","something","anything","almost","just","like","even","still","much","many","made","way","one","two","help","helps","need","needs","want","wants","try","trying","work","works","working","using","used","new","good","bad","better","best","thing","things","side","honest","people","person","don","doesn","didn","isn","aren","wasn","won","wouldn","couldn","shouldn","haven","hasn","can","cant"]);
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

// Domain clusters: when a profile is about a topic, a post only counts if the
// post ITSELF contains a real term from that topic — a generic word like
// "skill" or "sucks" is not enough. The matched term is named in the reason.
type DomainCluster = { id: string; label: string; triggers: string[]; terms: string[] };
const DOMAIN_CLUSTERS: DomainCluster[] = [
  {
    id: "makeup", label: "makeup",
    triggers: ["makeup", "cosmetics", "cosmetic", "eyeliner", "foundation", "mascara", "beauty routine"],
    terms: ["makeup", "cosmetics", "cosmetic", "foundation", "eyeliner", "eye liner", "mascara", "lipstick", "lip stick", "blush", "concealer", "eyeshadow", "eye shadow", "bronzer", "highlighter", "contour", "contouring", "primer", "setting spray", "setting powder", "brow pencil", "eyebrow pencil", "beauty blender", "makeup routine", "makeup tutorial"],
  },
];

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

function normText(s: string): string {
  // Unify make-up / make up / makeup so the phrase and the terms compare cleanly.
  return s.toLowerCase().replace(/make[-\s]?up/g, " makeup ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
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

type ProfileLike = { productName: string; productDesc: string; audience: string; pain: string; workaround: string; keywords: string; coreAction: string };
type Relevance = { score: number; reason: string; keep: boolean; matchedTerms: string[]; exactPhrase: string; contextPhrase: string; anchorHits: string[]; anchorPresent: boolean; painSignals: string[]; workaroundSignal: string };

function keywordPhrases(profile: ProfileLike): string[] {
  const fromKw = profile.keywords.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromKw.length) return fromKw;
  const p = profile.pain.trim();
  return p ? [p] : [];
}
function activeClusters(profile: ProfileLike): DomainCluster[] {
  const all = normText([profile.productName, profile.productDesc, profile.audience, profile.pain, profile.workaround, profile.keywords, profile.coreAction].join(" "));
  return DOMAIN_CLUSTERS.filter((c) => c.triggers.some((t) => containsTerm(all, normText(t))));
}
// The query sent to a channel's search API: for a clustered (e.g. makeup)
// profile that is the topic term itself, never an OR of the keyword's words.
function searchQueryFor(profile: ProfileLike): string {
  const clusters = activeClusters(profile);
  const first = clusters[0];
  if (first) return first.terms[0] ?? first.label;
  const phrases = keywordPhrases(profile);
  return phrases[0] ?? profile.pain.split(/\s+/).filter((w) => w.length > 4).slice(0, 3).join(" ");
}

// Domain anchor tokens for a NON-clustered profile, derived from the
// founder's own profile text — keywords first (the strongest signal), then
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

export function analyseText(rawText: string, profile: ProfileLike, channel?: string): Relevance {
  const text = normText(rawText);
  const clusters = activeClusters(profile);
  const cluster = clusters[0];
  let score = 0;
  const parts: string[] = [];

  // 1. Domain anchor in the post itself — the safety net's hard requirement.
  // Clustered profile: a real term from the cluster (makeup, foundation…).
  // Other profiles: a strong keyword anchor, the "show hn" phrase anchor,
  // or two secondary anchors from the audience/pain text.
  const matchedTerms: string[] = [];
  if (cluster) {
    const seenNorm = new Set<string>();
    for (const term of cluster.terms) {
      const nt = normText(term);
      if (seenNorm.has(nt)) continue;
      if (containsTerm(text, nt)) { matchedTerms.push(term); seenNorm.add(nt); }
    }
    if (matchedTerms.length) {
      score += 38 + Math.min((matchedTerms.length - 1) * 6, 18);
      parts.push(`Matched ${cluster.label} term “${matchedTerms[0]}” in the post${matchedTerms.length > 1 ? ` (also ${matchedTerms.slice(1, 4).map((t) => `“${t}”`).join(", ")})` : ""}`);
    }
  }
  const tiers = cluster ? { strong: [] as string[], secondary: [] as string[] } : splitAnchorTiers(profile);
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
  const showHnHit = !cluster && showHnWanted && text.includes("show hn");
  // One surface word = one hit: kinship synonyms mean several terms can
  // match through the SAME word ("mom", "siblings", "children" all via
  // "child"). Counting each would inflate the score and print words the post
  // never contains — so hits sharing a surface form collapse to one, and the
  // reason names surface forms (what is really in the post).
  const surfaceOf = (t: string): string => (t === "show hn" ? t : (anchorVia.get(t) ?? normText(t)));
  const rawHits: string[] = cluster ? [...matchedTerms] : [...strongHits, ...(showHnHit ? ["show hn"] : []), ...secondaryHits];
  const seenSurface = new Set<string>();
  const anchorHits = rawHits.filter((t) => {
    const s = cluster ? normText(t) : surfaceOf(t);
    if (seenSurface.has(s)) return false;
    seenSurface.add(s);
    return true;
  });
  const strongSet = new Set(strongHits);
  const uniqStrong = anchorHits.filter((t) => strongSet.has(t)).length;
  const uniqSecondary = anchorHits.length - uniqStrong - (showHnHit && anchorHits.includes("show hn") ? 1 : 0);
  const anchorPresent = cluster
    ? matchedTerms.length > 0
    : uniqStrong > 0 || showHnHit || uniqSecondary >= 2;
  if (!cluster && anchorPresent && anchorHits.length) {
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
  for (const a of [...tiers.strong, ...matchedTerms.map((t) => normText(t))]) {
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
  if (exactPhrase) { score += cluster ? 28 : 24; parts.push(`matches your keyword phrase “${exactPhrase}” word for word`); }
  else if (contextPhrase) {
    score += cluster ? 16 : 18;
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
  const anchorTokenSet = new Set([...tiers.strong, ...tiers.secondary, ...(cluster?.terms ?? []).flatMap((t) => normText(t).split(" "))]);
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

  // Hacker News is a tech pool: for a consumer-topic (clustered) profile it
  // is deprioritised — the same post needs a stronger signal from HN. For a
  // developer-audience profile HN is the home pool, so no dock applies.
  if (channel === "hackernews" && cluster) score = Math.max(0, score - 8);

  score = Math.max(0, Math.min(97, score));
  // THE LIGHT GATE: domain anchor + at least one pain or workaround signal
  // (or an exact/context keyword match), over a low score floor. Anything
  // beyond that — is this really the right person with this pain? — is
  // Muse's call in synthesis, with evidence quote and confidence.
  const hasSignal = hasStrongPainSignal || !!workaroundSignal || !!exactPhrase || !!contextPhrase;
  const keep = anchorPresent && hasSignal && score >= MIN_SAVE_SCORE;
  const reason = parts.length
    ? parts.join("; ") + "."
    : cluster
      ? `No ${cluster.label} term in this post — generic words like “skill” or “sucks” don't count as a domain anchor.`
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
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.llmSettings);
  const s = rows[0];
  if (!s || !s.apiKey.trim()) return null;
  return s;
}
function llmConfigured(s: LlmSettingsRow | null): boolean {
  return !!s && !!s.apiKey.trim() && !!s.smallModel.trim() && !!s.largeModel.trim();
}
async function requireLlm(ctx: Ctx): Promise<LlmSettingsRow | null> {
  const s = await loadLlmSettings(ctx);
  return llmConfigured(s) ? s : null;
}
type LlmFail = { ok: false; status: "not_configured" | "error"; message: string };
// Runs one bounded Muse task through the workspace's Muse model runtime
// with a typed schema (the runtime validates the shape). The founder's
// configured Muse model name for the tier travels with the task.
async function runLlm<T>(ctx: Ctx, tier: "small" | "large", task: string, schema: z.ZodSchema<T>): Promise<{ ok: true; value: T } | LlmFail> {
  const s = await loadLlmSettings(ctx);
  if (!llmConfigured(s) || !s) return { ok: false, status: "not_configured", message: LLM_SETUP_MESSAGE };
  const model = (tier === "large" ? (s.largeModel || s.smallModel) : (s.smallModel || s.largeModel)).trim();
  if (!model) return { ok: false, status: "not_configured", message: `No ${tier === "large" ? "large" : "small/fast"} Muse model name set in the AI tab.` };
  // Direct path: a Model API key (LLM|…) calls Muse Spark 1.3 over HTTPS so
  // the pasted key is actually used. Any other key is served by the workspace
  // model runtime (the hosted artifact has no direct egress to assume).
  if (isDirectKey(s.apiKey)) {
    const r = await completeViaMetaModel(task, s.apiKey, META_MODEL);
    if (!r.ok) return { ok: false, status: "error", message: `Direct Muse Spark 1.3 call failed (${r.error}). Check the key and Model API quota — nothing was saved.` };
    try {
      return { ok: true, value: schema.parse(r.value) };
    } catch {
      return { ok: false, status: "error", message: "Direct Muse Spark 1.3 call returned an unexpected shape — nothing was saved." };
    }
  }
  try {
    const value = await ctx.inference.complete(
      `Configured Muse model for this task (${tier === "large" ? "large tier — quality matters more than speed" : "small/fast tier — high-volume first pass"}): ${model}\n\n${task}`,
      { schema },
    );
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

// ─── Step 4 synthesis: Muse classification of waiting leads ───────────────
// Shared by the classifyLeads action AND by searchLiveLeads, which runs this
// automatically at the end of every search (workflow Step 3 → Step 4) so the
// results a founder sees are always the synthesized, classified ones — never
// raw, unclassified keyword hits. Returns counts + a human message.
type ClassifyOutcome = { status: string; message: string; classified: number; cached: number; lowConfidence: number; needsReview: number };
async function classifyForProfile(ctx: Ctx, profile: typeof schema.profiles.$inferSelect): Promise<ClassifyOutcome> {
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
    const r = await runLlm(ctx, "small",
      `Classify candidate seed users for a founder. The light pre-filter already confirmed a domain anchor from the profile is present in the post, plus a pain or workaround signal (or the post was a top anchored candidate passed up for your judgement) — that filter is only a safety net, NOT a relevance verdict: your classification is the real gate, so judge strictly and mark anchor-only showcases, ads and jokes irrelevant with low confidence. Your job is the judgement keywords can't do. For EACH post, return one result with its post id and judge: rightPerson (is this the target audience, in the situation described?), realPain (did they describe this pain in their own words, as their own current problem?), workaroundOrPaying (are they already hacking a workaround or paying for something imperfect?), recent (does it read as current/recent, not an old or hypothetical story?). category is one of: seed_user (right person + real pain), curious (interested or adjacent but no clear own pain), irrelevant (wrong person, selling something, joke, or not this pain). confidence is 0-100 — be honest: ambiguous posts get low confidence. Show HN launch announcements and founder pitches are irrelevant unless the author personally asks for help with this pain in their own words — describing a market problem ("difficult for young investors", "high entry barrier") is not the author's own pain. Some candidates come from forum thread titles only (no post body) — judge on the title alone; prefer curious unless the title itself shows the person's own pain. The quote MUST be copied word-for-word from the post; if no phrase supports the pain, use an empty string and lower the confidence. reason: one short sentence grounded in the post. Never invent a quote. Only the public post text follows — no personal data beyond what the person posted.\nTarget profile — Audience: ${profile.audience}\nPain: ${profile.pain}\nWorkaround today: ${profile.workaround}\nProduct: ${profile.productName} — ${profile.productDesc}\n\n${items}`,
      z.object({ results: z.array(z.object({ id: z.number(), category: z.string(), confidence: z.number(), reason: z.string(), quote: z.string(), rightPerson: z.boolean(), realPain: z.boolean(), workaroundOrPaying: z.boolean(), recent: z.boolean() })) }));
    if (!r.ok) { return { status: r.status, message: `${r.message} (${classified} lead${classified === 1 ? "" : "s"} classified before this batch.)`, classified, cached, lowConfidence, needsReview }; }
    for (const o of r.value.results) {
      const lead = batch.find((l) => l.id === o.id);
      if (!lead) continue;
      const cat = ["seed_user", "curious", "irrelevant"].includes(o.category) ? o.category : "curious";
      const conf = Math.max(0, Math.min(100, Math.round(o.confidence || 0)));
      let quote = o.quote.trim();
      if (quote && !normText(`${lead.title} ${lead.body}`).includes(normText(quote))) quote = "";
      const signals = JSON.stringify({ rightPerson: o.rightPerson, realPain: o.realPain, workaroundOrPaying: o.workaroundOrPaying, recent: o.recent });
      await db.update(schema.leads).set({ llmCategory: cat, llmConfidence: conf, llmReason: o.reason.slice(0, 300), llmQuote: quote.slice(0, 300), llmSignals: signals, llmHash: llmHashFor(`${lead.title} ${lead.body}`, profile), llmReviewed: 0, updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
      classified++;
      if (conf < LOW_CONFIDENCE) lowConfidence++;
      if (conf < LOW_CONFIDENCE || cat === "irrelevant") needsReview++;
    }
  }
  const bits = [`${classified} classified by your small Muse model`, cached ? `${cached} reused from cache` : "", lowConfidence ? `${lowConfidence} low-confidence (under ${LOW_CONFIDENCE}%)` : "", needsReview ? `${needsReview} held for your review before any outreach` : ""].filter(Boolean).join(" · ");
  return { status: "ok", message: classified || cached ? `Done — ${bits}. Every verdict shows its evidence and quote on the lead. Only classified leads can move to drafts and outreach; the rule-based score underneath is a pre-filter only.` : "The model returned no usable verdicts — no lead was cleared for outreach. Try again.", classified, cached, lowConfidence, needsReview };
}

// ─── LLM search expansion (Step 3) ──────────────────────────────────────────
// Before and during search, Muse generates an expansion plan from the
// profile: query variants in the person's own language, related pain phrases
// and adjacent problems, related communities/places and which channel each
// maps to. HARD RULE: every expanded query must stay anchored to the
// profile's domain — for a clustered profile (e.g. makeup) the query must
// contain a real term from that cluster (makeup, foundation, eyeliner…);
// for other profiles it must contain the plan's anchor term, which itself
// must come from the profile text. Unanchored queries are dropped
// server-side and counted — generic words alone never become a query, so
// expansion can't bring back the old generic coding/Plex-type matches.
type ExpansionQuery = { query: string; intent: string };
type ExpansionCommunity = { name: string; where: string; channel: string; access: string; why: string };
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

// ─── Profile-aware channel recommendations ────────────────────────────────
// The app never defaults to the same channels for every product. Signals in
// the founder's own profile text vote channels up or down, Muse's expansion
// plan votes with the communities it maps, and per-profile mappings decide
// whether Stack Exchange or a sitemap forum earns a place at all.
const OPEN_SEARCH_CHANNELS = ["bluesky", "hackernews", "github", "stackexchange", "agingcare", "mumsnet"];
const DEV_SIGNALS = ["software", "developer", "developers", "programmer", "coding", "github", "api", "saas", "devtools", "open source", "pull request", "codebase", "deploy", "localhost", "npm", "startup", "indie hacker", "hacker news", "tech stack", "side project", "web app", "mobile app", "launch"];
const CAREER_SIGNALS = ["laid off", "layoff", "layoffs", "unemployed", "job search", "freelance", "freelancer", "side hustle", "passive income", "income", "career", "interview", "resume", "fired", "severance", "paycheck"];
const ISSUE_SIGNALS = ["bug", "bugs", "error", "errors", "broken", "issue", "issues", "crash", "exception"];
// Everyday-life topics whose biggest public conversations live on Reddit and
// general social — not on developer channels.
const LIFE_SIGNALS = ["parent", "parents", "baby", "kids", "pregnancy", "pregnant", "health", "patient", "caregiver", "dementia", "alzheimer", "medication", "meds", "wedding", "landlord", "tenant", "pet", "dog", "marriage", "divorce"];
const FAMILY_SIGNALS = ["parent", "parents", "baby", "kids", "pregnancy", "pregnant", "caregiver", "dementia", "marriage", "divorce"];
const MONEY_SIGNALS = ["income", "paycheck", "severance", "debt", "salary", "budget", "rent", "mortgage", "investing", "passive income"];

function countSignals(normHaystack: string, signals: string[]): number {
  let n = 0;
  for (const s of signals) if (containsTerm(normHaystack, normText(s))) n++;
  return n;
}

export type ChannelFit = "best" | "good" | "poor";
export type ChannelRec = { channel: string; fit: ChannelFit; reasons: string[]; needsConnection: boolean };

export function channelRecsFor(profile: ProfileLike, plan: ExpansionPlan | null): { recs: ChannelRec[] } {
  const hay = normText([profile.productName, profile.productDesc, profile.audience, profile.pain, profile.workaround, profile.keywords, profile.coreAction].join(" "));
  const cluster = activeClusters(profile)[0];
  const isDev = countSignals(hay, DEV_SIGNALS) >= 2;
  const isCareer = countSignals(hay, CAREER_SIGNALS) >= 2;
  const isLife = countSignals(hay, LIFE_SIGNALS) >= 2;
  const issueHits = countSignals(hay, ISSUE_SIGNALS);

  const scores = new Map<string, { score: number; reasons: string[] }>();
  const bump = (ch: string, delta: number, reason: string) => {
    const r = scores.get(ch) ?? { score: 0, reasons: [] as string[] };
    r.score += delta;
    if (reason && !r.reasons.includes(reason)) r.reasons.push(reason);
    scores.set(ch, r);
  };
  // Base: every open channel starts viable.
  for (const ch of OPEN_SEARCH_CHANNELS) bump(ch, 0, "Open channel — searchable with no connection.");
  // Muse's plan: each mapped community votes for its channel.
  if (plan) {
    for (const c of plan.communities) {
      if (!c.name || !c.channel) continue;
      const ch = c.channel.trim();
      bump(ch, c.access === "closed" ? 1 : 2, `Muse mapped “${c.name}” here${c.why ? ` — ${c.why}` : ""}`);
    }
  }
  // Profile shape adjustments. Developer channels need developer evidence:
  // GitHub issues are bug reports, and Hacker News is a tech conversation —
  // neither is where non-technical audiences report pain. A Muse expansion
  // plan can still upgrade a channel when it maps a real community there.
  if (cluster) {
    bump("hackernews", -2, `Your topic is ${cluster.label}, not tech — Ask HN-style threads rarely discuss it.`);
    bump("github", -2, `Your topic is ${cluster.label} — GitHub issues are the wrong pool.`);
  }
  if (isDev) {
    bump("hackernews", 2, "Developer audience — Hacker News is where they ask for help.");
    bump("github", issueHits > 0 ? 2 : 1, issueHits > 0 ? "Developers report this pain as GitHub issues." : "Developer audience — adjacent issue talk lives here.");
  } else {
    bump("github", -2, "GitHub issues are bug reports — your people don't report this pain there.");
    if (!isCareer && !cluster) bump("hackernews", -1, "Hacker News rarely discusses this topic — a long shot unless your plan maps a community there.");
  }
  if (isCareer) {
    bump("hackernews", 1, "Ask HN work threads exist for this kind of pain.");
    bump("bluesky", 1, "Work-life talk is common on Bluesky.");
    bump("reddit_poc", 1, "Career subreddits hold this conversation — needs your Reddit connection.");
  }
  if (isLife) {
    bump("bluesky", 1, "Everyday-life talk is common on Bluesky.");
    bump("reddit_poc", 1, "This conversation lives on Reddit most of all — needs your Reddit connection.");
  }
  // Stack Exchange earns its place per profile, never by default: people ask
  // exactly this kind of question on the mapped communities — or on none.
  const seSites = stackSitesFor(profile);
  if (seSites.length) bump("stackexchange", 2, `People ask exactly this kind of question on ${seSites.join(" + ")} — keyless search.`);
  else bump("stackexchange", -1, "No Stack Exchange community matches this topic — it would search blindly.");
  // Sitemap-indexed forums earn their place per profile like SE: real
  // threads match this topic — or no forum does.
  const smForums = sitemapForumsFor(profile);
  if (smForums.length) for (const f of smForums) bump(f.channel, 2, `Real threads on ${f.label} match this topic — keyless sitemap-title search, no connection needed.`);
  else { bump("agingcare", -1, "No sitemap-indexed forum matches this topic — it would search blindly."); bump("mumsnet", -1, "No sitemap-indexed forum matches this topic — it would search blindly."); }

  const rank: Record<ChannelFit, number> = { best: 0, good: 1, poor: 2 };
  const recs: ChannelRec[] = [...scores.entries()].map(([channel, r]) => ({
    channel,
    fit: (r.score >= 2 ? "best" : r.score < 0 ? "poor" : "good") as ChannelFit,
    reasons: r.reasons.length ? r.reasons : ["Named by your expansion plan."],
    needsConnection: !OPEN_SEARCH_CHANNELS.includes(channel),
  }));
  recs.sort((a, b) => rank[a.fit] - rank[b.fit] || Number(a.needsConnection) - Number(b.needsConnection) || b.reasons.length - a.reasons.length);
  return { recs };
}

// Stack Exchange per-profile site mapping (cap 2): the shared keyless quota
// (~300 req/day/IP) is spent carefully, never on blind searches.
export function stackSitesFor(profile: ProfileLike): string[] {
  const hay = normText([profile.productName, profile.productDesc, profile.audience, profile.pain, profile.workaround, profile.keywords, profile.coreAction].join(" "));
  const sites: string[] = [];
  if (countSignals(hay, DEV_SIGNALS) >= 2) sites.push("stackoverflow");
  if (countSignals(hay, CAREER_SIGNALS) >= 2) sites.push("workplace", "freelancing");
  if (countSignals(hay, FAMILY_SIGNALS) >= 2) sites.push("parenting");
  if (countSignals(hay, MONEY_SIGNALS) >= 2) sites.push("money");
  return [...new Set(sites)].slice(0, 2);
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
// thread. A forum is only searched when the profile's own signals map to it,
// and only the topic sections matching the profile are fetched — never blindly.
// Topic-defining signals count double; supporting kin/meds words count
// single. Threshold: "dementia" + "mom" maps, but a profile that merely
// mentions "mom and dad" (supporting only, no topic) does not.
const ELDER_CORE = ["caregiver", "dementia", "alzheimer", "elderly", "hospice", "nursing home", "assisted living", "memory care"];
const ELDER_KIN = ["mom", "mum", "mother", "dad", "daddy", "father", "parents", "meds", "medication", "respite", "senior care", "aging parent"];
const MUMSNET_CORE = ["pregnancy", "pregnant", "breastfeeding", "newborn", "toddler", "miscarriage", "fertility", "postnatal"];
const MUMSNET_KIN = ["baby", "babies", "parent", "parents", "mom", "mum", "dad", "kids", "children", "sleep", "feed", "feeding", "school", "nursery", "caregiver", "dementia", "meds", "money", "debt", "layoff", "unemployed"];
// A section is one slice of a forum's sitemap worth fetching for a matching
// profile: `token` must appear in the sitemap file's URL (slash-delimited so
// "/talk/parenting/" never matches "eco-friendly-parenting"), `signals`
// narrows it to the profile (null = the whole forum already mapped, as with
// AgingCare's Q&A/Discussions split).
export type SitemapSection = { token: string; signals: string[] | null };
export type SitemapForum = { channel: string; label: string; index: string; sections: SitemapSection[]; core: string[]; kin: string[]; minScore: number; maxFiles: number; communityFor: (url: string) => string };
function mumsnetCommunity(url: string): string {
  const m = url.match(/\/talk\/([^/]+)\//);
  const topic = (m?.[1] ?? "").replace(/[_-]+/g, " ").trim();
  return topic ? `Mumsnet Talk · ${topic}` : "Mumsnet Talk";
}
const SITEMAP_FORUMS: SitemapForum[] = [
  {
    channel: "agingcare", label: "AgingCare",
    index: "https://www.agingcare.com/sitemaps/sitemap.xml",
    sections: [{ token: "content-questions", signals: null }, { token: "content-discussions", signals: null }],
    communityFor: (url) => (url.includes("/discussions/") ? "AgingCare Discussions" : "AgingCare Q&A"),
    core: ELDER_CORE, kin: ELDER_KIN, minScore: 3, maxFiles: 6,
  },
  {
    channel: "mumsnet", label: "Mumsnet",
    index: "https://www.mumsnet.com/sitemap/talk",
    sections: [
      { token: "/talk/parenting/", signals: ["parent", "baby", "toddler", "children", "kids"] },
      { token: "/talk/sleep/", signals: ["sleep", "night", "nap", "tired", "feed", "routine"] },
      { token: "/talk/pregnancy/", signals: ["pregnancy", "pregnant", "fertility", "conception"] },
      { token: "/talk/breast_and_bottle_feeding/", signals: ["breastfeed", "bottle", "formula", "feed", "milk"] },
      { token: "/talk/childrens_health/", signals: ["health", "doctor", "fever", "rash", "ill", "gp"] },
      { token: "/talk/general_health/", signals: ["health", "doctor", "fever", "rash", "ill", "gp"] },
      { token: "/talk/behaviour_development/", signals: ["behaviour", "behavior", "tantrum", "development", "milestone"] },
      { token: "/talk/elderly_parents/", signals: ["elderly", "dementia", "caregiver", "care home"] },
      { token: "/talk/money-matters/", signals: ["money", "debt", "budget", "rent", "mortgage", "salary"] },
      { token: "/talk/work/", signals: ["layoff", "laid off", "unemployed", "interview", "resume", "freelance"] },
      { token: "/talk/childcare/", signals: ["childcare", "nursery", "nanny", "childminder"] },
    ],
    communityFor: mumsnetCommunity,
    core: MUMSNET_CORE, kin: MUMSNET_KIN, minScore: 2, maxFiles: 10,
  },
];
export function sitemapForumsFor(profile: ProfileLike): SitemapForum[] {
  const hay = normText([profile.productName, profile.productDesc, profile.audience, profile.pain, profile.workaround, profile.keywords, profile.coreAction].join(" "));
  return SITEMAP_FORUMS.filter((f) => countSignals(hay, f.core) * 2 + countSignals(hay, f.kin) >= f.minScore);
}
// Section filter (pure, tested): which sitemap files deserve a fetch for
// THIS profile. Runs at every index level, so one code path serves flat
// sitemaps (AgingCare) and nested topic indexes (Mumsnet).
export function filterSitemapLocs(forum: SitemapForum, locs: string[], profile: ProfileLike): string[] {
  const hay = normText([profile.productName, profile.productDesc, profile.audience, profile.pain, profile.workaround, profile.keywords, profile.coreAction].join(" "));
  return locs.filter((u) => forum.sections.some((s) => u.includes(s.token) && (!s.signals || countSignals(hay, s.signals) >= 1)));
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
async function fetchSitemapEntries(forum: SitemapForum, profile: ProfileLike): Promise<{ entries: SitemapEntry[] } | { error: string }> {
  const idx0 = await fetchText(forum.index);
  if (!idx0.ok) return { error: `Sitemap index unreachable (HTTP ${idx0.status}).` };
  const level0 = filterSitemapLocs(forum, sitemapLocs(idx0.text, "sitemap").map((e) => e.loc), profile);
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
    for (const loc of level) {
      if (fetches >= forum.maxFiles || entries.length >= SITEMAP_MAX_ENTRIES) break;
      if (loc === forum.index) continue;
      const r = await fetchText(loc);
      fetches++;
      if (!r.ok) continue; // one bad file doesn't sink the channel
      if (r.text.includes("<sitemapindex")) {
        for (const u of filterSitemapLocs(forum, sitemapLocs(r.text, "sitemap").map((e) => e.loc), profile)) {
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
  return { entries };
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
  const clusters = activeClusters(profile);
  const first = clusters[0];
  if (first) return { anchorTerm: first.label, terms: first.terms.map((t) => normText(t)).filter(Boolean) };
  // No known cluster: the anchor set is every specific anchor token derived
  // from the profile (keywords first, then audience, then pain — see
  // profileAnchorTokens). Previously only the FIRST keyword word counted,
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

const expansionPlanSchema = z.object({
  anchorTerm: z.string(),
  queries: z.array(z.object({ query: z.string(), intent: z.string() })),
  painPhrases: z.array(z.string()),
  adjacentProblems: z.array(z.string()),
  adjacentAudiences: z.array(z.string()),
  communities: z.array(z.object({ name: z.string(), where: z.string(), channel: z.string(), access: z.string(), why: z.string() })),
  relaxations: z.array(z.string()),
  nextSuggestions: z.array(z.string()),
});

// Generates one expansion round with Muse and stores it. `previous` carries
// the earlier rounds' queries/suggestions so a later round genuinely broadens
// (adjacent audiences/pains, new communities, a named relaxation) instead of
// repeating round 1. Returns the stored plan, or an LlmFail-style status.
async function generateExpansionRound(
  ctx: Ctx,
  profile: typeof schema.profiles.$inferSelect,
  context: { reason: string; found: number; discarded: number; synthesized: number; seenCount: number },
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
  const painPhrasesSaved: string[] = (() => { try { const v = JSON.parse(profile.painPhrases || "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } })();
  const isLaterRound = round > 1;
  const r = await runLlm(ctx, "small",
    `You are planning WHERE to find seed users for a founder — not just rewording one keyword. Build a search expansion plan from this target profile.\n\nProfile — Product: ${profile.productName} — ${profile.productDesc}\nAudience: ${profile.audience}\nPain (founder's words): ${profile.pain}\nWorkaround today: ${profile.workaround}\nFounder keywords: ${profile.keywords}\nCore action: ${profile.coreAction}\nPain phrases already known: ${painPhrasesSaved.join(" · ") || "(none yet)"}\n\nDOMAIN ANCHOR (hard rule): the anchor term is "${anchorTerm}". Valid anchor terms for queries: ${terms.join(", ")}. EVERY query you return MUST contain at least one of those anchor terms, word-for-word. A query made only of generic words (like "skill", "struggle", "help", "sucks", "beginner") is forbidden — unanchored queries are discarded server-side. If you broaden, broaden the pain/audience/community around the anchor, never drop the anchor.\n\nReturn:\n- anchorTerm: exactly "${anchorTerm}".\n- queries: ${isLaterRound ? "6-8" : "5-7"} search queries a real person in pain might match — variants and synonyms in the person's own language, each with a one-line intent. Cover different phrasings of the pain, the workaround, and beginner/first-time framings — all anchored.\n- painPhrases: 5-8 related pain phrases and adjacent problem phrasings in their words (these inform the founder; they are not all queries).\n- adjacentProblems: 3-5 adjacent problems the same person hits around this pain.\n- adjacentAudiences: 3-5 adjacent audiences — people one step wider than the profile who plausibly hit the same anchored pain.\n- communities: 5-8 specific places these people already talk — name the actual kind of place (e.g. for a beauty profile: beginner makeup subreddits, beauty forums, tutorial comment sections, beginner beauty groups/hashtags; for a caregiver profile: AgingCare Q&A and Discussions threads, Mumsnet elderly_parents threads). For each: name, where (platform/place), channel — one of bluesky, hackernews, github, stackexchange, agingcare, mumsnet, reddit_poc, reddit, x, facebook, discord, slack, linkedin, instagram, youtube (use stackexchange only for Q&A-style communities, agingcare for caregiver/elder-care forum threads, mumsnet for parenting/family forum threads) — access: "open" if it is a public searchable channel EarlyProof searches by default, "closed" if the founder must provide an API/connection or join and send themselves, and why this place fits.\n- relaxations: 2-4 specific over-strict terms or exact phrases from the profile/keywords that could be relaxed WITHOUT dropping the anchor (name the exact term and what to relax it to).\n- nextSuggestions: 3-5 concrete next expansion moves if this round still returns 0 synthesized results — broaden to an adjacent audience or adjacent pain (still anchored), try a different named channel or community, relax a named over-strict term.\n${isLaterRound ? `\nThis is expansion round ${round}. The previous search context: ${context.reason} It found ${context.found} candidates, the pre-filter dropped ${context.discarded}, Muse synthesized ${context.synthesized} results, and ${context.seenCount} leads are already seen (new results are deduplicated against them — do not repeat old queries). Previous rounds already tried these queries: ${previousQueries.join(" · ") || "(none)"}. Your new queries must be DIFFERENT from those: lean on the adjacent audiences, adjacent pains, new communities and the relaxations — while keeping every query anchored to "${anchorTerm}".` : `\nThis is expansion round 1, generated before the search runs.`}`,
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
      channel: ["bluesky", "hackernews", "github", "stackexchange", "agingcare", "mumsnet", "reddit_poc", "reddit", "x", "facebook", "discord", "slack", "linkedin", "instagram", "youtube", "manual"].includes(c.channel.trim()) ? c.channel.trim() : "manual",
      access: c.access.trim().toLowerCase() === "closed" ? "closed" : "open",
      why: c.why.trim().slice(0, 240),
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
async function ensureExpansionPlan(
  ctx: Ctx,
  profile: typeof schema.profiles.$inferSelect,
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
  const gen = await generateExpansionRound(ctx, profile, { reason: "First search for this profile — no expansion plan exists yet.", found: 0, discarded: 0, synthesized: 0, seenCount: 0 });
  if (!gen.ok) return gen;
  return { ok: true, plan: gen.plan, round: gen.round, generated: true };
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
async function runChannelSearch(
  ctx: Ctx,
  profile: typeof schema.profiles.$inferSelect,
  channels: string[],
  subreddits: string,
  queries: string[],
): Promise<{ created: number; found: number; discarded: number; pruned: number; promoted: number; errors: { channel: string; message: string }[] }> {
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
      // FirstFeedback HN retune: a stored unclassified HN lead whose title
      // does not start with "Ask HN" (e.g. an old Show HN showcase from a
      // pre-retune run) can never be an HN candidate for this profile again.
      const hnExcluded = l.channel === "hackernews" && isFirstFeedbackProfile(profile) && hnTitleKind(l.title) !== "ask";
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
  const errors: { channel: string; message: string }[] = [];

  type Cand = { key: string; values: typeof schema.leads.$inferInsert; score: number; keep: boolean; anchorPresent: boolean; reason: string };
  const candidates = new Map<string, Cand>();
  const addCandidate = (key: string, values: typeof schema.leads.$inferInsert, s: Relevance) => {
    if (!key) return;
    const prev = candidates.get(key);
    if (prev && prev.score >= s.score) return;
    candidates.set(key, { key, values, score: s.score, keep: s.keep, anchorPresent: s.anchorPresent, reason: s.reason });
  };

  for (const ch of channels) {
    if (ch === "stackexchange") {
      // Stack Exchange: keyless full-text question search, but ONLY across
      // the communities that fit THIS profile (mapped from its signals, never
      // hardcoded). Shared free quota (~300 req/day/IP): two queries per site.
      const sites = stackSitesFor(profile);
      if (!sites.length) { errors.push({ channel: "Stack Exchange", message: "No Stack Exchange community matches this profile's topic — skipped instead of searching blindly." }); continue; }
      let failed = false;
      for (const site of sites) {
        for (const query of queries.slice(0, 2)) {
          if (failed) break;
          const r = await fetchJson(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${site}&filter=withbody&pagesize=20`);
          const d = asObj(r.data);
          if (!r.ok) { errors.push({ channel: "Stack Exchange", message: d.error_id === 502 ? "Stack Exchange throttled the shared free quota — retry later today." : `Search failed (HTTP ${r.status}).` }); failed = true; continue; }
          if (((d.quota_remaining as number | undefined) ?? 1) === 0) { errors.push({ channel: "Stack Exchange", message: "Stack Exchange free quota exhausted for today — retry tomorrow." }); failed = true; continue; }
          const items = (d.items as unknown[]) ?? [];
          for (const it of items.slice(0, 20)) {
            const c = seCandidate(asObj(it), site, profile, profile.id);
            if (!c) continue;
            addCandidate(c.key, c.values, c.s);
          }
        }
      }
    } else if (ch === "agingcare" || ch === "mumsnet") {
      // Sitemap-indexed forums: no API, no RSS, bot-disallowed /search — but
      // public sitemaps with thread titles in the slugs. Scored title-only;
      // the candidate reason says so, and the founder verifies by opening
      // the thread. Skipped (never blind) when no forum maps to the profile.
      const forums = sitemapForumsFor(profile).filter((f) => f.channel === ch);
      if (!forums.length) { errors.push({ channel: ch === "mumsnet" ? "Mumsnet" : "AgingCare", message: "No sitemap-indexed forum matches this profile's topic — skipped instead of searching blindly." }); continue; }
      for (const forum of forums) {
        const r = await fetchSitemapEntries(forum, profile);
        if ("error" in r) { errors.push({ channel: forum.label, message: r.error }); continue; }
        for (const e of r.entries) {
          const c = sitemapCandidate(e, forum, profile, profile.id);
          if (!c) continue;
          addCandidate(c.key, c.values, c.s);
        }
      }
    } else if (ch === "hackernews") {
      let failed = false;
      // FirstFeedback: HN runs ONLY the help-request phrases against the
      // ask_hn tag with relevance ranking. Every other profile keeps the
      // existing story search_by_date behaviour exactly as it was.
      const ffHn = isFirstFeedbackProfile(profile);
      const hnQueries = ffHn ? FIRSTFEEDBACK_HN_HELP_QUERIES : queries.slice(0, 5);
      for (const query of hnQueries) {
        const url = ffHn
          ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=ask_hn&hitsPerPage=12`
          : `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=12`;
        const r = await fetchJson(url);
        if (!r.ok) { if (!failed) errors.push({ channel: "Hacker News", message: `Search failed (HTTP ${r.status}). Try again.` }); failed = true; continue; }
        const hits = (asObj(r.data).hits as unknown[]) ?? [];
        for (const h of hits.slice(0, ffHn ? 12 : 10)) {
          const o = asObj(h);
          const oid = String(o.objectID ?? "");
          const title = String(o.title ?? "");
          // Ask HN title-prefix gate (FirstFeedback only): only a title
          // starting with "Ask HN" is a candidate. "Show HN" showcases and
          // all other titles are excluded here — before the pre-filter — so
          // they are never counted as found or discarded candidates. This
          // also drops comment hits (they carry no story title).
          if (ffHn && hnTitleKind(title) !== "ask") continue;
          const text = String(o.story_text ?? o.title ?? "");
          const clean = decodeHnText(text).slice(0, 900);
          const s = analyseText(title + " " + clean, profile, "hackernews");
          addCandidate(`hn:${oid}`, { profileId: profile.id, channel: "hackernews", mode: "live_search", externalUrl: `https://news.ycombinator.com/item?id=${oid}`, externalId: oid, author: String(o.author ?? ""), authorHandle: String(o.author ?? ""), title, body: clean, postedAt: String(o.created_at ?? ""), matchScore: s.score, matchReason: s.reason }, s);
        }
      }
    } else if (ch === "github") {
      let failed = false;
      for (const query of queries.slice(0, 3)) {
        if (failed) break; // rate-limited: stop spending the free search budget
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
          addCandidate(`gh:${String(o.id ?? "")}`, { profileId: profile.id, channel: "github", mode: "live_post", externalUrl: String(o.html_url ?? ""), externalId: String(o.id ?? ""), author: String(user.login ?? ""), authorHandle: String(user.login ?? ""), title, body: bodyTxt, community: repo, postedAt: String(o.created_at ?? ""), matchScore: s.score, matchReason: s.reason }, s);
        }
      }
    } else if (ch === "bluesky") {
      const sess = await ensureBsky(ctx);
      if (!sess) { errors.push({ channel: "Bluesky", message: "Bluesky is not connected. Connect your free Bluesky account in Channels to search posts." }); continue; }
      let failed = false;
      for (const query of queries.slice(0, 5)) {
        const r = await fetchJson(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=15&sort=latest`, { headers: { Authorization: `Bearer ${sess.accessJwt}` } });
        if (!r.ok) { if (!failed) errors.push({ channel: "Bluesky", message: `Search failed (HTTP ${r.status}). Your session may have expired — reconnect in Channels.` }); failed = true; continue; }
        const posts = (asObj(r.data).posts as unknown[]) ?? [];
        for (const p of posts.slice(0, 10)) {
          const o = asObj(p); const author = asObj(o.author); const record = asObj(o.record);
          const uri = String(o.uri ?? ""); const rkey = uri.split("/").pop() ?? "";
          const handle = String(author.handle ?? "");
          const text = String(record.text ?? "").slice(0, 900);
          const s = analyseText(text, profile, "bluesky");
          addCandidate(`bsky:${uri}`, { profileId: profile.id, channel: "bluesky", mode: "live_post", externalUrl: `https://bsky.app/profile/${handle}/post/${rkey}`, externalId: uri, externalUri: uri, externalCid: String(o.cid ?? ""), author: String(author.displayName ?? handle), authorHandle: handle, title: "", body: text, postedAt: String(record.createdAt ?? o.indexedAt ?? ""), matchScore: s.score, matchReason: s.reason }, s);
        }
      }
    } else if (ch === "reddit_poc") {
      const subs = subreddits.split(/[,\s]+/).map((s) => s.trim().replace(/^r\//, "")).filter(Boolean).slice(0, 5);
      if (!subs.length) { errors.push({ channel: "Reddit POC", message: "Enter at least one subreddit (max 5) for the POC search." }); continue; }
      const sess = await ensureReddit(ctx);
      if ("error" in sess) { errors.push({ channel: "Reddit POC", message: sess.error }); continue; }
      // On-demand only, sequential, deduplicated in the leads table — total
      // calls capped at 10 per run, far under the 100/min free-tier limit.
      let calls = 0;
      for (const sub of subs) {
        for (const query of queries.slice(0, 3)) {
          if (calls >= 10) break;
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
            addCandidate(`rd:${fullname}`, { profileId: profile.id, channel: "reddit_poc", mode: "live_post", externalUrl: `https://www.reddit.com${String(d.permalink ?? "")}`, externalId: fullname, author: String(d.author ?? ""), authorHandle: String(d.author ?? ""), title, body: self, community: `r/${sub}`, postedAt: d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : "", matchScore: s.score, matchReason: s.reason }, s);
          }
        }
      }
    }
  }

  // Selection: light-gate passers first (strongest first, capped at 30 so a
  // single search never floods Muse synthesis), then — if fewer than 3
  // passed — top-up promotion of the highest-scoring ANCHORED candidates so
  // Muse always gets a real batch to judge when anchored posts exist.
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  const found = sorted.length;
  const MAX_TO_SYNTHESIS = 30;
  let selected = sorted.filter((c) => c.keep).slice(0, MAX_TO_SYNTHESIS);
  let promoted = 0;
  if (selected.length < 3) {
    const extra = sorted
      .filter((c) => !c.keep && c.anchorPresent && !selected.includes(c))
      .slice(0, Math.min(3 - selected.length, MAX_TO_SYNTHESIS - selected.length));
    if (extra.length) { selected = [...selected, ...extra]; promoted = extra.length; }
  }
  const selectedKeys = new Set(selected.map((c) => c.key));
  let created = 0;
  for (const cand of selected) {
    const url = cand.values.externalUrl ?? "";
    const extId = cand.values.externalId ?? "";
    if ((url && seen.has(url)) || (extId && seen.has(extId))) continue; // already stored from an earlier search — not new, not discarded
    const isPromoted = !cand.keep;
    await db.insert(schema.leads).values({
      ...cand.values,
      matchReason: isPromoted
        ? `${cand.reason} Passed to Muse as a top anchored candidate from this search — the light pre-filter found the domain anchor, and Muse makes the relevance call with evidence and confidence.`
        : cand.reason,
    });
    if (url) seen.add(url);
    if (extId) seen.add(extId);
    created++;
  }
  const discarded = sorted.filter((c) => !selectedKeys.has(c.key)).length;
  return { created, found, discarded, pruned, promoted, errors };
}

const searchResponse = z.object({ runId: z.number(), created: z.number(), found: z.number(), discarded: z.number(), pruned: z.number(), promoted: z.number(), synthesized: z.number(), synthesisStatus: z.string(), synthesisMessage: z.string(), errors: z.array(z.object({ channel: z.string(), message: z.string() })), expansionRound: z.number(), expansionAnchor: z.string(), expansionQueries: z.array(z.string()), expansionGenerated: z.boolean(), nextSuggestions: z.array(z.string()) });
const emptySearch = { runId: 0, created: 0, found: 0, discarded: 0, pruned: 0, promoted: 0, synthesized: 0, expansionRound: 0, expansionAnchor: "", expansionQueries: [] as string[], expansionGenerated: false, nextSuggestions: [] as string[] };

const leadOut = z.object({
  id: z.number(), profileId: z.number(), channel: z.string(), mode: z.string(), externalUrl: z.string(),
  externalId: z.string(), author: z.string(), authorHandle: z.string(), title: z.string(), body: z.string(),
  community: z.string(), postedAt: z.string(), matchScore: z.number(), matchReason: z.string(),
  draftBody: z.string(), status: z.string(), postedUrl: z.string(), created_at: z.string(),
  llmCategory: z.string(), llmConfidence: z.number(), llmReason: z.string(), llmQuote: z.string(),
  llmSignals: z.string(), llmReviewed: z.boolean(), draftToneCheck: z.string(),
});
const llmStatusOut = z.object({ configured: z.boolean(), provider: z.string(), hasKey: z.boolean(), keyHint: z.string(), baseUrl: z.string(), smallModel: z.string(), largeModel: z.string(), founderVoice: z.string() });
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
      const llmRows = await db.select().from(schema.llmSettings);
      const llmRow = llmRows[0];
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
          hasKey: !!(llmRow?.apiKey.trim()),
          keyHint: llmRow?.apiKey.trim() ? `••••${llmRow.apiKey.trim().slice(-4)}` : "",
          baseUrl: llmRow?.baseUrl ?? "",
          smallModel: llmRow?.smallModel ?? "",
          largeModel: llmRow?.largeModel ?? "",
          founderVoice: llmRow?.founderVoice ?? "",
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
      await db.update(schema.profiles).set({ productName: args.productName, productDesc: args.productDesc, audience: args.audience, pain: args.pain, workaround: args.workaround, keywords: args.keywords, coreAction: args.coreAction }).where(eq(schema.profiles.id, args.id));
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
      const sig = JSON.stringify({ rightPerson: true, realPain: true, workaroundOrPaying: true, recent: true });
      const a = await db.insert(schema.leads).values({
        profileId: pid, channel: "bluesky", mode: "live_post",
        externalUrl: "https://bsky.app/profile/demo.bsky.social/post/demo01", externalId: "demo-a",
        author: "Riley", authorHandle: "riley.bsky.social", title: "",
        body: "Laid off last Friday with rent due in two weeks. Everyone says learn to code but I need money now, not in six months.",
        postedAt: new Date().toISOString(), matchScore: 74,
        matchReason: "Demo lead — matched “laid off” plus pain signals.",
        draftBody: "Your post hit home — I built SecondShift for this exact spot. Open to trying it for one gig?",
        status: "sent", llmCategory: "seed_user", llmConfidence: 82,
        llmReason: "Laid-off worker describing their own pain in their own words.",
        llmQuote: "need money now, not in six months", llmSignals: sig,
      }).returning({ id: schema.leads.id });
      const bBody = "Laid off in March, applied to 200 jobs with two callbacks. Trying freelance gigs now but don't know where to start.";
      await db.insert(schema.leads).values({
        profileId: pid, channel: "bluesky", mode: "live_post",
        externalUrl: "https://bsky.app/profile/demo.bsky.social/post/demo02", externalId: "demo-b",
        author: "Mara", authorHandle: "mara.bsky.social", title: "", body: bBody,
        postedAt: new Date().toISOString(), matchScore: 70,
        matchReason: "Demo lead — matched “freelance” plus pain signals.",
        status: "new", llmCategory: "curious", llmConfidence: 55,
        llmReason: "Laid-off worker trying workarounds, asking where to start.",
        llmQuote: "don't know where to start", llmSignals: sig,
      });
      const cBody = "Took a starter gig through a friend, got paid, now looking for steady freelance work.";
      const c = await db.insert(schema.leads).values({
        profileId: pid, channel: "manual", mode: "guided",
        externalUrl: "", externalId: "demo-c",
        author: "Devon", authorHandle: "Devon", title: "", body: cBody, community: "Demo group",
        postedAt: new Date().toISOString(), matchScore: 72,
        matchReason: "Demo lead — did the core action.",
        status: "trial", llmCategory: "seed_user", llmConfidence: 80,
        llmReason: "Did the core action and keeps going.",
        llmQuote: "got paid, now looking for steady freelance work", llmSignals: sig,
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
      const runId = await startSearchRun(db, profile.id, "search");
      const exp = await ensureExpansionPlan(ctx, profile);
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
      const run = await runChannelSearch(ctx, profile, args.channels, args.subreddits, usable);
      // Step 4 — LLM synthesis runs automatically before any result is shown.
      await touchSearchRun(db, runId, "synthesizing", `Synthesizing ${run.created} candidate(s) with Muse…`, { found: run.found, created: run.created });
      const synth = await classifyForProfile(ctx, profile);
      const errors = [...run.errors];
      if (synth.status !== "ok") errors.push({ channel: "Muse synthesis", message: synth.message });
      await touchSearchRun(db, runId, "done", `Checked ${run.found} posts, ${run.created} looked like your people.`, { found: run.found, created: run.created, synthesized: synth.classified + synth.cached });
      ctx.invalidateQueries();
      return { runId, created: run.created, found: run.found, discarded: run.discarded, pruned: run.pruned, promoted: run.promoted, synthesized: synth.classified + synth.cached, synthesisStatus: synth.status, synthesisMessage: synth.message, errors, expansionRound: exp.round, expansionAnchor: exp.plan.anchorTerm, expansionQueries: usable, expansionGenerated: exp.generated, nextSuggestions: exp.plan.nextSuggestions };
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
      const gen = await generateExpansionRound(ctx, profile, {
        reason: synthesizedNow === 0
          ? "The last search returned 0 synthesized results — a dead end the founder asked to expand past."
          : `The founder asked to widen the search beyond the ${synthesizedNow} synthesized result(s) found so far.`,
        found: leadsNow.length, discarded: 0, synthesized: synthesizedNow, seenCount: leadsNow.length,
      });
      const runId = await startSearchRun(db, profile.id, "expand");
      if (!gen.ok) {
        await touchSearchRun(db, runId, "done", gen.message);
        return { ...emptySearch, runId, synthesisStatus: gen.status, synthesisMessage: gen.message, errors: [{ channel: "Muse expansion", message: gen.message }] };
      }
      const queries = gen.plan.queries.map((q) => q.query).slice(0, 6);
      await touchSearchRun(db, runId, "searching", `Searching ${args.channels.length} channel(s) with round ${gen.round} queries…`);
      const run = await runChannelSearch(ctx, profile, args.channels, args.subreddits, queries);
      await touchSearchRun(db, runId, "synthesizing", `Synthesizing ${run.created} candidate(s) with Muse…`, { found: run.found, created: run.created });
      const synth = await classifyForProfile(ctx, profile);
      const errors = [...run.errors];
      if (synth.status !== "ok") errors.push({ channel: "Muse synthesis", message: synth.message });
      await touchSearchRun(db, runId, "done", `Checked ${run.found} posts, ${run.created} looked like your people.`, { found: run.found, created: run.created, synthesized: synth.classified + synth.cached });
      ctx.invalidateQueries();
      return { runId, created: run.created, found: run.found, discarded: run.discarded, pruned: run.pruned, promoted: run.promoted, synthesized: synth.classified + synth.cached, synthesisStatus: synth.status, synthesisMessage: synth.message, errors, expansionRound: gen.round, expansionAnchor: gen.plan.anchorTerm, expansionQueries: queries, expansionGenerated: true, nextSuggestions: gen.plan.nextSuggestions };
    },
  }),

  // Generates (a new round of) the LLM expansion plan on its own, so the
  // founder can read where Muse wants to look before any search runs.
  generateExpansionPlan: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), round: z.number(), anchorTerm: z.string(), droppedUnanchored: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { status: "error", message: "Profile not found.", round: 0, anchorTerm: "", droppedUnanchored: 0 };
      const leadsNow = await db.select().from(schema.leads).where(eq(schema.leads.profileId, profile.id));
      const gen = await generateExpansionRound(ctx, profile, { reason: "The founder asked for an expansion plan.", found: leadsNow.length, discarded: 0, synthesized: leadsNow.filter((l) => !!l.llmCategory).length, seenCount: leadsNow.length });
      if (!gen.ok) return { status: gen.status, message: gen.message, round: 0, anchorTerm: "", droppedUnanchored: 0 };
      ctx.invalidateQueries();
      return { status: "ok", message: `Expansion plan round ${gen.round} saved — ${gen.plan.queries.length} anchored queries (anchor: “${gen.plan.anchorTerm}”)${gen.plan.droppedUnanchored ? `, ${gen.plan.droppedUnanchored} unanchored suggestion${gen.plan.droppedUnanchored === 1 ? "" : "s"} dropped` : ""}, ${gen.plan.communities.length} communities mapped to channels. It will drive the next search.`, round: gen.round, anchorTerm: gen.plan.anchorTerm, droppedUnanchored: gen.plan.droppedUnanchored };
    },
  }),

  // Which channels fit THIS profile: profile signals plus Muse's latest
  // expansion plan, ranked best/good/poor with reasons. The UI preselects
  // the open non-poor picks — GitHub and HN are never defaults for a
  // non-technical profile.
  recommendChannels: defineAction({
    request: z.object({ profileId: z.number() }),
    response: z.object({ status: z.string(), message: z.string(), basedOn: z.string(), recs: z.array(z.object({ channel: z.string(), fit: z.string(), reasons: z.array(z.string()), needsConnection: z.boolean() })) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profileId));
      const profile = profRows[0];
      if (!profile) return { status: "error", message: "Profile not found.", basedOn: "", recs: [] };
      const existing = await db.select().from(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, profile.id));
      const latest = existing.sort((a, b) => b.round - a.round)[0];
      let plan: ExpansionPlan | null = null;
      let basedOn = "profile signals (no expansion plan yet — generate one for sharper picks)";
      if (latest) {
        try {
          const p = JSON.parse(latest.plan || "{}") as ExpansionPlan;
          if (p && Array.isArray(p.queries) && p.queries.length) {
            plan = p;
            basedOn = `Muse expansion round ${latest.round} + profile signals`;
          }
        } catch { /* heuristic-only */ }
      }
      const { recs } = channelRecsFor(profile, plan);
      const tops = recs.filter((r) => r.fit === "best" && !r.needsConnection).map((r) => r.channel);
      const poors = recs.filter((r) => r.fit === "poor" && !r.needsConnection).map((r) => r.channel);
      return {
        status: "ok",
        message: tops.length
          ? `Best channels for this profile: ${tops.join(", ")} (${basedOn}).`
          : poors.length
            ? `No channel stands out for this profile (${basedOn}) — ${poors.join(", ")} deselected as poor fits.`
            : `No channel stands out for this profile (${basedOn}) — all open channels stay selected.`,
        basedOn,
        recs,
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
      if (!lead.llmCategory) return { draft: lead.draftBody, toneCheck: "Muse classification required first: this lead has not been classified by Muse yet, so it can't be used for outreach. Run “Classify waiting leads” in the Match queue, read the verdict and its quote, then generate the draft.", llmStatus: "needs_classification" };
      if ((lead.llmCategory === "irrelevant" || (lead.llmConfidence > 0 && lead.llmConfidence < LOW_CONFIDENCE)) && lead.llmReviewed !== 1) {
        return { draft: lead.draftBody, toneCheck: "Held for your review: Muse classified this lead as low-confidence or irrelevant. Read the evidence on the lead and tap “I reviewed this — keep it in my queue” before any draft is written for it.", llmStatus: "needs_review" };
      }
      const voice = settings.founderVoice.trim();
      const channelRules = lead.channel === "bluesky" ? "Bluesky: keep it under 280 characters, conversational, no hashtag spam." : lead.channel === "reddit_poc" || lead.channel === "reddit" ? "Reddit: respect community norms — no link dump on first touch, no hype, disclose that you built it." : lead.channel === "github" ? "GitHub: be brief and technical, acknowledge their issue specifically, never spam maintainers." : "Closed/DM channel: extra care — they didn't ask to be contacted; be short, easy to decline, no pressure.";
      const r = await runLlm(ctx, "large",
        `Write a first outreach message for a founder, then check your own work in the toneCheck field: one or two plain sentences on whether the draft sounds like a genuine founder asking for help (not a pitch blast or a template), whether it follows the channel rules, and anything the founder should fix before approving. You never post anything yourself.\nFounder voice notes (write in this voice): ${voice || "plain, honest, first person, no marketing language"}\nChannel: ${lead.channel}. Channel rules: ${channelRules}\nRules for the draft: reference their specific post in their own words; say plainly the founder built something for this exact problem; ask for help trying it for one real task — a request for help, not a pitch; no link dump; under 90 words unless the channel rule above is stricter.\nProduct: ${p.productName} — ${p.productDesc}\nPain it addresses: ${p.pain}\nTheir post (by ${lead.author}): Title: ${lead.title}\n${lead.body.slice(0, 900)}`,
        z.object({ draft: z.string(), toneCheck: z.string() }));
      if (!r.ok) return { draft: lead.draftBody, toneCheck: r.status === "not_configured" ? LLM_SETUP_MESSAGE : `${r.message} No fallback draft was substituted — draft generation is a Muse step. Fix the Muse connection and try again.`, llmStatus: r.status };
      if (!r.value.draft.trim()) return { draft: lead.draftBody, toneCheck: "Your large Muse model didn't return a usable draft, so nothing was saved. Try again — no template draft is substituted.", llmStatus: "error" };
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
        if (!sess) return { posted: false, postedUrl: "", message: "Bluesky is not connected. This draft is saved as Approved — connect Bluesky in Channels to post it from here, or copy it and reply manually." };
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
          return { posted: false, postedUrl: "", message: "Marked Approved. Connect a GitHub token in Channels to post comments from here, or copy the draft and comment on the issue yourself." };
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
          return { posted: false, postedUrl: "", message: "Marked Approved (POC). Reddit POC is not connected, so copy the draft and reply manually — or reconnect the POC in Channels." };
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

      // All other channels: founder sends manually.
      await db.update(schema.leads).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.leads.id, lead.id));
      ctx.invalidateQueries();
      const label = lead.channel === "hackernews" ? "Hacker News has no posting API" : lead.channel === "reddit" || lead.channel === "x" ? "This channel uses your pasted link (no paid API)" : "This is a closed/DM channel";
      return { posted: false, postedUrl: "", message: `Marked Approved — ready for you to send. ${label}, so copy the draft, send it from your own account, then tap “Mark sent”.` };
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
  // AI setup is key-only: the founder pastes their Muse API key (and
  // optionally voice notes). Model choice is automatic — small/fast tier for
  // high-volume first passes, large tier for drafts and summaries — so there
  // is nothing to pick and nothing to misconfigure.
  saveLlmSettings: defineAction({
    request: z.object({ apiKey: z.string().default(""), founderVoice: z.string().default("") }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.llmSettings);
      const vals = { provider: "muse", apiKey: args.apiKey.trim() || (existing[0]?.apiKey ?? ""), baseUrl: "", smallModel: "auto", largeModel: "auto", founderVoice: args.founderVoice, updatedAt: Date.now() };
      if (existing[0]) await db.update(schema.llmSettings).set(vals).where(eq(schema.llmSettings.id, existing[0].id));
      else await db.insert(schema.llmSettings).values(vals);
      ctx.invalidateQueries();
      return { ok: true };
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

  testLlmConnection: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), status: z.string(), message: z.string() }),
    async handler(ctx) {
      // Receipt-grade: with a Model API key this makes a REAL direct call and
      // names the model that answered, so the founder (and a judge) sees the
      // exact serving path instead of taking it on faith.
      const s = await loadLlmSettings(ctx);
      if (s && isDirectKey(s.apiKey)) {
        const t0 = Date.now();
        const r = await completeViaMetaModel("Connection test: reply with the single word ok.", s.apiKey, META_MODEL);
        if (!r.ok) return { ok: false, status: "error", message: `Direct ${META_MODEL} call failed (${r.error}). Check the key and Model API quota.` };
        return { ok: true, status: "ok", message: `Direct ${META_MODEL} via Model API answered in ${((Date.now() - t0) / 1000).toFixed(1)}s — the key works and all Muse calls will use it.` };
      }
      const r = await runLlm(ctx, "small", "Connection test: reply with a short confirmation that you received this.", z.string());
      if (!r.ok) return { ok: false, status: r.status, message: r.message };
      return { ok: true, status: "ok", message: "Workspace model runtime answered — models are picked automatically (fast tier for first passes, large tier for drafts and summaries)." };
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
        z.object({ painPhrases: z.array(z.string()), workaroundPhrases: z.array(z.string()), exclusions: z.array(z.string()) }));
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
      for (const ph of phrases.slice(0, 6)) if (!merged.some((k) => k.toLowerCase() === ph.toLowerCase())) merged.push(ph);
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
        z.object({ clusters: z.array(z.object({ theme: z.string(), quotes: z.array(z.string()), stuckPoints: z.array(z.string()), requests: z.array(z.string()) })), repeatedPainLanguage: z.array(z.string()), followUpQuestions: z.array(z.string()) }));
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
      const r = await runLlm(ctx, "small",
        `Suggest ONE next experiment for a founder from cohort signals. Hard rules: you must NOT give a PMF score, a PMF verdict, or say whether they have product-market fit — the founder decides that. You must keep the lever you are given (audience, message, or problem) — the order is fixed. Write the experiment as one concrete paragraph: what to change, who it runs on, for how long, and which signal to watch. Ground it in the numbers given.\nLever (fixed): ${lever}\nWhy this lever: ${rationale}\nSignals: ${JSON.stringify(signals)}\nProfile: audience ${p.audience}; pain ${p.pain}; core action ${p.coreAction}\nLatest feedback summary (may be empty): ${latestFb.slice(0, 1500)}`,
        z.object({ experiment: z.string() }));
      if (!r.ok) return { status: r.status, message: r.status === "not_configured" ? LLM_SETUP_MESSAGE : `${r.message} No rule-based suggestion was substituted — next-experiment suggestions are a Muse step.`, source: "" };
      if (!r.value.experiment.trim()) return { status: "error", message: "Your Muse model didn't return a usable experiment, so nothing was saved. Try again.", source: "" };
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
