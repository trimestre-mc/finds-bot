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

test('écran Santé : quotas des deux bases et de l\'IA', async () => {
  const { healthView } = await import('../src/views.js');
  const env = { DB: memoryDb(), DB2: memoryDb(), READS_MONTH_CAP: '480000000', BUDGET_MONTH_ROWS: '9000000' };
  env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('reads:month', '{\"month\":\"2026-10\",\"rows\":498000000}')").run();
  const v = JSON.stringify(await healthView(env));
  assert.match(v, /Base 1 \(Weidian\)\*\* : lectures 498,0 M/);
  assert.match(v, /indexation en pause/);
  assert.match(v, /Base 2 \(Taobao \+ 1688\)/);
  assert.match(v, /IA du jour/);
});

test('top de la semaine : les items les plus cliqués, posté une fois dans le salon choisi', async () => {
  const { sendWeeklyTop } = await import('../src/report.js');
  const { settingsView } = await import('../src/views.js');
  const env = { DB: memoryDb(), DISCORD_API: 'https://discord.test' };
  env.DB.raw.prepare("INSERT INTO items (id, platform, item_id, url, title_en, price_cny) VALUES ('weidian:1000001', 'weidian', '1000001', 'u', 'Nike Tech Fleece Hoodie', 200), ('weidian:1000002', 'weidian', '1000002', 'u', 'Supreme Box Logo Tee', 150)").run();
  for (const [id, n] of [['weidian:1000001', 2], ['weidian:1000002', 5]]) {
    for (let i = 0; i < n; i++) env.DB.raw.prepare("INSERT INTO clicks (item_id, agent, at) VALUES (?, 'BBDBuy', ?)").run(id, Date.now());
  }
  const posted = [];
  globalThis.fetch = async (url, opts = {}) => { posted.push({ url: String(url), body: opts.body }); return Response.json({ id: 'm' }); };
  assert.equal(await sendWeeklyTop(env), false); // pas de salon choisi
  env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('cfg_weeklyTop', '777')").run();
  assert.equal(await sendWeeklyTop(env), true);
  assert.equal(await sendWeeklyTop(env), false); // déjà posté aujourd'hui
  assert.match(posted[0].url, /channels\/777\/messages/);
  assert.match(posted[0].body, /🥇 Supreme Box Logo Tee[\s\S]*🥈 Nike Tech Fleece Hoodie/);
  const settings = await settingsView(env, { guild_id: 'g' });
  let n = 0; const walk = (c) => { n++; (c.components || []).forEach(walk); if (c.accessory) walk(c.accessory); }; settings.forEach(walk);
  assert.ok(n <= 40, `réglages : ${n} composants`);
});

test('message reçu en direct : traité une seule fois (la position de lecture du salon sert de verrou)', async () => {
  const { handleLiveMessage } = await import('../src/watch.js');
  const env = { DB: memoryDb(), DISCORD_API: 'https://discord.test' };
  env.DB.raw.prepare("INSERT INTO convert_channels (channel_id, guild_id, added_at) VALUES ('555', 'g', 0)").run();
  env.DB.raw.prepare("INSERT INTO agents (name, template, position) VALUES ('BBDBuy', 'https://bbd.example/{id}', 1)").run();
  const posted = [];
  globalThis.fetch = async (url, opts = {}) => { posted.push(String(url)); return Response.json({ id: 'r1' }); };
  const m = { id: '1300000000000000001', channel_id: '555', author: { id: 'u' }, content: 'regarde https://weidian.com/item.html?itemID=7863670229', attachments: [], embeds: [] };
  assert.equal(await handleLiveMessage(env, '555', m), 1);
  assert.equal(await handleLiveMessage(env, '555', m), 0); // déjà traité
  assert.equal(posted.filter((u) => u.endsWith('/channels/555/messages')).length, 1);
  assert.equal(env.DB.raw.prepare('SELECT converted FROM convert_channels').get().converted, 1);
  assert.equal(await handleLiveMessage(env, '999', m), 0); // salon non surveillé
});

test('alertes de recherche : seuls les nouveaux items qui correspondent arrivent en message privé, une fois', async () => {
  const { toggleSearchAlert, checkSearchAlerts, watchesView } = await import('../src/alerts.js');
  const { expandQuery } = await import('../src/synonyms.js');
  const env = { DB: memoryDb(), DB2: memoryDb(), DISCORD_API: 'https://discord.test' };
  const add = (db, id, title, price) => db.raw.prepare("INSERT INTO items (id, platform, item_id, url, title_en, price_cny, popularity) VALUES (?, 'weidian', ?, 'u', ?, ?, 1)").run(`weidian:${id}`, id, title, price);
  add(env.DB, '1000001', 'Chrome Hearts Cross Hoodie', 300); // déjà là avant l'alerte : ignoré
  assert.match(await toggleSearchAlert(env, 'u1', 'g', { q: 'chrome hearts hoodie', groups: expandQuery('chrome hearts hoodie') }), /Alerte créée/);
  const dms = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/users/@me/channels')) return Response.json({ id: 'dm1' });
    if (u.endsWith('/channels/dm1/messages')) { dms.push(opts.body); return Response.json({ id: 'm' }); }
    throw new Error(`fetch inattendu ${u}`);
  };
  assert.equal(await checkSearchAlerts(env), 0); // premier passage : point de départ
  add(env.DB, '1000002', 'CH Horseshoe Zip Hoodie', 280);
  add(env.DB, '1000003', 'Nike Tech Fleece Hoodie', 200); // autre marque
  add(env.DB2, '1000004', 'Chrome Hearts Sweatshirt Black', 350); // autre base
  assert.equal(await checkSearchAlerts(env), 1);
  assert.match(dms[0], /CH Horseshoe Zip Hoodie/);
  assert.match(dms[0], /Chrome Hearts Sweatshirt Black/);
  assert.doesNotMatch(dms[0], /Nike Tech|Cross Hoodie/);
  assert.equal(await checkSearchAlerts(env), 0); // rien de nouveau
  assert.match(JSON.stringify(await watchesView(env, 'u1')), /chrome hearts hoodie/);
  assert.match(await toggleSearchAlert(env, 'u1', 'g', { q: 'chrome hearts hoodie' }), /supprimée/);
});
