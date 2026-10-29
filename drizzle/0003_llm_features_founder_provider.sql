CREATE TABLE `llm_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text DEFAULT 'openai' NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`small_model` text DEFAULT '' NOT NULL,
	`large_model` text DEFAULT '' NOT NULL,
	`founder_voice` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feedback_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`seed_name` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`raw_text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `llm_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`kind` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `profiles` ADD `pain_phrases` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD `workaround_phrases` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD `exclusions` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_category` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_confidence` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_reason` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_quote` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_signals` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_hash` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `llm_reviewed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `leads` ADD `draft_tone_check` text DEFAULT '' NOT NULL;
