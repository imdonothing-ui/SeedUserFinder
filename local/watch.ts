// Nightly Watcher sweep: re-hunts every profile (or one), then pushes what
// changed — new seed-user leads, due follow-up nudges, and best-effort
// Bluesky replies. Alerts go to Telegram when EARLYPROOF_TELEGRAM_BOT_TOKEN
// and EARLYPROOF_TELEGRAM_CHAT_ID are set; otherwise the run appends to
// local/data/watch.log and prints to stdout. State lives in
// local/data/watch.json (last sweep per profile). Usage:
//   LOCAL_NO_SERVE=1 bun local/watch.ts [profileId]
// Schedule (example, every 30 min):
//   */30 * * * * cd /Users/guanxs/SeedUserFinder && LOCAL_NO_SERVE=1 bun local/watch.ts >> local/data/watch.log 2>&1
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { handleRequest } from "./server.ts";

async function post(action: string, args: unknown) {
  const r = await handleRequest(
    new Request("http://localhost:3213/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, args }),
    }),
  );
  return (await r.json().catch(() => null)) as any;
}

const db = new Database("local/data/app.db");
const q = (sql: string, ...params: (string | number)[]) => db.query(sql).all(...params) as any[];

const STATE_PATH = "local/data/watch.json";
const state: Record<string, number> = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};

const only = process.argv[2] ? Number(process.argv[2]) : undefined;
const profiles = (q("SELECT id, product_name AS productName FROM profiles") as { id: number; productName: string }[])
  .filter((p) => only === undefined || p.id === only);
if (!profiles.length) { console.error("no matching profiles"); process.exit(1); }

const alerts: string[] = [];
for (const p of profiles) {
  const lastTs = state[String(p.id)] ?? 0;
  const lines: string[] = [`Profile ${p.id} (${p.productName}):`];
  // Channels: what the founder could hunt in the UI — open, non-poor recs.
  const recs = await post("recommendChannels", { profileId: p.id });
  const channels: string[] = Array.isArray(recs?.recs)
    ? recs.recs.filter((r: any) => (r.fit === "best" || r.fit === "good") && !r.needsConnection).map((r: any) => String(r.channel))
    : [];
  // Subreddits: latest plan's reddit communities, same source the UI prefills.
  let subs = "";
  try {
    const plans = q("SELECT plan AS planJson FROM search_expansions WHERE profile_id = ? ORDER BY id DESC LIMIT 1", p.id);
    const plan = plans[0]?.planJson ? JSON.parse(plans[0].planJson) : null;
    const comms: any[] = Array.isArray(plan?.communities) ? plan.communities : [];
    subs = comms.filter((c) => /reddit/i.test(String(c.channel ?? "")) || /^r\//i.test(String(c.name ?? "")))
      .map((c) => String(c.name ?? "").replace(/^r\//i, "").trim()).filter(Boolean).join(",");
  } catch { /* plan unreadable — hunt runs without subs */ }
  if (!channels.length) {
    lines.push("  no searchable open channels (connect something in Channels first) — skipped");
  } else {
    const r = await post("searchLiveLeads", { profileId: p.id, channels, subreddits: subs });
    if (r?.synthesisStatus === "not_configured") {
      lines.push("  skipped: Muse key missing — configure it in the UI, the sweep never fakes a hunt");
    } else {
      lines.push(`  hunted ${channels.join(", ")}${subs ? ` + r/${subs.split(",").join(" r/")}` : ""}: found ${r?.found ?? 0}, new ${r?.created ?? 0}, synthesized ${r?.synthesized ?? 0}`);
      for (const e of (r?.errors ?? []) as any[]) lines.push(`  channel note [${e.channel}]: ${String(e.message).slice(0, 140)}`);
    }
  }
  // New seed users since the last sweep.
  const fresh = q(
    "SELECT id, title, external_url AS url FROM leads WHERE profile_id = ? AND llm_category = 'seed_user' AND created_at > ? ORDER BY id",
    p.id, lastTs,
  ) as { id: number; title: string; url: string }[];
  if (fresh.length) {
    lines.push(`  NEW seed users (${fresh.length}):`);
    for (const f of fresh) lines.push(`    - ${f.title.slice(0, 90)} ${f.url}`);
  }
  // Due follow-up nudges.
  const due = q(
    "SELECT f.id, l.title AS title FROM followups f JOIN leads l ON l.id = f.lead_id WHERE f.profile_id = ? AND f.stopped = 0 AND f.done_at IS NULL AND f.due_at <= ?",
    p.id, Date.now(),
  ) as { id: number; title: string }[];
  if (due.length) lines.push(`  nudges due (${due.length}): ${due.map((d) => `#${d.id} ${d.title.slice(0, 60)}`).join("; ")}`);
  // Best-effort Bluesky replies to anything we sent.
  try {
    const conns = q("SELECT did, access_jwt AS jwt FROM connections WHERE channel = 'bluesky' LIMIT 1");
    if (conns[0]?.jwt) {
      const notif = await fetch("https://bsky.social/xrpc/com.atproto.notification.listNotifications?limit=50",
        { headers: { Authorization: `Bearer ${conns[0].jwt}` }, signal: AbortSignal.timeout(20000) });
      if (notif.ok) {
        const data = await notif.json() as any;
        const uris = new Set((q("SELECT external_uri AS u FROM leads WHERE profile_id = ? AND external_uri != ''", p.id) as any[]).map((x) => x.u));
        const hits: string[] = [];
        for (const n of (data.notifications ?? [])) {
          if (!["reply", "mention", "quote"].includes(n.reason)) continue;
          const uri = String(n.uri ?? "");
          if ([...uris].some((u) => uri.includes(String(u).split("/").pop() ?? "§"))) hits.push(`${n.reason} by @${n.author?.handle}: ${uri}`);
        }
        if (hits.length) lines.push(`  replies (${hits.length}): ${hits.slice(0, 5).join("; ")}`);
      }
    }
  } catch { lines.push("  reply check skipped (unreachable)"); }
  state[String(p.id)] = Date.now();
  const block = lines.join("\n");
  console.log(block);
  if (fresh.length || due.length) alerts.push(block);
}
writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const summary = alerts.length
  ? `EarlyProof watch: ${alerts.length} profile(s) need you\n\n${alerts.join("\n\n").slice(0, 3500)}`
  : null;
if (summary) {
  const token = process.env.EARLYPROOF_TELEGRAM_BOT_TOKEN;
  const chat = process.env.EARLYPROOF_TELEGRAM_CHAT_ID;
  if (token && chat) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: summary }),
        signal: AbortSignal.timeout(20000),
      });
      console.log("telegram alert sent");
    } catch { console.log("telegram send failed — alert below"); console.log(summary); }
  } else {
    console.log("no Telegram configured (set EARLYPROOF_TELEGRAM_BOT_TOKEN + CHAT_ID for push) — alert:");
    console.log(summary);
  }
} else {
  console.log("watch clean — nothing new");
}
appendFileSync("local/data/watch.log", `\n[${new Date().toISOString()}] sweep ${profiles.map((p) => p.id).join(",")}: ${alerts.length ? alerts.length + " profile(s) with news" : "clean"}\n`);
db.close();
