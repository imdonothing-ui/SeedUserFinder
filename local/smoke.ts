// In-process smoke test: drives the REAL action handlers (same code the
// artifact runtime and `local/server.ts` call) against real local SQLite with
// stub inference. Run: `bun local/smoke.ts`. Uses a throwaway database so
// `local/data/app.db` is never touched.

import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { complete } from "./inference-stub.ts";
import { Actions, analyseText, shouldRetryFetch, matchVariant, synonymsFor, sitemapLocs, slugTitleFor, sitemapForumsFor, filterSitemapLocs, sitemapCandidate, channelRecsFor, stackSitesFor, seCandidate } from "../server/src/actions.ts";
import { META_MODEL, buildResponsesRequest, extractJsonValue, isDirectKey, completeViaMetaModel } from "../server/src/meta-api.ts";
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
  founderVoice: "", updatedAt: Date.now(),
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

// 1. Version readout for knowing which build is under test.
const ver = (await call("getVersion", {})) as any;
check(ver.version === "0.2.0" && typeof ver.sha === "string" && typeof ver.dirty === "boolean", "version shape", ver);
check(typeof ver.label === "string" && ver.label.startsWith("0.2.0 ·"), "version label", ver);

// 2. Key-only AI setup: key + voice in, models automatic, nothing to pick.
await call("saveLlmSettings", { apiKey: "k-9999", founderVoice: "plain" });
const llm = (await state()).llm;
check(llm.hasKey === true && llm.smallModel === "auto" && llm.largeModel === "auto", "key-only setup stores key, models auto", llm);
const tst = (await call("testLlmConnection", {})) as any;
check(tst.ok === true, "stub connection test passes", tst);

