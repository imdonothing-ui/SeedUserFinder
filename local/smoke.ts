// In-process smoke test: drives the REAL action handlers (same code the
// artifact runtime and `local/server.ts` call) against real local SQLite with
// stub inference. Run: `bun local/smoke.ts`. Uses a throwaway database so
// `local/data/app.db` is never touched.
//
// Stub output is test-only surface: the product blocks it unless this flag is
// set, so the suite opts in explicitly. Never set it in local/server.ts.
process.env.EARLYPROOF_ALLOW_STUB = "1";

import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { complete } from "./inference-stub.ts";
import { Actions, analyseText, shouldRetryFetch, matchVariant, normText, synonymsFor, sitemapLocs, slugTitleFor, forumAdapter, filterSitemapLocs, sitemapCandidate, channelRecsFor, seSitesFromPlan, seCandidate, devtoCandidate, lobstersCandidate, ddgResults, groupVenues, mergeDiscovery, dynamicForumFor, buildExpansionPrompt, parseExpansionPlan, parseBraveResults, parseSearxngResults, planDomains, profileSignature, stringishArray } from "../server/src/actions.ts";
import { bm25Order, fuseRanks } from "../server/src/retrieval.ts";
import { extractOutlinkDomains, forumGraphVenues, parseSeRelatedSites, registrable, seGraphVenues } from "../server/src/venue-graph.ts";
import { collectCorrections, replayCorrections } from "../server/src/eval.ts";
import { buildSemanticRerankPrompt, fetchText, parseSemanticScores, runChannelSearch, SITEMAP_MAX_BYTES } from "../server/src/actions.ts";
import { META_MODEL, buildResponsesRequest, extractJsonValue, extractResponseText, isDirectKey, completeViaMetaModel } from "../server/src/meta-api.ts";
import { GATE_CORPUS, WILLOW, SECONDHIFT, DEV, MAKEUP, DAWNLITE } from "./gate-corpus.ts";
import * as schema from "../server/src/schema.ts";

const sqlite = new Database(":memory:");
sqlite.exec("PRAGMA foreign_keys=OFF");
const journal = (await Bun.file(new URL("../drizzle/meta/_journal.json", import.meta.url)).json()) as {
  entries: { tag: string }[];
};
for (const entry of journal.entries) {
  const sql = await Bun.file(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url)).text();
  for (const stmt of sql.split("--> statement-breakpoint")) {
    if (stmt.trim()) sqlite.exec(stmt);
  }
}
const db = drizzle(sqlite);
const ctx = { db: <T>() => db as unknown as T, inference: { complete }, invalidateQueries: () => {} };

let n = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (!cond) throw new Error(`SMOKE FAIL: ${label} ${extra !== undefined ? JSON.stringify(extra)?.slice(0, 200) : ""}`);
  n++;
  console.log(`ok ${n} — ${label}`);
}

async function call<K extends keyof typeof Actions>(
  action: K,
  args: Parameters<(typeof Actions)[K]["handler"]>[1],
): Promise<unknown> {
  const def = Actions[action] as any;
  return def.response.parse(await def.handler(ctx, def.request.parse(args)));
}

async function state() {
  return (await call("getState", {})) as any;
}

// Seed LLM settings (stub key — same as the local server seeds).
await db.insert(schema.llmSettings).values({
  provider: "muse", apiKey: "local-stub-key", baseUrl: "",
  smallModel: "local-stub-small", largeModel: "local-stub-large",
  updatedAt: Date.now(),
});

// 0. Demo mode seeds a full loop on an empty DB, then refuses when taken.
const demo1 = (await call("seedDemoData", {})) as any;
check(demo1.ok === true && demo1.profileId > 0, "demo seeds on empty DB", demo1);
const demoState = (await call("getState", {})) as any;
check(
  demoState.profiles.length === 1 && demoState.leads.length === 3 &&
  demoState.invites.length === 1 && demoState.invites[0].code === "DEMO-01" &&
  demoState.events.length === 2 &&
  demoState.followups.filter((f: any) => f.profileId === demo1.profileId).length === 1,
  "demo lights up queue, tracker, and cohort",
  { profiles: demoState.profiles.length, leads: demoState.leads.length, invites: demoState.invites.length, events: demoState.events.length },
);
const demo2 = (await call("seedDemoData", {})) as any;
check(demo2.ok === false, "demo refuses when workspace taken", demo2);
// Demo seeds structure only — zero Muse output. Verdicts, quotes, signals
// and drafts stay empty until a real key classifies; the reason slot points
// at the key instead of faking a verdict.
const demoLeads = await db.select().from(schema.leads).where(eq(schema.leads.profileId, demo1.profileId));
check(
  demoLeads.length === 3 && demoLeads.every((l) => !l.llmCategory && l.llmConfidence === 0 && !l.llmQuote && !l.llmSignals && !l.draftBody),
  "demo seeds zero AI fields — verdicts come only from Muse",
  demoLeads.map((l) => ({ id: l.id, cat: l.llmCategory, conf: l.llmConfidence })),
);
check(demoLeads.every((l) => l.llmReason.includes("no Muse verdict yet")), "demo verdict slots point at the key, never a fake verdict", null);

// 1. Version readout for knowing which build is under test.
const ver = (await call("getVersion", {})) as any;
check(ver.version === "0.2.0" && typeof ver.sha === "string" && typeof ver.dirty === "boolean", "version shape", ver);
check(typeof ver.label === "string" && ver.label.startsWith("0.2.0 ·"), "version label", ver);

