// Channel feasibility gate: no channel is called feasible OR infeasible
// without running this. Each spec probes the keyless surface from THIS
// machine AND (for implemented channels) runs a scratch profile through the
// real recommendChannels + searchLiveLeads flow, then deletes the scratch.
// Usage: bun local/verify-channel.ts [name|all]   (exit 1 on any mismatch)
process.env.LOCAL_NO_SERVE = "1";
const { handleRequest } = await import("./server.ts");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function probe(url: string): Promise<{ status: number; bytes: number; text: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json" }, signal: ctrl.signal });
    const text = await r.text().catch(() => "");
    clearTimeout(t);
    return { status: r.status, bytes: text.length, text: text.slice(0, 4000) };
  } catch {
    return { status: 0, bytes: 0, text: "" };
  }
}

type Expect = "sitemap" | "sniff" | "blocked" | "unusable";
type ProbeSpec = { url: string; expect: Expect; sniff?: RegExp; note: string };
type Spec = {
  name: string; verdict: "feasible" | "infeasible"; why: string;
  probes: ProbeSpec[];
  profile?: Record<string, string>; searchChannels?: string[];
  expectOpenSubset?: string[]; expectCreatedMin?: number;
};
const LOGIN = /\/login\/|reason=lor|log in/i;
const CHALLENGE = /challenge-platform|just a moment|captcha|cf-chl/i;
const GONEPAGE = /error\?404|page not found|not be found/i;

const SPECS: Spec[] = [
  {
    name: "eurobricks", verdict: "feasible", why: "public IPS sitemap index, fresh thread slugs, searched live",
    probes: [{ url: "https://www.eurobricks.com/forum/sitemap.php", expect: "sitemap", note: "index must list topic files" }],
    profile: { productName: "lego lover", productDesc: "help lego lover find precious and limited lego", audience: "lego collectors hunting rare sets", pain: "rare sets sell out before I find them", workaround: "refreshing reseller listings", keywords: "", coreAction: "" },
    searchChannels: ["eurobricks"], expectOpenSubset: ["eurobricks", "bluesky"], expectCreatedMin: 1,
  },
  {
    name: "reddit", verdict: "infeasible", why: "keyless JSON is bot-walled; only the connected Reddit POC can search",
    probes: [
      { url: "https://www.reddit.com/r/lego/search.json?q=rare+set&restrict_sr=1&limit=5&sort=new", expect: "blocked", note: "403 block page expected" },
      { url: "https://old.reddit.com/r/lego/search.json?q=rare+set&restrict_sr=1&limit=5&sort=new", expect: "blocked", note: "login redirect expected" },
    ],
  },
  {
    name: "brickset", verdict: "infeasible", why: "forum closed (page points at Discord/Facebook); main-site sitemap 404s; forum subdomain dead",
    probes: [
      { url: "https://brickset.com/sitemap.xml", expect: "unusable", note: "serves error page, not a sitemap" },
      { url: "https://forum.brickset.com/", expect: "unusable", note: "subdomain dead" },
      { url: "https://brickset.com/forum", expect: "sniff", sniff: /discord|facebook/i, note: "community moved off-forum" },
    ],
  },
  {
    name: "petforums", verdict: "infeasible", why: "unreachable from the app network (previously Cloudflare-walled); homepage included",
    probes: [
      { url: "https://www.petforums.com/sitemap.xml", expect: "unusable", note: "no thread surface reachable" },
      { url: "https://www.petforums.com/", expect: "unusable", note: "homepage itself unreachable" },
    ],
  },
];

async function call(action: string, args: Record<string, unknown>) {
  const req = new Request("http://localhost/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, args }) });
  return handleRequest(req).then((r) => r.json() as Promise<any>);
}
function probePass(p: ProbeSpec, r: { status: number; bytes: number; text: string }): { ok: boolean; saw: string } {
  const isSitemap = r.text.includes("<sitemapindex") || r.text.includes("<urlset");
  if (p.expect === "sitemap") return { ok: r.status === 200 && isSitemap, saw: `http ${r.status}, ${r.bytes}b, sitemap-xml=${isSitemap}` };
  if (p.expect === "sniff") return { ok: r.status === 200 && !!p.sniff?.test(r.text), saw: `http ${r.status}, sniff=${!!p.sniff?.test(r.text)}` };
  if (p.expect === "blocked") return { ok: r.status === 403 || r.status === 429 || LOGIN.test(r.text) || CHALLENGE.test(r.text), saw: `http ${r.status}, login=${LOGIN.test(r.text)}, challenge=${CHALLENGE.test(r.text)}` };
  const dead = r.status === 0 || r.status >= 400 || GONEPAGE.test(r.text) || CHALLENGE.test(r.text);
  return { ok: dead, saw: `http ${r.status}, ${r.bytes}b, gone-page=${GONEPAGE.test(r.text)}, challenge=${CHALLENGE.test(r.text)}` };
}

let failures = 0;
const only = process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : null;
for (const spec of SPECS) {
  if (only && spec.name !== only) continue;
  console.log(`\n## ${spec.name} (claimed: ${spec.verdict}) — ${spec.why}`);
  for (const p of spec.probes) {
    const r = await probe(p.url);
    const { ok, saw } = probePass(p, r);
    if (!ok) failures++;
    console.log(` ${ok ? "ok  " : "FAIL"} probe ${p.url}\n      expect=${p.expect} saw: ${saw} (${p.note})`);
  }
  if (spec.profile && spec.searchChannels) {
    let pid = 0;
    try {
      const c = await call("createProfile", spec.profile);
      pid = c.id;
      const recs = await call("recommendChannels", { profileId: pid });
      const open = recs.recs.filter((x: any) => !x.needsConnection && x.fit !== "poor").map((x: any) => x.channel);
      const mapped = (spec.expectOpenSubset ?? []).every((x) => open.includes(x));
      if (!mapped) failures++;
      console.log(` ${mapped ? "ok  " : "FAIL"} lineup open=[${open.join(", ")}] want subset [${(spec.expectOpenSubset ?? []).join(", ")}]`);
      const s = await call("searchLiveLeads", { profileId: pid, channels: spec.searchChannels, subreddits: "" });
      const createdOk = (s.created ?? 0) >= (spec.expectCreatedMin ?? 1) && !(s.errors ?? []).length;
      if (!createdOk) failures++;
      console.log(` ${createdOk ? "ok  " : "FAIL"} live search found=${s.found} created=${s.created} discarded=${s.discarded} errors=${JSON.stringify(s.errors)}`);
    } finally {
      if (pid) await call("deleteProfile", { id: pid });
    }
  }
}
console.log(failures ? `\nVERIFY-CHANNEL FAILED (${failures} mismatch${failures === 1 ? "" : "es"})` : "\nVERIFY-CHANNEL PASSED");
process.exit(failures ? 1 : 0);
