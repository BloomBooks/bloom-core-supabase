// Parse -> Supabase sample importer (sync tool v0).
//
// Fetches a diverse sample of in-circulation books from a Parse server's
// public read API and upserts them (plus their uploaders, languages, tags,
// and relatedBooks rows) into a Supabase database. Idempotent: re-running
// refreshes the same rows.
//
// Environment. Variables are SYNC_-prefixed on purpose: generic names like
// SUPABASE_URL are often set machine-wide (deploy credentials!) and must not
// silently redirect this tool.
//   SYNC_PARSE_SERVER_URL  default: production bloom-parse-server
//   SYNC_PARSE_APP_ID      default: production app id (public; it ships in
//                          the bloomlibrary.org client bundle)
//   SYNC_SUPABASE_URL      default: http://127.0.0.1:44321 (local stack)
//   SYNC_SUPABASE_SERVICE_ROLE_KEY  default: the local stack's demo key
//   SYNC_ALLOW_REMOTE      must be "1" to write to a non-localhost Supabase
//   SAMPLE_TARGET          approximate number of books to import, default 100

import { createClient } from "@supabase/supabase-js";

const PARSE_SERVER_URL =
  process.env.SYNC_PARSE_SERVER_URL ??
  "https://bloom-parse-server-production.azurewebsites.net/parse";
const PARSE_APP_ID =
  process.env.SYNC_PARSE_APP_ID ?? "R6qNTeumQXjJCMutAJYAwPtip1qBulkFyLefkCE5";
const SUPABASE_URL = process.env.SYNC_SUPABASE_URL ?? "http://127.0.0.1:44321";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SYNC_SUPABASE_SERVICE_ROLE_KEY ??
  // Well-known local-dev service key printed by `supabase start`. Not a secret.
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const SAMPLE_TARGET = parseInt(process.env.SAMPLE_TARGET ?? "100", 10);

