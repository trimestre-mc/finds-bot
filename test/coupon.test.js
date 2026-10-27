import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseCouponLinks, setCoupon, setSignup } from '../src/config.js';
import { couponView } from '../src/views.js';
import { agentsView } from '../src/ui.js';
import { buildItemMessage, postContext, cardTitle } from '../src/post.js';

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
const buttons = (v) => { const out = []; const walk = (c) => { if (c.type === 2) out.push(c); (c.components || []).forEach(walk); if (c.accessory) walk(c.accessory); }; v.forEach(walk); return out; };

test('liens de /coupon : « Texte | lien », « Texte : lien », lien seul', () => {
  assert.deepEqual(parseCouponLinks('BBDBuy -15 % | https://a.example/x\nKakobuy : https://b.example/y\nhttps://c.example\npas un lien'), [
    { label: 'BBDBuy -15 %', url: 'https://a.example/x' },
    { label: 'Kakobuy', url: 'https://b.example/y' },
    { label: 'Ouvrir', url: 'https://c.example' },
  ]);
});

test('/coupon : message public avec les liens, sinon le bouton d\'inscription, sinon un message clair', async () => {
  const env = { DB: memoryDb() };
  assert.match(JSON.stringify(await couponView(env)), /Aucun coupon/);
  await setSignup(env, { url: 'https://agent.example/register', label: 'S\'inscrire', color: 'gris' });
  assert.ok(buttons(await couponView(env)).some((b) => b.url === 'https://agent.example/register'));
  await setCoupon(env, { title: 'Promos', message: 'Coupons offerts', links: parseCouponLinks('BBDBuy | https://a.example/x') });
  const v = await couponView(env);
  assert.match(JSON.stringify(v), /Promos/);
  assert.deepEqual(buttons(v).map((b) => b.url), ['https://a.example/x']);
  const admin = await agentsView(env, null, true);
  assert.ok(count(admin) <= 40, `${count(admin)} composants`);
  assert.ok(buttons(admin).some((b) => b.custom_id === 'ag:cp'));
});

test('carte : achat d\'abord, puis QC, annonce d\'origine ; titre nettoyé', async () => {
  const env = { DB: memoryDb() };
  env.DB.raw.prepare("INSERT INTO agents (name, template, position) VALUES ('BBDBuy', 'https://bbd.example/{id}', 1)").run();
  const item = { id: 'weidian:7863670229', platform: 'weidian', item_id: '7863670229', url: 'https://weidian.com/item.html?itemID=7863670229',
    title_en: 'Cross-border Nike Tech Fleece Hoodie', price_cny: 199, popularity: 1234, qc_count: 56, category: 'hoodies' };
  const msg = buildItemMessage(item, await postContext(env));
  assert.deepEqual(buttons(msg.components).map((b) => b.label || b.custom_id), ['Acheter sur BBDBuy', 'QC · 56', 'Weidian', 'pub:watch:weidian:7863670229']);
  assert.equal(cardTitle(item), 'Nike Tech Fleece Hoodie');
  assert.match(JSON.stringify(msg), /1 234 ventes/);
});

test('/menu et /aide restent dans les limites de Discord (40 composants)', async () => {
  const { homeView } = await import('../src/ui.js');
  const { guideView } = await import('../src/views.js');
  const env = { DB: memoryDb() };
  await setCoupon(env, { title: 'Promos', links: parseCouponLinks('BBDBuy | https://a.example/x\nKakobuy | https://b.example/y') });
  const home = await homeView(env, { guild_id: 'g', member: { user: { id: 'u' } } });
  assert.ok(count(home) <= 40, `menu : ${count(home)} composants`);
  assert.ok(buttons(home).some((b) => b.custom_id === 'guide:post'));
  const guide = await guideView(env);
  assert.ok(count(guide) <= 40);
  assert.deepEqual(buttons(guide).map((b) => b.url), ['https://a.example/x', 'https://b.example/y']);
});
