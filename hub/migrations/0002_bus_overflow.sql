-- Events too big for a NOTIFY (which carries at most 8000 bytes) wait here, briefly, while the other
-- hub processes read them. See src/shared-bus.ts. Nothing here is a source of truth: the event log is,
-- and these rows are deleted a few minutes after they are written.

create table hub_bus_overflow (
  id bigserial primary key,
  body text not null,
  created_at timestamptz not null default now()
);

create index hub_bus_overflow_created on hub_bus_overflow (created_at);
