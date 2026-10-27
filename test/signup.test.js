import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { postContext, buildItemMessage } from '../src/post.js';
import { setSignup } from '../src/config.js';
import { handlePublicComponent, handleGo } from '../src/features.js';

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

const buttons = (msg) => {
  const out = [];
  const walk = (c) => { if (c.type === 2) out.push(c); (c.components || []).forEach(walk); };
  msg.components.forEach(walk);
  return out;
};

const item = { id: 'weidian:7863670229', platform: 'weidian', item_id: '7863670229', url: 'https://weidian.com/item.html?itemID=7863670229', title_en: 'Tee', price_cny: 99 };

test('bouton d\'inscription : gris = lien suivi, couleur = fenêtre avec le lien', async () => {
  const env = { DB: memoryDb(), PUBLIC_URL: 'https://bot.example' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };

  let msg = buildItemMessage(item, await postContext(env));
  assert.ok(!buttons(msg).some((b) => /inscri/i.test(b.label || '')), 'rien tant que ce n\'est pas configuré');

  await setSignup(env, { url: 'https://agent.example/register?code=ABC', label: 'S\'inscrire 🎁', emoji: '✍️', color: 'gris' });
  msg = buildItemMessage(item, await postContext(env), [], '123');
  const grey = buttons(msg).find((b) => b.label === 'S\'inscrire 🎁');
  assert.equal(grey.style, 5);
  assert.equal(grey.url, 'https://bot.example/go/weidian%3A7863670229/signup?c=123');
  const go = await handleGo(new URL(grey.url), env, ctx);
  assert.equal(go.headers.get('Location'), 'https://agent.example/register?code=ABC');

  await setSignup(env, { url: 'https://agent.example/register?code=ABC', label: 'Inscription', color: 'rouge', message: 'Coupons offerts' });
  msg = buildItemMessage(item, await postContext(env));
  const red = buttons(msg).find((b) => b.label === 'Inscription');
  assert.equal(red.style, 4);
  const res = await handlePublicComponent({ channel_id: '1', data: { custom_id: red.custom_id } }, env, ctx);
  const body = JSON.stringify(await res.json());
  assert.match(body, /agent\.example\/register/);
  assert.match(body, /Coupons offerts/);
  await Promise.all(waits);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM clicks WHERE agent = 'signup'").get().n, 2);
});
