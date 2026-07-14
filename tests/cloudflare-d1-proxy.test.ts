import { describe, expect, it, vi } from 'vitest';
import {
  D1DatabaseLike,
  D1PreparedStatementLike,
  handleD1ProxyRequest,
} from '../cloudflare/d1-proxy';

describe('handleD1ProxyRequest', () => {
  it('executes parameterized queries using the linked binding', async () => {
    const statement = createStatement();
    const database = createDatabase(statement);
    const response = await handleD1ProxyRequest(
      new Request('http://sst-laravel-d1.internal/query', {
        method: 'POST',
        body: JSON.stringify({
          sql: 'select * from cache where key = ?',
          bindings: ['cache-key'],
        }),
      }),
      database,
    );

    expect(database.prepare).toHaveBeenCalledWith(
      'select * from cache where key = ?',
    );
    expect(statement.bind).toHaveBeenCalledWith('cache-key');
    expect(await response.json()).toEqual({
      success: true,
      errors: [],
      messages: [],
      result: [
        {
          success: true,
          results: [{ key: 'cache-key', value: 'serialized' }],
        },
      ],
    });
  });

  it('uses D1 batch for atomic batches', async () => {
    const statement = createStatement();
    const database = createDatabase(statement);
    const response = await handleD1ProxyRequest(
      new Request('http://sst-laravel-d1.internal/batch', {
        method: 'POST',
        body: JSON.stringify({
          statements: [
            { sql: 'insert into cache values (?, ?, ?)', bindings: ['a', 'b', 1] },
            { sql: 'delete from cache where key = ?', bindings: ['old'] },
          ],
        }),
      }),
      database,
    );

    expect(database.batch).toHaveBeenCalledWith([statement, statement]);
    expect(response.status).toBe(200);
  });

  it('supports migration SQL and reports a missing link', async () => {
    const database = createDatabase(createStatement());
    const migration = await handleD1ProxyRequest(
      new Request('http://sst-laravel-d1.internal/exec', {
        method: 'POST',
        body: JSON.stringify({ sql: 'create table cache (key text)' }),
      }),
      database,
    );
    const missing = await handleD1ProxyRequest(
      new Request('http://sst-laravel-d1.internal/query', { method: 'POST' }),
      undefined,
    );

    expect(database.exec).toHaveBeenCalledWith('create table cache (key text)');
    expect(migration.status).toBe(200);
    expect(missing.status).toBe(503);
  });
});

function createStatement(): D1PreparedStatementLike {
  const statement: D1PreparedStatementLike = {
    bind: vi.fn(() => statement),
    all: vi.fn(async () => ({
      success: true,
      results: [{ key: 'cache-key', value: 'serialized' }],
    })),
    raw: vi.fn(async () => [['cache-key', 'serialized']]),
  };

  return statement;
}

function createDatabase(statement: D1PreparedStatementLike): D1DatabaseLike {
  return {
    prepare: vi.fn(() => statement),
    batch: vi.fn(async () => [{ success: true }]),
    exec: vi.fn(async () => ({ count: 1, duration: 1 })),
  };
}
