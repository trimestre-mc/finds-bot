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

test('onglet Secret : outils du propriétaire, refusé aux autres', async () => {
  const { secretView, handleSecretComponent } = await import('../src/secret.js');
  const env = { AGENTS_OWNER_ID: '42', INDEXER_SECRET: 's', PUBLIC_URL: 'https://bot.test', DB: { prepare: () => ({ first: async () => null }) } };
  const v = JSON.stringify(await secretView(env, { member: { user: { id: '42' } } }));
  assert.match(v, /ad:open/);
  assert.match(v, /srv:open/);
  assert.match(v, /bot\.test\/dashboard\?t=/);
  const denied = await handleSecretComponent({ member: { user: { id: '7' } } }, env);
  assert.match(await denied.text(), /propriétaire/);
});

test('approbation des serveurs : 1er passage = serveurs actuels approuvés, puis MP pour un nouveau', async () => {
  const sets = { 'guilds:ok': new Set(), 'guilds:pending': new Set() };
  const sent = [];
  let guilds = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://up.test')) {
      const cmds = JSON.parse(opts.body);
      return Response.json(cmds.map(([c, k, ...v]) => {
        if (c === 'SMEMBERS') return { result: [...sets[k]] };
        if (c === 'SADD') { v.forEach((x) => sets[k].add(x)); return { result: v.length }; }
        if (c === 'SREM') { v.forEach((x) => sets[k].delete(x)); return { result: 1 }; }
        if (c === 'SISMEMBER') return { result: sets[k].has(v[0]) ? 1 : 0 };
        if (c === 'SCARD') return { result: sets[k].size };
        return { result: null };
      }));
    }
    if (u.includes('/users/@me/guilds')) return Response.json(guilds);
    sent.push(`${opts.method} ${u}`);
    return Response.json({ id: 'dm' });
  };
  const env = { UPSTASH_URL: 'https://up.test', UPSTASH_TOKEN: 't', AGENTS_OWNER_ID: '42', DISCORD_API: 'https://discord.test', DB: { prepare: () => ({ first: async () => null }) } };
  const { checkNewGuilds, guildApproved } = await import('../src/guilds.js');
  assert.equal(await checkNewGuilds(env), 0);
  assert.deepEqual([...sets['guilds:ok']].sort(), ['1', '2']);
  guilds = [...guilds, { id: '3', name: 'Nouveau' }];
  assert.equal(await checkNewGuilds(env), 1);
  assert.ok(sent.some((s) => s.includes('/channels/dm/messages')));
  assert.equal(await guildApproved(env, '3'), false);
  assert.equal(await checkNewGuilds(env), 0); // déjà signalé : pas de 2e MP
});

test('MP de pub : mentionne le membre (en haut, ou à la place de {user})', async () => {
  const { adMessage } = await import('../src/pub.js');
  assert.match(JSON.stringify(adMessage({}, { text: 'Promo' }, '123')), /Salut <@123>/);
  const placed = JSON.stringify(adMessage({}, { text: 'Hey {user}, regarde ça' }, '123'));
  assert.match(placed, /Hey <@123>, regarde ça/);
  assert.doesNotMatch(placed, /Salut <@123>/);
});

test('envoi de pub : journal par destinataire, compteurs, envoi terminé quand la file est vide', async () => {
  const kv = { 'ad:job': JSON.stringify({ state: 'running', total: 2, draft: { text: 'Promo' } }), 'ad:queue': ['1', '2'], 'ad:log': [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://up.test')) {
      return Response.json(JSON.parse(opts.body).map(([c, k, ...v]) => {
        if (c === 'GET') return { result: Array.isArray(kv[k]) ? null : (kv[k] ?? null) };
        if (c === 'SET') { kv[k] = v[0]; return { result: 'OK' }; }
        if (c === 'DEL') { delete kv[k]; return { result: 1 }; }
        if (c === 'LPOP') { const n = Number(v[0]) || 1; const out = (kv[k] || []).splice(0, n); return { result: out }; }
        if (c === 'LPUSH') { kv[k] = [...v.reverse(), ...(kv[k] || [])]; return { result: kv[k].length }; }
        if (c === 'LTRIM' || c === 'EXPIRE') return { result: 'OK' };
        if (c === 'LLEN') return { result: (kv[k] || []).length };
        if (c === 'INCRBY' || c === 'INCR') { kv[k] = String((Number(kv[k]) || 0) + Number(v[0] || 1)); return { result: Number(kv[k]) }; }
        if (c === 'LRANGE') return { result: kv[k] || [] };
        return { result: null };
      }));
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm${body.recipient_id}` });
    if (u.includes('/channels/dm2/messages')) return new Response('{"message":"Cannot send messages to this user","code":50007}', { status: 403 });
    return Response.json({ id: 'm' });
  };
  const env = { UPSTASH_URL: 'https://up.test', UPSTASH_TOKEN: 't', DISCORD_API: 'https://discord.test', DB: { prepare: () => ({ first: async () => null }) } };
  const { runPubQueue } = await import('../src/pub.js');
  assert.equal(await runPubQueue(env), 1);
  const log = kv['ad:log'].map((x) => JSON.parse(x));
  assert.ok(log.some((l) => l.id === '1' && l.ok));
  assert.ok(log.some((l) => l.id === '2' && !l.ok && l.why === 'MP fermés'));
  assert.equal(kv['ad:sent'], '1');
  assert.equal(kv['ad:failed'], '1');
  assert.equal(JSON.parse(kv['ad:job']).state, 'done');
});

test('chien de garde : un MP par problème, pas de rappel avant 6 h', async () => {
  const sets = new Set();
  const dms = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://up.test')) {
      return Response.json(JSON.parse(opts.body).map(([c, k]) => (c === 'SET' ? { result: sets.has(k) ? null : (sets.add(k), 'OK') } : { result: null })));
    }
    if (u.endsWith('/users/@me/channels')) return Response.json({ id: 'dm' });
    dms.push(u);
    return Response.json({ id: 'm' });
  };
  const env = { UPSTASH_URL: 'https://up.test', UPSTASH_TOKEN: 't', AGENTS_OWNER_ID: '42', DISCORD_API: 'https://discord.test' };
  const { alertOwner } = await import('../src/watchdog.js');
  assert.equal(await alertOwner(env, 'neon', 'Neon presque plein', 'x'), true);
  assert.equal(await alertOwner(env, 'neon', 'Neon presque plein', 'x'), false);
  assert.equal(await alertOwner(env, 'd1', 'Base D1 illisible', 'y'), true);
  assert.equal(dms.length, 2);
});
