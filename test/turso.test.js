import test from 'node:test';
import assert from 'node:assert/strict';
import { tursoDb } from '../src/turso.js';

// Faux serveur Turso : enregistre les requêtes et renvoie des réponses Hrana.
function fakeFetch(handler) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, auth: init.headers.Authorization });
    return { ok: true, json: async () => ({ results: [...body.requests.map(handler), { type: 'ok', response: { type: 'close' } }] }) };
  };
  return seen;
}

test('requête simple : arguments typés et lignes converties', async () => {
  const seen = fakeFetch((r) => ({
    type: 'ok',
    response: { type: 'execute', result: {
      cols: [{ name: 'id' }, { name: 'n' }, { name: 'price' }, { name: 'empty' }],
      rows: [[{ type: 'text', value: 'weidian:1' }, { type: 'integer', value: '42' }, { type: 'float', value: 1.5 }, { type: 'null' }]],
      affected_row_count: 0,
    } },
  }));
  const db = tursoDb('libsql://finds-bot-x.turso.io', 'tok');
  const row = await db.prepare('SELECT * FROM items WHERE id = ? AND n > ? AND p < ? AND x IS ?').bind('weidian:1', 3, 2.5, null).first();
  assert.deepEqual(row, { id: 'weidian:1', n: 42, price: 1.5, empty: null });
  assert.equal(seen[0].url, 'https://finds-bot-x.turso.io/v2/pipeline');
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.deepEqual(seen[0].body.requests[0].stmt.args, [
    { type: 'text', value: 'weidian:1' }, { type: 'integer', value: '3' }, { type: 'float', value: 2.5 }, { type: 'null' }]);
  assert.equal(await db.prepare('SELECT n FROM t').first('n'), 42);
});

test('lot atomique : BEGIN … COMMIT, résultats et nombre de lignes modifiées', async () => {
  const seen = fakeFetch(() => ({
    type: 'ok',
    response: { type: 'batch', result: {
      step_results: [{ cols: [], rows: [] }, { cols: [], rows: [], affected_row_count: 1 }, { cols: [], rows: [], affected_row_count: 0 }, { cols: [], rows: [] }, null],
      step_errors: [null, null, null, null, null],
    } },
  }));
  const db = tursoDb('libsql://x.turso.io', 't');
  const res = await db.batch([db.prepare('INSERT INTO a VALUES (?)').bind(1), db.prepare('INSERT OR IGNORE INTO a VALUES (?)').bind(1)]);
  assert.deepEqual(res.map((r) => r.meta.changes), [1, 0]);
  const steps = seen[0].body.requests[0].batch.steps.map((s) => s.stmt.sql);
  assert.deepEqual(steps, ['BEGIN', 'INSERT INTO a VALUES (?)', 'INSERT OR IGNORE INTO a VALUES (?)', 'COMMIT', 'ROLLBACK']);
});

test('lot atomique : une étape en erreur fait échouer tout le lot', async () => {
  fakeFetch(() => ({
    type: 'ok',
    response: { type: 'batch', result: {
      step_results: [{ cols: [], rows: [] }, null, null, null, { cols: [], rows: [] }],
      step_errors: [null, { message: 'UNIQUE constraint failed' }, null, null, null],
    } },
  }));
  const db = tursoDb('libsql://x.turso.io', 't');
  await assert.rejects(() => db.batch([db.prepare('INSERT INTO a VALUES (1)')]), /UNIQUE constraint failed/);
});
