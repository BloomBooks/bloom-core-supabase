-- Enables per-array-element wildcard tag matching (Parse supported e.g.
-- "bookshelf:Enabling Writers*" via Mongo regex on the tags array; PostgREST
-- has no per-element pattern operator). tags_text renders the tags array as
-- "|tag1|tag2|...|", so a LIKE against it can anchor on element boundaries:
--   prefix  bookshelf:X*  ->  LIKE '%|bookshelf:X%'
--   suffix  *X            ->  LIKE '%X|%'
--   contains *X*          ->  LIKE '%X%'   (tags never contain '|')
--
-- array_to_string() is only STABLE in Postgres, and generated columns demand
-- IMMUTABLE expressions; for text[] (no element rendering ambiguity) this
-- wrapper is genuinely immutable.
create or replace function public.immutable_text_array_to_string(text[], text)
returns text
language sql
immutable
as $$
  select array_to_string($1, $2);
$$;

alter table public.books
  add column tags_text text generated always as (
    '|' || public.immutable_text_array_to_string(tags, '|') || '|'
  ) stored;
