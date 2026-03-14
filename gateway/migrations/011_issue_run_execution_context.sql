-- Align issue run execution context to the cloud/local model and remove legacy target tables.
ALTER TABLE IF EXISTS issue_runs
    ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(16),
    ADD COLUMN IF NOT EXISTS executor_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS executor_hostname VARCHAR(255),
    ADD COLUMN IF NOT EXISTS executor_platform VARCHAR(64);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'execution_targets'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'issue_runs' AND column_name = 'execution_target_id'
    ) THEN
        UPDATE issue_runs ir
        SET execution_mode = COALESCE(NULLIF(BTRIM(et.type), ''), 'local'),
            executor_name = COALESCE(ir.executor_name, NULLIF(BTRIM(et.name), '')),
            executor_hostname = COALESCE(ir.executor_hostname, NULLIF(BTRIM(et.hostname), '')),
            executor_platform = COALESCE(ir.executor_platform, NULLIF(BTRIM(et.platform), ''))
        FROM execution_targets et
        WHERE ir.execution_target_id = et.id
          AND (ir.execution_mode IS NULL OR BTRIM(ir.execution_mode) = '');
    END IF;
END $$;

UPDATE issue_runs
SET execution_mode = 'cloud'
WHERE execution_mode IS NULL OR BTRIM(execution_mode) = '';

ALTER TABLE IF EXISTS issue_runs
    ALTER COLUMN execution_mode SET DEFAULT 'cloud';

ALTER TABLE IF EXISTS issue_runs
    ALTER COLUMN execution_mode SET NOT NULL;

ALTER TABLE IF EXISTS issue_runs
    DROP COLUMN IF EXISTS execution_target_id;

DROP INDEX IF EXISTS idx_issue_runs_execution_target_status;
DROP TABLE IF EXISTS execution_target_logs;
DROP TABLE IF EXISTS execution_targets;
DROP TABLE IF EXISTS operation_logs;
DROP TABLE IF EXISTS desktop_clients;
