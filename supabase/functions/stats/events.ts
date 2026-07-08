// Go to postgresql (the analytics database) to get the information asked for
// based on category and rowType.
//
// Differences from the Azure version, both deliberate:
// - SQL is parameterized instead of assembled by string interpolation (the Azure
//   version had only a crude ";" check against injection).
// - moment is replaced by a strict local date validator.

export interface IParseDBQuery {
  url: string;
  method?: string;
  options: {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    data?: any;
  };
}

export interface IFilter {
  parseDBQuery?: IParseDBQuery;
  branding?: string;
  country?: string;
  fromDate?: string;
  toDate?: string;
  bookId?: string;
  bookInstanceId?: string;
}

// strict YYYY-MM-DD, and it must be a real calendar date
export function isValidDateStr(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const [year, month, day] = [+match[1], +match[2], +match[3]];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function getSqlFunctionName(
  category: string,
  rowType: string
): string {
  if (category === "reading" && rowType === "book") {
    return "common.get_book_stats";
  } else if (category === "reading" && rowType === "per-day") {
    return "common.get_reading_perday_events";
  } else if (category === "reading" && rowType === "per-book") {
    return "common.get_reading_perbook_events";
  } else if (category === "reading" && rowType === "overview") {
    return "common.get_reading_overview";
  } else if (category === "reading" && rowType === "locations") {
    return "common.get_reading_locations";
  }
  throw new Error(`Unknown category and rowType: (${category}, ${rowType})`);
}

interface SqlStatement {
  text: string;
  values?: unknown[];
}

export async function processEvents(
  category: string,
  rowType: string,
  filter: IFilter
): Promise<any[]> {
  const t0 = Date.now();

  if (filter.fromDate && !isValidDateStr(filter.fromDate)) {
    throw new Error(`Invalid from date: ${filter.fromDate}`);
  } else if (filter.toDate && !isValidDateStr(filter.toDate)) {
    throw new Error(`Invalid to date: ${filter.toDate}`);
  }

  const sqlFunctionName = getSqlFunctionName(category, rowType);

  let statements: SqlStatement[] | undefined;
  if (sqlFunctionName === "common.get_book_stats") {
    statements = [
      {
        text: "SELECT * FROM common.get_book_stats($1, $2)",
        values: [filter.bookId, filter.bookInstanceId],
      },
    ];
  } else {
    statements = await getCombinedParseAndOrSqlStatements(
      sqlFunctionName,
      filter
    );
  }

  if (!statements) {
    // Parse has no records matching the query; no stats to report.
    return [];
  }

  const rows = await runStatements(statements, sqlFunctionName);

  const t1 = Date.now();
  console.log(`stats - processEvents took ${t1 - t0} milliseconds to complete.`);
  return rows;
}

async function runStatements(
  statements: SqlStatement[],
  sqlFunctionName: string
): Promise<any[]> {
  // Lazy import (mirrors the Azure version's require("pg") inside the function)
  // so that unit tests of the pure logic don't need the npm package.
  const { default: pg } = await import("npm:pg@8.16.3");
  // Like the Azure version, connection settings come from the standard libpq
  // environment variables: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE.
  const client = new pg.Client();
  await client.connect();
  try {
    const tSql0 = Date.now();
    let lastResult;
    for (const statement of statements) {
      lastResult = await client.query(statement.text, statement.values);
    }
    const tSql1 = Date.now();
    console.log(
      `stats - SQL query (${sqlFunctionName}) took ${
        tSql1 - tSql0
      } milliseconds to return.`
    );
    return lastResult?.rows ?? [];
  } finally {
    await client.end();
  }
}

function getDatesFromFilter(filter: IFilter): [string, string] {
  let fromDate = filter.fromDate;
  if (!fromDate) fromDate = "2000-01-01";
  let toDate = filter.toDate;
  if (!toDate) toDate = "9999-12-31";

  return [fromDate, toDate];
}

// Serialize axios-style params the way axios did for the Azure version:
// object values are JSON-stringified, everything else becomes a string.
export function appendAxiosStyleParams(
  url: string,
  params: Record<string, unknown> | undefined
): string {
  if (!params) return url;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    searchParams.append(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value)
    );
  }
  const queryString = searchParams.toString();
  if (!queryString) return url;
  return url + (url.includes("?") ? "&" : "?") + queryString;
}

