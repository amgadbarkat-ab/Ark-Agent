-- Ark Hub: conversation threads, the append-only event log that is their source of truth,
-- and the one-run-at-a-time lock per thread.

create table hub_threads (
  id text primary key,
  user_id text not null,
  agent_id text not null,
  name text,
  archived boolean not null default false,
  learning_container_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz
);

create index hub_threads_user_recency
  on hub_threads (user_id, archived, (coalesce(last_run_at, created_at)) desc, id desc);

create table hub_events (
  seq bigserial primary key,
  thread_id text not null references hub_threads (id) on delete cascade,
  run_id text,
  event_id text not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (thread_id, event_id)
);

create index hub_events_thread_seq on hub_events (thread_id, seq);
create index hub_events_run_seq on hub_events (thread_id, run_id, seq);

create table hub_thread_locks (
  thread_id text primary key references hub_threads (id) on delete cascade,
  run_id text not null,
  user_id text not null,
  agent_id text not null,
  lock_key text not null,
  expires_at timestamptz not null
);