const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(
  SUPABASE_URL
);
if (!isLocalTarget && process.env.SYNC_ALLOW_REMOTE !== "1") {
  console.error(
    `Refusing to write to non-local Supabase (${SUPABASE_URL}).\n` +
      `Set SYNC_ALLOW_REMOTE=1 if you really mean to.`
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Parse REST helpers
// ---------------------------------------------------------------------------

async function parseQuery(className, params) {
  // POST with _method:GET (Parse REST convention) so large `where` clauses
  // don't hit query-string length limits (IIS rejects >2KB with a bare 404).
  const res = await fetch(`${PARSE_SERVER_URL}/classes/${className}`, {
    method: "POST",
    headers: {
      "X-Parse-Application-Id": PARSE_APP_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ _method: "GET", ...params }),
  });
  if (!res.ok) {
    throw new Error(
      `Parse query ${className} failed: ${res.status} ${await res.text()}`
    );
  }
  return (await res.json()).results;
}

// ---------------------------------------------------------------------------
// The diverse sampler: several angles so search, facets, levels, features and
// multiple scripts all have something to show in the local library.
// ---------------------------------------------------------------------------

// Books must be publicly visible and harvested (so S3 artifacts exist).
const BASE_WHERE = {
  inCirculation: true,
  draft: { $ne: true },
  rebrand: { $ne: true },
  harvestState: "Done",
  baseUrl: { $exists: true },
};

function langQuery(isoCode) {
  return {
    langPointers: {
      $inQuery: { where: { isoCode }, className: "language" },
    },
  };
}

const SAMPLER = [
  { label: "newest", where: {}, order: "-createdAt", limit: 20 },
  { label: "talking books", where: { features: "talkingBook" }, limit: 10 },
  { label: "activities", where: { features: { $in: ["activity", "quiz"] } }, limit: 8 },
  { label: "sign language", where: { features: "signLanguage" }, limit: 6 },
  { label: "level 1", where: { tags: "computedLevel:1" }, limit: 5 },
  { label: "level 2", where: { tags: "computedLevel:2" }, limit: 5 },
  { label: "level 3", where: { tags: "computedLevel:3" }, limit: 5 },
  { label: "level 4", where: { tags: "computedLevel:4" }, limit: 5 },
  { label: "topic: animal stories", where: { tags: "topic:Animal Stories" }, limit: 6 },
  { label: "topic: science", where: { tags: "topic:Science" }, limit: 6 },
  { label: "topic: health", where: { tags: "topic:Health" }, limit: 6 },
  { label: "french", where: langQuery("fr"), limit: 5 },
  { label: "spanish", where: langQuery("es"), limit: 5 },
  { label: "swahili", where: langQuery("sw"), limit: 5 },
  { label: "thai", where: langQuery("th"), limit: 5 },
  { label: "arabic", where: langQuery("ar"), limit: 5 },
  { label: "chinese", where: langQuery("zh"), limit: 5 },
  { label: "bengali", where: langQuery("bn"), limit: 5 },
  { label: "derivatives", where: { bookLineage: { $exists: true, $ne: "" } }, limit: 6 },
];

// ---------------------------------------------------------------------------
// Transform: Parse book JSON -> snake_case row + relations
// ---------------------------------------------------------------------------

// Columns of public.books (see supabase/migrations/20260717120000_*.sql),
// minus id/created_at/updated_at/uploader_id which are handled specially.
const BOOK_COLUMNS = new Set([
  "all_titles", "analytics_bloompub_downloads", "analytics_epub_downloads",
  "analytics_finished_count", "analytics_mean_questions_correct_pct",
  "analytics_median_questions_correct_pct", "analytics_pdf_downloads",
  "analytics_questions_in_book_count", "analytics_quizzes_taken_count",
  "analytics_shell_downloads", "analytics_started_count", "authors",
  "base_url", "bloom_pub_version", "book_hash_from_images",
  "book_instance_id", "book_lineage", "book_lineage_array", "book_order",
  "booklet_making_is_appropriate", "branding_project_name", "copyright",
  "country", "credits", "current_tool", "district", "download_count",
  "download_source", "draft", "edition", "experimental", "features", "folio",
  "format_version", "harvest_log", "harvest_started_at", "harvest_state",
  "harvester_id", "harvester_major_version", "harvester_minor_version",
  "has_bloom_pub", "imported_book_source_url", "importer_major_version",
  "importer_minor_version", "importer_name", "in_circulation",
  "internet_limits", "isbn", "keyword_stems", "keywords", "lang_pointers",
  "last_uploaded", "leveled_reader_level", "librarian_note",
  "license", "license_notes", "original_publisher", "original_title",
  "page_count", "phash_of_first_content_image", "province", "publisher",
  "publisher_book_id", "reader_tools_available", "rebrand", "search", "show",
  "suitable_for_making_shells", "suitable_for_vernacular_library", "summary",
  "tags", "thumbnail", "title", "tools", "update_source",
  "upload_pending_timestamp",
]);

// camelCase -> snake_case, aware of capital runs: bloomPUBVersion ->
// bloom_pub_version (not bloom_pubversion).
function toSnake(name) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function plainValue(v) {
  if (v && typeof v === "object" && v.__type === "Date") return v.iso;
  return v;
}

const droppedFields = new Set();

function transformBook(parseBook) {
  const row = {
    id: parseBook.objectId,
    created_at: parseBook.createdAt,
    updated_at: parseBook.updatedAt,
    uploader_id: parseBook.uploader?.objectId ?? null,
  };
  // `languages` is deliberately dropped: empty on every production row, and
  // its column-name slot is reserved for the PostgREST languages(*) embed
  // (see the schema migration).
  const specialFields = [
    "objectId", "createdAt", "updatedAt", "ACL", "uploader", "languages",
  ];
  for (const [key, value] of Object.entries(parseBook)) {
    if (specialFields.includes(key)) continue;
    if (key === "langPointers") {
      row.lang_pointers = (value ?? []).map((p) => p.objectId);
      continue;
    }
    const col = toSnake(key);
    if (!BOOK_COLUMNS.has(col)) {
      droppedFields.add(key);
      continue;
    }
    row[col] = plainValue(value);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function upsert(table, rows, options = {}) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: options.onConflict ?? "id" });
    if (error) throw new Error(`upsert into ${table} failed: ${error.message}`);
  }
  console.log(`  ${table}: upserted ${rows.length} rows`);
}

