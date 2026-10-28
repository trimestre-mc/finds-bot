import test from 'node:test';
import assert from 'node:assert/strict';

test('MP de pub : titre, texte, bouton de lien, « Se désinscrire » activable', async () => {
  const { adMessage } = await import('../src/pub.js');
  const on = JSON.stringify(adMessage({}, { title: 'Promo', text: 'Salut', btnLabel: 'Voir', btnUrl: 'https://x.y' }));
  assert.match(on, /Promo/);
  assert.match(on, /pub:adoff/);
  assert.match(on, /https:\/\/x\.y/);
  const off = JSON.stringify(adMessage({}, { title: 'Promo', text: 'Salut', unsub: false }));
  assert.doesNotMatch(off, /pub:adoff/);
});

test('modèle Kij Find : mise en forme Discord gardée, bouton vers le serveur', async () => {
  const { adMessage, PRESETS } = await import('../src/pub.js');
  const s = JSON.stringify(adMessage({}, PRESETS.kijfind));
  assert.match(s, /kijfind\.png/); // bannière
  assert.match(s, /Kij Find/);
  assert.match(s, /✅ Débutant/); // {fb_verified} → emoji (Unicode de secours sans la liste des emojis)
  assert.match(s, /"type":14/); // séparateurs
  assert.match(s, /https:\/\/discord\.gg\/9XpCj6p6Rg/);
});

test('serveurs du bot : liste, confirmation avant de quitter, réservé au propriétaire', async () => {
  const { serversView, handleServersComponent } = await import('../src/servers.js');
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    return Response.json(String(url).includes('/users/@me/guilds?') ? [{ id: '1', name: 'Kij Find', approximate_member_count: 120 }, { id: '2', name: 'test' }] : {});
  };
  const env = { DISCORD_API: 'https://discord.test', AGENTS_OWNER_ID: '42', DB: { prepare: () => ({ first: async () => null }) } };
  const owner = { guild_id: '2', member: { user: { id: '42' } } };
  assert.match(JSON.stringify(await serversView(env, owner)), /Kij Find.*120 membres/);
  assert.match(JSON.stringify(await serversView(env, owner, null, '1')), /srv:leave:1/);
  const denied = await handleServersComponent({ guild_id: '2', member: { user: { id: '7' } } }, env, 'leave', '1', []);
  assert.match(await denied.text(), /propriétaire/);
  assert.ok(!calls.some((c) => c.startsWith('DELETE')));
});
