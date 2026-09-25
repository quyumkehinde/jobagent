-- Two-category targeting (spec.md): additive, all nullable — existing rows are untouched
-- and read as "scored before targeting" until the one-off rescore reaches them.
ALTER TABLE `companies` ADD `sector` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `base_score` real;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `work_mode` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `remote_eligibility` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `office_region` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `is_fintech` integer;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `fintech_subdomain` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `min_years_experience` integer;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `seniority` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `domain` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `target_category` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `needs_check` integer;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `location_quote` text;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `experience_quote` text;
--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `stats` text;
