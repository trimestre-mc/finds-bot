// Base Turso (libSQL, compatible SQLite) avec la même interface que D1 : prepare().bind().first()/all()/run(), batch().
// Le reste du bot ne change pas. Protocole HTTP « Hrana » de Turso (POST /v2/pipeline).

function toArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}

function fromValue(c) {
  switch (c.type) {
    case 'integer': return Number(c.value);
    case 'float': return Number(c.value);
    case 'text': return c.value;
    case 'blob': return c.base64;
    default: return null;
  }
}

function toResult(r) {
  const cols = (r.cols || []).map((c) => c.name);
  const results = (r.rows || []).map((row) => Object.fromEntries(row.map((v, i) => [cols[i], fromValue(v)])));
  return {
    results,
    success: true,
    meta: { changes: r.affected_row_count || 0, rows_read: r.rows_read, rows_written: r.rows_written, last_row_id: r.last_insert_rowid },
  };
}

export function tursoDb(env) {
  const endpoint = `${String(env.TURSO_URL).replace(/^libsql:\/\//, 'https://').replace(/\/$/, '')}/v2/pipeline`;

  async function pipeline(requests) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
    });
    if (!res.ok) throw new Error(`Turso ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.results.slice(0, requests.length).map((r) => {
      if (r.type === 'error') throw new Error(`Turso : ${(r.error && r.error.message) || 'erreur'}`);
      return r.response;
    });
  }

  class Statement {
    constructor(sql, args = []) {
      this.sql = sql;
      this.args = args;
    }

    bind(...args) {
      return new Statement(this.sql, args);
    }

    async all() {
      const [response] = await pipeline([{ type: 'execute', stmt: { sql: this.sql, args: this.args.map(toArg) } }]);
      return toResult(response.result);
    }

    async first(column) {
      const { results } = await this.all();
      const row = results[0] ?? null;
      return column ? (row ? row[column] : null) : row;
    }

    async run() {
      return this.all();
    }
  }

  // Lot atomique, comme D1 : tout passe, ou rien (BEGIN … COMMIT, ROLLBACK si une étape échoue).
  async function batch(statements) {
    if (!statements.length) return [];
    const n = statements.length;
    const steps = [{ stmt: { sql: 'BEGIN' } }];
    statements.forEach((s, i) => steps.push({ condition: { type: 'ok', step: i }, stmt: { sql: s.sql, args: s.args.map(toArg) } }));
    steps.push({ condition: { type: 'ok', step: n }, stmt: { sql: 'COMMIT' } });
    steps.push({ condition: { type: 'not', cond: { type: 'ok', step: n + 1 } }, stmt: { sql: 'ROLLBACK' } });
    const [response] = await pipeline([{ type: 'batch', batch: { steps } }]);
    const { step_results: results, step_errors: errors } = response.result;
    const failed = errors.slice(0, n + 1).find((e) => e);
    if (failed) throw new Error(`Turso : ${failed.message}`);
    return results.slice(1, n + 1).map(toResult);
  }

  return { prepare: (sql) => new Statement(sql), batch };
}

// Utilise Turso si TURSO_URL et TURSO_TOKEN sont configurés, sinon la base D1 liée au Worker.
let cached = null;
export function withDb(env) {
  if (!env.TURSO_URL || !env.TURSO_TOKEN) return env;
  if (!cached || cached.url !== env.TURSO_URL) cached = { url: env.TURSO_URL, db: tursoDb(env) };
  return Object.assign(Object.create(env), { DB: cached.db });
}
