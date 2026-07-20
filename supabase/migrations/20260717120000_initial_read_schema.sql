-- Initial read-scope schema for the "Local Supabase + Blorg" milestone.
-- Columns are generated from the authoritative Parse schema dump
-- (BloomBooks/bloom-parser-server-schema, schema/production.json), mapped
-- camelCase -> snake_case. IDs preserve legacy Parse objectIds (TEXT PKs);
-- rows created in Supabase get a legacy-style 10-char alphanumeric id.
--
-- Deliberately NOT here yet (post-milestone): derivation triggers replacing
-- Parse beforeSave (search string, tag normalization, ...), updated_at
-- triggers (an update trigger stamping now() would overwrite the Parse
-- timestamps the importer/sync writes on every re-run; updated_at triggers
-- arrive together with the sync-gating mechanism when the write path lands),
-- write RLS policies, auth wiring, apiAccount and the app* / downloadHistory
-- classes.

create extension if not exists pgcrypto;

-- Legacy-style short id: 10 alphanumeric chars, like Parse objectIds.
-- 24 random bytes -> base64 (32 chars) always retains >= 10 alphanumerics
-- after stripping '+', '/', '='.
create or replace function public.generate_legacy_style_id()
returns text
language sql
volatile
as $$
  select substring(
           regexp_replace(encode(gen_random_bytes(24), 'base64'), '[^0-9A-Za-z]', '', 'g')
           from 1 for 10
         );
$$;

