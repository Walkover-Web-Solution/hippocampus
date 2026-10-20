import { memoryConfig } from './config';

/**
 * The memory schema, applied in order and recorded in memory_migrations. Three tables are the source of truth
 * (spaces, notes, note versions, plus the original of a document); chunks, entities, note_entities and entity links
 * are indexes rebuilt from the versions; signers and usage hold who may sign tokens and what was used.
 */
export interface Migration {
    name: string;
    sql: string;
}

export const migrations: Migration[] = [{
    name: '001_memory_file_system',
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_signers (
    issuer      text PRIMARY KEY,
    secret      text NOT NULL,
    name        text,
    org_id      text,
    project_id  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);

CREATE TABLE IF NOT EXISTS memory_spaces (
    id          uuid PRIMARY KEY,
    issuer      text NOT NULL,
    org_id      text NOT NULL,
    project_id  text NOT NULL,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, org_id, project_id, name)
);

CREATE TABLE IF NOT EXISTS memory_notes (
    id                  uuid PRIMARY KEY,
    space_id            uuid NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
    path                text NOT NULL,
    kind                text NOT NULL DEFAULT 'note',
    slot                text,
    labels              text[] NOT NULL DEFAULT '{}',
    current_version_id  uuid,
    status              text NOT NULL DEFAULT 'active',
    valid_from          timestamptz NOT NULL DEFAULT now(),
    valid_to            timestamptz,
    source              jsonb,
    written_by          text NOT NULL,
    confidence          real,
    evidence_count      integer NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (space_id, path)
);
CREATE INDEX IF NOT EXISTS idx_memory_notes_space ON memory_notes (space_id, status, kind);
CREATE INDEX IF NOT EXISTS idx_memory_notes_labels ON memory_notes USING GIN (labels);
CREATE INDEX IF NOT EXISTS idx_memory_notes_source ON memory_notes USING GIN (source jsonb_path_ops);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_notes_live_slot ON memory_notes (space_id, slot) WHERE status = 'active' AND slot IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_note_versions (
    id          uuid PRIMARY KEY,
    note_id     uuid NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    version     integer NOT NULL,
    title       text,
    summary     text,
    body        text NOT NULL,
    names       text[] NOT NULL DEFAULT '{}',
    written_by  text NOT NULL,
    change      text NOT NULL DEFAULT 'write',
    indexed_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (note_id, version)
);
CREATE INDEX IF NOT EXISTS idx_memory_note_versions_names ON memory_note_versions USING GIN (names);

CREATE TABLE IF NOT EXISTS memory_documents (
    id            uuid PRIMARY KEY,
    note_id       uuid NOT NULL UNIQUE REFERENCES memory_notes(id) ON DELETE CASCADE,
    url           text,
    filename      text,
    mime          text,
    bytes         integer,
    status        text NOT NULL DEFAULT 'queued',
    error         text,
    extracted_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_chunks (
    id               uuid PRIMARY KEY,
    version_id       uuid NOT NULL REFERENCES memory_note_versions(id) ON DELETE CASCADE,
    note_id          uuid NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    space_id         uuid NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
    ordinal          integer NOT NULL,
    text             text NOT NULL,
    embedding        vector(${memoryConfig.embeddingDimensions}),
    embedding_model  text,
    search_text      tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_version ON memory_chunks (version_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_space ON memory_chunks (space_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_search ON memory_chunks USING GIN (search_text);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding ON memory_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_entities (
    id          uuid PRIMARY KEY,
    space_id    uuid NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
    name        text NOT NULL,
    type        text NOT NULL DEFAULT 'other',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (space_id, name)
);

CREATE TABLE IF NOT EXISTS memory_note_entities (
    version_id  uuid NOT NULL REFERENCES memory_note_versions(id) ON DELETE CASCADE,
    entity_id   uuid NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (version_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_note_entities_entity ON memory_note_entities (entity_id);

CREATE TABLE IF NOT EXISTS memory_entity_links (
    id          uuid PRIMARY KEY,
    version_id  uuid NOT NULL REFERENCES memory_note_versions(id) ON DELETE CASCADE,
    note_id     uuid NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    space_id    uuid NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
    subject     text NOT NULL,
    relation    text NOT NULL,
    object      text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_entity_links_subject ON memory_entity_links (space_id, subject);
CREATE INDEX IF NOT EXISTS idx_memory_entity_links_object ON memory_entity_links (space_id, object);
CREATE INDEX IF NOT EXISTS idx_memory_entity_links_version ON memory_entity_links (version_id);

CREATE TABLE IF NOT EXISTS memory_usage (
    id          bigserial PRIMARY KEY,
    issuer      text NOT NULL,
    org_id      text NOT NULL,
    project_id  text NOT NULL,
    caller      text,
    verb        text NOT NULL,
    tokens      integer NOT NULL DEFAULT 0,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_usage_tenant ON memory_usage (issuer, org_id, project_id, at);
`,
}];
