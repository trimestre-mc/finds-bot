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
  assert.equal(calls, 4); // identification de l'article + une analyse par photo (2) + la fusion
  const again = await qcAnalysis(env, photos);
  assert.equal(again.cached, true);
  assert.equal(calls, 4); // en cache : aucun appel de plus
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

test('quota d\'IA épuisé chez Cloudflare : message « limite du jour », plus d\'essai', async () => {
  let calls = 0;
  const env = { DB: memoryDb(), AI: { run: async () => { calls++; throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } } };
  globalThis.fetch = async () => new Response(new Uint8Array(3000), { headers: { 'content-type': 'image/jpeg' } });
  const res = await qcAnalysis(env, ['https://img.finderqc.com/9.jpg']);
  assert.equal(res.reason, 'limite');
  const before = calls;
  assert.equal((await qcAnalysis(env, ['https://img.finderqc.com/10.jpg'])).reason, 'limite');
  assert.equal(calls, before); // plus d'appel à l'IA aujourd'hui
});

test('Groq d\'abord (score sur 10, photos à demander), Cloudflare en secours si Groq est saturé', async () => {
  const groqPhoto = '{"photos":["étiquette US 11 / UK 10 / EUR 45"],"article":"Air Jordan 4","verdict":"ok","points":[{"etat":"ok","texte":"Étiquette conforme US 11 = UK 10 = EUR 45 (photo 1)"}]}';
  const groqMerge = '{"article":"Air Jordan 4","verdict":"ok","note":9,"points":[{"etat":"ok","texte":"Étiquette conforme US 11 = UK 10 = EUR 45 (photo 1)"}],"manque":["profil de la chaussure","semelle"],"conseil":"Demande une photo de profil."}';
  let cf = 0;
  let groqUp = true;
  const env = { DB: memoryDb(), GROQ_API_KEY: 'k', AI: { run: async () => { cf++; return { response: groqMerge, usage: { neurons: 5 } }; } } };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.groq.com')) {
      if (!groqUp) return new Response('rate limit', { status: 429 });
      const body = JSON.parse(opts.body);
      return Response.json({ choices: [{ message: { content: body.model.includes('scout') ? groqPhoto : groqMerge } }] });
    }
    return new Response(new Uint8Array(3000), { headers: { 'content-type': 'image/jpeg' } });
  };
  const res = await qcAnalysis(env, ['https://img.finderqc.com/a.jpg', 'https://img.finderqc.com/b.jpg']);
  assert.equal(cf, 1, 'Cloudflare seulement pour identifier l\'article (peu coûteux), les photos par Groq');
  assert.equal(res.result.note, 9);
  const view = JSON.stringify(analysisView({}, res, {}));
  assert.match(view, /Note QC : \*\*9\/10\*\*/);
  assert.match(view, /À demander à ton agent :\*\* profil de la chaussure · semelle/);
  groqUp = false;
  const fallback = await qcAnalysis(env, ['https://img.finderqc.com/c.jpg']);
  assert.ok(fallback.result, 'analyse faite par Cloudflare');
  assert.ok(cf > 0);
});

test('points d\'expert par marque : la bonne marque, plusieurs logos officiels acceptés', async () => {
  const { qcGuide } = await import('../src/qcguide.js');
  assert.match(qcGuide('BAPE hoodie camouflage bleu'), /têtes de singe/);
  assert.match(qcGuide('Supreme hoodie gris'), /Ne pénalise pas l'absence de box logo/);
  assert.match(qcGuide('Air Jordan 4'), /Jumpman/);
  assert.match(qcGuide('article inconnu'), /plusieurs logos officiels/);
  assert.doesNotMatch(qcGuide('article inconnu'), /Supreme|BAPE/);
});

test('qcGuide : savoir général par type d\'article, même sans marque connue', async () => {
  const { qcGuide, knownType } = await import('../src/qcguide.js');
  assert.match(qcGuide('sneakers blanches'), /deux pieds/);
  assert.match(qcGuide('sac en cuir'), /tranches/);
  assert.match(qcGuide('hoodie à capuche'), /molleton/);
  assert.doesNotMatch(qcGuide('hoodie à capuche'), /Casquette/);
  assert.doesNotMatch(qcGuide('sweatshirt'), /T-shirt/);
  assert.match(qcGuide('article inconnu'), /sérigraphie/);
  assert.equal(knownType('article inconnu'), false);
  assert.equal(knownType('Air Jordan 4'), true);
});
