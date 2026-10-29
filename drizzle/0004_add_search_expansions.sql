CREATE TABLE `search_expansions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`round` integer NOT NULL DEFAULT 1,
	`anchor_term` text NOT NULL DEFAULT '',
	`plan` text NOT NULL DEFAULT '',
	`created_at` integer NOT NULL
);
