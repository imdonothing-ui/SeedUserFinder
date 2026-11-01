import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productName: text("product_name").notNull(),
  productDesc: text("product_desc").notNull().default(""),
  audience: text("audience").notNull().default(""),
  pain: text("pain").notNull().default(""),
  workaround: text("workaround").notNull().default(""),
  keywords: text("keywords").notNull().default(""),
  coreAction: text("core_action").notNull().default(""),
  // LLM pain-language expansion (JSON arrays stored as text; empty = not run)
  painPhrases: text("pain_phrases").notNull().default(""),
  workaroundPhrases: text("workaround_phrases").notNull().default(""),
  exclusions: text("exclusions").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  channel: text("channel").notNull(), // bluesky | hackernews | github | reddit | x | facebook | discord | slack | linkedin | instagram | manual
  mode: text("mode").notNull().default("live"), // live_post | live_search | pasted | guided
  externalUrl: text("external_url").notNull().default(""),
  externalId: text("external_id").notNull().default(""),
  // bluesky reply refs
  externalUri: text("external_uri").notNull().default(""),
  externalCid: text("external_cid").notNull().default(""),
  author: text("author").notNull().default(""),
  authorHandle: text("author_handle").notNull().default(""),
  title: text("title").notNull().default(""),
  body: text("body").notNull().default(""),
  community: text("community").notNull().default(""),
  postedAt: text("posted_at").notNull().default(""),
  matchScore: integer("match_score").notNull().default(50),
  matchReason: text("match_reason").notNull().default(""),
  draftBody: text("draft_body").notNull().default(""),
  // LLM classification evidence (empty category = not classified by LLM)
  llmCategory: text("llm_category").notNull().default(""), // seed_user | curious | irrelevant
  llmConfidence: integer("llm_confidence").notNull().default(0), // 0-100
  llmReason: text("llm_reason").notNull().default(""),
  llmQuote: text("llm_quote").notNull().default(""),
  llmSignals: text("llm_signals").notNull().default(""), // JSON {rightPerson, realPain, workaroundOrPaying, recent}
  llmHash: text("llm_hash").notNull().default(""), // cache key: hash of post text + profile pain
  llmReviewed: integer("llm_reviewed").notNull().default(0), // founder confirmed a low-confidence lead
  draftToneCheck: text("draft_tone_check").notNull().default(""),
  status: text("status", { enum: ["new","drafted","approved","sent","replied","conversation","trial","dismissed"] }).notNull().default("new"),
  postedUrl: text("posted_url").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const connections = sqliteTable("connections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel").notNull().unique(), // bluesky | github | reddit_poc
  handle: text("handle").notNull().default(""),
  did: text("did").notNull().default(""),
  accessJwt: text("access_jwt").notNull().default(""),
  refreshJwt: text("refresh_jwt").notNull().default(""),
  token: text("token").notNull().default(""), // github PAT
  clientId: text("client_id").notNull().default(""), // reddit POC app client id
  clientSecret: text("client_secret").notNull().default(""), // reddit POC app secret (founder's own app)
  expiresAt: integer("expires_at").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const insights = sqliteTable("insights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  sourceLabel: text("source_label").notNull().default(""),
  rawText: text("raw_text").notNull(),
  painLanguage: text("pain_language").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const invites = sqliteTable("invites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  leadId: integer("lead_id"),
  code: text("code").notNull().unique(),
  label: text("label").notNull().default(""),
  seedName: text("seed_name").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const cohortEvents = sqliteTable("cohort_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inviteId: integer("invite_id").notNull(),
  profileId: integer("profile_id").notNull(),
  eventType: text("event_type", { enum: ["started","core","returned","paid","referred"] }).notNull(),
  source: text("source").notNull().default("manual"), // manual | snippet | posthog
  note: text("note").notNull().default(""),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const posthogConfigs = sqliteTable("posthog_configs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().unique(),
  host: text("host").notNull().default("https://us.posthog.com"),
  projectId: text("project_id").notNull().default(""),
  apiKey: text("api_key").notNull().default(""),
  startedEvent: text("started_event").notNull().default(""),
  coreEvent: text("core_event").notNull().default(""),
  returnedEvent: text("returned_event").notNull().default(""),
  paidEvent: text("paid_event").notNull().default(""),
  referredEvent: text("referred_event").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Founder's Muse LLM settings — a single row (id 1). The provider is Muse;
// the founder's Muse API key is entered in-app, stored server-side, and
// never returned to the client (only a masked hint).
export const llmSettings = sqliteTable("llm_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().default("muse"), // Muse — the workspace's Muse model API
  apiKey: text("api_key").notNull().default(""),
  baseUrl: text("base_url").notNull().default(""), // legacy column, unused under Muse
  smallModel: text("small_model").notNull().default(""),
  largeModel: text("large_model").notNull().default(""),
  founderVoice: text("founder_voice").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(0),
});

// Verbatim feedback from seed users — the raw material the feedback summary
// clusters. Quotes in a summary must come from these rows, word for word.
export const feedbackEntries = sqliteTable("feedback_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  seedName: text("seed_name").notNull().default(""),
  source: text("source").notNull().default(""), // call notes | message | survey | support chat…
  rawText: text("raw_text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Stored LLM outputs the founder can re-read: feedback summaries and
// next-experiment suggestions (content is JSON text).
export const llmSummaries = sqliteTable("llm_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  kind: text("kind").notNull(), // feedback | next_experiment
  content: text("content").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// LLM search-expansion plans (Step 3): one row per expansion round for a
// profile. `plan` is JSON: { anchorTerm, queries[], painPhrases[],
// adjacentProblems[], adjacentAudiences[], communities[], relaxations[],
// nextSuggestions[] }. Every query in the plan is verified server-side to
// contain a domain anchor term before it is stored or searched.
export const searchExpansions = sqliteTable("search_expansions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  round: integer("round").notNull().default(1),
  anchorTerm: text("anchor_term").notNull().default(""),
  plan: text("plan").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Search runs (Step 3 progress): one row per search/expand run so the UI
// can poll phases instead of showing one spinner.
export const searchRuns = sqliteTable("search_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  kind: text("kind").notNull().default("search"), // search | expand
  phase: text("phase").notNull().default("expanding"), // expanding | searching | synthesizing | done
  detail: text("detail").notNull().default(""),
  found: integer("found").notNull().default(0),
  created: integer("created").notNull().default(0),
  synthesized: integer("synthesized").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Reply nudges: after a lead is sent, one open nudge reminds the founder to
// check for a reply. Snooze pushes it 3 days out; stop closes it for good.
export const followups = sqliteTable("followups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id").notNull(),
  profileId: integer("profile_id").notNull(),
  dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  doneAt: integer("done_at", { mode: "timestamp_ms" }),
  stopped: integer("stopped").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// legacy scaffold table kept in type file only; dropped in migration for new DBs, harmless if absent
export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
