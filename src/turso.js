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

// Requêtes qui lisent beaucoup (quota gratuit : 500 M lignes lues par mois) : signalées dans les logs.
const HEAVY_READ = 20000;
function watchReads(sql, r) {
  if (r && r.rows_read > HEAVY_READ) console.log('lecture lourde', r.rows_read, sql.replace(/\s+/g, ' ').slice(0, 160));
}

// db : la base qui a répondu, pour son total de lignes lues pendant l'exécution (compteur du mois dans budget.js).
function toResult(r, sql = '', db = null) {
  watchReads(sql, r);
  if (db && r && r.rows_read) db.rowsRead += r.rows_read;
  const cols = (r.cols || []).map((c) => c.name);
  const results = (r.rows || []).map((row) => Object.fromEntries(row.map((v, i) => [cols[i], fromValue(v)])));
  return {
    results,
    success: true,
    meta: { changes: r.affected_row_count || 0, rows_read: r.rows_read, rows_written: r.rows_written, last_row_id: r.last_insert_rowid },
  };
}

// shared : compteur de requêtes commun à toutes les bases de l'exécution (50 requêtes externes max sur Workers gratuit).
// Lectures bloquées par Turso (quota du mois) : retenu 5 min par base, les lectures suivantes échouent tout de suite
// au lieu d'un aller-retour inutile (chaque fiche Taobao/1688 passait par là avant l'index Neon).
const blockedUntil = new Map();
const READ_ONLY = /^\s*(select|with)\b/i;

export function tursoDb(url, token, shared = { calls: 0 }) {
  const endpoint = `${String(url).replace(/^libsql:\/\//, 'https://').replace(/\/$/, '')}/v2/pipeline`;
  const db = { rowsRead: 0, get calls() { return shared.calls; } };

  async function pipeline(requests) {
    const send = () => {
      shared.calls++;
      return fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
      });
    };
    let res = await send();
    // Erreur passagère de Turso (5xx, ex. 520) : un 2e essai après une courte pause.
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 400));
      res = await send();
    }
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
      const read = READ_ONLY.test(this.sql);
      const known = read && blockedUntil.get(url);
      if (known && known.until > Date.now()) throw new Error(known.message);
      try {
        const [response] = await pipeline([{ type: 'execute', stmt: { sql: this.sql, args: this.args.map(toArg) } }]);
        if (read) blockedUntil.delete(url);
        return toResult(response.result, this.sql, db);
      } catch (err) {
        if (read && /reads are blocked/i.test(String(err))) blockedUntil.set(url, { until: Date.now() + 300000, message: err.message });
        throw err;
      }
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
    return results.slice(1, n + 1).map((r, i) => toResult(r, statements[i].sql, db));
  }

  return Object.assign(db, { prepare: (sql) => new Statement(sql), batch });
}

// Utilise Turso si TURSO_URL et TURSO_TOKEN sont configurés, sinon la base D1 liée au Worker. Avec TURSO2_URL et
// TURSO2_TOKEN, une 2e base (autre compte gratuit) reçoit la moitié du catalogue (voir shard.js).
// Un accès neuf par exécution : le compteur de requêtes repart de zéro à chaque fois.
export function withDb(env) {
  if (!env.TURSO_URL || !env.TURSO_TOKEN) return env;
  const shared = { calls: 0 };
  // MAIN_DB = "d1" : la 1re base Turso est mise de côté (ex. quota de lectures du mois atteint, lectures bloquées) ;
  // (Quota d'écritures du jour de D1 épuisé : les écritures sont ignorées au lieu de faire planter le bot ; voir d1Statement.)
  // réglages et items Weidian dans D1 (gratuit, 5 M lectures/jour), Taobao et 1688 toujours dans la 2e base Turso.
  if (env.MAIN_DB === 'd1') {
    const d1 = env.DB;
    const main = {
      isD1: true, rowsRead: 0, get calls() { return shared.calls; },
      prepare: (sql) => d1Statement(d1.prepare(sql), WRITE.test(sql)),
      batch: (list) => d1.batch(list.map((x) => x.inner || x)).catch((err) => {
        if (!writesFull(err)) throw err;
        return list.map(() => ({ results: [], meta: { rows_written: 0, skipped: true } }));
      }),
    };
    const extra = { DB: main };
    if (env.TURSO2_URL && env.TURSO2_TOKEN) extra.DB2 = tursoDb(env.TURSO2_URL, env.TURSO2_TOKEN, shared);
    return Object.assign(Object.create(env), extra);
  }
  const extra = { DB: tursoDb(env.TURSO_URL, env.TURSO_TOKEN, shared) };
  if (env.TURSO2_URL && env.TURSO2_TOKEN) extra.DB2 = tursoDb(env.TURSO2_URL, env.TURSO2_TOKEN, shared);
  return Object.assign(Object.create(env), extra);
}

// D1 gratuit : 100 000 lignes écrites par jour. Quota épuisé → une écriture ne fait rien (résultat vide) au lieu de
// lever une erreur : le bot continue de lire et de répondre jusqu'à minuit UTC.
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const writesFull = (err) => /daily row write limit|exceeded D1's free tier/i.test(String(err && err.message || err));

function d1Statement(stmt, write) {
  if (!write) return stmt;
  const guard = (p, empty) => p.catch((err) => {
    if (!writesFull(err)) throw err;
    console.log('D1 : quota d\'écritures du jour atteint, écriture ignorée');
    return empty;
  });
  return {
    inner: stmt,
    bind: (...args) => d1Statement(stmt.bind(...args), true),
    run: () => guard(stmt.run(), { results: [], meta: { rows_written: 0, skipped: true } }),
    all: () => guard(stmt.all(), { results: [], meta: { rows_written: 0, skipped: true } }),
    first: (col) => guard(stmt.first(col), null),
    raw: (o) => guard(stmt.raw(o), []),
  };
}
