CREATE TABLE `search_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`kind` text NOT NULL DEFAULT 'search',
	`phase` text NOT NULL DEFAULT 'expanding',
	`detail` text NOT NULL DEFAULT '',
	`found` integer NOT NULL DEFAULT 0,
	`created` integer NOT NULL DEFAULT 0,
	`synthesized` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);
