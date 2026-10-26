import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runImageSearch } from '../src/imagesearch.js';

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

const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const result = (itemId, mallType, qc) => ({
  itemId, mallType, enTitle: `Hoodie ${itemId}`, cnPrice: 199, qcPhotosCount: qc, oneYear: 50,
  picUrl: `https://img.finderqc.com/${itemId}/spu/x.webp`,
});

// Faux Discord + fausse recherche FinderQC.
function fakeWeb(messages) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/channels/777/messages') && (init.method || 'GET') === 'GET') return json(messages);
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
    if (url.endsWith('/api/searchImage/search')) return json({ code: 0, data: { search_id: 'abc' } });
    if (url.includes('/api/searchImage/results/abc')) {
      return json({ code: 0, data: { results: [result('7561755071', 'Weidian', 293), result('868034409365', 'Taobao', 0), result('x', 'Weidian', 1)] } });
    }
    return json({ id: '999' });
  };
  return calls;
}

test('recherche par image : chaque photo d\'un membre reçoit les items qui ressemblent', async () => {
  const DB = memoryDb();
  DB.raw.exec("INSERT INTO image_channels (channel_id, guild_id, last_message_id, added_at) VALUES ('777', 'g1', '100', 0)");
  DB.raw.exec("INSERT INTO agents (name, template) VALUES ('BBDBuy', 'https://www.bbdbuy.com/goods/{PLATFORM}/{id}?inviteCode=TEST')");
  const env = { DB, DISCORD_BOT_TOKEN: 't', PUBLIC_URL: 'https://finds-bot.test' };
  const calls = fakeWeb([
    { id: '101', author: { id: 'u1' }, attachments: [{ url: 'https://cdn.discordapp.com/a/1.jpg', filename: '1.jpg', content_type: 'image/jpeg' }] },
    { id: '102', author: { id: 'bot', bot: true }, attachments: [{ url: 'https://cdn.discordapp.com/a/2.jpg', filename: '2.jpg', content_type: 'image/jpeg' }] },
    { id: '103', author: { id: 'u2' }, content: 'pas de photo', attachments: [] },
  ]);
  await runImageSearch(env);

  const searches = calls.filter((c) => c.url.endsWith('/api/searchImage/search'));
  assert.equal(searches.length, 1, 'une seule photo de membre (pas celle du bot)');
  assert.ok(searches[0].body instanceof FormData && searches[0].body.get('file'), 'image envoyée en multipart « file »');

  const reply = calls.find((c) => c.method === 'POST' && c.url.endsWith('/channels/777/messages'));
  assert.ok(reply, 'réponse postée dans le salon');
  const body = JSON.parse(reply.body);
  const s = JSON.stringify(body);
  assert.equal(body.message_reference.message_id, '101');
  assert.match(s, /Items qui ressemblent/);
  assert.match(s, /pub:qc:weidian:7561755071/);
  assert.match(s, /Voir les QC \(293\)/);
  assert.match(s, /finds-bot\.test\/go\/taobao%3A868034409365\/BBDBuy/);
  assert.doesNotMatch(s, /finderqc\.com\/product/, 'aucun lien vers le site de QC');
  assert.ok(!s.includes('"x"'), 'résultat invalide ignoré');

  const ch = DB.raw.prepare("SELECT last_message_id, searched FROM image_channels WHERE channel_id = '777'").get();
  assert.deepEqual({ ...ch }, { last_message_id: '103', searched: 1 });
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'finderqc'").get().n, 2, 'items trouvés ajoutés au catalogue');
});

test('recherche par image : premier passage, on ne répond pas aux anciennes photos', async () => {
  const DB = memoryDb();
  DB.raw.exec("INSERT INTO image_channels (channel_id, guild_id, added_at) VALUES ('777', 'g1', 0)");
  const calls = fakeWeb([{ id: '500', author: { id: 'u1' }, attachments: [{ url: 'https://cdn.discordapp.com/a/1.jpg', filename: '1.jpg', content_type: 'image/jpeg' }] }]);
  await runImageSearch({ DB, DISCORD_BOT_TOKEN: 't' });
  assert.ok(!calls.some((c) => c.url.includes('searchImage')));
  assert.equal(DB.raw.prepare("SELECT last_message_id FROM image_channels").get().last_message_id, '500');
});
