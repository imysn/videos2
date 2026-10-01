-- Older releases did not capture the intended media generation. They cannot
-- safely publish against a generation selected later. Preserve their originals
-- and require a fresh owner request; never infer content identity during upgrade.
UPDATE jobs SET state='cancelled', safe_error_code='CONTENT_GENERATION_UNKNOWN',
  lease_until=NULL, cancel_requested=true
WHERE kind IN ('ingest','prepare-copy','hls') AND state IN ('queued','running')
  AND NOT (payload_json ? 'contentGeneration');

ALTER TABLE jobs ADD CONSTRAINT active_media_job_generation CHECK (
  kind NOT IN ('ingest','prepare-copy','hls') OR state NOT IN ('queued','running')
  OR (payload_json ? 'contentGeneration'
    AND jsonb_typeof(payload_json->'contentGeneration')='string'
    AND payload_json->>'contentGeneration' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
);
