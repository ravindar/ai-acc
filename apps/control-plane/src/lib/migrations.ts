import type { Database, QueryResultRow, Queryable } from "./database.js";

const migrationTableName = "schema_migrations";
const requiredTables = [
  "workspaces",
  "agent_sessions",
  "agent_events",
  "context_packs",
  "context_items",
  "agent_context_mounts",
  "usage_ticks",
  "artifacts",
  "agent_runs",
  "transcript_entries",
  "tool_calls",
  "approval_requests",
  "handoff_items",
  "agent_worktrees",
  "workspace_coordination_states",
  "agent_memory_blocks",
  "agent_messages",
] as const;

const baselineSchema = `
create table if not exists workspaces (
  id text primary key,
  name text not null,
  description text,
  project_root text,
  shared_context text not null default '',
  layout_config text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists agent_sessions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  provider text not null,
  model text not null,
  title text,
  state text not null default 'CREATED' check (state in (
    'CREATED',
    'STARTING',
    'READY',
    'RUNNING',
    'WAITING_INPUT',
    'WAITING_APPROVAL',
    'IDLE',
    'COMPLETED',
    'ERROR',
    'STOPPED'
  )),
  runtime_session_id text,
  heartbeat_at text,
  last_event_at text,
  idle_since text,
  error_code text,
  error_message text,
  started_at text,
  completed_at text,
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists idx_agent_sessions_workspace on agent_sessions(workspace_id);
create index if not exists idx_agent_sessions_state on agent_sessions(state);

create table if not exists agent_events (
  id text primary key,
  agent_id text not null references agent_sessions(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  seq integer not null,
  event_type text not null,
  ts text not null,
  provider text not null,
  payload text not null,
  created_at text not null default current_timestamp,
  unique(agent_id, seq)
);

create index if not exists idx_agent_events_workspace_ts on agent_events(workspace_id, ts);
create index if not exists idx_agent_events_agent_ts on agent_events(agent_id, ts);

create table if not exists context_packs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  version integer not null default 1,
  immutable integer not null default 1 check (immutable in (0, 1)),
  created_at text not null default current_timestamp
);

create table if not exists context_items (
  id text primary key,
  context_pack_id text not null references context_packs(id) on delete cascade,
  item_type text not null check (item_type in ('file', 'url', 'text')),
  value text not null,
  checksum text not null,
  token_estimate integer,
  created_at text not null default current_timestamp
);

create table if not exists agent_context_mounts (
  agent_id text not null references agent_sessions(id) on delete cascade,
  context_pack_id text not null references context_packs(id) on delete cascade,
  mounted_at text not null default current_timestamp,
  max_context_tokens integer,
  primary key (agent_id, context_pack_id)
);

create table if not exists usage_ticks (
  id text primary key,
  agent_id text not null references agent_sessions(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  ts text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real not null default 0,
  latency_ms integer,
  metadata text not null default '{}'
);

create index if not exists idx_usage_ticks_workspace_ts on usage_ticks(workspace_id, ts);
create index if not exists idx_usage_ticks_agent_ts on usage_ticks(agent_id, ts);

create table if not exists artifacts (
  id text primary key,
  agent_id text not null references agent_sessions(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  run_id text references agent_runs(id) on delete set null,
  kind text not null check (kind in ('log', 'file', 'patch', 'trace')),
  uri text not null,
  size_bytes integer,
  created_at text not null default current_timestamp
);

create table if not exists agent_worktrees (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null unique references agent_sessions(id) on delete cascade,
  repo_root text not null,
  branch text not null,
  path text not null,
  base_ref text not null default 'HEAD',
  status text not null check (status in ('READY', 'ERROR', 'MISSING')),
  last_validated_at text not null,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists agent_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null references agent_sessions(id) on delete cascade,
  title text not null,
  prompt text not null,
  state text not null check (state in ('CREATED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'ERROR', 'STOPPED')),
  error_message text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  started_at text not null default current_timestamp,
  completed_at text
);

create index if not exists idx_agent_runs_agent on agent_runs(agent_id, created_at desc);
create index if not exists idx_agent_runs_workspace on agent_runs(workspace_id, created_at desc);

create table if not exists transcript_entries (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null references agent_sessions(id) on delete cascade,
  seq integer not null,
  entry_type text not null check (entry_type in ('user', 'assistant', 'tool', 'system', 'error', 'approval')),
  content text not null,
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  unique(run_id, seq)
);

create index if not exists idx_transcript_entries_run on transcript_entries(run_id, seq asc);

create table if not exists tool_calls (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null references agent_sessions(id) on delete cascade,
  provider_call_id text,
  approval_id text,
  tool_name text not null,
  status text not null check (status in ('requested', 'pending_approval', 'approved', 'denied', 'running', 'completed', 'error')),
  input text not null,
  output text,
  requested_cwd text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists idx_tool_calls_run on tool_calls(run_id, created_at asc);

create table if not exists approval_requests (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null references agent_sessions(id) on delete cascade,
  tool_call_id text not null unique references tool_calls(id) on delete cascade,
  status text not null check (status in ('PENDING', 'APPROVED', 'DENIED')),
  requested_action text not null,
  requested_payload text not null,
  reason text,
  decision_message text,
  created_at text not null default current_timestamp,
  decided_at text
);

create index if not exists idx_approval_requests_workspace on approval_requests(workspace_id, created_at desc);
create index if not exists idx_approval_requests_status on approval_requests(status, created_at desc);

create table if not exists handoff_items (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  source_agent_id text not null references agent_sessions(id) on delete cascade,
  source_run_id text not null references agent_runs(id) on delete cascade,
  assigned_agent_id text references agent_sessions(id) on delete set null,
  title text not null,
  summary text not null,
  recommended_provider text not null,
  recommended_model text not null,
  next_prompt text not null,
  artifact_ids text not null default '[]',
  status text not null check (status in ('OPEN', 'ASSIGNED', 'DONE', 'DISMISSED')),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists idx_handoff_items_workspace on handoff_items(workspace_id, created_at desc);
create index if not exists idx_handoff_items_status on handoff_items(status, created_at desc);

create table if not exists workspace_coordination_states (
  workspace_id text primary key references workspaces(id) on delete cascade,
  brief text,
  agent_briefs text not null default '[]',
  handoff_summaries text not null default '[]',
  finding_summaries text not null default '[]',
  action_requests text not null default '[]',
  team_ask text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
`;

