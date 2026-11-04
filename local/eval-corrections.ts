// Corrections ledger replay: reads the founder's recorded verdicts
// (reviewed-kept = relevant, dismissed-classified = not relevant) from the
// LOCAL database and replays the current gate against them. Read-only —
// opens app.db in readonly mode and writes only local/data/eval-report.json.
// Usage: bun local/eval-corrections.ts [profileId]
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { writeFileSync } from "node:fs";
import { collectCorrections, replayCorrections } from "../server/src/eval.ts";
import * as schema from "../server/src/schema.ts";

const sqlite = new Database("local/data/app.db", { readonly: true });
const db = drizzle(sqlite);

const only = process.argv[2] ? Number(process.argv[2]) : undefined;
const profiles = await db.select({
  id: schema.profiles.id, productName: schema.profiles.productName, productDesc: schema.profiles.productDesc,
  audience: schema.profiles.audience, pain: schema.profiles.pain, workaround: schema.profiles.workaround,
  keywords: schema.profiles.keywords, coreAction: schema.profiles.coreAction,
}).from(schema.profiles).where(only === undefined ? undefined : eq(schema.profiles.id, only));

const report: Record<string, unknown> = {};
let total = 0;
for (const p of profiles) {
  const rows = await collectCorrections(db as never, p.id);
  if (!rows.length) continue;
  const r = replayCorrections(rows, p);
  total += r.total;
  report[p.id] = {
    profile: p.productName,
    corrections: r.total,
    ruleAgreeRate: +r.ruleAgreeRate.toFixed(2),
    modelAgreeRate: +r.modelAgreeRate.toFixed(2),
    contestedTokens: r.contestedTokens,
    disagreements: r.rows.filter((x) => !x.ruleAgrees || !x.modelAgrees).map((x) => ({
      leadId: x.leadId, channel: x.channel, founder: x.founderLabel,
      model: x.modelCategory || "(none)", ruleScore: x.ruleScore,
      text: x.text.slice(0, 120),
    })),
  };
  console.log(`profile ${p.id} (${p.productName}): ${r.total} corrections, rule agrees ${(r.ruleAgreeRate * 100).toFixed(0)}%, model agrees ${(r.modelAgreeRate * 100).toFixed(0)}%` +
    (r.contestedTokens.length ? `, contested: ${r.contestedTokens.map(([t]) => t).join(", ")}` : ""));
}
writeFileSync("local/data/eval-report.json", JSON.stringify({ at: new Date().toISOString(), total, profiles: report }, null, 2));
console.log(total ? `wrote local/data/eval-report.json (${total} corrections)` : "no corrections recorded yet — review or dismiss a held/classified lead to seed the ledger");
sqlite.close();
