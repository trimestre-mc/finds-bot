import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePublicComponent } from '../src/features.js';
import { compareView } from '../src/compare.js';
import { voteRow } from '../src/qc.js';

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

const texts = (v) => JSON.stringify(v);
const item = { id: 'weidian:7863670229', platform: 'weidian', item_id: '7863670229', image: 'https://img.example/a.jpg', title_en: 'Nike Tech Fleece Hoodie', category: 'hoodies', price_cny: 299, popularity: 50, qc_count: 4 };

test('votes GL/RL : un vote par membre, modifiable, chiffres mis à jour dans la fenêtre', async () => {
  const env = { DB: memoryDb() };
  env.DB.raw.prepare("INSERT INTO items (id, platform, item_id, url) VALUES ('weidian:7863670229', 'weidian', '7863670229', 'https://weidian.com/x')").run();
  const message = { components: [{ type: 17, components: [voteRow(item)] }] };
  const vote = async (user, v) => (await handlePublicComponent({ member: { user: { id: user } }, message, data: { custom_id: `pub:vote:${item.id}:${v}` } }, env, { waitUntil: (p) => p })).json();
  await vote('a', 'gl');
  await vote('b', 'gl');
  const res = await vote('a', 'rl'); // a change d'avis
  assert.match(texts(res.data.components), /GL · 1/);
  assert.match(texts(res.data.components), /RL · 1/);
  await new Promise((r) => setTimeout(r, 10));
  const row = env.DB.raw.prepare('SELECT gl_votes, rl_votes FROM items').get();
  assert.deepEqual({ ...row }, { gl_votes: 1, rl_votes: 1 });
});

test('comparer : le même article chez d\'autres vendeurs, le moins cher et le plus vendu repérés', async () => {
  const env = { DB: memoryDb() };
  env.DB.raw.prepare("INSERT INTO items (id, platform, item_id, url, image, title_en, category, price_cny, popularity, qc_count) VALUES (?, 'weidian', ?, 'https://weidian.com/x', ?, ?, 'hoodies', 299, 50, 4)")
    .run(item.id, item.item_id, item.image, item.title_en);
  let calls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls++;
    if (u === item.image) return new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/jpeg' } });
    if (u.endsWith('/searchImage/search')) return Response.json({ code: 0, data: { search_id: 's' } });
    if (u.includes('/searchImage/results/')) {
      return Response.json({ code: 0, data: { results: [
        { mallType: 'Weidian', itemId: '7863670229', enTitle: 'Nike Tech Fleece Hoodie', cnPrice: 299, picUrl: 'https://img.example/a.jpg', oneYear: 50, qcPhotosCount: 4 },
        { mallType: 'Weidian', itemId: '7000000001', enTitle: 'NK Tech Fleece Hoodie Grey', cnPrice: 189, picUrl: 'https://img.example/b.jpg', oneYear: 900, qcPhotosCount: 40 },
        { mallType: 'Taobao', itemId: '7000000002', enTitle: 'Tech Fleece Hoodie Black', cnPrice: 159, picUrl: 'https://img.example/c.jpg', oneYear: 20, qcPhotosCount: 0 },
        { mallType: 'Weidian', itemId: '7000000003', enTitle: 'Tech Fleece Pants', cnPrice: 99, picUrl: 'https://img.example/d.jpg', oneYear: 5000, qcPhotosCount: 1 },
      ] } });
    }
    throw new Error(`fetch inattendu ${u}`);
  };
  const view = texts(await compareView(env, item.id));
  assert.match(view, /chez \*\*3\*\* vendeurs/); // l'article + 2 hoodies (le pantalon est écarté : autre catégorie)
  assert.match(view, /Tech Fleece Hoodie Black[^"]*\\n[^"]*le moins cher/);
  assert.match(view, /NK Tech Fleece Hoodie Grey[^"]*\\n[^"]*le plus vendu/);
  const before = calls;
  await compareView(env, item.id); // en cache : rien de redemandé
  assert.equal(calls, before);
});

test('partager des QC : message public avec les photos, qui a partagé et les boutons d\'achat', async () => {
  const env = { DB: memoryDb(), DISCORD_APP_ID: 'app', DISCORD_API: 'https://discord.test' };
  env.DB.raw.prepare("INSERT INTO agents (name, template, position) VALUES ('BBDBuy', 'https://bbd.example/{id}', 1)").run();
  env.DB.raw.prepare("INSERT INTO items (id, platform, item_id, url, title_en, qc_count) VALUES ('weidian:7863670229', 'weidian', '7863670229', 'https://weidian.com/item.html?itemID=7863670229', 'Nike Tech Fleece Hoodie', 2)").run();
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('finderqc')) {
      return Response.json({ code: 0, data: { spuInfo: { qcPhotosCount: 2, spuQcName: [{ name: 'BBDBuy', spuImg: [{ url: 'https://img.finderqc.com/qc1.jpg' }, { url: 'https://img.finderqc.com/qc2.jpg' }] }] } } });
    }
    if (u.startsWith('https://discord.test')) { sent.push({ url: u, method: opts.method, body: JSON.parse(opts.body || 'null') }); return Response.json({ id: '1' }); }
    throw new Error(`fetch inattendu ${u}`);
  };
  const waits = [];
  const window = { components: [{ type: 17, components: [{ type: 10, content: '## QC' }] }] };
  const res = await handlePublicComponent({ token: 'tok', channel_id: '555', member: { user: { id: '42' } }, message: window,
    data: { custom_id: 'pub:qcshare:weidian:7863670229:0' } }, env, { waitUntil: (p) => waits.push(p) });
  assert.equal((await res.json()).type, 6); // réponse différée : la fenêtre sera mise à jour
  await Promise.all(waits);
  const post = sent.find((s) => s.method === 'POST' && s.url.endsWith('/webhooks/app/tok'));
  assert.ok(post, 'message public envoyé');
  assert.equal((post.body.flags & 64), 0, 'pas éphémère');
  const body = JSON.stringify(post.body);
  assert.match(body, /Partagé par <@42>/);
  assert.match(body, /qc1\.jpg/);
  assert.match(body, /Acheter sur BBDBuy/);
  const edit = sent.find((s) => s.method === 'PATCH');
  assert.match(JSON.stringify(edit.body), /Partagé dans le salon/);
});

test('comparer un item pas encore dans la base : sa fiche FinderQC sert de point de départ', async () => {
  const env = { DB: memoryDb() };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('webSpuInfo')) return Response.json({ code: 0, data: { spuInfo: { enTitle: 'Stussy Basic Hoodie', cnPrice: 210, picUrl: 'https://img.finderqc.com/a.jpg', oneYear: 30, qcPhotosCount: 2 } } });
    if (u === 'https://img.finderqc.com/a.jpg') return new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/jpeg' } });
    if (u.endsWith('/searchImage/search')) return Response.json({ code: 0, data: { search_id: 's' } });
    if (u.includes('/searchImage/results/')) {
      return Response.json({ code: 0, data: { results: [{ mallType: 'Taobao', itemId: '8000000001', enTitle: 'Stussy Hoodie Black', cnPrice: 150, picUrl: 'https://img.finderqc.com/b.jpg', oneYear: 400, qcPhotosCount: 12 }] } });
    }
    throw new Error(`fetch inattendu ${u}`);
  };
  const view = JSON.stringify(await compareView(env, 'taobao:7000000009'));
  assert.match(view, /chez \*\*2\*\* vendeurs/);
  assert.match(view, /Stussy Hoodie Black[^"]*\\n[^"]*le moins cher/);
});
