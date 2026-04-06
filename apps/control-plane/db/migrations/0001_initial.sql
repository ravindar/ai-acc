create table if not exists workspaces (
  id text primary key,
  name text not null,
  description text,
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
  kind text not null check (kind in ('log', 'file', 'patch', 'trace')),
  uri text not null,
  size_bytes integer,
  created_at text not null default current_timestamp
);
