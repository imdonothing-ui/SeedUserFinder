// ─── Learning loop: corrections ledger + replay eval ───────────────────────
// The founder's verdicts are the only labels that matter. Two in-UI actions
// record them: clearing a held/irrelevant lead (llmReviewed = 1, lead stays
// visible → founder says RELEVANT) and dismissing a lead Muse classified as
// seed_user/curious (→ founder says NOT RELEVANT). This module collects those
// corrections and replays the rule gate against them, so drift shows up as a
// number plus the contested words — the prompt-tuning starting point.
// Reads only; never writes to the database.

import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { analyseText, type ProfileLike } from "./actions";
import * as schema from "./schema";

type Db = BunSQLiteDatabase<typeof schema>;

export interface Correction {
  leadId: number;
  profileId: number;
  channel: string;
  text: string;
  founderLabel: "relevant" | "not-relevant";
  modelCategory: string;
  modelConfidence: number;
}

// Every row where the founder overruled the machine, in either direction.
export async function collectCorrections(db: Db, profileId?: number): Promise<Correction[]> {
  const base = or(
    and(eq(schema.leads.llmReviewed, 1), ne(schema.leads.status, "dismissed")),
    and(eq(schema.leads.status, "dismissed"), inArray(schema.leads.llmCategory, ["seed_user", "curious"])),
  )!;
  const rows = profileId === undefined
    ? await db.select({
        id: schema.leads.id, profileId: schema.leads.profileId, channel: schema.leads.channel,
        title: schema.leads.title, body: schema.leads.body, status: schema.leads.status,
        llmCategory: schema.leads.llmCategory, llmConfidence: schema.leads.llmConfidence,
      }).from(schema.leads).where(base)
    : await db.select({
        id: schema.leads.id, profileId: schema.leads.profileId, channel: schema.leads.channel,
        title: schema.leads.title, body: schema.leads.body, status: schema.leads.status,
        llmCategory: schema.leads.llmCategory, llmConfidence: schema.leads.llmConfidence,
      }).from(schema.leads).where(and(base, eq(schema.leads.profileId, profileId)));
  return rows.map((r) => ({
    leadId: r.id,
    profileId: r.profileId,
    channel: r.channel,
    text: `${r.title} ${r.body}`.trim(),
    founderLabel: (r.status === "dismissed" ? "not-relevant" : "relevant") as Correction["founderLabel"],
    modelCategory: r.llmCategory,
    modelConfidence: r.llmConfidence,
  }));
}

export interface ReplayRow extends Correction {
  ruleScore: number;
  ruleKeep: boolean;
  modelKeep: boolean;
  ruleAgrees: boolean;
  modelAgrees: boolean;
}

export interface ReplayReport {
  total: number;
  ruleAgreeRate: number;
  modelAgreeRate: number;
  contestedTokens: [string, number][];
  rows: ReplayRow[];
}

const EVAL_STOP = new Set(
  "the,a,an,and,or,for,with,from,that,this,have,has,are,was,were,will,would,can,could,should,there,their,they,them,then,than,when,what,which,who,how,about,into,over,after,before,just,like,need,needs,more,very,really,also,been,being,because,been,does,did,your,you,our,its,it's,i'm,we're,they're".split(","),
);

// Replay the rule half (analyseText at the 60-point hold bar) and the model
// half (stored verdict) against the founder's labels.
export function replayCorrections(rows: Correction[], profile: ProfileLike): ReplayReport {
  const out: ReplayRow[] = rows.map((c) => {
    const a = analyseText(c.text, profile, c.channel);
    const ruleKeep = a.anchorPresent && a.score >= 60;
    const modelKeep = c.modelCategory === "seed_user" || c.modelCategory === "curious";
    const want = c.founderLabel === "relevant";
    return { ...c, ruleScore: a.score, ruleKeep, modelKeep, ruleAgrees: ruleKeep === want, modelAgrees: modelKeep === want };
  });
  // Contested words: frequent in disagreements, discounted by agreement
  // frequency — the prompt-tuning starting point, not a rule change.
  const dis = new Map<string, number>();
  const agr = new Map<string, number>();
  for (const r of out) {
    const toks = new Set(r.text.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 4 && !EVAL_STOP.has(t)));
    for (const t of toks) {
      const m = r.ruleAgrees && r.modelAgrees ? agr : dis;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
  }
  const contested = [...dis.entries()]
    .map(([t, n]): [string, number] => [t, n - (agr.get(t) ?? 0)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const agree = (f: (r: ReplayRow) => boolean) => (out.length ? out.filter(f).length / out.length : 1);
  return {
    total: out.length,
    ruleAgreeRate: agree((r) => r.ruleAgrees),
    modelAgreeRate: agree((r) => r.modelAgrees),
    contestedTokens: contested,
    rows: out,
  };
}