async function queryParseForBooks(bookQuery: IParseDBQuery): Promise<any> {
  // Filtering for collections built up of subcollections produces very complex
  // filters that get too large to express as parameters in a URL.  For such
  // queries, we have to use a POST with the filter and other parameters as data,
  // and with an embedded GET operation indicated.
  const t0 = Date.now();
  let response: Response;
  if (
    bookQuery.method === "POST" &&
    bookQuery.options?.data?._method === "GET"
  ) {
    response = await fetch(bookQuery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bookQuery.options.headers || {}),
      },
      body: JSON.stringify(bookQuery.options.data),
    });
  } else {
    response = await fetch(
      appendAxiosStyleParams(bookQuery.url, bookQuery.options?.params),
      { headers: bookQuery.options?.headers }
    );
  }
  const t1 = Date.now();
  console.log(
    `stats - parse server query took ${t1 - t0} milliseconds to return.`
  );

  if (!response.ok) {
    throw new Error("Invalid book query");
  }
  return await response.json();
}

// Build the parameterized CREATE TEMP TABLE statement for the book IDs
// returned by Parse. Returns undefined if Parse returned no books.
export function generateAddParseBooksToTempTableStatement(
  booksInfo: Array<{ objectId: string; bookInstanceId: string }>
): SqlStatement | undefined {
  if (!booksInfo || booksInfo.length === 0) {
    return undefined;
  }

  const placeholders: string[] = [];
  const values: unknown[] = [];
  booksInfo.forEach((b, i) => {
    placeholders.push(`($${i * 2 + 1},$${i * 2 + 2})`);
    values.push(b.objectId, b.bookInstanceId);
  });

  return {
    text: `CREATE TEMP TABLE temp_book_ids(book_id,book_instance_id) AS VALUES ${placeholders.join(
      ","
    )}`,
    values,
  };
}

async function getCombinedParseAndOrSqlStatements(
  functionName: string,
  filter: IFilter
): Promise<SqlStatement[] | undefined> {
  const statements: SqlStatement[] = [];
  const parseDBQuery = filter.parseDBQuery;
  const shouldQueryUsingIdsInTempTable: boolean = !!parseDBQuery;
  if (parseDBQuery) {
    // First, determine the group of books by asking parse using the given query.
    const data = await queryParseForBooks(parseDBQuery);
    if (!data || !data.results) {
      throw new Error("Invalid book query");
    }
    const tempTableStatement = generateAddParseBooksToTempTableStatement(
      data.results
    );
    if (!tempTableStatement) {
      // Parse has no records
      console.log("stats - no results returned from parse server");
      return undefined;
    }
    statements.push(tempTableStatement);
  }

  // Determine which books by passing parameters to postgresql directly (not book IDs from parse in a temp table).
  const [fromDate, toDate] = getDatesFromFilter(filter);

  // note branding is not actually needed anymore, but still expected by the postgresql function at the moment.
  // Not all queries use branding and/or country. At the moment the locations one does not.
  // NB: absent branding/country become SQL NULL, which the functions treat as "no filter"
  // (their WHERE clauses are `p_branding IS NULL OR ...`). The Azure version interpolated
  // '${filter.branding}' and so sent the literal string "undefined" — which could only ever
  // match nothing in the non-temp-table branch. NULL is what the SQL was designed for.
  statements.push({
    text: `SELECT * from ${functionName}($1, $2, $3, $4, $5)`,
    values: [
      shouldQueryUsingIdsInTempTable,
      fromDate,
      toDate,
      filter.branding ?? null,
      filter.country ?? null,
    ],
  });
  return statements;
}
