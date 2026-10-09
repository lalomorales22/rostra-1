-- Rostra v0 schema. Times are ISO 8601 strings (UTC). Lists are JSON arrays.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  profile_url TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  rate TEXT,
  availability TEXT,
  status TEXT NOT NULL DEFAULT 'prospect'
    CHECK (status IN ('prospect','active','paused','ended')),
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agents_source_ref ON agents (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX agents_status ON agents (status);

CREATE TABLE engagements (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'proposed'
    CHECK (stage IN ('proposed','hired','delivered','accepted','paid')),
  amount TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  source_ref TEXT,
  proposed_at TEXT,
  hired_at TEXT,
  delivered_at TEXT,
  accepted_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX engagements_agent ON engagements (agent_id);
CREATE INDEX engagements_stage ON engagements (stage);
CREATE UNIQUE INDEX engagements_source_ref ON engagements (agent_id, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE followups (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  due TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX followups_open ON followups (done, due);