type EmbeddedMigration = {
  name: string;
  apply: (db: Queryable) => Promise<void>;
};

async function ensureColumn(
  db: Queryable,
  tableName: string,
  columnName: string,
  sql: string,
): Promise<void> {
  const columns = await db.query<QueryResultRow>(`pragma table_info(${tableName})`);
  const hasColumn = columns.rows.some((row) => row.name === columnName);

  if (!hasColumn) {
    await db.exec(sql);
  }
}

async function rebuildAgentSessionsForApprovalState(db: Queryable): Promise<void> {
  const tableSqlResult = await db.query<QueryResultRow>(
    `select sql from sqlite_master where type = 'table' and name = 'agent_sessions'`,
  );
  const tableSql = String(tableSqlResult.rows[0]?.sql ?? "");

  if (tableSql.includes("WAITING_APPROVAL")) {
    return;
  }

  const columns = await db.query<QueryResultRow>(`pragma table_info(agent_sessions)`);
  const hasUpdatedAt = columns.rows.some((row) => row.name === "updated_at");

  await db.exec(`
    alter table agent_sessions rename to agent_sessions_old;

    create table agent_sessions (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      provider text not null,
      model text not null,
      title text,
      state text not null default 'CREATED' check (state in (
        'CREATED',
        'STARTING',
        'READY',
        'RUNNING',
        'WAITING_INPUT',
        'WAITING_APPROVAL',
        'IDLE',
        'COMPLETED',
        'ERROR',
        'STOPPED'
      )),
      runtime_session_id text,
      heartbeat_at text,
      last_event_at text,
      idle_since text,
      error_code text,
      error_message text,
      started_at text,
      completed_at text,
      metadata text not null default '{}',
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
  `);

  await db.exec(`
    insert into agent_sessions (
      id,
      workspace_id,
      provider,
      model,
      title,
      state,
      runtime_session_id,
      heartbeat_at,
      last_event_at,
      idle_since,
      error_code,
      error_message,
      started_at,
      completed_at,
      metadata,
      created_at,
      updated_at
    )
    select
      id,
      workspace_id,
      provider,
      model,
      title,
      state,
      runtime_session_id,
      heartbeat_at,
      last_event_at,
      idle_since,
      error_code,
      error_message,
      started_at,
      completed_at,
      metadata,
      created_at,
      ${hasUpdatedAt ? "updated_at" : "created_at"}
    from agent_sessions_old;

    drop table agent_sessions_old;

    create index if not exists idx_agent_sessions_workspace on agent_sessions(workspace_id);
    create index if not exists idx_agent_sessions_state on agent_sessions(state);
  `);
}

