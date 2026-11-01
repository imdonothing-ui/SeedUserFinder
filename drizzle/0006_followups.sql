CREATE TABLE `followups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`due_at` integer NOT NULL,
	`done_at` integer,
	`stopped` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);
