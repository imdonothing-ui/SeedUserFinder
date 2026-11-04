// Regenerate a profile's expansion plan with the REAL configured key and
// show the resulting channel lineup. Usage:
//   LOCAL_NO_SERVE=1 bun local/regenerate-plan.ts <profileId>
// Deletes that profile's existing plans first so generation starts clean.
import { Database } from "bun:sqlite";
import { handleRequest } from "./server.ts";

async function post(action: string, args: unknown) {
  const r = await handleRequest(
    new Request("http://localhost:3213/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, args }),
    }),
  );
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

const pid = Number(process.argv[2]);
if (!pid) {
  console.error("usage: LOCAL_NO_SERVE=1 bun local/regenerate-plan.ts <profileId>");
  process.exit(1);
}

const db = new Database("local/data/app.db");
const wiped = db
  .query("DELETE FROM search_expansions WHERE profile_id = ? RETURNING id")
  .all(pid) as unknown[];
console.log(`wiped ${wiped.length} old plan(s) for profile ${pid}`);

const gen = await post("generateExpansionPlan", { profileId: pid });
console.log("generateExpansionPlan:", JSON.stringify(gen.body).slice(0, 600));

const recs = await post("recommendChannels", { profileId: pid });
const list = ((recs.body as any)?.recs ?? []) as any[];
console.log(`recommendChannels: ${list.length} channel(s), webOk=${(recs.body as any)?.webOk} webVia=${(recs.body as any)?.webVia}`);
for (const r of list) {
  console.log(`- ${r.channel} [${r.fit}]${r.needsConnection ? " (needs connection)" : ""} :: ${(r.reasons ?? []).join(" | ").slice(0, 220)}`);
}
console.log("message:", (recs.body as any)?.message);