async function main() {
  console.log(`Parse:    ${PARSE_SERVER_URL}`);
  console.log(`Supabase: ${SUPABASE_URL}`);

  // 1. Gather a diverse sample of books (deduped by objectId).
  const booksById = new Map();
  for (const q of SAMPLER) {
    if (booksById.size >= SAMPLE_TARGET * 1.2) break;
    const results = await parseQuery("books", {
      where: { ...BASE_WHERE, ...q.where },
      limit: q.limit,
      ...(q.order ? { order: q.order } : {}),
      include: "uploader,langPointers",
    });
    let fresh = 0;
    for (const b of results) {
      if (!booksById.has(b.objectId)) fresh++;
      booksById.set(b.objectId, b);
    }
    console.log(`sampled ${q.label}: ${results.length} found, ${fresh} new`);
  }
  const parseBooks = [...booksById.values()];
  console.log(`total sample: ${parseBooks.length} books`);

  // 2. Collect referenced users and languages from the expanded pointers.
  const usersById = new Map();
  const languagesById = new Map();
  for (const b of parseBooks) {
    const u = b.uploader;
    if (u?.objectId) {
      usersById.set(u.objectId, {
        id: u.objectId,
        email: u.username ?? u.email ?? null,
        created_at: u.createdAt,
        updated_at: u.updatedAt,
      });
    }
    for (const lp of b.langPointers ?? []) {
      if (lp?.objectId && lp.__type !== "Pointer") {
        languagesById.set(lp.objectId, {
          id: lp.objectId,
          created_at: lp.createdAt,
          updated_at: lp.updatedAt,
          iso_code: lp.isoCode ?? null,
          name: lp.name ?? null,
          english_name: lp.englishName ?? null,
          ethnologue_code: lp.ethnologueCode ?? null,
          banner_image_url: lp.bannerImageUrl ?? null,
          usage_count: 0, // recomputed below from the local sample
        });
      }
    }
  }

  // Local usage counts so the language menu reflects what's actually here.
  for (const b of parseBooks) {
    for (const lp of b.langPointers ?? []) {
      const lang = languagesById.get(lp?.objectId);
      if (lang) lang.usage_count++;
    }
  }

  // 3. All tag rows (cheap, and the topic/search menus need the vocabulary).
  const parseTags = await parseQuery("tag", { limit: 10000, order: "name" });
  const tagRows = parseTags.map((t) => ({
    id: t.objectId,
    name: t.name,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  }));

  // 4. relatedBooks rows that mention any sampled book.
  const relatedRows = new Map();
  const ids = [...booksById.keys()];
  for (let i = 0; i < ids.length; i += 25) {
    const pointers = ids.slice(i, i + 25).map((id) => ({
      __type: "Pointer",
      className: "books",
      objectId: id,
    }));
    const results = await parseQuery("relatedBooks", {
      where: { books: { $in: pointers } },
      limit: 100,
    });
    for (const r of results) {
      relatedRows.set(r.objectId, {
        id: r.objectId,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        book_ids: (r.books ?? []).map((p) => p.objectId),
      });
    }
  }

  // 5. Transform books and build the junction rows.
  const bookRows = parseBooks.map(transformBook);
  // Dedupe per book: a duplicated langPointer would put the same
  // (book_id, language_id) twice in one upsert statement, which Postgres
  // rejects ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const bookLanguageRows = parseBooks.flatMap((b) => {
    const langIds = (b.langPointers ?? [])
      .filter((lp) => lp?.objectId && languagesById.has(lp.objectId))
      .map((lp) => lp.objectId);
    return [...new Set(langIds)].map((id) => ({
      book_id: b.objectId,
      language_id: id,
    }));
  });
  if (droppedFields.size > 0) {
    console.warn(
      `WARNING: Parse fields not in the books schema were dropped: ` +
        [...droppedFields].join(", ")
    );
  }

  // 6. Upsert in FK order.
  console.log("importing into Supabase...");
  await upsert("users", [...usersById.values()]);
  await upsert("languages", [...languagesById.values()]);
  await upsert("tags", tagRows);
  await upsert("books", bookRows);
  await upsert("book_languages", bookLanguageRows, {
    onConflict: "book_id,language_id",
  });
  await upsert("related_books", [...relatedRows.values()]);

  const { count } = await supabase
    .from("books")
    .select("*", { count: "exact", head: true });
  console.log(`done. books in Supabase: ${count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
