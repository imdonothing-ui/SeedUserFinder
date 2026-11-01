// Shared localhost boot: real SQLite (migrated from `drizzle/*.sql`), seeded
// demo data, and the action-host context. Used by `local/server.ts` (HTTP)
// and `local/smoke.ts` (in-process). No artifact runtime required.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { complete } from "./inference-stub.ts";
import * as schema from "../server/src/schema.ts";

const root = new URL("..", import.meta.url).pathname;

export async function boot() {
  await Bun.$`mkdir -p ${root}/local/data`.quiet();
  const sqlite = new Database(`${root}/local/data/app.db`);
  sqlite.exec("CREATE TABLE IF NOT EXISTS local_migrations (tag TEXT PRIMARY KEY)");
  const applied = new Set(
    (sqlite.query("SELECT tag FROM local_migrations").all() as { tag: string }[]).map((r) => r.tag),
  );
  const journal = (await Bun.file(`${root}/drizzle/meta/_journal.json`).json()) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    if (applied.has(entry.tag)) continue;
    const sql = await Bun.file(`${root}/drizzle/${entry.tag}.sql`).text();
    sqlite.exec("PRAGMA foreign_keys=OFF");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
    sqlite.query("INSERT INTO local_migrations (tag) VALUES (?)").run(entry.tag);
  }
  const db = drizzle(sqlite);

  let seeded = false;
  if (!(await db.select().from(schema.profiles)).length) {
    await db.insert(schema.profiles).values({
      productName: "DawnFeed",
      productDesc: "Tracks night feeds and predicts the next wake window",
      audience: "First-time parents in the first 6 months",
      pain: "I never know if she'll sleep through or wake screaming at 5am",
      workaround: "Notes app timestamps and guesswork",
      keywords: "baby wakes at 5am, night feed tracking, sleep regression",
      coreAction: "Logged a night feed three nights in a row",
    });
    await db.insert(schema.llmSettings).values({
      provider: "muse",
      apiKey: "local-stub-key",
      baseUrl: "",
      smallModel: "local-stub-small",
      largeModel: "local-stub-large",
      founderVoice: "",
      updatedAt: Date.now(),
    });
    seeded = true;
  }

  const ctx = {
    db: <T>() => db as unknown as T,
    inference: { complete },
    invalidateQueries: () => {},
  };
  return { db, ctx, seeded };
}
