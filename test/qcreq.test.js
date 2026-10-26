import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePublicComponent } from '../src/features.js';
import { qcWindow } from '../src/qc.js';

// Base SQLite en mémoire avec la même interface que D1, et le vrai schéma.
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

// Faux Discord : enregistre les appels.
function fakeDiscord() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: '999' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const allText = (v) => JSON.stringify(v);

async function click(env, customId, user = '111') {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const it = { type: 3, guild_id: 'g1', channel_id: 'c1', token: 'tok', application_id: 'app', member: { user: { id: user } }, data: { custom_id: customId } };
  const res = await handlePublicComponent(it, env, ctx);
  await Promise.all(pending);
  return res;
}

test('fenêtre QC sans aucune QC : bouton « Demander un QC » seulement si un salon QC existe', async () => {
  const item = { id: 'weidian:7000000001', item_id: '7000000001', platform: 'weidian', qc_count: 0, qc_preview: null };
  const env = { DB: memoryDb() };
  fakeDiscord(); // aucune source QC ne répond
  const withCh = await qcWindow(env, item, 0, { community: [], qcChannel: '555' });
  assert.match(allText(withCh), /pub:qcreq:weidian:7000000001/);
  const without = await qcWindow(env, item, 0, { community: [] });
  assert.doesNotMatch(allText(without), /pub:qcreq/);
});

test('« Demander un QC » : message dans le salon QC, une seule demande par item et par 24 h', async () => {
  const DB = memoryDb();
  DB.raw.exec("INSERT INTO qc_channels (channel_id, guild_id, added_at) VALUES ('555', 'g1', 0)");
  DB.raw.exec('CREATE TABLE IF NOT EXISTS qc_requests (item_id TEXT PRIMARY KEY, user_id TEXT, at INTEGER NOT NULL)');
  DB.raw.exec(`INSERT INTO items (id, platform, item_id, title_en, url, image, first_seen)
    VALUES ('weidian:7000000001', 'weidian', '7000000001', 'Test Hoodie', 'https://weidian.com/item.html?itemID=7000000001', 'https://img.example/x.jpg', 0)`);
  const env = { DB, DISCORD_BOT_TOKEN: 't', DISCORD_APP_ID: 'app' };

  let calls = fakeDiscord();
  await click(env, 'pub:qcreq:weidian:7000000001');
  const posted = calls.find((c) => c.method === 'POST' && c.url.endsWith('/channels/555/messages'));
  assert.ok(posted, 'demande postée dans le salon QC');
  assert.match(allText(posted.body), /QC demandés/);
  assert.match(allText(posted.body), /weidian\.com\/item\.html\?itemID=7000000001/);
  assert.match(allText(posted.body), /<@111>/);
  const reply = calls.find((c) => c.method === 'PATCH');
  assert.match(allText(reply.body), /Demande envoyée/);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM qc_requests').get().n, 1);

  // Deuxième clic (autre membre) dans les 24 h : pas de nouveau message.
  calls = fakeDiscord();
  await click(env, 'pub:qcreq:weidian:7000000001', '222');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.endsWith('/channels/555/messages')));
  assert.match(allText(calls.find((c) => c.method === 'PATCH').body), /déjà été demandés/);
});

test('« Demander un QC » : lien d\'item invalide ignoré', async () => {
  const env = { DB: memoryDb() };
  fakeDiscord();
  assert.equal(await click(env, 'pub:qcreq:evil:abc'), null);
});

test('FinderQC surchargé (429) : la fenêtre dit « réessaie », pas « aucune QC », et garde le compteur', async () => {
  const item = { id: 'weidian:4290211664', item_id: '4290211664', platform: 'weidian', qc_count: 8443, qc_preview: null };
  globalThis.fetch = async () => new Response('', { status: 429 });
  const view = allText(await qcWindow({ DB: memoryDb() }, item, 0, { community: [], qcChannel: '555' }));
  assert.match(view, /surchargée/);
  assert.match(view, /8 443 photos QC/);
  assert.match(view, /pub:qcp:weidian:4290211664:0/);
  assert.doesNotMatch(view, /Aucune photo QC|pub:qcreq/);
});
