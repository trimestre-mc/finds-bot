import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleFeatureComponent, handleFeatureModal, runSchedule } from '../src/features.js';

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { meta: {} }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())), raw: db };
}

const count = (v) => { let n = 0; const walk = (c) => { n++; (c.components || []).forEach(walk); if (c.accessory) walk(c.accessory); }; v.forEach(walk); return n; };

test('salons par catégorie : un salon choisi = un drop des meilleurs items de la catégorie', async () => {
  const DB = memoryDb();
  const insert = DB.raw.prepare("INSERT INTO items (id, platform, item_id, url, category, popularity, first_seen) VALUES (?, 'weidian', ?, 'https://weidian.com/x', ?, ?, 0)");
  for (let i = 0; i < 6; i++) insert.run(`weidian:10000${i}`, `10000${i}`, i < 4 ? 'shoes' : 'bags', 100 - i);
  const env = { DB };
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const it = { guild_id: 'g1', channel_id: 'c1', member: { user: { id: 'u1' } }, data: { resolved: { channels: { 555: { type: 0 } } } } };
  const ctx = { waitUntil: () => {} };

  const open = await handleFeatureComponent(it, env, ctx, 'cch', 'open', undefined, undefined, []);
  const view = (await open.json()).data.components;
  assert.ok(count(view) <= 40, `${count(view)} composants`);
  assert.match(JSON.stringify(view), /Salons par catégorie/);

  const picked = await (await handleFeatureComponent(it, env, ctx, 'cch', 'pick', undefined, undefined, ['shoes'])).json();
  assert.match(JSON.stringify(picked), /cch:set:shoes/);

  await handleFeatureComponent(it, env, ctx, 'cch', 'set', 'shoes', undefined, ['555']);
  const s = DB.raw.prepare('SELECT * FROM schedules').get();
  assert.equal(s.channel_id, '555');
  assert.equal(JSON.parse(s.params).catChannel, 'shoes');
  assert.deepEqual([s.per_run, s.every_minutes], [3, 60]);

  await handleFeatureComponent(it, env, ctx, 'cch', 'rhythm', undefined, undefined, ['10m']);
  const s2 = DB.raw.prepare('SELECT * FROM schedules').get();
  assert.deepEqual([s2.per_run, s2.every_minutes], [1, 10]);

  // Rythme personnalisé : « Personnalisé… » ouvre une modale, puis 5 items toutes les 15 min.
  const custom = await (await handleFeatureComponent(it, env, ctx, 'cch', 'rhythm', undefined, undefined, ['custom'])).json();
  assert.equal(custom.type, 9, 'modale');
  assert.equal(custom.data.custom_id, 'm:cch:rhythm');
  await handleFeatureModal(it, env, 'cch', ['rhythm'], { count: '5', minutes: '15' });
  const s3 = DB.raw.prepare('SELECT * FROM schedules').get();
  assert.deepEqual([s3.per_run, s3.every_minutes], [5, 15]);
  const bad = await (await handleFeatureModal(it, env, 'cch', ['rhythm'], { count: '50', minutes: '1' })).json();
  assert.match(JSON.stringify(bad), /Entre 1 et 10 items/);

  DB.raw.exec('UPDATE schedules SET per_run = 3');
  const n = await runSchedule(env, DB.raw.prepare('SELECT * FROM schedules').get());
  assert.equal(n, 3);
  const queued = DB.raw.prepare('SELECT item_id FROM post_queue ORDER BY id').all().map((r) => r.item_id);
  assert.deepEqual(queued, ['weidian:100000', 'weidian:100001', 'weidian:100002'], 'les plus vendus de la catégorie, pas les sacs');

  await handleFeatureComponent(it, env, ctx, 'cch', 'set', 'shoes', undefined, []);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 0, 'vider le salon arrête le drop');
});
