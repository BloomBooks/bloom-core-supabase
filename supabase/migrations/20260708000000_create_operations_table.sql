-- Tracks long-running operations (currently book upload-start/upload-finish).
-- Replaces the Azure Durable Functions state store: the books function inserts
-- a row and updates it when the background work completes; the status function
-- reads it. Clients poll /v1/status/{id}.
create table if not exists public.operations (
  id uuid primary key default gen_random_uuid(),
  -- Running | Succeeded | Failed (mirrors the old status API's terms)
  status text not null default 'Running',
  -- the return value of the operation (which may itself contain an error
  -- object for anticipated failures, matching the Azure behavior)
  result jsonb,
  -- unanticipated failure message (operation threw)
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only the service role (used by the edge functions, bypasses RLS) may access;
-- no policies means no access for anon/authenticated.
alter table public.operations enable row level security;

-- Allow cleanup of old rows by created_at.
create index if not exists operations_created_at_idx on public.operations (created_at);