async function getTableSql(db: Queryable, tableName: string): Promise<string> {
  const result = await db.query<QueryResultRow>(
    `select sql from sqlite_master where type = 'table' and name = ?`,
    [tableName],
  );

  return String(result.rows[0]?.sql ?? "");
}

async function getTableColumns(db: Queryable, tableName: string): Promise<Set<string>> {
  const result = await db.query<QueryResultRow>(`pragma table_info(${tableName})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function rebuildAgentSessionDependentTable(
  db: Queryable,
  input: {
    tableName: string;
    createSql: string;
    insertColumns: string[];
    selectColumns: (existingColumns: Set<string>) => string[];
    indexSql?: string;
    forceIf?: (existingColumns: Set<string>, tableSql: string) => boolean;
  },
): Promise<void> {
  const tableSql = await getTableSql(db, input.tableName);
  if (!tableSql) {
    await db.exec(`
      ${input.createSql}
      ${input.indexSql ?? ""}
    `);
    return;
  }

  const existingColumns = await getTableColumns(db, input.tableName);
  const needsRepair =
    tableSql.includes("agent_sessions_old") ||
    (input.forceIf ? input.forceIf(existingColumns, tableSql) : false);

  if (!needsRepair) {
    return;
  }

  const tempTableName = `${input.tableName}_repair_old`;
  const insertColumns = input.insertColumns.join(", ");
  const selectColumns = input.selectColumns(existingColumns).join(", ");

  await db.exec(`
    alter table ${input.tableName} rename to ${tempTableName};
    ${input.createSql}
  `);

  await db.exec(`
    insert into ${input.tableName} (${insertColumns})
    select ${selectColumns}
    from ${tempTableName};

    drop table ${tempTableName};
    ${input.indexSql ?? ""}
  `);
}

async function repairAgentSessionForeignKeys(db: Queryable): Promise<void> {
  await rebuildAgentSessionDependentTable(db, {
    tableName: "agent_events",
    createSql: `
      create table agent_events (
        id text primary key,
        agent_id text not null references agent_sessions(id) on delete cascade,
        workspace_id text not null references workspaces(id) on delete cascade,
        seq integer not null,
        event_type text not null,
        ts text not null,
        provider text not null,
        payload text not null,
        created_at text not null default current_timestamp,
        unique(agent_id, seq)
      );
    `,
    insertColumns: ["id", "agent_id", "workspace_id", "seq", "event_type", "ts", "provider", "payload", "created_at"],
    selectColumns: () => ["id", "agent_id", "workspace_id", "seq", "event_type", "ts", "provider", "payload", "created_at"],
    indexSql: `
      create index if not exists idx_agent_events_workspace_ts on agent_events(workspace_id, ts);
      create index if not exists idx_agent_events_agent_ts on agent_events(agent_id, ts);
    `,
  });

  await rebuildAgentSessionDependentTable(db, {
    tableName: "agent_context_mounts",
    createSql: `
      create table agent_context_mounts (
        agent_id text not null references agent_sessions(id) on delete cascade,
        context_pack_id text not null references context_packs(id) on delete cascade,
        mounted_at text not null default current_timestamp,
        max_context_tokens integer,
        primary key (agent_id, context_pack_id)
      );
    `,
    insertColumns: ["agent_id", "context_pack_id", "mounted_at", "max_context_tokens"],
    selectColumns: (columns) => [
      "agent_id",
      "context_pack_id",
      "mounted_at",
      columns.has("max_context_tokens") ? "max_context_tokens" : "null",
    ],
  });

  await rebuildAgentSessionDependentTable(db, {
    tableName: "usage_ticks",
    createSql: `
      create table usage_ticks (
        id text primary key,
        agent_id text not null references agent_sessions(id) on delete cascade,
        workspace_id text not null references workspaces(id) on delete cascade,
        ts text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cost_usd real not null default 0,
        latency_ms integer,
        metadata text not null default '{}'
      );
    `,
    insertColumns: [
      "id",
      "agent_id",
      "workspace_id",
      "ts",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "latency_ms",
      "metadata",
    ],
    selectColumns: (columns) => [
      "id",
      "agent_id",
      "workspace_id",
      "ts",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      columns.has("latency_ms") ? "latency_ms" : "null",
      columns.has("metadata") ? "metadata" : "'{}'",
    ],
    indexSql: `
      create index if not exists idx_usage_ticks_workspace_ts on usage_ticks(workspace_id, ts);
      create index if not exists idx_usage_ticks_agent_ts on usage_ticks(agent_id, ts);
    `,
  });

  await rebuildAgentSessionDependentTable(db, {
    tableName: "artifacts",
    createSql: `
      create table artifacts (
        id text primary key,
        agent_id text not null references agent_sessions(id) on delete cascade,
        workspace_id text not null references workspaces(id) on delete cascade,
        run_id text references agent_runs(id) on delete set null,
        kind text not null check (kind in ('log', 'file', 'patch', 'trace')),
        uri text not null,
        size_bytes integer,
        created_at text not null default current_timestamp
      );
    `,
    insertColumns: ["id", "agent_id", "workspace_id", "run_id", "kind", "uri", "size_bytes", "created_at"],
    selectColumns: (columns) => [
      "id",
      "agent_id",
      "workspace_id",
      columns.has("run_id") ? "run_id" : "null",
      "kind",
      "uri",
      columns.has("size_bytes") ? "size_bytes" : "null",
      "created_at",
    ],
    forceIf: (columns) => !columns.has("run_id"),
  });
}

const embeddedMigrations: readonly EmbeddedMigration[] = [
  {
    name: "0001_initial.sql",
    apply: async (db) => {
      await db.exec(baselineSchema);
    },
  },
  {
    name: "0002_workspace_project_context.sql",
    apply: async (db) => {
      await ensureColumn(db, "workspaces", "project_root", `
        alter table workspaces
        add column project_root text
      `);
      await ensureColumn(db, "workspaces", "shared_context", `
        alter table workspaces
        add column shared_context text not null default ''
      `);
    },
  },
  {
    name: "0003_production_alpha.sql",
    apply: async (db) => {
      await rebuildAgentSessionsForApprovalState(db);
      await db.exec(`
        create table if not exists agent_worktrees (
          id text primary key,
          workspace_id text not null references workspaces(id) on delete cascade,
          agent_id text not null unique references agent_sessions(id) on delete cascade,
          repo_root text not null,
          branch text not null,
          path text not null,
          base_ref text not null default 'HEAD',
          status text not null check (status in ('READY', 'ERROR', 'MISSING')),
          last_validated_at text not null,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );

        create table if not exists agent_runs (
          id text primary key,
          workspace_id text not null references workspaces(id) on delete cascade,
          agent_id text not null references agent_sessions(id) on delete cascade,
          title text not null,
          prompt text not null,
          state text not null check (state in ('CREATED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'ERROR', 'STOPPED')),
          error_message text,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp,
          started_at text not null default current_timestamp,
          completed_at text
        );
        create index if not exists idx_agent_runs_agent on agent_runs(agent_id, created_at desc);
        create index if not exists idx_agent_runs_workspace on agent_runs(workspace_id, created_at desc);

        create table if not exists transcript_entries (
          id text primary key,
          run_id text not null references agent_runs(id) on delete cascade,
          workspace_id text not null references workspaces(id) on delete cascade,
          agent_id text not null references agent_sessions(id) on delete cascade,
          seq integer not null,
          entry_type text not null check (entry_type in ('user', 'assistant', 'tool', 'system', 'error', 'approval')),
          content text not null,
          metadata text not null default '{}',
          created_at text not null default current_timestamp,
          unique(run_id, seq)
        );
        create index if not exists idx_transcript_entries_run on transcript_entries(run_id, seq asc);

        create table if not exists tool_calls (
          id text primary key,
          run_id text not null references agent_runs(id) on delete cascade,
          workspace_id text not null references workspaces(id) on delete cascade,
          agent_id text not null references agent_sessions(id) on delete cascade,
          provider_call_id text,
          approval_id text,
          tool_name text not null,
          status text not null check (status in ('requested', 'pending_approval', 'approved', 'denied', 'running', 'completed', 'error')),
          input text not null,
          output text,
          requested_cwd text,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        create index if not exists idx_tool_calls_run on tool_calls(run_id, created_at asc);

        create table if not exists approval_requests (
          id text primary key,
          run_id text not null references agent_runs(id) on delete cascade,
          workspace_id text not null references workspaces(id) on delete cascade,
          agent_id text not null references agent_sessions(id) on delete cascade,
          tool_call_id text not null unique references tool_calls(id) on delete cascade,
          status text not null check (status in ('PENDING', 'APPROVED', 'DENIED')),
          requested_action text not null,
          requested_payload text not null,
          reason text,
          decision_message text,
          created_at text not null default current_timestamp,
          decided_at text
        );
        create index if not exists idx_approval_requests_workspace on approval_requests(workspace_id, created_at desc);
        create index if not exists idx_approval_requests_status on approval_requests(status, created_at desc);

        create table if not exists handoff_items (
          id text primary key,
          workspace_id text not null references workspaces(id) on delete cascade,
          source_agent_id text not null references agent_sessions(id) on delete cascade,
          source_run_id text not null references agent_runs(id) on delete cascade,
          assigned_agent_id text references agent_sessions(id) on delete set null,
          title text not null,
          summary text not null,
          recommended_provider text not null,
          recommended_model text not null,
          next_prompt text not null,
          artifact_ids text not null default '[]',
          status text not null check (status in ('OPEN', 'ASSIGNED', 'DONE', 'DISMISSED')),
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        create index if not exists idx_handoff_items_workspace on handoff_items(workspace_id, created_at desc);
        create index if not exists idx_handoff_items_status on handoff_items(status, created_at desc);
      `);
    },
  },
  {
    name: "0004_tool_call_provider_id.sql",
    apply: async (db) => {
      await ensureColumn(db, "tool_calls", "provider_call_id", `
        alter table tool_calls
        add column provider_call_id text
      `);
    },
  },
  {
    name: "0005_repair_agent_session_foreign_keys.sql",
    apply: async (db) => {
      await repairAgentSessionForeignKeys(db);
    },
  },
  {
    name: "0006_workspace_coordination_state.sql",
    apply: async (db) => {
      await db.exec(`
        create table if not exists workspace_coordination_states (
          workspace_id text primary key references workspaces(id) on delete cascade,
          brief text,
          agent_briefs text not null default '[]',
          handoff_summaries text not null default '[]',
          finding_summaries text not null default '[]',
          action_requests text not null default '[]',
          team_ask text,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
      `);
    },
  },
  {
    name: "0007_workspace_coordination_findings.sql",
    apply: async (db) => {
      await ensureColumn(db, "workspace_coordination_states", "finding_summaries", `
        alter table workspace_coordination_states
        add column finding_summaries text not null default '[]'
      `);
      await ensureColumn(db, "workspace_coordination_states", "action_requests", `
        alter table workspace_coordination_states
        add column action_requests text not null default '[]'
      `);
    },
  },
  {
    name: "0008_workspace_coordination_team_ask.sql",
    apply: async (db) => {
      await ensureColumn(db, "workspace_coordination_states", "team_ask", `
        alter table workspace_coordination_states
        add column team_ask text
      `);
    },
  },
  {
    name: "0009_coordinator_state_phase1.sql",
    apply: async (db) => {
      await ensureColumn(db, "workspace_coordination_states", "dependency_graph", `
        alter table workspace_coordination_states
        add column dependency_graph text not null default '[]'
      `);
      await ensureColumn(db, "workspace_coordination_states", "execution_plan", `
        alter table workspace_coordination_states
        add column execution_plan text not null default '[]'
      `);
      await ensureColumn(db, "workspace_coordination_states", "blocked_agents", `
        alter table workspace_coordination_states
        add column blocked_agents text not null default '[]'
      `);
      await ensureColumn(db, "workspace_coordination_states", "coordinator_decisions", `
        alter table workspace_coordination_states
        add column coordinator_decisions text not null default '[]'
      `);
      await ensureColumn(db, "workspace_coordination_states", "reply_packets", `
        alter table workspace_coordination_states
        add column reply_packets text not null default '[]'
      `);
      await ensureColumn(db, "workspace_coordination_states", "team_ask_history", `
        alter table workspace_coordination_states
        add column team_ask_history text not null default '[]'
      `);

      // Backfill: migrate existing team_ask snapshots into the new history column
      await db.exec(`
        update workspace_coordination_states
        set team_ask_history = json_array(json(team_ask))
        where team_ask is not null and team_ask != 'null' and team_ask != ''
      `);

      await ensureColumn(db, "workspace_coordination_states", "current_prompt_id", `
        alter table workspace_coordination_states
        add column current_prompt_id text
      `);

      // Add coordination_brief as a dedicated column to workspaces (resolves dual-write hazard)
      await ensureColumn(db, "workspaces", "coordination_brief", `
        alter table workspaces
        add column coordination_brief text
      `);

      await db.exec(`
        update workspaces set coordination_brief = (
          select brief from workspace_coordination_states where workspace_id = workspaces.id
        ) where exists (select 1 from workspace_coordination_states where workspace_id = workspaces.id)
      `);
    },
  },
  {
    name: "0010_cross_agent_context.sql",
    apply: async (db) => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_blocks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('private','workspace')) DEFAULT 'private',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(agent_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_blocks_workspace ON agent_memory_blocks(workspace_id, scope);
        CREATE INDEX IF NOT EXISTS idx_memory_blocks_agent ON agent_memory_blocks(agent_id);

        CREATE TABLE IF NOT EXISTS agent_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          from_agent_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
          to_agent_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
          subject TEXT NOT NULL,
          content TEXT NOT NULL,
          read_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, read_at);
      `);

      // Feature 5: workspace shared KV
      await ensureColumn(db, "workspaces", "shared_context_kv",
        `ALTER TABLE workspaces ADD COLUMN shared_context_kv TEXT NOT NULL DEFAULT '{}'`);

      // Feature 3: handoff auto-spawn flag
      await ensureColumn(db, "handoff_items", "auto_assign",
        `ALTER TABLE handoff_items ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    name: "0011_batch_query_indexes.sql",
    apply: async (db) => {
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_runs_agent_created ON agent_runs(agent_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_transcript_run_seq ON transcript_entries(run_id, seq ASC);
      `);
    },
  },
  {
    name: "0012_coordinator_usage.sql",
    apply: async (db) => {
      await ensureColumn(db, "workspace_coordination_states", "coordinator_usage", `
        alter table workspace_coordination_states
        add column coordinator_usage text
      `);
    },
  },
] as const;

type LoggerLike = Pick<Console, "info" | "warn" | "error">;

type AppliedMigrationRow = QueryResultRow & {
  name: string;
};

type ExistingTableRow = QueryResultRow & {
  name: string;
};

async function ensureMigrationTable(db: Queryable): Promise<void> {
  await db.exec(`
    create table if not exists ${migrationTableName} (
      name text primary key,
      applied_at text not null default current_timestamp
    )
  `);
}

export async function runMigrations(
  db: Database,
  logger: LoggerLike = console,
): Promise<string[]> {
  await ensureMigrationTable(db);

  const appliedResult = await db.query<AppliedMigrationRow>(
    `select name from ${migrationTableName} order by name asc`,
  );
  const applied = new Set(appliedResult.rows.map((row) => row.name));
  const executed: string[] = [];

  for (const migration of embeddedMigrations) {
    if (applied.has(migration.name)) {
      continue;
    }

    await db.transaction(async (client) => {
      await ensureMigrationTable(client);
      await migration.apply(client);
      await client.query(`insert into ${migrationTableName} (name) values (?)`, [migration.name]);
    });

    executed.push(migration.name);
    logger.info(`applied migration ${migration.name}`);
  }

  if (executed.length === 0) {
    logger.info("database schema already up to date");
  }

  return executed;
}

export async function assertCoreSchema(db: Database): Promise<void> {
  const placeholders = requiredTables.map(() => "?").join(", ");
  const result = await db.query<ExistingTableRow>(
    `
      select name
      from sqlite_master
      where type = 'table'
        and name in (${placeholders})
    `,
    [...requiredTables],
  );

  const existing = new Set(result.rows.map((row) => row.name));
  const missing = requiredTables.filter((tableName) => !existing.has(tableName));

  if (missing.length > 0) {
    throw new Error(`Database schema is incomplete. Missing tables: ${missing.join(", ")}`);
  }
}
