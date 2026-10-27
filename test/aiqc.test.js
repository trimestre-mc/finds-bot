import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { qcAnalysis, analysisView, aiqcMessage, AIQC_PER_DAY } from '../src/aiqc.js';

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

const answer = '{"article":"Nike Tech Fleece Shorts","verdict":"a_verifier","points":[{"etat":"ok","texte":"Étiquette : taille M"},{"etat":"attention","texte":"Photo 2 : fil qui dépasse sur la poche"}],"conseil":"Demande une photo de près de la poche."}';

test('analyse IA des QC : résultat lisible, gardé en cache, limite du jour', async () => {
  let calls = 0;
  const env = { DB: memoryDb(), AI: { run: async () => { calls++; return { response: answer, usage: { neurons: 150 } }; } } };
  globalThis.fetch = async () => new Response(new Uint8Array(3000), { headers: { 'content-type': 'image/jpeg' } });
  const photos = ['https://img.finderqc.com/1.jpg', 'https://img.finderqc.com/2.jpg'];
  const first = await qcAnalysis(env, photos);
  assert.equal(first.result.verdict, 'a_verifier');
  assert.equal(first.result.article, 'Nike Tech Fleece Shorts');
  assert.equal(calls, 3); // une analyse par photo (2) + la fusion
  const again = await qcAnalysis(env, photos);
  assert.equal(again.cached, true);
  assert.equal(calls, 3); // en cache : aucun appel de plus
  const view = JSON.stringify(analysisView({}, first, { title: 'Nike Tech Fleece Shorts', photos }));
  assert.match(view, /Quelques points à vérifier/);
  assert.match(view, /⚠️ Photo 2 : fil qui dépasse/);
  assert.match(view, /pas une garantie/);
  // Limite du jour : au-delà de AIQC_PER_DAY analyses nouvelles, plus d'appel à l'IA.
  env.DB.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_qc', ?)").run(JSON.stringify({ day: new Date().toISOString().slice(0, 10), used: AIQC_PER_DAY }));
  const limited = await qcAnalysis(env, ['https://img.finderqc.com/3.jpg']);
  assert.equal(limited.reason, 'limite');
  assert.match(JSON.stringify(analysisView({}, limited)), /limite du jour/);
});

test('salon d\'analyse IA : photos postées → « analyse en cours » puis le résultat', async () => {
  const env = { DB: memoryDb(), DISCORD_API: 'https://discord.test', AI: { run: async () => ({ response: answer }) } };
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://discord.test')) { sent.push({ method: opts.method, body: opts.body }); return Response.json({ id: 'p1' }); }
    return new Response(new Uint8Array(3000), { headers: { 'content-type': 'image/jpeg' } });
  };
  const c = { channel_id: '555', done: 0 };
  const ctx = { cfg: { accent: 'orange' }, emojis: {} };
  const m = { id: '1', author: { id: '42' }, content: 'mes qc', attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/a.jpg', filename: 'a.jpg', content_type: 'image/jpeg' }] };
  await aiqcMessage(env, ctx, c, m);
  assert.equal(c.done, 1);
  assert.match(sent[0].body, /Analyse de tes QC en cours/);
  assert.equal(sent[1].method, 'PATCH');
  assert.match(sent[1].body, /Étiquette : taille M/);
  assert.match(sent[1].body, /Demandé par <@42>/);
  assert.equal(await aiqcMessage(env, ctx, c, { ...m, attachments: [] }), 0); // pas de photo : rien
});