-- ---------------------------------------------------------------------------
-- users (minimal: what anonymous book display needs, i.e. uploader email).
-- Full auth design (Firebase third-party) comes later.
-- ---------------------------------------------------------------------------
create table public.users (
  id text primary key default public.generate_legacy_style_id(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  email text unique -- in Parse, username == email
);

create table public.languages (
  id text primary key default public.generate_legacy_style_id(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  iso_code text, -- NOT unique: production has multiple rows per isoCode
  name text,
  english_name text,
  ethnologue_code text,
  usage_count integer,
  banner_image_url text
);

create table public.tags (
  id text primary key default public.generate_legacy_style_id(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text unique -- Parse has uniqueNameIndex
);

create table public.books (
  id text primary key default public.generate_legacy_style_id(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  uploader_id text references public.users(id),

  all_titles text, -- JSON-as-string, parsed client-side (matches Parse)
  analytics_bloompub_downloads integer,
  analytics_epub_downloads integer,
  analytics_finished_count integer,
  analytics_mean_questions_correct_pct numeric,
  analytics_median_questions_correct_pct numeric,
  analytics_pdf_downloads integer,
  analytics_questions_in_book_count integer,
  analytics_quizzes_taken_count integer,
  analytics_shell_downloads integer,
  analytics_started_count integer,
  authors text[],
  base_url text,
  bloom_pub_version integer,
  book_hash_from_images text,
  book_instance_id text,
  book_lineage text,
  book_lineage_array text[],
  book_order text,
  booklet_making_is_appropriate boolean,
  branding_project_name text,
  copyright text,
  country text,
  credits text,
  current_tool text,
  district text,
  download_count integer,
  download_source text,
  draft boolean,
  edition text,
  experimental boolean,
  features text[],
  folio boolean,
  format_version text,
  harvest_log text[],
  harvest_started_at timestamptz,
  harvest_state text,
  harvester_id text,
  harvester_major_version integer,
  harvester_minor_version integer,
  has_bloom_pub boolean,
  imported_book_source_url text,
  importer_major_version integer,
  importer_minor_version integer,
  importer_name text,
  in_circulation boolean,
  internet_limits jsonb,
  isbn text,
  keyword_stems text[],
  keywords text[],
  lang_pointers text[], -- language ids; kept alongside book_languages for sync fidelity
  -- Parse's legacy `languages` array is deliberately NOT ported: every
  -- production row that has it holds [] (nothing has written it since Jan
  -- 2015), and the name must stay free so PostgREST can embed language
  -- records as `languages(*)` through book_languages.
  last_uploaded timestamptz,
  leveled_reader_level integer,
  librarian_note text,
  license text,
  license_notes text,
  original_publisher text,
  original_title text,
  page_count integer,
  phash_of_first_content_image text,
  province text,
  publisher text,
  publisher_book_id text, -- added to Parse after the schema dump (bloom-parse-server PR #76)
  reader_tools_available boolean,
  rebrand boolean,
  search text,
  show jsonb,
  suitable_for_making_shells boolean,
  suitable_for_vernacular_library boolean,
  summary text,
  tags text[],
  thumbnail text,
  title text,
  tools jsonb, -- array that can hold objects in Parse
  update_source text,
  upload_pending_timestamp bigint,

  -- soft-delete support for the future incremental sync (tombstones)
  is_deleted boolean not null default false,
  deleted_at timestamptz
);

-- Junction table so PostgREST/supabase-js can embed language records with
-- books (Parse `include=langPointers` equivalent).
create table public.book_languages (
  book_id text not null references public.books(id) on delete cascade,
  language_id text not null references public.languages(id) on delete cascade,
  primary key (book_id, language_id)
);

create table public.related_books (
  id text primary key default public.generate_legacy_style_id(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  book_ids text[] -- Parse field `books`: array of Pointer<books>, flattened to ids
);

-- ---------------------------------------------------------------------------
-- Indexes for the anonymous read path (derived from blorg query patterns and
-- the hot Mongo indexes on the books class)
-- ---------------------------------------------------------------------------
create index idx_books_book_instance_id on public.books (book_instance_id);
create index idx_books_created_at on public.books (created_at desc);
create index idx_books_last_uploaded on public.books (last_uploaded desc);
create index idx_books_uploader_id on public.books (uploader_id);
create index idx_books_tags on public.books using gin (tags);
create index idx_books_features on public.books using gin (features);
create index idx_books_lang_pointers on public.books using gin (lang_pointers);
create index idx_books_book_lineage_array on public.books using gin (book_lineage_array);
create index idx_book_languages_language_id on public.book_languages (language_id);
create index idx_languages_iso_code on public.languages (iso_code);
create index idx_languages_usage_count on public.languages (usage_count desc);

-- ---------------------------------------------------------------------------
-- RLS: anonymous public read; no client writes (service role bypasses RLS,
-- which is how the importer/sync writes).
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.languages enable row level security;
alter table public.tags enable row level security;
alter table public.books enable row level security;
alter table public.book_languages enable row level security;
alter table public.related_books enable row level security;

-- Uploader emails are shown publicly on bloomlibrary.org book pages, so the
-- uploaders of visible books are readable (blorg embeds uploader:users(email)
-- via books.uploader_id). But the users table must not be a listable email
-- directory: rows without at least one visible book stay hidden.
create policy "Public read" on public.users for select to anon, authenticated
  using (
    exists (
      select 1 from public.books b
      where b.uploader_id = users.id and not b.is_deleted
    )
  );
create policy "Public read" on public.languages for select to anon, authenticated using (true);
create policy "Public read" on public.tags for select to anon, authenticated using (true);
-- Soft-deleted books (tombstones from the future incremental sync) must never
-- be served to clients.
create policy "Public read" on public.books for select to anon, authenticated
  using (not is_deleted);
-- Junction rows must not enumerate the ids of soft-deleted (invisible) books.
create policy "Public read" on public.book_languages for select to anon, authenticated
  using (
    exists (
      select 1 from public.books b
      where b.id = book_id and not b.is_deleted
    )
  );
-- Same principle: a related_books row is only served while at least one of
-- its books is visible. (A mixed row can still contain a deleted book's id
-- in book_ids — an opaque id whose book row stays unreadable.)
create policy "Public read" on public.related_books for select to anon, authenticated
  using (
    exists (
      select 1 from public.books b
      where b.id = any (book_ids) and not b.is_deleted
    )
  );

-- Table-level grants (RLS policies filter rows; grants allow the operation).
grant select on public.users, public.languages, public.tags, public.books,
  public.book_languages, public.related_books to anon, authenticated;
grant all on public.users, public.languages, public.tags, public.books,
  public.book_languages, public.related_books to service_role;
