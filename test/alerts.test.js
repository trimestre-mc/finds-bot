import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { toggleWatch, checkWatches } from '../src/alerts.js';

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

test('alertes de prix : suivre, message privé quand le prix baisse, une seule fois', async () => {
  const env = { DB: memoryDb(), DISCORD_API: 'https://discord.test' };
  env.DB.raw.prepare("INSERT INTO items (id, platform, item_id, url, title_en, price_cny) VALUES ('weidian:7863670229', 'weidian', '7863670229', 'https://weidian.com/item.html?itemID=7863670229', 'Nike Tech Fleece Hoodie', 300)").run();
  assert.match(await toggleWatch(env, 'u1', 'g', 'weidian:7863670229'), /Suivi/);
  let price = 300;
  const dms = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('webSpuInfo')) return Response.json({ code: 0, data: { spuInfo: { cnPrice: price } } });
    if (u.endsWith('/users/@me/channels')) return Response.json({ id: 'dm1' });
    if (u.endsWith('/channels/dm1/messages')) { dms.push(JSON.parse(opts.body)); return Response.json({ id: 'm' }); }
    throw new Error(`fetch inattendu ${u}`);
  };
  assert.equal(await checkWatches(env), 0); // prix inchangé
  price = 250;
  assert.equal(await checkWatches(env), 1);
  assert.match(JSON.stringify(dms[0]), /Baisse de prix/);
  assert.equal(env.DB.raw.prepare('SELECT price_cny, prev_price FROM items').get().prev_price, 300);
  assert.equal(await checkWatches(env), 0); // déjà prévenu à ce prix
  assert.match(await toggleWatch(env, 'u1', 'g', 'weidian:7863670229'), /ne suis plus/);
});

test('rapport du jour : activité, catalogue et quotas, envoyé une seule fois par jour', async () => {
  const { dailyReport, sendDailyReport } = await import('../src/report.js');
  const env = { DB: memoryDb(), DB2: memoryDb(), AGENTS_OWNER_ID: '944', DISCORD_API: 'https://discord.test' };
  env.DB.raw.prepare("INSERT INTO clicks (item_id, agent, at) VALUES ('weidian:1', 'BBDBuy', ?)").run(Date.now());
  env.DB.raw.prepare("INSERT INTO items (id, platform, item_id, url) VALUES ('weidian:1', 'weidian', '1', 'u')").run();
  const view = JSON.stringify(await dailyReport(env));
  assert.match(view, /Rapport du jour/);
  assert.match(view, /\*\*1\*\* clics \(BBDBuy 1\)/);
  assert.match(view, /Base 2 · Taobao \+ 1688/);
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => { sent.push(String(url)); return Response.json({ id: 'dm' }); };
  assert.equal(await sendDailyReport(env), true);
  assert.equal(await sendDailyReport(env), false);
  assert.equal(sent.filter((u) => u.endsWith('/channels/dm/messages')).length, 1);
});
