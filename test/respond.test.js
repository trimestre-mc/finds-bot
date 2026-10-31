import test from 'node:test';
import assert from 'node:assert/strict';
import { inTime, update } from '../src/respond.js';
import { itemById } from '../src/shard.js';

function fakeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
}

test('inTime : réponse rapide renvoyée telle quelle', async () => {
  const res = await inTime({ token: 't' }, {}, fakeCtx(), async () => update([]));
  assert.equal((await res.json()).type, 7);
});

test('inTime : réponse lente → accusé de réception, puis le panneau est édité', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([url, init.method]); return new Response('{}', { status: 200 }); };
  try {
    const ctx = fakeCtx();
    const env = { DISCORD_APP_ID: 'app', DISCORD_API: 'https://d' };
    const res = await inTime({ token: 'tok' }, env, ctx, () => new Promise((r) => setTimeout(() => r(update([])), 2700)));
    assert.equal((await res.json()).type, 6);
    await Promise.all(ctx.pending);
    assert.deepEqual(calls, [['https://d/webhooks/app/tok/messages/@original', 'PATCH']]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('itemById : base aux lectures bloquées → pas d\'erreur (fiche Neon ou null)', async () => {
  const blocked = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('Turso : SQL read operations are forbidden (reads are blocked)'); } }) }) };
  assert.equal(await itemById({ DB: blocked, DB2: blocked }, 'taobao:712345678901'), null);
});

test('itemById : autre erreur toujours remontée', async () => {
  const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('réseau'); } }) }) };
  await assert.rejects(itemById({ DB: broken }, 'weidian:7234567890'), /réseau/);
});
