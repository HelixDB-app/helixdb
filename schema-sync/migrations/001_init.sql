-- Schema designer cloud sync — apply via schema-sync service on startup or run manually once.

CREATE TABLE IF NOT EXISTS schema_projects (
    id UUID PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    app_type TEXT NOT NULL DEFAULT '',
    content_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schema_projects_owner ON schema_projects (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_schema_projects_updated ON schema_projects (updated_at DESC);

CREATE TABLE IF NOT EXISTS schema_project_ops (
    id BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES schema_projects (id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    author_user_id TEXT NOT NULL,
    client_op_id UUID NOT NULL,
    payload_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_schema_project_ops_client UNIQUE (client_op_id),
    CONSTRAINT uq_schema_project_ops_seq UNIQUE (project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_schema_project_ops_project_seq ON schema_project_ops (project_id, seq);

CREATE TABLE IF NOT EXISTS schema_project_members (
    project_id UUID NOT NULL REFERENCES schema_projects (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_schema_project_members_user ON schema_project_members (user_id);

-- SHA-256 hex (64 chars) of the raw share token; never store plaintext tokens.
CREATE TABLE IF NOT EXISTS schema_share_links (
    id UUID PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    project_id UUID NOT NULL REFERENCES schema_projects (id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('viewer', 'editor')),
    expires_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schema_share_links_project ON schema_share_links (project_id);
