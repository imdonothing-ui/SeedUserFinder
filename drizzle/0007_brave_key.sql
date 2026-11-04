ALTER TABLE `llm_settings` ADD `brave_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `llm_settings` DROP COLUMN `founder_voice`;
