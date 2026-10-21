import Database from 'better-sqlite3';

// ============================================================================
// Migrations — append-only; never modify an existing entry
// ============================================================================

// Exported read-only for tests that need to construct a DB at a specific
// pre-migration checkpoint (e.g. a migration-compatibility fixture). Not
// part of the runtime public API otherwise — application code should only
// ever call openDatabase().
export const MIGRATIONS: readonly string[] = [
  // Migration 1: initial control-plane schema (DDR-032 §15, §28 Phase 2)
  // Migration 2: scheduler leases table (DDR-032 §28 Phase 5)
  `
  CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name         TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
    priority     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id),
    provider        TEXT NOT NULL CHECK(provider IN ('github')),
    remote          TEXT NOT NULL,
    default_branch  TEXT NOT NULL,
    local_workspace TEXT,
    status          TEXT NOT NULL CHECK(status IN ('active','disabled'))
  );

  CREATE TABLE objectives (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id),
    title                TEXT NOT NULL,
    description          TEXT NOT NULL,
    priority             INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL CHECK(status IN ('draft','active','completed','cancelled')),
    constraints_json     TEXT NOT NULL DEFAULT '[]',
    success_criteria_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE work_items (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(id),
    objective_id          TEXT REFERENCES objectives(id),
    repository_ids_json   TEXT NOT NULL DEFAULT '[]',
    title                 TEXT NOT NULL,
    goal                  TEXT NOT NULL,
    workflow_id           TEXT NOT NULL,
    state                 TEXT NOT NULL,
    priority              INTEGER NOT NULL DEFAULT 0,
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    constraints_json      TEXT NOT NULL DEFAULT '[]',
    required_evidence_json TEXT NOT NULL DEFAULT '[]',
    parent_id             TEXT REFERENCES work_items(id),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );

  CREATE TABLE work_dependencies (
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    depends_on_id TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY (work_item_id, depends_on_id),
    CHECK(work_item_id != depends_on_id)
  );

  CREATE TABLE step_executions (
    id              TEXT PRIMARY KEY,
    work_item_id    TEXT NOT NULL REFERENCES work_items(id),
    workflow_run_id TEXT NOT NULL,
    step_id         TEXT NOT NULL,
    executor        TEXT NOT NULL,
    state           TEXT NOT NULL CHECK(state IN ('dispatched','running','succeeded','failed','cancelled')),
    attempt         INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    started_at      TEXT,
    completed_at    TEXT,
    cost_json       TEXT,
    tokens          INTEGER,
    failure_json    TEXT
  );

  CREATE TABLE decisions (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(id),
    work_item_id          TEXT REFERENCES work_items(id),
    type                  TEXT NOT NULL,
    subject_ref_json      TEXT NOT NULL,
    title                 TEXT NOT NULL,
    summary               TEXT NOT NULL,
    options_json          TEXT NOT NULL DEFAULT '[]',
    recommended_option_id TEXT,
    recommendation_reason TEXT,
    impact                TEXT NOT NULL CHECK(impact IN ('low','medium','high','critical')),
    reversibility         TEXT NOT NULL CHECK(reversibility IN ('easy','medium','hard','irreversible')),
    urgency               TEXT NOT NULL CHECK(urgency IN ('normal','blocking','urgent')),
    status                TEXT NOT NULL CHECK(status IN ('pending','resolved','expired','cancelled')),
    resolution_json       TEXT
  );

  CREATE TABLE policies (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id),
    config_json TEXT NOT NULL
  );

  CREATE TABLE evidence (
    id                TEXT PRIMARY KEY,
    work_item_id      TEXT NOT NULL REFERENCES work_items(id),
    step_execution_id TEXT REFERENCES step_executions(id),
    type              TEXT NOT NULL,
    source            TEXT NOT NULL,
    subject_ref       TEXT,
    status            TEXT NOT NULL CHECK(status IN ('passed','failed','informational')),
    payload_json      TEXT NOT NULL,
    collected_at      TEXT NOT NULL
  );

  CREATE TABLE artifacts (
    id                TEXT PRIMARY KEY,
    work_item_id      TEXT REFERENCES work_items(id),
    workflow_run_id   TEXT,
    step_execution_id TEXT REFERENCES step_executions(id),
    type              TEXT NOT NULL,
    ref               TEXT,
    path              TEXT,
    hash              TEXT,
    created_at        TEXT NOT NULL
  );

  -- Append-only event log. No UPDATE or DELETE permitted by convention.
  CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    schema_version  INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
    type            TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    project_id      TEXT,
    work_item_id    TEXT,
    workflow_run_id TEXT,
    occurred_at     TEXT NOT NULL,
    payload_json    TEXT NOT NULL
  );

  CREATE INDEX idx_projects_workspace      ON projects(workspace_id);
  CREATE INDEX idx_repositories_project    ON repositories(project_id);
  CREATE INDEX idx_objectives_project      ON objectives(project_id);
  CREATE INDEX idx_work_items_project      ON work_items(project_id);
  CREATE INDEX idx_work_items_state        ON work_items(state);
  CREATE INDEX idx_step_executions_wi      ON step_executions(work_item_id);
  CREATE INDEX idx_step_executions_run     ON step_executions(workflow_run_id);
  CREATE INDEX idx_decisions_project       ON decisions(project_id);
  CREATE INDEX idx_decisions_work_item     ON decisions(work_item_id);
  CREATE INDEX idx_decisions_status        ON decisions(status);
  CREATE INDEX idx_evidence_work_item      ON evidence(work_item_id);
  CREATE INDEX idx_events_workspace        ON events(workspace_id);
  CREATE INDEX idx_events_work_item        ON events(work_item_id);
  CREATE INDEX idx_events_occurred_at      ON events(occurred_at);
  CREATE INDEX idx_events_type             ON events(type);
  `,

  // Migration 2: scheduler lease table for repository write safety (DDR-032 §16.2, §28 Phase 5)
  `
  CREATE TABLE scheduler_leases (
    id            TEXT PRIMARY KEY,
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    repository_id TEXT,
    lease_type    TEXT NOT NULL CHECK(lease_type IN ('write', 'read')),
    acquired_at   TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    heartbeat_at  TEXT NOT NULL
  );

  CREATE INDEX idx_scheduler_leases_repo      ON scheduler_leases(repository_id, lease_type);
  CREATE INDEX idx_scheduler_leases_work_item ON scheduler_leases(work_item_id);
  CREATE INDEX idx_scheduler_leases_expires   ON scheduler_leases(expires_at);
  `,

  // Migration 3: auth tokens, audit log, notification channels (DDR-032 §22, §28 Phase 8)
  `
  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    revoked_at   TEXT
  );

  CREATE TABLE audit_events (
    id            TEXT PRIMARY KEY,
    token_id      TEXT REFERENCES api_tokens(id),
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    details_json  TEXT,
    ip_address    TEXT,
    occurred_at   TEXT NOT NULL
  );

  CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at);
  CREATE INDEX idx_audit_events_resource    ON audit_events(resource_type, resource_id);
  CREATE INDEX idx_audit_events_token       ON audit_events(token_id);

  CREATE TABLE notification_channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('webhook')),
    config_json TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );
  `,

  // Migration 4: add trust fields to evidence (DDR-032 §20 — candidateRef SHA
  // binding and collectorId provenance). Append-only; existing rows get NULL.
  `
  ALTER TABLE evidence ADD COLUMN candidate_ref TEXT;
  ALTER TABLE evidence ADD COLUMN collector_id  TEXT;
  `,

  // Migration 5: durable WorkflowRun cursor (DDR-031 Stage 2 — checkpoint/resume).
  // One row per logical run; updated in place as the engine advances through steps.
  // work_item_id has no FK here — corrected in Migration 6.
  `
  CREATE TABLE workflow_runs (
    run_id              TEXT PRIMARY KEY,
    workflow_id         TEXT NOT NULL,
    work_item_id        TEXT,
    status              TEXT NOT NULL CHECK(status IN ('active','halted','complete')),
    current_step_id     TEXT NOT NULL,
    iteration           INTEGER NOT NULL DEFAULT 1,
    revision            INTEGER NOT NULL DEFAULT 0,
    awaiting_checkpoint TEXT,
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );

  CREATE INDEX idx_workflow_runs_work_item ON workflow_runs(work_item_id);
  CREATE INDEX idx_workflow_runs_status    ON workflow_runs(status);
  `,

  // Migration 6: correct schema invariants introduced in Stages 1–2.
  //
  // (a) step_executions: add 'waiting' state for checkpoint-paused executions;
  //     abusing 'cancelled' for a successfully reached checkpoint is semantically wrong.
  // (b) workflow_runs: restore nullable FK to work_items(id) so any supplied
  //     work_item_id has referential integrity; NULL remains valid for standalone runs.
  //
  // SQLite does not support ALTER COLUMN, so both tables are recreated in place.
  `
  CREATE TABLE step_executions_v6 (
    id              TEXT PRIMARY KEY,
    work_item_id    TEXT NOT NULL REFERENCES work_items(id),
    workflow_run_id TEXT NOT NULL,
    step_id         TEXT NOT NULL,
    executor        TEXT NOT NULL,
    state           TEXT NOT NULL CHECK(state IN
                      ('dispatched','running','succeeded','failed','cancelled','waiting')),
    attempt         INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    started_at      TEXT,
    completed_at    TEXT,
    cost_json       TEXT,
    tokens          INTEGER,
    failure_json    TEXT
  );
  INSERT INTO step_executions_v6 SELECT * FROM step_executions;
  DROP TABLE step_executions;
  ALTER TABLE step_executions_v6 RENAME TO step_executions;
  CREATE INDEX idx_step_executions_wi  ON step_executions(work_item_id);
  CREATE INDEX idx_step_executions_run ON step_executions(workflow_run_id);

  CREATE TABLE workflow_runs_v6 (
    run_id              TEXT PRIMARY KEY,
    workflow_id         TEXT NOT NULL,
    work_item_id        TEXT REFERENCES work_items(id),
    status              TEXT NOT NULL CHECK(status IN ('active','halted','complete')),
    current_step_id     TEXT NOT NULL,
    iteration           INTEGER NOT NULL DEFAULT 1,
    revision            INTEGER NOT NULL DEFAULT 0,
    awaiting_checkpoint TEXT,
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  INSERT INTO workflow_runs_v6 SELECT * FROM workflow_runs;
  DROP TABLE workflow_runs;
  ALTER TABLE workflow_runs_v6 RENAME TO workflow_runs;
  CREATE INDEX idx_workflow_runs_work_item ON workflow_runs(work_item_id);
  CREATE INDEX idx_workflow_runs_status    ON workflow_runs(status);
  `,

  // Migration 7: workflow parameter provenance chain.
  // work_items.workflow_parameters_json: requested workflow configuration from the requester.
  // workflow_runs.resolved_parameters_json: validated, frozen snapshot used by this specific run.
  // On resume the engine reads resolved_parameters_json — never re-reads workflow_parameters_json.
  `
  ALTER TABLE work_items    ADD COLUMN workflow_parameters_json TEXT;
  ALTER TABLE workflow_runs ADD COLUMN resolved_parameters_json TEXT;
  `,

  // Migration 8: checkpoint application journal (A.3 — durable idempotency).
  // Records APPLYING (before side effects) and APPLIED (after side effects) transitions.
  // Replaces filesystem checkpoint receipts as the idempotency authority for resume.
  // decision_id is the PK and FK to decisions; one row per resolved checkpoint.
  `
  CREATE TABLE checkpoint_applications (
    decision_id          TEXT PRIMARY KEY REFERENCES decisions(id),
    workflow_run_id      TEXT NOT NULL REFERENCES workflow_runs(run_id),
    workflow_id          TEXT NOT NULL,
    step_id              TEXT NOT NULL,
    iteration            INTEGER NOT NULL,
    revision_before      INTEGER NOT NULL,
    selected_option_id   TEXT NOT NULL,
    rationale            TEXT,
    state                TEXT NOT NULL CHECK(state IN ('applying','applied')),
    continuation_step_id TEXT,
    remain_at_checkpoint INTEGER NOT NULL DEFAULT 0,
    increment_revision   INTEGER NOT NULL DEFAULT 0,
    cancel               INTEGER NOT NULL DEFAULT 0,
    started_at           TEXT NOT NULL,
    applied_at           TEXT
  );

  CREATE INDEX idx_checkpoint_applications_run ON checkpoint_applications(workflow_run_id);
  `,

  // Migration 9: activate Objective (D.2 — docs/developmentPlan/d2-objectives.md).
  // Every other durable entity (Workspace/Project/WorkItem/...) carries
  // created_at/updated_at; Objective was the one exception. Nullable/
  // append-only per convention (existing rows get NULL) — in practice there
  // are none yet, since nothing wrote to this table before ObjectiveService.
  `
  ALTER TABLE objectives ADD COLUMN created_at TEXT;
  ALTER TABLE objectives ADD COLUMN updated_at TEXT;
  `,

  // Migration 10: backfill NULL Objective timestamps (D.2.1/D.2.2 — docs/
  // developmentPlan/d2-objectives.md). Migration 9 left created_at/
  // updated_at nullable, but ObjectiveSchema requires valid TimestampSchema
  // values — a pre-D.2.1 row would type as `string` while reading back as
  // runtime `null`. Policy, applied once, existing non-null values
  // untouched: missing created_at -> the actual time this migration runs;
  // missing updated_at -> the row's (possibly just-backfilled) created_at.
  // strftime('%Y-%m-%dT%H:%M:%fZ', 'now') is SQLite's UTC clock, evaluated
  // at migration-execution time (not a fixed literal — D.2.2 correction: an
  // earlier version of this migration hardcoded a single date, which would
  // have been wrong for every database first migrated afterward), formatted
  // to exactly the millisecond-precision ISO-8601 TimestampSchema requires
  // (matching what `new Date().toISOString()` produces everywhere else).
  // No table recreation: nullable columns stay nullable at the schema
  // level — this migration is the one-time guarantee that no NULL survives
  // it, not a NOT NULL constraint (SQLite can't add one without a full
  // recreation, and every future row is written through ObjectiveService,
  // which always supplies both fields).
  `
  UPDATE objectives SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE created_at IS NULL;
  UPDATE objectives SET updated_at = created_at WHERE updated_at IS NULL;
  `,

  // Migration 11: application Processes. These records retain project intent
  // and review history independently from executable kernel WorkItems.
  `
  CREATE TABLE app_processes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    objective_id TEXT REFERENCES objectives(id),
    title TEXT NOT NULL,
    intent TEXT NOT NULL,
    desired_outcomes_json TEXT NOT NULL DEFAULT '[]',
    constraints_json TEXT NOT NULL DEFAULT '[]',
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','paused','completed','cancelled')),
    current_focus TEXT NOT NULL DEFAULT 'Planning',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_app_processes_project ON app_processes(project_id, lifecycle, updated_at);
  CREATE TABLE app_process_repositories (
    process_id TEXT NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    PRIMARY KEY (process_id, repository_id)
  );
  CREATE TABLE app_process_activity (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('update','proposal','review','decision')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    outcome TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_app_process_activity_process ON app_process_activity(process_id, created_at);
  `,

  // Migration 12: projects may explicitly share a repository identity.
  // Keep repositories.project_id for compatibility with existing consumers;
  // this association becomes the authoritative membership relation.
  `
  CREATE TABLE project_repositories (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (project_id, repository_id)
  );
  INSERT INTO project_repositories (project_id, repository_id, linked_at)
    SELECT project_id, id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM repositories;
  CREATE INDEX idx_project_repositories_repository ON project_repositories(repository_id);
  CREATE INDEX idx_project_repositories_project ON project_repositories(project_id);
  `,

  // Migration 13: retain repository IDs while coordinating leases by canonical remote.
  `
  ALTER TABLE repositories ADD COLUMN canonical_identity TEXT;
  CREATE INDEX idx_repositories_canonical_identity ON repositories(canonical_identity);
  `,

  // Migration 14: proposals are durable review requirements with stable IDs.
  `
  ALTER TABLE app_process_activity ADD COLUMN proposal_id TEXT;
  CREATE TABLE app_process_proposals (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL UNIQUE REFERENCES app_process_activity(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','revise','deferred')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  UPDATE app_process_activity SET proposal_id=id WHERE kind='proposal';
  INSERT INTO app_process_proposals (id,process_id,activity_id,status,created_at)
    SELECT id,process_id,id,'pending',created_at FROM app_process_activity WHERE kind='proposal';
  CREATE INDEX idx_app_process_proposals_pending ON app_process_proposals(process_id,status,created_at);
  `,

  // Migration 15: reconcile legacy reviews from installations that already
  // applied migration 14. Only explicit supported outcomes resolve a proposal.
  `
  UPDATE app_process_activity AS review SET proposal_id=(
    SELECT proposal.proposal_id FROM app_process_activity proposal
    WHERE proposal.process_id=review.process_id AND proposal.kind='proposal'
      AND (proposal.created_at < review.created_at OR (proposal.created_at=review.created_at AND proposal.rowid<review.rowid))
    ORDER BY proposal.created_at DESC,proposal.rowid DESC LIMIT 1
  ) WHERE review.kind='review' AND review.outcome IN ('accepted','rejected','revise','deferred');
  UPDATE app_process_proposals AS proposal SET
    status=(SELECT review.outcome FROM app_process_activity review WHERE review.kind='review' AND review.proposal_id=proposal.id
      AND review.outcome IN ('accepted','rejected','revise','deferred') ORDER BY review.created_at DESC,review.rowid DESC LIMIT 1),
    resolved_at=(SELECT review.created_at FROM app_process_activity review WHERE review.kind='review' AND review.proposal_id=proposal.id
      AND review.outcome IN ('accepted','rejected','revise','deferred') ORDER BY review.created_at DESC,review.rowid DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM app_process_activity review WHERE review.kind='review' AND review.proposal_id=proposal.id
      AND review.outcome IN ('accepted','rejected','revise','deferred'));
  `,

  // Migration 16: version Process definitions and retain amendment provenance.
  `
  ALTER TABLE app_process_activity ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE app_process_activity ADD COLUMN amendment_id TEXT;
  CREATE TABLE app_process_definition_versions (
    process_id TEXT NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version >= 1),
    definition_json TEXT NOT NULL,
    amendment_id TEXT,
    change_reason TEXT NOT NULL,
    authorized_by TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    PRIMARY KEY(process_id,version)
  );
  CREATE TABLE app_process_amendments (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
    base_version INTEGER NOT NULL,
    proposed_definition_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')),
    proposed_by TEXT NOT NULL,
    proposed_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT
  );
  CREATE INDEX idx_app_process_amendments_status ON app_process_amendments(process_id,status,proposed_at);
  INSERT INTO app_process_definition_versions (process_id,version,definition_json,change_reason,authorized_by,accepted_at)
    SELECT id,1,json_object('title',title,'intent',intent,'desiredOutcomes',json(desired_outcomes_json),
      'constraints',json(constraints_json),'objectiveId',objective_id,
      'repositoryIds',json(COALESCE((SELECT json_group_array(repository_id) FROM app_process_repositories WHERE process_id=app_processes.id),'[]'))),
      'Initial accepted Process definition', 'migration', created_at FROM app_processes;
  `,
];