// 2b. Direct Muse Spark path: key routing, request shape, response reading,
// and fail-closed behavior with a bogus key (no real key ever needed).
check(META_MODEL === "muse-spark-1.3", "model pinned to muse-spark-1.3", META_MODEL);
check(
  isDirectKey("LLM|123|abc") === true && isDirectKey("  LLM|x") === true && isDirectKey("k-9999") === false,
  "LLM| keys route direct, others use the runtime",
);
const req = buildResponsesRequest("hello", "LLM|1|secret");
check(
  req.url === "https://api.meta.ai/v1/responses" &&
  req.headers.Authorization === "Bearer LLM|1|secret" &&
  (JSON.parse(req.body) as any).model === "muse-spark-1.3",
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

// 6. Profile-aware channel recommendations.
const wRecs = channelRecsFor(WILLOW, null).recs;
const wAc = wRecs.find((r) => r.channel === "agingcare");
const wGh = wRecs.find((r) => r.channel === "github");
const wHn = wRecs.find((r) => r.channel === "hackernews");
check(!!wAc && wAc.fit === "best" && !wAc.needsConnection, "caregiver: AgingCare best + open", wAc);
check(!!wGh && wGh.fit === "poor" && !!wHn && wHn.fit === "poor", "caregiver: dev channels poor", { wGh, wHn });
const dRecs = channelRecsFor(DEV, null).recs;
const dHn = dRecs.find((r) => r.channel === "hackernews");
const dGh = dRecs.find((r) => r.channel === "github");
const dAc = dRecs.find((r) => r.channel === "agingcare");
check(!!dHn && dHn.fit !== "poor" && !!dGh && dGh.fit !== "poor", "dev: HN + GitHub viable", { dHn, dGh });
check(!!dAc && dAc.fit === "poor", "dev: AgingCare poor", dAc);
const mRecs = channelRecsFor(MAKEUP, null).recs;
check(!!mRecs.find((r) => r.channel === "hackernews" && r.fit === "poor") && !!mRecs.find((r) => r.channel === "github" && r.fit === "poor"), "makeup: HN + GitHub poor", null);
const sRecs = channelRecsFor(SECONDHIFT, null).recs;
const sRd = sRecs.find((r) => r.channel === "reddit_poc");
check(!!sRd && sRd.needsConnection && sRd.fit !== "poor", "career: Reddit surfaced with connection note", sRd);
const recAction = (await call("recommendChannels", { profileId: demo1.profileId })) as any;
check(recAction.status === "ok" && Array.isArray(recAction.recs) && recAction.recs.length > 0, "recommendChannels action answers", recAction.message);

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
const DEV_LIKE = { productName: "MergePilot", productDesc: "api status page for deploy pipelines", audience: "developers shipping web apps", pain: "pull request checks keep failing", workaround: "", keywords: "api, pull request", coreAction: "" };
const MOMDAD_LIKE = { productName: "RentSplit", productDesc: "split bills with family", audience: "help my mom and dad pay rent", pain: "bills piling up every month", workaround: "", keywords: "", coreAction: "" };
check(
  sitemapForumsFor(WILLOW).map((f) => f.channel).join(",") === "agingcare,mumsnet" &&
  sitemapForumsFor(DAWNLITE).map((f) => f.channel).join(",") === "mumsnet" &&
  sitemapForumsFor(DEV_LIKE).length === 0 &&
  sitemapForumsFor(MOMDAD_LIKE).map((f) => f.channel).join(",") === "mumsnet",
  "forum mapping: willow both, dawn mumsnet, dev none, rent-split mumsnet-money",
);
const acForum = sitemapForumsFor(WILLOW).find((f) => f.channel === "agingcare");
const mnForum = sitemapForumsFor(DAWNLITE).find((f) => f.channel === "mumsnet");
if (!acForum || !mnForum) throw new Error("SMOKE FAIL: forum mapping missing");
const MN_LOCS = [
  "https://www.mumsnet.com/sitemap/talk/parenting/parenting_1",
  "https://www.mumsnet.com/sitemap/talk/sleep/sleep_2",
  "https://www.mumsnet.com/sitemap/talk/pregnancy/pregnancy_1",
  "https://www.mumsnet.com/sitemap/talk/eco-friendly-parenting/eco-friendly-parenting_1",
  "https://www.mumsnet.com/sitemap/talk/elderly_parents/elderly_parents_1",
  "https://www.mumsnet.com/sitemap/talk/money-matters/money-matters_1",
];
check(
  JSON.stringify(filterSitemapLocs(mnForum, MN_LOCS, DAWNLITE)) === JSON.stringify([MN_LOCS[0], MN_LOCS[1]]),
  "dawn fetches parenting + sleep, never eco lookalikes or pregnancy",
);
check(
  JSON.stringify(filterSitemapLocs(mnForum, MN_LOCS, WILLOW)) === JSON.stringify([MN_LOCS[0], MN_LOCS[4]]),
  "willow fetches parenting + elderly_parents sections",
);
check(
  JSON.stringify(filterSitemapLocs(mnForum, MN_LOCS, MOMDAD_LIKE)) === JSON.stringify([MN_LOCS[5]]),
  "rent-split fetches money section only",
);
check(
  JSON.stringify(filterSitemapLocs(acForum, ["https://www.agingcare.com/sitemaps/content-questions1.xml", "https://www.agingcare.com/sitemaps/content-articles1.xml"], WILLOW)) ===
    JSON.stringify(["https://www.agingcare.com/sitemaps/content-questions1.xml"]),
  "agingcare fetches questions + discussions, never articles",
);
const KEEP_URL = "https://www.agingcare.com/questions/83-yr-old-mother-in-law-with-dementia-cant-be-alone-has-no-money-for-home-care-hates-where-we-live-456791.htm";
const keepCand = sitemapCandidate({ url: KEEP_URL, title: slugTitleFor(KEEP_URL), lastmod: "2026-09-01", community: "AgingCare Q&A" }, acForum, WILLOW, 1);
check(
  !!keepCand && keepCand.s.keep && keepCand.s.score >= 38 &&
  keepCand.values.matchReason.includes("Thread-title match on AgingCare") &&
  keepCand.values.body === "" && keepCand.key.startsWith("agingcare:https://www.agingcare.com/questions/"),
  "real pain thread keeps as title-only candidate",
);

// 10. Stack Exchange mapping + candidate decoding.
check(JSON.stringify(stackSitesFor(DEV_LIKE)) === JSON.stringify(["stackoverflow"]), "dev → stackoverflow", null);
check(JSON.stringify(stackSitesFor(SECONDHIFT)) === JSON.stringify(["workplace", "freelancing"]), "career → workplace + freelancing", null);
check(JSON.stringify(stackSitesFor(WILLOW)) === JSON.stringify(["parenting"]), "family → parenting", null);
check(stackSitesFor(MAKEUP).length === 0, "makeup → no community, skipped blindly", null);
const seQ = seCandidate({ question_id: 123, owner: { display_name: "Ann" }, title: "How do I &amp; test?", body: "<p>body here</p>", link: "https://stackoverflow.com/q/123", creation_date: 1700000000 }, "stackoverflow", DEV_LIKE, 1);
check(!!seQ && seQ.key === "se:stackoverflow:123" && seQ.values.title === "How do I & test?" && seQ.values.community === "stackoverflow", "fixture question → decoded candidate", null);
check(seCandidate({ owner: {} }, "stackoverflow", DEV_LIKE, 1) === null, "question without id → null", null);

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

console.log(`\nSMOKE PASSED (${n} checks)`);
