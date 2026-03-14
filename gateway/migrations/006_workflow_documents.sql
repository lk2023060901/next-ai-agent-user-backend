DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'workflows' AND column_name = 'revision'
    ) THEN
        ALTER TABLE workflows RENAME COLUMN revision TO current_revision;
    END IF;
END $$;

ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS current_revision INT NOT NULL DEFAULT 1;

ALTER TABLE workflows
    ALTER COLUMN current_revision SET DEFAULT 1;

UPDATE workflows
SET current_revision = 1
WHERE current_revision IS NULL;

ALTER TABLE workflows
    ALTER COLUMN current_revision SET NOT NULL;

ALTER TABLE workflows
    ALTER COLUMN spec_version SET DEFAULT 'workflow.v1';

UPDATE workflows
SET spec_version = 'workflow.v1'
WHERE COALESCE(spec_version, '') = '';

CREATE TABLE IF NOT EXISTS workflow_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    spec_version VARCHAR(64) NOT NULL DEFAULT 'workflow.definition.v1',
    content JSONB NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_workflow_definitions_workflow
    ON workflow_definitions(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_layouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    spec_version VARCHAR(64) NOT NULL DEFAULT 'workflow.layout.v1',
    content JSONB NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_workflow_layouts_workflow
    ON workflow_layouts(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    revision INT NOT NULL,
    definition_id UUID NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
    layout_id UUID NOT NULL REFERENCES workflow_layouts(id) ON DELETE RESTRICT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_workflow_revisions_workflow
    ON workflow_revisions(workflow_id);

CREATE INDEX IF NOT EXISTS idx_workflow_revisions_workflow_revision
    ON workflow_revisions(workflow_id, revision DESC);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'workflows' AND column_name = 'data'
    ) THEN
        INSERT INTO workflow_definitions (workflow_id, spec_version, content, content_hash, created_at)
        SELECT
            w.id,
            'workflow.definition.v1',
            def.content,
            md5(def.content::text),
            COALESCE(w.updated_at, NOW())
        FROM workflows w
        CROSS JOIN LATERAL (
            SELECT jsonb_build_object(
                'specVersion', 'workflow.definition.v1',
                'nodes', COALESCE((
                    SELECT jsonb_agg(
                        jsonb_strip_nulls(
                            jsonb_build_object(
                                'id', node_item->>'id',
                                'typeId', COALESCE(node_item->>'typeId', node_item->>'type', node_item->>'kind'),
                                'version', CASE
                                    WHEN NULLIF(node_item->>'version', '') IS NULL THEN NULL
                                    ELSE (node_item->>'version')::INT
                                END,
                                'properties', COALESCE(node_item->'properties', '{}'::jsonb)
                            )
                        )
                        ORDER BY ord
                    )
                    FROM jsonb_array_elements(COALESCE(w.data->'nodes', '[]'::jsonb)) WITH ORDINALITY AS node_arr(node_item, ord)
                ), '[]'::jsonb),
                'connections', COALESCE((
                    SELECT jsonb_agg(
                        jsonb_strip_nulls(
                            jsonb_build_object(
                                'id', NULLIF(conn_item->>'id', ''),
                                'sourceNodeId', COALESCE(conn_item->>'sourceNodeId', conn_item->>'source'),
                                'sourcePinId', COALESCE(conn_item->>'sourcePinId', conn_item->>'sourceHandle', conn_item->>'sourcePortId'),
                                'targetNodeId', COALESCE(conn_item->>'targetNodeId', conn_item->>'target'),
                                'targetPinId', COALESCE(conn_item->>'targetPinId', conn_item->>'targetHandle', conn_item->>'targetPortId')
                            )
                        )
                        ORDER BY ord
                    )
                    FROM jsonb_array_elements(COALESCE(w.data->'connections', w.data->'edges', '[]'::jsonb)) WITH ORDINALITY AS conn_arr(conn_item, ord)
                ), '[]'::jsonb)
            ) AS content
        ) AS def
        WHERE NOT EXISTS (
            SELECT 1
            FROM workflow_revisions wr
            WHERE wr.workflow_id = w.id
        )
        ON CONFLICT (workflow_id, content_hash) DO NOTHING;

        INSERT INTO workflow_layouts (workflow_id, spec_version, content, content_hash, created_at)
        SELECT
            w.id,
            'workflow.layout.v1',
            layout.content,
            md5(layout.content::text),
            COALESCE(w.updated_at, NOW())
        FROM workflows w
        CROSS JOIN LATERAL (
            SELECT jsonb_build_object(
                'specVersion', 'workflow.layout.v1',
                'viewport', CASE
                    WHEN jsonb_typeof(w.data->'viewport') = 'object' THEN jsonb_build_object(
                        'x', COALESCE((w.data->'viewport'->>'x')::NUMERIC, 0),
                        'y', COALESCE((w.data->'viewport'->>'y')::NUMERIC, 0),
                        'zoom', COALESCE((w.data->'viewport'->>'zoom')::NUMERIC, 1)
                    )
                    ELSE jsonb_build_object('x', 0, 'y', 0, 'zoom', 1)
                END,
                'nodes', COALESCE((
                    SELECT jsonb_agg(
                        jsonb_strip_nulls(
                            jsonb_build_object(
                                'nodeId', COALESCE(node_item->>'id', node_item->>'nodeId'),
                                'position', CASE
                                    WHEN jsonb_typeof(node_item->'position') = 'object' THEN jsonb_build_object(
                                        'x', COALESCE((node_item->'position'->>'x')::NUMERIC, ((ord - 1) % 4) * 320),
                                        'y', COALESCE((node_item->'position'->>'y')::NUMERIC, ((ord - 1) / 4) * 220)
                                    )
                                    ELSE jsonb_build_object(
                                        'x', ((ord - 1) % 4) * 320,
                                        'y', ((ord - 1) / 4) * 220
                                    )
                                END,
                                'width', CASE
                                    WHEN jsonb_typeof(node_item->'width') = 'number' THEN (node_item->>'width')::NUMERIC
                                    ELSE NULL
                                END,
                                'height', CASE
                                    WHEN jsonb_typeof(node_item->'height') = 'number' THEN (node_item->>'height')::NUMERIC
                                    ELSE NULL
                                END,
                                'zIndex', CASE
                                    WHEN jsonb_typeof(node_item->'zIndex') = 'number' THEN (node_item->>'zIndex')::INT
                                    ELSE NULL
                                END
                            )
                        )
                        ORDER BY ord
                    )
                    FROM jsonb_array_elements(COALESCE(w.data->'nodes', '[]'::jsonb)) WITH ORDINALITY AS node_arr(node_item, ord)
                ), '[]'::jsonb)
            ) AS content
        ) AS layout
        WHERE NOT EXISTS (
            SELECT 1
            FROM workflow_revisions wr
            WHERE wr.workflow_id = w.id
        )
        ON CONFLICT (workflow_id, content_hash) DO NOTHING;

        INSERT INTO workflow_revisions (workflow_id, revision, definition_id, layout_id, created_at)
        SELECT
            w.id,
            COALESCE(w.current_revision, 1),
            wd.id,
            wl.id,
            COALESCE(w.updated_at, NOW())
        FROM workflows w
        JOIN LATERAL (
            SELECT id
            FROM workflow_definitions
            WHERE workflow_id = w.id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        ) wd ON TRUE
        JOIN LATERAL (
            SELECT id
            FROM workflow_layouts
            WHERE workflow_id = w.id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        ) wl ON TRUE
        WHERE NOT EXISTS (
            SELECT 1
            FROM workflow_revisions wr
            WHERE wr.workflow_id = w.id
        )
        ON CONFLICT (workflow_id, revision) DO NOTHING;

        ALTER TABLE workflows DROP COLUMN IF EXISTS data;
    END IF;
END $$;
