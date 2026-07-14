export interface D1ResultLike {
  success: boolean;
  results?: unknown[];
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all(): Promise<D1ResultLike>;
  raw(): Promise<unknown[][]>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
  exec(sql: string): Promise<unknown>;
  withSession?(bookmarkOrConstraint: string): D1DatabaseSessionLike;
}

export interface D1DatabaseSessionLike extends D1DatabaseLike {
  getBookmark(): string | null;
}

type QueryBody = {
  sql: string;
  bindings?: unknown[];
  session?: string;
};

type BatchBody = {
  statements: QueryBody[];
  session?: string;
};

const MAX_BATCH_STATEMENTS = 100;

/**
 * Implements the HTTP contract used by ntanduy/cloudflare-d1-database's
 * Worker connector. It is called only through the Container outbound handler,
 * so the endpoint is not exposed on the public Laravel Worker route.
 */
export async function handleD1ProxyRequest(
  request: Request,
  database: D1DatabaseLike | undefined,
): Promise<Response> {
  if (!database) {
    return errorResponse(7500, 'No Cloudflare D1 database is linked.', 503);
  }

  const path = new URL(request.url).pathname;

  if (path === '/health' && request.method === 'GET') {
    return json({ success: true, message: 'OK' });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    switch (path) {
      case '/query':
        return await query(request, database);
      case '/batch':
        return await batch(request, database);
      case '/exec':
        return await exec(request, database);
      case '/raw':
        return await raw(request, database);
      default:
        return json({ error: 'Not found' }, 404);
    }
  } catch (error) {
    return errorResponse(
      7500,
      error instanceof Error ? error.message : String(error),
      500,
    );
  }
}

async function query(request: Request, database: D1DatabaseLike) {
  const body = await readQueryBody(request);
  const session = getSession(database, body.session);
  const result = await session.database
    .prepare(body.sql)
    .bind(...(body.bindings ?? []))
    .all();

  return json({
    success: result.success,
    errors: [],
    messages: [],
    result: [result],
    ...(session.bookmark ? { bookmark: session.bookmark() } : {}),
  });
}

async function batch(request: Request, database: D1DatabaseLike) {
  const body = (await request.json()) as Partial<BatchBody>;

  if (!Array.isArray(body.statements) || body.statements.length === 0) {
    throw new Error('Missing or invalid "statements" field.');
  }

  if (body.statements.length > MAX_BATCH_STATEMENTS) {
    throw new Error(
      `Batch exceeds D1 limit of ${MAX_BATCH_STATEMENTS} statements.`,
    );
  }

  body.statements.forEach(validateQueryBody);

  const session = getSession(database, body.session);
  const statements = body.statements.map((statement) =>
    session.database
      .prepare(statement.sql)
      .bind(...(statement.bindings ?? [])),
  );
  const results = await session.database.batch(statements);

  return json({
    success: true,
    errors: [],
    messages: [],
    result: results,
    ...(session.bookmark ? { bookmark: session.bookmark() } : {}),
  });
}

async function exec(request: Request, database: D1DatabaseLike) {
  const body = (await request.json()) as { sql?: unknown };

  if (typeof body.sql !== 'string' || body.sql.length === 0) {
    throw new Error('Missing or invalid "sql" field.');
  }

  return json({
    success: true,
    errors: [],
    messages: [],
    result: await database.exec(body.sql),
  });
}

async function raw(request: Request, database: D1DatabaseLike) {
  const body = await readQueryBody(request);
  const results = await database
    .prepare(body.sql)
    .bind(...(body.bindings ?? []))
    .raw();

  return json({
    success: true,
    errors: [],
    messages: [],
    result: [{ results }],
  });
}

async function readQueryBody(request: Request): Promise<QueryBody> {
  const body = (await request.json()) as QueryBody;

  validateQueryBody(body);

  return body;
}

function validateQueryBody(body: QueryBody) {
  if (!body || typeof body.sql !== 'string' || body.sql.length === 0) {
    throw new Error('Missing or invalid "sql" field.');
  }

  if (body.bindings !== undefined && !Array.isArray(body.bindings)) {
    throw new Error('"bindings" must be an array.');
  }
}

function getSession(database: D1DatabaseLike, session?: string) {
  if (!session || !database.withSession) {
    return { database };
  }

  const sessionDatabase = database.withSession(session);

  return {
    database: sessionDatabase,
    bookmark: () => sessionDatabase.getBookmark(),
  };
}

function errorResponse(code: number, message: string, status: number) {
  return json(
    {
      success: false,
      errors: [{ code, message }],
      result: [],
    },
    status,
  );
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