// 2. Key-only AI setup: key + voice in, models automatic, nothing to pick.
await call("saveLlmSettings", { apiKey: "k-9999" });
const llm = (await state()).llm;
check(llm.hasKey === true && llm.smallModel === "auto" && llm.largeModel === "auto", "key-only setup stores key, models auto", llm);
const tst = (await call("testLlmConnection", {})) as any;
check(tst.ok === false && tst.status === "stub", "stub connection test fails honestly instead of fake-passing", tst);
// Live-key flag: an LLM| key reports the direct path without any network.
await call("saveLlmSettings", { apiKey: "LLM|test|secret" });
check((await state()).llm.direct === true, "LLM| key reports direct path", null);
await call("saveLlmSettings", { apiKey: "k-9999" });
check((await state()).llm.direct === false, "plain key reports runtime path", null);
// One settings row ever; empty saves fail honestly; typed keys test as-typed.
await call("clearLlmSettings", {});
const emptySave = (await call("saveLlmSettings", { apiKey: "" })) as any;
check(emptySave.ok === false && emptySave.keyStored === false, "empty save with no stored key fails honestly", emptySave);
await call("saveLlmSettings", { apiKey: "k-9999" });
await call("saveLlmSettings", { apiKey: "LLM|test|secret" });
const setRows = await db.select().from(schema.llmSettings);
check(setRows.length === 1 && setRows[0].apiKey === "LLM|test|secret", "settings stay a single row, latest save wins", setRows.map((r) => r.apiKey));
const typedStub = (await call("testLlmConnection", { apiKey: "local-stub-key" })) as any;
check(typedStub.ok === false && typedStub.status === "error", "typed junk key gets the API verdict, never stub-passing", typedStub);
const bogusDirect = (await call("testLlmConnection", { apiKey: "LLM|bogus|key" })) as any;
check(bogusDirect.ok === false && typeof bogusDirect.message === "string" && bogusDirect.message.includes("nothing was saved"), "typed bogus direct key fails with the API verdict, never stub-passing", bogusDirect);
// The connection probe asks for a single word, so it must judge words — the
// old JSON-only probe failed every valid key with "no usable JSON".
check(extractResponseText({ output_text: "ok" }) === "ok", "text probe reads output_text", null);
check(extractResponseText({ output: [{ content: [{ text: "hi" }] }] }) === "hi", "text probe reads output content text", null);
check(extractResponseText({ choices: [{ message: { content: "yo" } }] }) === "yo", "text probe reads choices content", null);
check(extractResponseText("plain") === "plain" && extractResponseText({}) === "" && extractResponseText(null) === "", "text probe degrades gracefully", null);
check(extractJsonValue({ output_text: "ok" }) === null, "plain ok is text, not JSON — the probe must not demand braces", null);
check(((await state()).llm as any).keyHint === "••••cret", "stored key untouched by typed test", null);
// The harness seed placeholder is not a key: it refuses to save, and a
// stored one reads as not configured with Muse steps hard-blocked —
// placeholder "configuration" must never manufacture [local-stub] phrases.
const phSave = (await call("saveLlmSettings", { apiKey: "local-stub-key" })) as any;
check(phSave.ok === false && phSave.keyStored === false, "placeholder key refuses to save", phSave);
await db.delete(schema.llmSettings);
await db.insert(schema.llmSettings).values({ provider: "muse", apiKey: "local-stub-key", baseUrl: "", smallModel: "local-stub-small", largeModel: "local-stub-large", updatedAt: Date.now() });
const phState = (await state()).llm;
check(phState.configured === false && phState.hasKey === false && phState.direct === false, "stored placeholder reads as not configured", phState);
const phProf = (await call("createProfile", { productName: "PH", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k", coreAction: "c" })) as any;
const phExp = (await call("expandPainLanguage", { profileId: phProf.id })) as any;
check(phExp.status === "not_configured", "placeholder key hard-blocks expansion instead of stubbing", phExp);
// 2b. No working Muse key (placeholder stored): every AI step alerts
// not_configured and saves nothing — never a dummy verdict, draft, plan,
// phrase, search result, or summary.
const nkProf = (await call("createProfile", { productName: "NK", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k", coreAction: "c" })) as any;
await call("addPastedLead", { profileId: nkProf.id, channel: "reddit", externalUrl: "https://example.com/nk", author: "Zed", title: "t", body: "laid off with bills due, no idea where to start", community: "r/x" });
await call("addFeedback", { profileId: nkProf.id, rawText: "stuck at the gig application step" });
check(((await call("expandPainLanguage", { profileId: nkProf.id })) as any).status === "not_configured", "no key: pain expansion blocked", null);
check(((await call("generateExpansionPlan", { profileId: nkProf.id })) as any).status === "not_configured", "no key: expansion plan blocked", null);
const nkCls = (await call("classifyLeads", { profileId: nkProf.id })) as any;
check(nkCls.status === "not_configured" && nkCls.classified === 0, "no key: classification blocked", nkCls);
const nkLead = (await db.select().from(schema.leads).where(eq(schema.leads.profileId, nkProf.id)))[0]!;
const nkDraft = (await call("generateDraft", { leadId: nkLead.id })) as any;
check(nkDraft.llmStatus === "not_configured" && !nkDraft.draft, "no key: draft blocked, nothing substituted", nkDraft);
check(((await call("suggestNextExperiment", { profileId: nkProf.id })) as any).status === "not_configured", "no key: next experiment blocked", null);
check(((await call("summariseFeedback", { profileId: nkProf.id })) as any).status === "not_configured", "no key: feedback summary blocked", null);
const nkSearch = (await call("searchLiveLeads", { profileId: nkProf.id, channels: ["bluesky"], subreddits: "" })) as any;
check(nkSearch.synthesisStatus === "not_configured" && nkSearch.found === 0 && nkSearch.created === 0, "no key: live search blocked", nkSearch);
const nkLeadsFinal = await db.select().from(schema.leads).where(eq(schema.leads.profileId, nkProf.id));
const nkProfFinal = (await db.select().from(schema.profiles).where(eq(schema.profiles.id, nkProf.id)))[0]!;
check(
  nkLeadsFinal.length === 1 && !nkLeadsFinal[0]!.llmCategory && !nkLeadsFinal[0]!.draftBody &&
  (nkProfFinal.painPhrases || "[]") === "[]" &&
  (await db.select().from(schema.searchExpansions).where(eq(schema.searchExpansions.profileId, nkProf.id))).length === 0 &&
  (await db.select().from(schema.llmSummaries).where(eq(schema.llmSummaries.profileId, nkProf.id))).length === 0,
  "no key: zero AI output saved anywhere",
  null,
);
await call("deleteProfile", { id: nkProf.id });
await call("saveLlmSettings", { apiKey: "k-9999" });
// The model sometimes repeats a post id across result objects: 3 verdicts
// for 2 leads must count 2, or "synthesized" inflates past the queue.
const dupProf = (await call("createProfile", { productName: "DUP", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k", coreAction: "c" })) as any;
await call("addPastedLead", { profileId: dupProf.id, channel: "reddit", externalUrl: "https://example.com/d1", author: "A", title: "t1", body: "laid off with bills due, need help now", community: "r/x" });
await call("addPastedLead", { profileId: dupProf.id, channel: "reddit", externalUrl: "https://example.com/d2", author: "B", title: "t2", body: "laid off with bills due, need help now", community: "r/x" });
const dupLeads = await db.select().from(schema.leads).where(eq(schema.leads.profileId, dupProf.id));
const dupCtx: any = { db: () => db, inference: { complete: async () => ({ results: [{ id: dupLeads[0]!.id, category: "seed_user", confidence: 90, reason: "r", quote: "", rightPerson: true, realPain: true, workaroundOrPaying: false, recent: true }, { id: dupLeads[0]!.id, category: "seed_user", confidence: 90, reason: "r", quote: "", rightPerson: true, realPain: true, workaroundOrPaying: false, recent: true }, { id: dupLeads[1]!.id, category: "curious", confidence: 70, reason: "r", quote: "", rightPerson: true, realPain: false, workaroundOrPaying: false, recent: true }] }) }, invalidateQueries: () => {} };
const dupOut = (await (Actions.classifyLeads as any).handler(dupCtx, { profileId: dupProf.id })) as any;
check(dupOut.classified === 2, "repeated model verdict ids count once", dupOut);
await call("deleteProfile", { id: dupProf.id });
// Ensemble: a low-confidence first read gets a steelman second look, and an
// upgrade backed by the person's own quoted words is adopted.
const ensProf = (await call("createProfile", { productName: "ENS", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k", coreAction: "c" })) as any;
await call("addPastedLead", { profileId: ensProf.id, channel: "reddit", externalUrl: "https://example.com/e1", author: "A", title: "t1", body: "laid off with bills due, need help now", community: "r/x" });
const ensLead = (await db.select().from(schema.leads).where(eq(schema.leads.profileId, ensProf.id)))[0]!;
const ensCtx: any = { db: () => db, inference: { complete: async (prompt: string) => (prompt.includes("SECOND look")
  ? { results: [{ id: ensLead.id, category: "seed_user", confidence: 80, reason: "second look found own-words pain", quote: "need help now", rightPerson: true, realPain: true, workaroundOrPaying: false, recent: true }] }
  : { results: [{ id: ensLead.id, category: "irrelevant", confidence: 55, reason: "first look unsure", quote: "", rightPerson: false, realPain: false, workaroundOrPaying: false, recent: true }] }) }, invalidateQueries: () => {} };
const ensOut = (await (Actions.classifyLeads as any).handler(ensCtx, { profileId: ensProf.id })) as any;
const ensFinal = (await db.select().from(schema.leads).where(eq(schema.leads.profileId, ensProf.id)))[0]!;
check(ensOut.classified === 1 && ensFinal.llmCategory === "seed_user" && ensFinal.llmConfidence === 80 && ensFinal.llmQuote === "need help now", "unsure verdict rescued by quoted second look", { classified: ensOut.classified, cat: ensFinal.llmCategory });
await call("deleteProfile", { id: ensProf.id });
// Drafter validator: a bloated draft retries, then fails honestly — nothing saved.
const drProf = (await call("createProfile", { productName: "DR", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k", coreAction: "c" })) as any;
const drLeadRow = (await db.insert(schema.leads).values({ profileId: drProf.id, channel: "reddit", mode: "pasted", externalUrl: "https://example.com/dr", externalId: "dr1", author: "A", authorHandle: "a", title: "t", body: "laid off with bills due, need help now", postedAt: new Date().toISOString(), matchScore: 70, matchReason: "test", llmCategory: "seed_user", llmConfidence: 90, llmReason: "r", llmQuote: "need help now", llmSignals: "{}", llmHash: "h", status: "new" }).returning({ id: schema.leads.id }))[0]!;
const drCtx: any = { db: () => db, inference: { complete: async () => ({ draft: new Array(150).fill("word").join(" "), toneCheck: "t" }) }, invalidateQueries: () => {} };
const drOut = (await (Actions.generateDraft as any).handler(drCtx, { leadId: drLeadRow.id })) as any;
const drFinal = (await db.select().from(schema.leads).where(eq(schema.leads.id, drLeadRow.id)))[0]!;
check(drOut.llmStatus === "error" && !drFinal.draftBody, "bloated draft fails honestly, nothing saved", { status: drOut.llmStatus });
await call("deleteProfile", { id: drProf.id });
// Watcher validator: an experiment that drops the fixed lever is rejected — nothing saved.
const waCtx: any = { db: () => db, inference: { complete: async () => ({ experiment: "do something unrelated" }) }, invalidateQueries: () => {} };
const waProf = (await call("createProfile", { productName: "WA", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k", coreAction: "c" })) as any;
const waOut = (await (Actions.suggestNextExperiment as any).handler(waCtx, { profileId: waProf.id })) as any;
check(waOut.status === "error" && (await db.select().from(schema.llmSummaries).where(eq(schema.llmSummaries.profileId, waProf.id))).length === 0, "lever-dropping experiment rejected, nothing saved", waOut);
await call("deleteProfile", { id: waProf.id });

// 2c. Web discovery backend: Brave parser maps results to hits and drops
// junk; the key saves, reports in status, and a dead key/network fails
// honestly (never a fake pass).
const braveHits = parseBraveResults({ web: { results: [
  { title: "  Best stroller  for newborns ", url: "https://www.mumsnet.com/talk/1", description: "x" },
  { title: "", url: "https://example.com/empty-title" },
  { title: "No url here", url: "not a url" },
  { title: "AgingCare thread", url: "https://www.agingcare.com/questions/2" },
] } });
check(braveHits.length === 2 && braveHits[0].url === "https://www.mumsnet.com/talk/1" && braveHits[0].title === "Best stroller for newborns" && braveHits[1].url.includes("agingcare.com"), "brave parser maps hits, drops junk", braveHits);
check(parseBraveResults({}).length === 0 && parseBraveResults(null).length === 0, "brave parser degrades on junk input", null);
// SearXNG (self-hosted, free): same hit shape, junk dropped the same way.
const sxHits = parseSearxngResults({ results: [
  { title: "  Best stroller  for newborns ", url: "https://www.mumsnet.com/talk/1", content: "x" },
  { title: "", url: "https://example.com/empty-title" },
  { title: "No url here", url: "notaurl" },
  { title: "AgingCare thread", url: "https://www.agingcare.com/questions/2" },
] });
check(sxHits.length === 2 && sxHits[0].url === "https://www.mumsnet.com/talk/1" && sxHits[0].title === "Best stroller for newborns" && sxHits[1].url.includes("agingcare.com"), "searxng parser maps hits, drops junk", sxHits);
check(parseSearxngResults({}).length === 0 && parseSearxngResults(null).length === 0 && parseSearxngResults({ results: "junk" }).length === 0, "searxng parser degrades on junk input", null);
// 2d. Plan-named venue domains: Muse's community names/places yield domains
// for sitemap verification, minus registry forums (already covered) and junk.
const fakePlan = { communities: [
  { name: "GardenWeb Roses", where: "gardenweb.com", channel: "manual", access: "open", why: "rose talk" },
  { name: "AgingCare Q&A", where: "www.agingcare.com", channel: "agingcare", access: "open", why: "registry — already covered" },
  { name: "A photo", where: "rose.jpg", channel: "manual", access: "open", why: "not a domain" },
  { name: "GardenWeb again", where: "www.gardenweb.com/progress", channel: "manual", access: "open", why: "dup" },
] } as any;
const pds = planDomains(fakePlan);
check(pds.length === 1 && pds[0].domain === "gardenweb.com" && pds[0].name === "GardenWeb Roses", "plan domains extracted once, registry and junk skipped", pds);
check(planDomains(null).length === 0 && planDomains({ communities: [] } as any).length === 0, "plan domains degrade on empty plans", null);
const noBrave = (await call("testBraveKey", { braveKey: "" })) as any;
check(noBrave.ok === false && noBrave.status === "not_configured", "brave test with no key says so", noBrave);
const bogusBrave = (await call("testBraveKey", { braveKey: "bogus-key" })) as any;
check(bogusBrave.ok === false && typeof bogusBrave.message === "string" && bogusBrave.message.length > 0, "dead brave key/network fails honestly, never stub-passing", bogusBrave);
const braveSave = (await call("saveBraveKey", { braveKey: "BSA-test-key" })) as any;
check(braveSave.ok === true && braveSave.hasKey === true, "brave key saves", braveSave);
check((await state()).llm.hasBraveKey === true, "status reports brave key present", null);
const braveClear = (await call("saveBraveKey", { braveKey: "" })) as any;
check(braveClear.ok === true && braveClear.hasKey === false && (await state()).llm.hasBraveKey === false, "empty brave save clears the key", braveClear);

// 2b. Direct Muse Spark path: key routing, request shape, response reading,
// and fail-closed behavior with a bogus key (no real key ever needed).
check(META_MODEL === "muse-spark-1.3-contributor", "model pinned to muse-spark-1.3-contributor", META_MODEL);
check(
  isDirectKey("LLM|123|abc") === true && isDirectKey("  LLM|x") === true && isDirectKey("k-9999") === false,
  "LLM| keys route direct, others use the runtime",
);
const req = buildResponsesRequest("hello", "LLM|1|secret");
check(
  req.url === "https://api.meta.ai/v1/responses" &&
  req.headers.Authorization === "Bearer LLM|1|secret" &&
  (JSON.parse(req.body) as any).model === "muse-spark-1.3-contributor",
  "responses request: endpoint, bearer auth, pinned model",
);
check(
  JSON.stringify(extractJsonValue({ output_text: 'noise {"a":1} tail' })) === JSON.stringify({ a: 1 }) &&
  JSON.stringify(extractJsonValue({ output: [{ content: [{ text: 'x {"b":{"c":2}}' }] }] })) === JSON.stringify({ b: { c: 2 } }) &&
  JSON.stringify(extractJsonValue({ choices: [{ message: { content: '{"ok":true}' } }] })) === JSON.stringify({ ok: true }) &&
  extractJsonValue({ output_text: "no json here" }) === null &&
  extractJsonValue(null) === null,
  "response reading across API shapes, largest block wins",
);
check(
  JSON.stringify(extractJsonValue({ output_text: '[{"id":732,"category":"seed_user"},{"id":733,"category":"curious"}]' })) === JSON.stringify([{ id: 732, category: "seed_user" }, { id: 733, category: "curious" }]) &&
  JSON.stringify(extractJsonValue({ output_text: '```json\n[{"id":1}]\n```\n**Why:** notes' })) === JSON.stringify([{ id: 1 }]),
  "top-level JSON arrays extract (model verdict lists, fenced or bare)",
);
const bogus = await completeViaMetaModel("Connection test: reply ok.", "LLM|0|bogus-key-for-smoke");
check(bogus.ok === false && typeof (bogus as any).error === "string", "bogus key fails closed, never succeeds", bogus);

// 3. Profile CRUD: 3-field create, edit preserves hidden fields, delete cascades.
const p1 = (await call("createProfile", { productName: "P1", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k1, k2", coreAction: "c" })) as any;
await call("updateProfile", { id: p1.id, productName: "P1b", productDesc: "d", audience: "a", pain: "p", workaround: "w", keywords: "k1, k2", coreAction: "c" });
const p1read = (await state()).profiles.find((p: any) => p.id === p1.id);
check(p1read.productName === "P1b" && p1read.keywords === "k1, k2", "edit preserves keywords", p1read);
await call("addPastedLead", { profileId: p1.id, channel: "reddit", externalUrl: "https://example.com/t", author: "Ann", title: "t", body: "laid off and lost, no idea where to start", community: "r/x" });
await call("searchLiveLeads", { profileId: p1.id, channels: ["bluesky"], subreddits: "" });
await call("deleteProfile", { id: p1.id });
const afterDel = await state();
check(afterDel.profiles.every((p: any) => p.id !== p1.id), "delete removes profile", null);
check((await db.select().from(schema.leads).where(eq(schema.leads.profileId, p1.id))).length === 0, "delete cascades leads", null);
check((await db.select().from(schema.searchRuns).where(eq(schema.searchRuns.profileId, p1.id))).length === 0, "delete cascades search runs", null);

// 4. Empty/generic profiles never run a match-everything search.
const emptyP = (await call("createProfile", { productName: "E", productDesc: "", audience: "", pain: "", workaround: "", keywords: "", coreAction: "" })) as any;
const emptyR = (await call("searchLiveLeads", { profileId: emptyP.id, channels: ["bluesky"], subreddits: "" })) as any;
check(emptyR.found === 0 && emptyR.created === 0 && emptyR.synthesisStatus !== "ok", "empty profile searches nothing", emptyR);
const genP = (await call("createProfile", { productName: "G", productDesc: "", audience: "people", pain: "help struggle", workaround: "", keywords: "", coreAction: "" })) as any;
const genR = (await call("searchLiveLeads", { profileId: genP.id, channels: ["bluesky"], subreddits: "" })) as any;
check(genR.found === 0 && genR.created === 0, "generic-words profile searches nothing", genR);

// 5. Frozen gate corpus.
for (const c of GATE_CORPUS) {
  const a = analyseText(`${c.title} ${c.body}`, c.profile);
  check(
    a.keep === c.keep &&
    (!c.reasonIncludes || a.reason.includes(c.reasonIncludes)) &&
    (!c.reasonExcludes || !a.reason.includes(c.reasonExcludes)),
    `gate: ${c.label}`,
    { keep: a.keep, score: a.score, reason: a.reason.slice(0, 160) },
  );
}

// 5b. Founder exclusions veto: the Profile tab promises exclusions keep
// adjacent noise out of search — a post that keeps without them must drop
// with a matching one, naming the exclusion.
const exclPost = "my foundation looks cakey by noon, please help";
const exclKeep = analyseText(exclPost, MAKEUP);
const exclDrop = analyseText(exclPost, { ...MAKEUP, exclusions: JSON.stringify(["bridal", "cakey"]) });
check(exclKeep.keep === true && exclDrop.keep === false && exclDrop.reason.includes("cakey") && exclDrop.reason.includes("exclusion"), "exclusion veto drops anchored posts and names the exclusion", { keep: exclDrop.keep, reason: exclDrop.reason.slice(0, 120) });

// 6. Channel recommendations: the plan is the only picker. No plan means no
// pills — never a generic default, never a reused lineup.
const P = (comms: any[]) => ({ communities: comms }) as any;
const noPlan = channelRecsFor(WILLOW, null).recs;
check(noPlan.length === 0, "no plan → no pills, never a generic default", noPlan);
const devPlan = P([
  { name: "Ask HN", where: "Hacker News", channel: "hackernews", access: "open", why: "help requests" },
  { name: "r/forhire", where: "Reddit", channel: "reddit_poc", access: "closed", why: "gigs" },
  { name: "AgingCare Q&A", where: "www.agingcare.com", channel: "agingcare", access: "open", why: "caregiver Q&A" },
  { name: "Mystery group", where: "nowhere", channel: "telepathy", access: "open", why: "not executable" },
]);
const dRecs = channelRecsFor(DEV, devPlan).recs;
check(!!dRecs.find((r) => r.channel === "hackernews" && r.fit === "good" && !r.needsConnection) && !!dRecs.find((r) => r.channel === "reddit_poc" && r.needsConnection) && !!dRecs.find((r) => r.channel === "agingcare" && !r.needsConnection) && !dRecs.some((r) => r.channel === "telepathy"), "plan-mapped channels become pills: open hn, closed reddit, named forum; unknown channels skipped", dRecs);
check(dRecs.every((r) => r.reasons.length > 0 && r.reasons[0].includes("Muse mapped")), "every pill shows its Muse reason", dRecs.map((r) => r.reasons));
// Stack Exchange resolves only from the plan: explicit site field or a
// stackexchange.com subdomain in name/where. No site, no search — ever.
const SE_P = (comms: any[]) => ({ communities: comms }) as any;
check(JSON.stringify(seSitesFromPlan(SE_P([{ name: "DIY Stack Exchange", where: "repair Q&A", channel: "stackexchange", access: "open", why: "x", site: "diy" }]))) === JSON.stringify(["diy"]), "plan site slug resolves SE site", null);
check(JSON.stringify(seSitesFromPlan(SE_P([{ name: "Gardening", where: "diy.stackexchange.com rules", channel: "stackexchange", access: "open", why: "x" }]))) === JSON.stringify(["diy"]), "SE subdomain in name/where resolves site", null);
check(seSitesFromPlan(SE_P([{ name: "SE talk", where: "Stack Exchange", channel: "stackexchange", access: "open", why: "x" }])).length === 0, "SE community with no site never executes", null);
check(seSitesFromPlan(null).length === 0 && seSitesFromPlan({ communities: [] } as any).length === 0, "no plan → no SE sites", null);
const mProf = (await call("createProfile", { productName: "second hand market place", productDesc: "sell second hand stuff", audience: "buy and sell second hand marketplace", pain: "can't shift used goods, no buyers", workaround: "", keywords: "", coreAction: "" })) as any;
const mPlan = (await call("generateExpansionPlan", { profileId: mProf.id })) as any;
const mRun = (await call("searchRunStatus", { runId: mPlan.runId })) as any;
check(mPlan.status === "ok" && mPlan.runId > 0 && mRun.phase === "done" && mRun.detail.includes(mPlan.anchorTerm), "hunt run narrates the attempt with the real anchor", { runId: mPlan.runId, phase: mRun.phase, detail: mRun.detail?.slice(0, 120) });
const mAction = (await call("recommendChannels", { profileId: mProf.id })) as any;
{
  const open = ((mAction.recs ?? []) as any[]).filter((r) => !r.needsConnection).map((r) => r.channel);
  check(typeof mAction.webOk === "boolean" && typeof mAction.webVia === "string" && open.includes("bluesky") && open.length < 6, "stub plan maps the Bluesky pill through the action; nothing invented", { webOk: mAction.webOk, webVia: mAction.webVia, open });
}
check(parseExpansionPlan(JSON.stringify({ anchorTerm: "buy", queries: [], painPhrases: [], adjacentProblems: [], adjacentAudiences: [], communities: [{ name: "r/Flipping", where: "Reddit", channel: "reddit_poc", access: "closed", why: "flippers" }], relaxations: [], nextSuggestions: [], droppedUnanchored: 0 })) !== null, "communities-only plan parses usable", null);
// Error isolation: one channel failing degrades to that channel's error
// entry — never the run. Unconnected Reddit + Bluesky both refuse, the run
// still completes with both errors named.
const isoProf = (await call("createProfile", { productName: "ISO", productDesc: "sell second hand stuff", audience: "buy and sell second hand marketplace", pain: "can't shift used goods, no buyers", workaround: "", keywords: "", coreAction: "" })) as any;
const iso = (await call("searchLiveLeads", { profileId: isoProf.id, channels: ["reddit_poc", "bluesky"], subreddits: "" })) as any;
check(iso.runId > 0 && iso.found === 0 && iso.errors.length === 2 && iso.errors.some((e: any) => e.channel === "Reddit POC") && iso.errors.some((e: any) => e.channel === "Bluesky"), "one channel's failure never fails the run", iso.errors);
await call("deleteProfile", { id: isoProf.id });
// Plan-first: with the web check dead or alive, a plan-named pill still
// stands (badged by verification state) and a plan-named unexecutable venue
// survives with a plan badge instead of vanishing.
const pfProf = (await call("createProfile", { productName: "PF", productDesc: "sell second hand stuff", audience: "buy and sell second hand marketplace", pain: "can't shift used goods, no buyers", workaround: "", keywords: "", coreAction: "" })) as any;
await db.insert(schema.searchExpansions).values({ profileId: pfProf.id, round: 1, anchorTerm: "buy", plan: JSON.stringify({ anchorTerm: "buy", queries: [{ query: "buy second hand", intent: "x" }], painPhrases: [], adjacentProblems: [], adjacentAudiences: [], communities: [
  { name: "DIY SE", where: "diy.stackexchange.com", channel: "stackexchange", access: "open", why: "w", site: "diy" },
  { name: "Flip vids", where: "youtube.com", channel: "youtube", access: "open", why: "w", site: "" },
], relaxations: [], nextSuggestions: [], droppedUnanchored: 0 }) });
const pf = (await call("recommendChannels", { profileId: pfProf.id })) as any;
const pfSe = (pf.recs as any[]).find((r) => r.channel === "stackexchange");
check(!!pfSe && typeof pfSe.verified === "boolean", "plan-only pill stands, verification state badged", { verified: pfSe?.verified, webOk: pf.webOk });
const pfYt = (pf.venues as any[]).find((v) => v.name === "Flip vids");
check(!!pfYt && pfYt.src === "plan", "plan-named venue survives with a plan badge", pfYt);
await call("deleteProfile", { id: pfProf.id });
check(parseExpansionPlan("{}") === null && parseExpansionPlan("not json{{") === null, "empty/garbage plan parses unusable", null);
// Eurobricks stays a named forum adapter (verified 2026-11-02: IPS sitemap
// index, Topic_1 freshest, ~500 threads/file, slugs in URLs). Brickset has
// no forum any more (page points at Discord/Facebook) so a plan naming it
// resolves to nothing — the search errors honestly instead of guessing.
check(forumAdapter("eurobricks")?.label === "Eurobricks" && forumAdapter("brickset") === null && forumAdapter("nope") === null, "forum adapter resolves known forums, unknown names resolve to null", null);
// Lego, doctor, handyman: no profile ever maps a channel by itself. A plan
// naming the place pills it; without the plan there is no pill.
const LEGO = { productName: "lego lover", productDesc: "help lego lover find precious and limited lego", audience: "lego collectors hunting rare sets", pain: "rare sets sell out before I find them", workaround: "refreshing reseller listings", keywords: "", coreAction: "" };
const DOC = { productName: "help doctor take notes during patient visit", productDesc: "help doctor take notes during patient visit", audience: "help doctor take notes during patient visit", pain: "help doctor take notes during patient visit", workaround: "", keywords: "", coreAction: "" };
const HOME = { productName: "handyman finder", productDesc: "help people find handyman", audience: "homeowners with a repair list", pain: "can't find a reliable handyman for small repairs", workaround: "asking neighbors", keywords: "", coreAction: "" };
const PLANPICK = (name: string, where: string, channel: string, extra?: any) => ({ communities: [{ name, where, channel, access: "open", why: "Muse mapped it", ...(extra ?? {}) }] }) as any;
check(!!channelRecsFor(LEGO, PLANPICK("Eurobricks", "eurobricks.com", "eurobricks")).recs.find((r) => r.channel === "eurobricks" && r.fit === "good"), "plan naming Eurobricks pills it", null);
// Muse writes channel "reddit" for subreddit communities; the picker must
// normalize it to the Reddit POC pill (closed until connected), never drop it.
const rdRecs = channelRecsFor(LEGO, PLANPICK("r/plantclinic new-posts", "reddit.com", "reddit")).recs;
check(!!rdRecs.find((r) => r.channel === "reddit_poc" && r.needsConnection && r.fit === "good"), "plan channel 'reddit' normalizes to the Reddit pill (closed until connected)", rdRecs);
check(channelRecsFor(LEGO, null).recs.length === 0, "same lego profile with no plan gets no pills", null);
check(!!channelRecsFor(DOC, PLANPICK("Student Doctor Network", "forums.studentdoctor.net", "studentdoctor")).recs.find((r) => r.channel === "studentdoctor" && r.fit === "good"), "plan naming SDN pills it", null);
const HOMEPLAN = PLANPICK("DIY Stack Exchange", "diy.stackexchange.com", "stackexchange", { site: "diy" });
check(JSON.stringify(seSitesFromPlan(HOMEPLAN)) === JSON.stringify(["diy"]), "handyman plan resolves DIY Stack Exchange", seSitesFromPlan(HOMEPLAN));
check(!!channelRecsFor(HOME, HOMEPLAN).recs.find((r) => r.channel === "stackexchange" && r.fit === "good"), "plan naming DIY SE pills it", null);
// No vertical gets special normalization: every compound reads the same way.
check(normText("make-up") === "make up" && normText("set-up") === "set up" && normText("makeup") === "makeup", "normalization is uniform, no per-vertical exceptions", null);
// Hybrid retrieval: BM25 ranks the on-topic post first even when an
// off-topic post shares the common words — the pool teaches the weights.
check(JSON.stringify(bm25Order(["parents help children homework", "tutor kids math worksheets"], [
  { key: "bf", title: "minutes away from giving up bf", body: "need help giving up breastfeeding, help please" },
  { key: "dem", title: "coping with elderly parents dementia", body: "father difficult, need help with care" },
  { key: "hw", title: "helping kids with homework", body: "parents struggling every night with math homework worksheets" },
])) === JSON.stringify(["hw", "dem", "bf"]), "bm25 downweights common words, upweights domain words", null);
check(JSON.stringify(fuseRanks([["a", "b", "c", "d"], ["b", "c", "d", "a"]])) === JSON.stringify(["b", "a", "c", "d"]), "rrf fuses orderings deterministically", null);
// "wrong" is a weak anchor at best: it never anchors alone, only beside a
// real domain word — so a "what's wrong with my…" profile anchors "plant",
// never "wrong".
const WRONGP: any = { productName: "P", productDesc: "d", audience: "people with plants", pain: "what is wrong with my plant", workaround: "", keywords: "what is wrong with my plant, leaves turning yellow", coreAction: "" };
check(analyseText("something is wrong with it and I need help", WRONGP, "stackexchange").anchorPresent === false, "'wrong' alone never anchors", null);
check(analyseText("something is wrong with my plant leaves, need help", WRONGP, "stackexchange").anchorPresent === true, "'wrong' beside a domain word anchors on the domain word", null);
// The expansion prompt steers nothing: the anchor comes from the profile,
// and no product, vertical, or venue example is baked in.
const promptProbe = buildExpansionPrompt(LEGO, { painPhrasesSaved: [], anchorTerm: "lego", terms: ["lego", "rare sets"], isLaterRound: false, round: 1, context: { reason: "", found: 0, discarded: 0, synthesized: 0, seenCount: 0 }, previousQueries: [] });
check(
  promptProbe.includes('anchor term is "lego"') && !/plantclinic|gardenweb|gardening|parenting|beauty|foundation|eyeliner|\bdiy\b/i.test(promptProbe),
  "expansion prompt carries the profile anchor, never a baked-in venue",
  promptProbe.slice(promptProbe.indexOf("- communities:"), promptProbe.indexOf("- communities:") + 200),
);
check(JSON.stringify(stringishArray(["a", { term: "b", relaxTo: "c" }, 42, null, { unrelated: 1 }])) === JSON.stringify(["a", "b → c"]), "object relaxations coerce to readable strings, junk drops", null);
// Venue graph: structural one-hop parsing — fixtures only, no network.
const SE_SITES_FIXTURE = { items: [
  { api_site_parameter: "gardening", related_sites: [
    { api_site_parameter: "diy", name: "Home Improvement", site_url: "https://diy.stackexchange.com" },
    { api_site_parameter: "cooking", name: "Seasoned Advice", site_url: "https://cooking.stackexchange.com" },
    { name: "nameless", site_url: "https://example.com" },
  ] },
  { api_site_parameter: "diy", related_sites: [] },
] };
const rel = parseSeRelatedSites(SE_SITES_FIXTURE, "gardening");
check(rel.length === 2 && rel[0].apiParam === "diy" && rel[1].siteUrl === "https://cooking.stackexchange.com", "SE related_sites parse, malformed entries drop", rel);
check(parseSeRelatedSites(SE_SITES_FIXTURE, "nosuchsite").length === 0, "unknown site yields no related sites", null);
check(parseSeRelatedSites(null, "gardening").length === 0, "null payload yields no related sites", null);
check(registrable("www.EuroBricks.com") === "eurobricks.com" && registrable("x.com") === "x.com", "registrable strips www, lowercases", null);
const GRAPH_HTML = `<a href="https://www.eurobricks.com/forum/">self</a> <a href="https://brickset.com/article1">niche</a> <a href="https://www.youtube.com/watch?v=1">big</a> <a href="https://brickset.com/article2">dup</a> <a href="/relative/path">rel</a> <a href="https://github.com/x/y">code</a>`;
const outlinks = extractOutlinkDomains(GRAPH_HTML, "example-forum.com");
check(JSON.stringify(outlinks) === JSON.stringify(["eurobricks.com", "brickset.com"]), "outlinks mine niche forums, drop self/big/relative/dups", outlinks);
const gknown = new Set(["eurobricks.com"]);
const gadded: string[] = [];
const gpush = (n: string) => { gadded.push(n); };
check(seGraphVenues([{ apiParam: "diy", name: "DIY", siteUrl: "https://diy.stackexchange.com" }, { apiParam: "eb", name: "EB", siteUrl: "https://eurobricks.com/" }], "gardening", gknown, ((n: string) => gpush(n)) as never) === 1, "SE graph skips already-known hosts", gadded);
check(forumGraphVenues(["newforum.org", "eurobricks.com"], "eb", gknown, ((n: string) => gpush(n)) as never) === 1, "forum graph skips already-known domains", gadded);
// Learning loop: the founder's two overrule actions land in the ledger and
// replay deterministically against the current gate.
const evProf = (await call("createProfile", { productName: "EV", productDesc: "d", audience: "laid off workers", pain: "laid off with bills due", workaround: "w", keywords: "laid off, bills due", coreAction: "c" })) as any;
await db.insert(schema.leads).values({ profileId: evProf.id, channel: "reddit", mode: "pasted", externalUrl: "https://example.com/ev1", externalId: "ev1", title: "laid off with bills due", body: "need help now", postedAt: new Date().toISOString(), matchScore: 40, matchReason: "t", llmCategory: "irrelevant", llmConfidence: 30, llmReason: "r", llmQuote: "q", llmSignals: "{}", llmHash: "h", llmReviewed: 1, status: "new" });
await db.insert(schema.leads).values({ profileId: evProf.id, channel: "reddit", mode: "pasted", externalUrl: "https://example.com/ev2", externalId: "ev2", title: "my startup launch", body: "we just shipped v2", postedAt: new Date().toISOString(), matchScore: 80, matchReason: "t", llmCategory: "seed_user", llmConfidence: 90, llmReason: "r", llmQuote: "q", llmSignals: "{}", llmHash: "h2", status: "dismissed" });
const evRows = await collectCorrections(db as never, evProf.id);
check(evRows.length === 2 && evRows.some((r) => r.founderLabel === "relevant") && evRows.some((r) => r.founderLabel === "not-relevant"), "reviewed-kept and dismissed-classified both land in the ledger", evRows.map((r) => r.founderLabel));
const evRep = replayCorrections(evRows, { productName: "EV", productDesc: "d", audience: "laid off workers", pain: "laid off with bills due", workaround: "w", keywords: "laid off, bills due", coreAction: "c" });
check(evRep.total === 2 && evRep.ruleAgreeRate >= 0 && evRep.ruleAgreeRate <= 1 && Array.isArray(evRep.contestedTokens), "replay scores both halves and surfaces contested words", { rule: evRep.ruleAgreeRate, model: evRep.modelAgreeRate });
// Semantic rerank: prompt carries the pain and exact CAND keys (truncating
// long bodies), parsing clamps and drops invented keys.
const semPrompt = buildSemanticRerankPrompt("laid off with bills due", "laid off workers", [
  { key: "a:1", title: "laid off", body: "x".repeat(500) },
  { key: "b:2", title: "launch", body: "we shipped" },
]);
check(semPrompt.includes("laid off with bills due") && semPrompt.includes("--- CAND a:1") && semPrompt.includes("--- CAND b:2") && !semPrompt.includes("x".repeat(401)) && semPrompt.includes('"scores"'), "rerank prompt carries pain + exact keys, truncates bodies", semPrompt.length);
const semKeys = new Set(["a:1", "b:2"]);
const semMap = parseSemanticScores({ scores: [{ key: "a:1", score: 95 }, { key: "b:2", score: 12 }, { key: "ghost:9", score: 100 }, { key: "a:1", score: 50 }] }, semKeys);
check(semMap.get("a:1") === 95 && semMap.get("b:2") === 12 && !semMap.has("ghost:9"), "rerank parse keeps first score per known key, drops invented keys", [...semMap]);
const semClamp = parseSemanticScores({ scores: [{ key: "a:1", score: 150 }, { key: "b:2", score: -7 }] }, semKeys);
check(semClamp.get("a:1") === 100 && semClamp.get("b:2") === 0, "rerank scores clamp to 0-100", [...semClamp]);
check(parseSemanticScores({}, semKeys).size === 0, "empty envelope scores nobody — order falls back to lexical", null);
let semThrew = false;
try { parseSemanticScores({ scores: "nope" }, semKeys); } catch { semThrew = true; }
check(semThrew, "rerank parse rejects non-envelope output", null);
// No-candidate hunts skip the rerank with an honest message (and the
// extended response shape validates on every hunt above).
check(emptyR.semanticApplied === false && typeof emptyR.semanticMessage === "string", "empty hunt never claims a rerank", null);
check(genR.semanticApplied === false, "generic hunt never claims a rerank", null);
// The fusion skip branch itself, reached with zero candidates and no
// network: an unknown channel errors, nothing ranks, the run says so.
const evProfRow = (await db.select().from(schema.profiles).where(eq(schema.profiles.id, evProf.id)))[0]!;
const skipRun = await runChannelSearch(ctx as never, evProfRow, ["no-such-channel"], "", ["laid off with bills due"]);
check(skipRun.found === 0 && skipRun.semanticApplied === false && skipRun.semanticMessage.includes("fewer than 2"), "zero-candidate run skips rerank with an honest message", skipRun.semanticMessage);
// Funnel fields: every hunt carries per-channel rows (zero rows included)
// plus this hunt's verdict counts.
check(skipRun.channelStats.length === 1 && skipRun.channelStats[0].channel === "no-such-channel" && skipRun.channelStats[0].found === 0, "funnel lists the searched channel even at zero", skipRun.channelStats);
check(Array.isArray(emptyR.channelsSearched) && emptyR.channelStats.length === 0 && emptyR.verdicts.seedUser === 0 && emptyR.verdicts.pending === 0, "empty hunt reports an empty funnel, never omits it", null);
// Sitemap budget regression: the global 8MB fetch cap once silently dropped
// whole sitemap files (MakeupTalk's 9.3MB slice vanished — half the forum).
// The cap mechanism trips on a tiny budget, and the sitemap budget stays
// above the biggest file actually seen in the wild.
const tiny = await fetchText(`data:text/plain,${"x".repeat(100)}`, {}, 10);
check(tiny.ok === false && tiny.status === 413, "fetchText refuses bodies over budget instead of truncating", tiny.status);
check(SITEMAP_MAX_BYTES >= 10_000_000, "sitemap budget exceeds the 9.3MB file that exposed the silent drop", SITEMAP_MAX_BYTES);
// A profile's hunt belongs to its exact words: new/edited text gets a fresh
// hunt, untouched text keeps its plan — never another profile's channels.
const SIG_A = { productName: "Second hand market place", productDesc: "sell second hand stuff", audience: "buyers", pain: "no buyers", workaround: "", keywords: "", coreAction: "" };
check(profileSignature(SIG_A) === profileSignature({ ...SIG_A, productName: "SECOND HAND MARKET PLACE" }), "signature ignores case/punctuation", null);
check(profileSignature(SIG_A) !== profileSignature({ ...SIG_A, pain: "no sellers" }), "signature changes with the words", null);
const sigProf = (await call("createProfile", { ...SIG_A })) as any;
await call("generateExpansionPlan", { profileId: sigProf.id });
const plansFor = async (id: number) => ((await state()).expansions as any[]).filter((x) => x.profileId === id).length;
check((await plansFor(sigProf.id)) === 1, "new profile gains its plan", null);
await call("updateProfile", { id: sigProf.id, ...SIG_A });
check((await plansFor(sigProf.id)) === 1, "identical save keeps the plan", null);
await call("updateProfile", { id: sigProf.id, ...SIG_A, audience: "sellers and buyers", pain: "no sellers" });
check((await plansFor(sigProf.id)) === 0, "edited words retire the old plan so the hunt restarts", null);
const dRecs2 = channelRecsFor(DEV, P([
  { name: "Dev.to webdev", where: "Dev.to", channel: "devto", access: "open", why: "articles" },
  { name: "Lobsters front page", where: "Lobsters", channel: "lobsters", access: "open", why: "shop talk" },
])).recs;
check(!!dRecs2.find((r) => r.channel === "devto" && r.fit === "good") && !!dRecs2.find((r) => r.channel === "lobsters" && r.fit === "good"), "plan-mapped devto + lobsters become pills", null);
// A plan community maps its channel: Stack Exchange was never in a static
// list for makeup, but a Muse plan mapping a community there pills it.
const planVote = channelRecsFor(MAKEUP, { communities: [{ name: "r/MakeupAddiction", where: "Reddit", channel: "stackexchange", access: "open", why: "test" }] } as any).recs;
check(!!planVote.find((r) => r.channel === "stackexchange" && r.fit === "good"), "plan community maps its channel as a pill", null);
// Web venue discovery (pure parts, fixture HTML — no network): parse,
// group by venue, merge evidence, build dynamic forum objects.
const DDG_HTML = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fr%2FMakeupAddiction%2Fcomments%2Fabc%2Fx&amp;rut=1">Foundation cakey?</a><a rel="nofollow" class="result__a" href="https://www.byrdie.com/fix-cakey">Fix cakey makeup</a><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fr%2Fbeauty%2Fcomments%2Fdef%2Fy&amp;rut=2">Help</a>`;
const ddgHits = ddgResults(DDG_HTML);
check(ddgHits.length === 3 && ddgHits[0].url === "https://www.reddit.com/r/MakeupAddiction/comments/abc/x" && ddgHits[1].url === "https://www.byrdie.com/fix-cakey", "ddg results decode uddg + direct links", ddgHits);
const venues = groupVenues(ddgHits);
check(venues.length === 3 && !!venues.find((v) => v.key === "reddit:r/makeupaddiction" && v.urls.length === 1) && !!venues.find((v) => v.key === "reddit:r/beauty"), "venues group reddit subs separately from article domains", venues.map((v) => v.key));
const mgRecs = [{ channel: "mumsnet", fit: "good", reasons: ["a"] }, { channel: "hackernews", fit: "good", reasons: ["b"] }] as any;
mergeDiscovery(mgRecs, { evidence: [{ channel: "mumsnet", threads: 2, samples: ["Sleepless nights again"] }, { channel: "hackernews", threads: 5, samples: ["Show HN: sleep app"] }], dynamic: [], venues: [], webOk: false, webVia: "" });
check(mgRecs[0].fit === "good" && mgRecs[0].reasons.length === 2 && mgRecs[0].reasons[1].includes("Sleepless nights again") && mgRecs[1].fit === "good" && mgRecs[1].reasons.length === 2, "merge appends web evidence to plan pills, never rescues or demotes", mgRecs);
const dynForum = dynamicForumFor("forum:alz-org", { evidence: [], dynamic: [{ slug: "alz-org", label: "Alzconnected", domain: "alzconnected.org", index: "https://alzconnected.org/sitemap.xml", files: ["https://alzconnected.org/sitemap-2.xml"], flat: false }], venues: [] });
check(!!dynForum && dynForum.channel === "forum:alz-org" && dynForum.label === "Alzconnected" && (dynForum.sections[0] as any).token === "https://alzconnected.org/sitemap-2.xml" && dynamicForumFor("forum:nope", { evidence: [], dynamic: [], venues: [] }) === null, "dynamic forum object carries exact verified file tokens; unknown slug misses", dynForum);
const dtCand = devtoCandidate({ id: 1, title: "t", description: "d", url: "https://dev.to/x", user: { username: "u" }, published_at: "2026-01-01" }, DEV, 1);
const loCand = lobstersCandidate({ short_id: "abc", title: "t", description_plain: "d", comments_url: "https://lobste.rs/s/abc", submitter_user: "u", created_at: "2026-01-01", tags: ["a", "b"] }, DEV, 1);
check(!!dtCand && dtCand.values.channel === "devto" && !!loCand && loCand.values.channel === "lobsters" && String(loCand.values.community).includes("a"), "devto/lobsters candidate builders shape leads", null);
const sRecs = channelRecsFor(SECONDHIFT, P([{ name: "r/forhire", where: "Reddit", channel: "reddit_poc", access: "closed", why: "gigs" }])).recs;
const sRd = sRecs.find((r) => r.channel === "reddit_poc");
check(!!sRd && sRd.needsConnection && sRd.fit === "good", "plan-mapped Reddit surfaces with connection note", sRd);
await call("generateExpansionPlan", { profileId: demo1.profileId });
const recAction = (await call("recommendChannels", { profileId: demo1.profileId })) as any;
check(recAction.status === "ok" && Array.isArray(recAction.recs) && recAction.recs.length > 0 && recAction.recs.every((r: any) => typeof r.channel === "string" && Array.isArray(r.reasons)), "recommendChannels action answers with plan pills", recAction.message);
check(typeof recAction.webVia === "string", "recommendChannels names its web backend", { webVia: recAction.webVia });

// 7. Fetch retry policy: GETs retry on 500/network, never POSTs or 4xx.
check(
  shouldRetryFetch(0, "GET", 0) === true && shouldRetryFetch(500, "GET", 1) === true &&
  shouldRetryFetch(500, "GET", 2) === false && shouldRetryFetch(404, "GET", 0) === false &&
  shouldRetryFetch(500, "POST", 0) === false && shouldRetryFetch(200, "GET", 0) === false,
  "retry matrix",
);

// 8. Kinship matcher units: exact-first ordering, abbreviations, misses.
check(
  synonymsFor("mom")[0] === "mom" && synonymsFor("mom").includes("father") &&
  synonymsFor("mom").includes("lo") && synonymsFor("mom").includes("dh") &&
  JSON.stringify(synonymsFor("traction")) === JSON.stringify(["traction"]),
  "synonym families expand kin, leave other terms alone",
);
check(
  matchVariant("my father has dementia", "mom") === "father" &&
  matchVariant("caring for my lo", "mom") === "lo" &&
  matchVariant("dm me for deals", "mom") === null &&
  matchVariant("my mom is here", "mom") === "mom" &&
  matchVariant("hello world", "mom") === null,
  "variant matching: exact first, abbreviations, clean misses",
);

// 9. Sitemap forums: de-slug, parse, per-profile mapping + sections.
check(
  slugTitleFor("https://www.agingcare.com/questions/85-yr-old-dad-with-dementia-refuses-to-take-a-bath-or-shower-i-am-at-my-wits-end-445854.htm") ===
    "85 yr old dad with dementia refuses to take a bath or shower i am at my wits end",
  "agingcare slug de-slugs",
);
check(
  slugTitleFor("https://www.mumsnet.com/talk/sleep/4380163-How-do-I-get-my-baby-to-sleep-through-the-night") ===
    "How do I get my baby to sleep through the night",
  "mumsnet leading-id slug de-slugs",
);
check(
  slugTitleFor("https://www.mumsnet.com/talk/sleep/short-1") === "" &&
  slugTitleFor("https://www.agingcare.com/") === "" &&
  slugTitleFor("https://www.agingcare.com/questions/27-years-old-and-living-with-my-mil-74-she-shows-signs-of-dementia-491070.htm").startsWith("27 years old"),
  "short/index URLs rejected, ages kept",
);
const idxXml = `<sitemapindex><sitemap><loc>https://www.agingcare.com/sitemaps/content-questions1.xml</loc></sitemap><sitemap><loc>https://www.agingcare.com/sitemaps/default1.xml</loc></sitemap></sitemapindex>`;
const urlXml = `<urlset><url><loc>https://www.agingcare.com/questions/a-real-thread-title-here-456791.htm</loc><lastmod>2026-09-01</lastmod></url><url><loc>https://www.agingcare.com/questions/other-title-here-123.htm</loc></url></urlset>`;
check(
  sitemapLocs(idxXml, "sitemap").length === 2 &&
  sitemapLocs(urlXml, "url")[0]?.lastmod === "2026-09-01" &&
  sitemapLocs(urlXml, "url")[1]?.lastmod === "" &&
  sitemapLocs(urlXml, "url", 1).length === 1,
  "sitemap index + urlset parse with lastmod and cap",
);
// 9. Sitemap forums: the registry is only fetch instructions — no profile
// input anywhere. Forums are picked by the plan (forumAdapter resolves
// names); sections filter by token only, and the anchor gate drops
// off-topic threads downstream.
const acForum = forumAdapter("agingcare");
const mnForum = forumAdapter("mumsnet");
const mtForum = forumAdapter("makeuptalk");
if (!acForum || !mnForum || !mtForum) throw new Error("SMOKE FAIL: forum adapter missing");
check(forumAdapter("brickset") === null && forumAdapter("nope") === null, "unknown forum names resolve to null, never guessed", null);
check(
  JSON.stringify(filterSitemapLocs(mtForum, ["https://www.makeuptalk.com/sitemap-1.xml", "https://www.makeuptalk.com/sitemap-4.xml", "https://www.makeuptalk.com/sitemap-3.xml", "https://www.makeuptalk.com/threads/eyeliner.6/"])) === JSON.stringify(["https://www.makeuptalk.com/sitemap-4.xml", "https://www.makeuptalk.com/sitemap-3.xml"]),
  "makeuptalk fetches newest content files only, never old files or thread urls",
);
const lsaForum = forumAdapter("lipstickalley");
if (!lsaForum) throw new Error("SMOKE FAIL: lipstickalley adapter missing");
check(
  JSON.stringify(filterSitemapLocs(lsaForum, ["https://www.lipstickalley.com/sitemap-1.xml", "https://www.lipstickalley.com/sitemap-43.xml", "https://www.lipstickalley.com/sitemap-42.xml"])) === JSON.stringify(["https://www.lipstickalley.com/sitemap-43.xml", "https://www.lipstickalley.com/sitemap-42.xml"]),
  "lipstickalley fetches newest content files only",
);
const MN_LOCS = [
  "https://www.mumsnet.com/sitemap/talk/parenting/parenting_1",
  "https://www.mumsnet.com/sitemap/talk/sleep/sleep_2",
  "https://www.mumsnet.com/sitemap/talk/pregnancy/pregnancy_1",
  "https://www.mumsnet.com/sitemap/talk/eco-friendly-parenting/eco-friendly-parenting_1",
  "https://www.mumsnet.com/sitemap/talk/elderly_parents/elderly_parents_1",
  "https://www.mumsnet.com/sitemap/talk/money-matters/money-matters_1",
];
check(
  JSON.stringify(filterSitemapLocs(mnForum, MN_LOCS)) === JSON.stringify([MN_LOCS[0], MN_LOCS[1], MN_LOCS[2], MN_LOCS[4], MN_LOCS[5]]),
  "every listed section fetches when the plan picks the forum; eco lookalikes never match the token",
);
check(
  JSON.stringify(filterSitemapLocs(acForum, ["https://www.agingcare.com/sitemaps/content-questions1.xml", "https://www.agingcare.com/sitemaps/content-articles1.xml"])) ===
    JSON.stringify(["https://www.agingcare.com/sitemaps/content-questions1.xml"]),
  "agingcare fetches questions, never articles",
);
const KEEP_URL = "https://www.agingcare.com/questions/83-yr-old-mother-in-law-with-dementia-cant-be-alone-has-no-money-for-home-care-hates-where-we-live-456791.htm";
const keepCand = sitemapCandidate({ url: KEEP_URL, title: slugTitleFor(KEEP_URL), lastmod: "2026-09-01", community: "AgingCare Q&A" }, acForum, WILLOW, 1);
check(
  !!keepCand && keepCand.s.keep && keepCand.s.score > 0 &&
  keepCand.values.matchReason.includes("Thread-title match on AgingCare") &&
  keepCand.values.body === "" && keepCand.key.startsWith("agingcare:https://www.agingcare.com/questions/"),
  "real pain thread keeps as title-only candidate",
);

// 10. Stack Exchange sites come only from the plan — never a static list.
const SEDEV = { communities: [{ name: "Stack Overflow", where: "stackoverflow.com", channel: "stackexchange", access: "open", why: "code", site: "stackoverflow" }] } as any;
const SECAR = { communities: [{ name: "Workplace", where: "work", channel: "stackexchange", access: "open", why: "jobs", site: "workplace" }, { name: "Freelancing", where: "work", channel: "stackexchange", access: "open", why: "gigs", site: "freelancing" }] } as any;
check(JSON.stringify(seSitesFromPlan(SEDEV)) === JSON.stringify(["stackoverflow"]), "plan site slug resolves SE site", null);
check(JSON.stringify(seSitesFromPlan(SECAR)) === JSON.stringify(["workplace", "freelancing"]), "two plan sites resolve in order", null);
check(seSitesFromPlan({ communities: [{ name: "SE talk", where: "Stack Exchange", channel: "stackexchange", access: "open", why: "x" }] } as any).length === 0, "SE without a site never executes", null);
const seQ = seCandidate({ question_id: 123, owner: { display_name: "Ann" }, title: "How do I &amp; test?", body: "<p>body here</p>", link: "https://stackoverflow.com/q/123", creation_date: 1700000000 }, "stackoverflow", DEV, 1);
check(!!seQ && seQ.key === "se:stackoverflow:123" && seQ.values.title === "How do I & test?" && seQ.values.community === "stackoverflow", "fixture question → decoded candidate", null);
check(seCandidate({ owner: {} }, "stackoverflow", DEV, 1) === null, "question without id → null", null);

// 11. Classify → draft → approve → sent → nudge loop, plus gates.
const fp = (await call("createProfile", { productName: "Flow", productDesc: "d", audience: "Recently laid-off workers", pain: "Laid off, no idea where to start", workaround: "", keywords: "laid off, side hustle", coreAction: "" })) as any;
const pl = (await call("addPastedLead", { profileId: fp.id, channel: "reddit", externalUrl: "https://example.com/r", author: "Bo", title: "laid off", body: "Laid off last week, no idea where to start with side hustles", community: "r/x" })) as any;
const gateTrial = (await call("setLeadStatus", { leadId: pl.id, status: "trial" })) as any;
check(gateTrial.ok === false, "trial blocked before Muse classification", gateTrial);
const gateApproved = (await call("setLeadStatus", { leadId: pl.id, status: "approved" })) as any;
check(gateApproved.ok === false, "approve blocked before Muse classification", gateApproved);
const cls = (await call("classifyLeads", { profileId: fp.id })) as any;
check(cls.status === "ok" && cls.classified === 1, "stub classifies waiting lead", cls);
const cat = (await state()).leads.find((l: any) => l.id === pl.id)?.llmCategory;
check(cat === "seed_user", "stub verdict recorded", cat);
const dr = (await call("generateDraft", { leadId: pl.id })) as any;
check(dr.llmStatus === "ok" && dr.draft.includes("[local-stub]"), "stub draft generated", dr);
const ap = (await call("approveAndPost", { leadId: pl.id })) as any;
check(ap.posted === false, "pasted channel parks at approved (manual send)", ap);
const st = (await call("setLeadStatus", { leadId: pl.id, status: "sent" })) as any;
check(st.ok === true, "sent after classification", st);
let fups = (await state()).followups.filter((f: any) => f.leadId === pl.id);
check(fups.length === 1 && typeof fups[0].dueAt === "string", "sent creates one reply nudge", fups);
const nudged = (await call("answerNudge", { followupId: fups[0].id, outcome: "replied" })) as any;
check(nudged.ok === true, "replied closes nudge", nudged);
const afterReply = await state();
check(afterReply.leads.find((l: any) => l.id === pl.id)?.status === "replied", "reply moves lead", null);
check(afterReply.followups.filter((f: any) => f.leadId === pl.id).length === 0, "reply clears nudges", null);
const pl2 = (await call("addPastedLead", { profileId: fp.id, channel: "reddit", externalUrl: "https://example.com/r2", author: "Cy", title: "laid off", body: "Laid off, need income now", community: "r/x" })) as any;
await call("classifyLeads", { profileId: fp.id });
await call("generateDraft", { leadId: pl2.id });
await call("approveAndPost", { leadId: pl2.id });
await call("setLeadStatus", { leadId: pl2.id, status: "sent" });
const f2Before = (await state()).followups.find((f: any) => f.leadId === pl2.id)?.dueAt ?? "";
const snoozed = (await call("answerNudge", { followupId: (await state()).followups.find((f: any) => f.leadId === pl2.id)?.id ?? 0, outcome: "snoozed" })) as any;
check(snoozed.ok === true, "snooze replaces the nudge", snoozed);
const f2After = (await state()).followups.find((f: any) => f.leadId === pl2.id)?.dueAt ?? "";
check(f2After >= f2Before, "snooze pushes due date out", { f2Before, f2After });
const pl3 = (await call("addPastedLead", { profileId: fp.id, channel: "reddit", externalUrl: "https://example.com/r3", author: "De", title: "laid off", body: "Laid off, bills due", community: "r/x" })) as any;
await call("classifyLeads", { profileId: fp.id });
await call("generateDraft", { leadId: pl3.id });
await call("approveAndPost", { leadId: pl3.id });
await call("setLeadStatus", { leadId: pl3.id, status: "sent" });
const f3 = (await state()).followups.find((f: any) => f.leadId === pl3.id);
const stopped = (await call("answerNudge", { followupId: f3?.id ?? 0, outcome: "stopped" })) as any;
check(stopped.ok === true, "stop clears nudge", stopped);
await call("setLeadStatus", { leadId: pl3.id, status: "sent" });
check((await state()).followups.filter((f: any) => f.leadId === pl3.id).length === 0, "stopped nudge never resurrects", null);
const noNudge = (await call("answerNudge", { followupId: 999999, outcome: "replied" })) as any;
check(noNudge.ok === false, "unknown nudge → failure", noNudge);
const noDraft = (await call("updateDraft", { leadId: 999999, draftBody: "x" })) as any;
check(noDraft.ok === false, "missing draft → failure", noDraft);

// 12. Search-run progress rows.
const sr = (await call("searchLiveLeads", { profileId: fp.id, channels: ["bluesky"], subreddits: "" })) as any;
check(sr.runId > 0 && sr.found === 0, "unconnected channel run recorded, nothing found", sr);
const runSt = (await call("searchRunStatus", { runId: sr.runId })) as any;
check(runSt.phase === "done" && runSt.detail.includes("Checked 0 posts"), "run status narrates plain summary", runSt);
const runMissing = (await call("searchRunStatus", { runId: 999999 })) as any;
check(runMissing.phase === "done" && runMissing.detail === "No such run.", "unknown run → honest miss", runMissing);

// 13. Cohort events: founder-side logEvent and snippet-side recordEvent.
const demoInv = (await state()).invites.find((i: any) => i.code === "DEMO-01");
const logOk = (await call("logEvent", { inviteId: demoInv.id, eventType: "core", note: "smoke" })) as any;
check(logOk.ok === true, "logEvent records founder-side event", logOk);
const logBad = (await call("logEvent", { inviteId: 999999, eventType: "core", note: "" })) as any;
check(logBad.ok === false, "logEvent rejects unknown invite", logBad);
const recOk = (await call("recordEvent", { code: "demo-01", eventType: "started", note: "smoke" })) as any;
check(recOk.ok === true && typeof recOk.message === "string", "recordEvent accepts invite code (any case)", recOk);
const recBad = (await call("recordEvent", { code: "NOPE-00", eventType: "started", note: "" })) as any;
check(recBad.ok === false, "recordEvent rejects unknown code", recBad);

// 14. Stub-data purge: stub-tagged phrases, verdicts and drafts clear;
// real content and decided leads survive.
const sp = (await call("createProfile", { productName: "Stubby", productDesc: "d", audience: "a", pain: "p", workaround: "", keywords: "", coreAction: "" })) as any;
await call("expandPainLanguage", { profileId: sp.id });
await call("applyExpansionToKeywords", { profileId: sp.id });
const spKw = ((await state()).profiles as any[]).find((p) => p.id === sp.id)?.keywords ?? "";
check(!spKw.includes("[local-stub]"), "stub phrases never fold into real keywords", spKw);
const sl = (await call("addPastedLead", { profileId: sp.id, channel: "reddit", externalUrl: "https://example.com/s", author: "Zed", title: "laid off", body: "Laid off, need income now", community: "r/x" })) as any;
await call("classifyLeads", { profileId: sp.id });
await call("generateDraft", { leadId: sl.id });
const before = (await state());
const beforeLead = before.leads.find((l: any) => l.id === sl.id);
check(beforeLead?.llmReason.includes("[local-stub]") === true, "stub verdict present before purge", null);
await call("generateExpansionPlan", { profileId: sp.id });
const purge = (await call("purgeStubData", {})) as any;
check(purge.ok === true && purge.profilesCleared >= 1 && purge.leadsCleared >= 1 && purge.expansionsCleared >= 1, "purge clears stub profiles, leads and plans", purge);
const spPlansLeft = ((await state()).expansions as any[]).filter((x) => x.profileId === sp.id).length;
check(spPlansLeft === 0, "stub plan gone so auto-plan refires after purge", null);
const after = (await state());
const afterProf = after.profiles.find((p: any) => p.id === sp.id);
const afterLead = after.leads.find((l: any) => l.id === sl.id);
check(afterProf?.painPhrases === "[]" && afterLead?.llmCategory === "" && afterLead?.draftBody === "", "stub phrases, verdict and draft cleared; lead unclassified", { pain: afterProf?.painPhrases, cat: afterLead?.llmCategory });

console.log(`\nSMOKE PASSED (${n} checks)`);
