import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { budget, dailyRows } from '../src/budget.js';

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { meta: {} }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => { for (const x of s) await x.run(); }, raw: db };
}

test('part du jour : reste du mois ÷ jours restants', () => {
  assert.equal(dailyRows(9000000, 0, new Date('2026-11-01T10:00:00Z')), 300000);
  assert.equal(dailyRows(9000000, 8000000, new Date('2026-10-27T10:00:00Z')), 200000);
});

test('budget lissé : la part du jour est répartie entre les tâches, le début de journée est mémorisé', async () => {
  const DB = memoryDb();
  const env = { DB, TURSO_URL: 'x', BUDGET_ITEMS: '1000000', BUDGET_PAGES: '1000000', BUDGET_MONTH_ROWS: '9000000' };
  DB.raw.prepare("INSERT INTO settings VALUES ('budget:month', ?)").run(JSON.stringify({ month: new Date().toISOString().slice(0, 7), rows: 1000, day: '2000-01-01' }));
  const b = await budget(env, 'items');
  const expected = Math.floor(dailyRows(9000000, 1000) * 0.4 / 8);
  assert.equal(b.left, expected);
  await b.use(100);
  const m = JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'budget:month'").get().value);
  assert.equal(m.rows, 1800);
  assert.equal(m.start, 1000);
  assert.equal(m.day, new Date().toISOString().slice(0, 10));
  await (await budget(env, 'pages')).use(10);
  const m2 = JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'budget:month'").get().value);
  assert.equal(m2.rows, 1840);
  assert.equal(m2.start, 1000);
  assert.equal((await budget(env, 'items')).left, expected - 100);
});
