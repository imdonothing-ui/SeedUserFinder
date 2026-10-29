DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_name TEXT NOT NULL,
  product_desc TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  pain TEXT NOT NULL DEFAULT '',
  workaround TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  core_action TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live',
  external_url TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  external_uri TEXT NOT NULL DEFAULT '',
  external_cid TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  author_handle TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  community TEXT NOT NULL DEFAULT '',
  posted_at TEXT NOT NULL DEFAULT '',
  match_score INTEGER NOT NULL DEFAULT 50,
  match_reason TEXT NOT NULL DEFAULT '',
  draft_body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  posted_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL DEFAULT '',
  did TEXT NOT NULL DEFAULT '',
  access_jwt TEXT NOT NULL DEFAULT '',
  refresh_jwt TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL,
  pain_language TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  lead_id INTEGER,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  seed_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE cohort_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id INTEGER NOT NULL,
  profile_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE posthog_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL UNIQUE,
  host TEXT NOT NULL DEFAULT 'https://us.posthog.com',
  project_id TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  started_event TEXT NOT NULL DEFAULT '',
  core_event TEXT NOT NULL DEFAULT '',
  returned_event TEXT NOT NULL DEFAULT '',
  paid_event TEXT NOT NULL DEFAULT '',
  referred_event TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
