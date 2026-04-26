-- Drop headline columns from broadcasts. Daily delivery template no longer
-- accepts headlines (admin doesn't enter them anymore — paves the way for
-- fully automated daily sends).
-- Apply with: wrangler d1 execute aljarida-db --remote --file=migration-drop-headlines.sql

ALTER TABLE broadcasts DROP COLUMN headline_1;
ALTER TABLE broadcasts DROP COLUMN headline_2;
ALTER TABLE broadcasts DROP COLUMN headline_3;
