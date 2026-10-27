import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { itemDb, itemsWhereIds, countAll, perDb } from '../src/shard.js';
import { allResultIds, itemsByIds } from '../src/search.js';
import { expandQuery } from '../src/synonyms.js';
import { postContext, buildItemMessage } from '../src/post.js';

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

test('deux bases : Weidian dans la 1re, Taobao et 1688 dans la 2e ; recherche et lecture fusionnées', async () => {
  const env = { DB: memoryDb(), DB2: memoryDb(), LIVE_SEARCH: '0' };
  const add = (platform, id, title, pop) => itemDb(env, `${platform}:${id}`).raw.prepare(
    "INSERT INTO items (id, platform, item_id, url, title_en, popularity, first_seen) VALUES (?, ?, ?, 'https://weidian.com/x', ?, ?, 1)",
  ).run(`${platform}:${id}`, platform, id, title, pop);
  add('weidian', '1000000', 'Nike Tech Fleece Hoodie', 50);
  add('taobao', '1000001', 'Nike Tech Fleece Jacket', 90);
  add('weidian', '1000002', 'Supreme Box Logo Tee', 10);
  assert.equal(env.DB2.raw.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
  assert.equal(await countAll(env, 'SELECT COUNT(*) AS n FROM items'), 3);
  assert.equal(perDb(env).length, 2);

  const ids = await allResultIds(env, { q: 'nike tech', groups: expandQuery('nike tech'), includePosted: true, sort: 'popular' }, { rate: 1 });
  assert.deepEqual(ids, ['taobao:1000001', 'weidian:1000000']);
  const items = await itemsByIds(env, ids);
  assert.deepEqual(items.map((i) => i.title_en), ['Nike Tech Fleece Jacket', 'Nike Tech Fleece Hoodie']);
  assert.equal((await itemsWhereIds(env, ['weidian:1000002', 'taobao:1000001'])).length, 2);
  assert.equal(itemDb(env, '7863670229'), env.DB);

  // Une carte d'item de la 2e base se construit comme une autre.
  const msg = buildItemMessage(items[0], await postContext(env));
  assert.match(JSON.stringify(msg), /Nike Tech Fleece Jacket/);
});
