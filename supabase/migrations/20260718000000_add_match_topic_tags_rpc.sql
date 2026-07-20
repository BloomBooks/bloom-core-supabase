-- Resolves non-canonical `topic:` filter values the way Parse/blorg did.
--
-- Background: blorg's `topic` filter (src/connection/BookQueryBuilder.ts) splits
-- the value on commas. Each part that matches a canonical topic in kTopicList
-- (case-insensitively) becomes an exact `topic:<Canonical>` tag requirement.
-- Parts that DON'T match a canonical topic ("non-canonical" topics) were
-- resolved by Parse with a case-insensitive Mongo $regex over the tag array:
--   * exactly one non-canonical value  -> anchored  ^topic:<value>$   (whole-tag
--     equality, case-insensitive)
--   * two or more non-canonical values -> the values are OR-joined as
--     `topic:<v1>|topic:<v2>|...` UNANCHORED, i.e. a case-insensitive
--     substring/contains match; a book matches if any of its tags contains
--     any of those substrings.
-- The value is regex-escaped (processRegExp) before being placed in the pattern,
-- so for every realistic input it behaves as a literal string, never a pattern.
--
-- PostgREST has no per-array-element regex operator, so the Supabase query
-- builder previously DROPPED non-canonical topics (a console.warn + TODO),
-- yielding an empty shelf where Parse showed books. This function closes that
-- gap: given the array of non-canonical topic values, it returns the set of
-- matching tag names, which the client feeds into its existing tag-requirement
-- machinery as an "any of these tags" (overlaps) constraint. That composes
-- (AND) with the canonical `topic:` requirements exactly as Parse's $and did.
--
-- Faithfulness / deliberate divergence: the value is treated as a LITERAL
-- string (exact equality for the single case via lower(), substring search via
-- strpos() for the multi case) rather than a regex. This mirrors processRegExp
-- for every normal input (it escapes all regex metacharacters) and, crucially,
-- does NOT honor processRegExp's obscure `/.../`-delimited raw-regex escape
-- hatch. That is intentional: this function is anon-executable, and evaluating
-- attacker-supplied regexes server-side is a ReDoS surface. The escape hatch is
-- not a reachable topic-filter input in practice.
--
-- Matching is done against the `tags` vocabulary table (small, unique-indexed
-- on name) rather than unnesting every book's tags on each call. In this
-- dataset the vocabulary is complete (every distinct book tag has a tags row),
-- and the Bloom tag vocabulary is maintained to stay so. A tag returned here
-- that no visible book carries is harmless (overlaps simply matches nothing);
-- soft-deleted books are still excluded by the outer book query's RLS.
--
-- Security posture: STABLE, read-only, SECURITY INVOKER (no RLS bypass -- it
-- only reads public.tags, which is public-read, and never returns book ids so
-- there is nothing soft-delete-related to leak). search_path is pinned.
create or replace function public.match_topic_tags(topic_names text[])
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(distinct t.name order by t.name), '{}'::text[])
  from public.tags t
  where case
    -- Single non-canonical value: anchored, whole-tag, case-insensitive
    -- equality (Parse's ^topic:value$ with the /i flag).
    when coalesce(array_length(topic_names, 1), 0) = 1 then
      lower(t.name) = lower('topic:' || topic_names[1])
    -- Two or more: unanchored, case-insensitive contains-match, OR-ed across
    -- the values (Parse's `topic:v1|topic:v2` with the /i flag). strpos on
    -- lower()ed operands is a pure literal substring test -- no pattern
    -- metacharacters, so nothing to escape and no ReDoS surface.
    when coalesce(array_length(topic_names, 1), 0) > 1 then
      exists (
        select 1
        from unnest(topic_names) as tn
        where strpos(lower(t.name), lower('topic:' || tn)) > 0
      )
    -- Empty/NULL input matches nothing.
    else false
  end;
$$;

-- Functions default to EXECUTE for PUBLIC; make the grant explicit and scoped.
revoke all on function public.match_topic_tags(text[]) from public;
grant execute on function public.match_topic_tags(text[])
  to anon, authenticated, service_role;
