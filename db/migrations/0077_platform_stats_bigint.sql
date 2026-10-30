-- platform_stats.total_processed_fils counts lifetime gross FILS (not BD). INTEGER tops out at
-- 2,147,483,647 (2,147,483.647 BD) while the volume tier threshold is 2,000,000,000: a few more
-- batches after the tier flips and the counter wraps negative (or the UPDATE fails and every
-- settlement close stops). Money columns are BIGINT everywhere else (ADR-0001).
ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;