// ============================================================================
// Database initialisation
// ============================================================================

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const canonicalize = (remote: string) => {
    const value = remote.trim().replace(/^git@github\.com:/i, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/').replace(/^http:\/\//i, 'https://');
    const match = value.match(/^(?:https:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return match ? `github:${match[1].toLowerCase()}/${match[2].toLowerCase()}` : `github:${value.toLowerCase()}`;
  };
  const updateIdentity = db.prepare('UPDATE repositories SET canonical_identity=? WHERE id=?');
  const repositories = db.prepare('SELECT id,remote FROM repositories').all() as { id: string; remote: string }[];
  const backfillIdentity = db.transaction(() => { for (const repository of repositories) updateIdentity.run(canonicalize(repository.remote), repository.id); });
  backfillIdentity();
  db.prepare(`UPDATE scheduler_leases SET repository_id=(SELECT canonical_identity FROM repositories WHERE repositories.id=scheduler_leases.repository_id)
    WHERE repository_id IS NOT NULL AND EXISTS (SELECT 1 FROM repositories WHERE repositories.id=scheduler_leases.repository_id)`).run();
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const check = db.prepare<[number], { count: number }>(
    'SELECT COUNT(*) as count FROM _migrations WHERE id = ?'
  );
  const record = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const migrationId = i + 1;
    if ((check.get(migrationId) as { count: number }).count === 0) {
      // PRAGMA foreign_keys cannot be changed inside a transaction, so disable it
      // around the transaction to allow table-recreation migrations to DROP a parent
      // table that has child-row FK references. Re-enabled immediately after.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(MIGRATIONS[i]);
          // Check FK integrity inside the transaction — any violation causes the
          // entire transaction to roll back (migration DDL + _migrations row).
          // This prevents a partially-valid migration from being committed and
          // skipped on the next startup.
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) {
            throw new Error(
              `Migration ${migrationId} introduced FK violations: ${JSON.stringify(violations)}`,
            );
          }
          record.run(migrationId, new Date().toISOString());
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
  }
}
