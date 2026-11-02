CREATE TABLE IF NOT EXISTS documents (
  col        TEXT        NOT NULL,
  id         TEXT        NOT NULL,
  doc        JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS documents_doc_gin ON documents USING GIN (doc jsonb_path_ops);
CREATE INDEX IF NOT EXISTS documents_col_created ON documents (col, created_at);
