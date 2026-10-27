import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { smartImageSearch } from '../src/imagesearch.js';

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { meta: {} }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())) };
}

const product = (id, title) => ({ mallType: 'Weidian', itemId: id, enTitle: title, cnPrice: 199, picUrl: 'https://img.example/x.jpg', oneYear: 10, qcPhotosCount: 3 });

test('photo : la marque lue par le modèle de vision passe devant, la recherche par texte complète', async () => {
  const searched = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://cdn.discordapp.com') || u.startsWith('https://media.discordapp.net')) {
      return new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.endsWith('/searchImage/search')) return Response.json({ code: 0, data: { search_id: 's1' } });
    if (u.includes('/searchImage/results/')) {
      return Response.json({ code: 0, data: { results: [
        product('1000001', 'Plain White Hoodie Oversized'),
        product('1000002', 'Chrome Hearts Cross Hoodie'),
        product('1000003', 'Stussy Basic Hoodie'),
      ] } });
    }
    if (u.includes('/spu/webSpuList')) {
      searched.push(new URL(u).searchParams.get('search'));
      return Response.json({ code: 0, data: { list: [product('1000002', 'Chrome Hearts Cross Hoodie'), product('1000004', 'CH Horseshoe Zip Hoodie'), product('1000005', 'Nike Hoodie')] } });
    }
    throw new Error(`fetch inattendu ${u} ${opts.method || ''}`);
  };
  const env = { DB: memoryDb(), AI: { run: async () => ({ response: '{"brand":"Chrome Hearts","model":null,"item":"hoodie","color":"white"}' }) } };
  const { items, seen } = await smartImageSearch(env, { url: 'https://cdn.discordapp.com/attachments/1/2/p.jpg', filename: 'p.jpg' });
  assert.equal(seen.brand, 'Chrome Hearts');
  assert.deepEqual(searched, ['chrome hearts hoodie']);
  assert.deepEqual(items.map((x) => x.id), ['1000002', '1000004', '1000001', '1000003']);
});

test('photo : FinderQC indisponible, la marque lue suffit (recherche par texte)', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://cdn.discordapp.com') || u.startsWith('https://media.discordapp.net')) {
      return new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.includes('/searchImage/')) return new Response('busy', { status: 429 });
    if (u.includes('/spu/webSpuList')) return Response.json({ code: 0, data: { list: [product('1000004', 'CH Horseshoe Zip Hoodie'), product('1000006', 'Chrome Hearts Cross Hoodie')] } });
    throw new Error(`fetch inattendu ${u}`);
  };
  const env = { DB: memoryDb(), AI: { run: async () => ({ response: '{"brand":"Chrome Hearts","item":"hoodie"}' }) } };
  const { items } = await smartImageSearch(env, { url: 'https://cdn.discordapp.com/attachments/1/2/p.jpg', filename: 'p.jpg' });
  assert.deepEqual(items.map((x) => x.id), ['1000004', '1000006']);
  const noBrand = { DB: memoryDb(), AI: { run: async () => ({ response: '{"brand":null,"item":"hoodie"}' }) } };
  await assert.rejects(smartImageSearch(noBrand, { url: 'https://cdn.discordapp.com/attachments/1/2/p.jpg', filename: 'p.jpg' }));
});

test('réponse d\'une photo : 4 items avec acheter, QC, comparer, suivre, et l\'inscription, sous 40 composants', async () => {
  const { imageResultsView } = await import('../src/imagesearch.js');
  const ctx = { cfg: { accent: 'orange', lang: 'fr' }, money: { rate: 0.13, code: 'EUR' }, base: 'https://bot.test', emojis: {},
    agents: [{ name: 'BBDBuy', template: 'https://bbd.example/{id}', preset: 'bbdbuy' }],
    signup: { url: 'https://agent.example/register', label: 'S\'inscrire', color: 'vert' } };
  const found = [1, 2, 3, 4].map((i) => ({ platform: 'weidian', id: `700000000${i}`, title: `Hoodie ${i}`, price: 199, image: 'https://img.example/x.jpg', sold: 5, qc: 3 }));
  const view = imageResultsView(ctx, found, '777', { brand: 'Nike', item: 'hoodie' });
  let n = 0; const walk = (c) => { n++; (c.components || []).forEach(walk); if (c.accessory) walk(c.accessory); }; view.forEach(walk);
  assert.ok(n <= 40, `${n} composants`);
  assert.match(JSON.stringify(view), /pub:cmp:weidian:7000000001/);
  assert.match(JSON.stringify(view), /pub:watch:weidian:7000000004/);
});
