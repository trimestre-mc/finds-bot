// Surveillance des salons de conversion et de recherche par image, presque en direct.
// Le bot n'a pas de connexion permanente à Discord (Workers gratuit) : chaque minute, une exécution relit les
// salons toutes les quelques secondes pendant ~55 s. Une photo ou un lien posté reçoit une réponse en quelques
// secondes : « 🔎 Recherche en cours… » tout de suite, puis les résultats à la place.
// Workers gratuit : 50 requêtes externes par exécution (Discord, FinderQC et la base Turso comptent toutes).

import { COMPONENTS_V2, container, text } from './components.js';
import { discordApi } from './discord.js';
import { extractItemRefs } from './links.js';
import { messageText, collectQc } from './discover.js';
import { convertView } from './views.js';
import { postContext, logError } from './post.js';
import { searchByImage, imageResultsView, isImage } from './imagesearch.js';
import { popularItemStatements } from './items.js';
import { budget } from './budget.js';
import { ACCENTS } from './config.js';

const MAX_CALLS = 46;
const WORK_RESERVE = 14; // requêtes gardées pour répondre (une recherche d'image en coûte ~5)
const ROUND_MS = 3000;
const DISCORD_EPOCH = 1420070400000n;

// Identifiant Discord correspondant à une date : « messages postés après l'ajout du salon ».
const snowflakeAt = (ms) => String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
const newer = (a, b) => BigInt(a) > BigInt(b);

export async function watchChannels(env, ms = 55000) {
  const deadline = Date.now() + ms;
  let external = 0;
  const used = () => external + (env.DB.calls || 0);
  const [conv, img] = await Promise.all([
    env.DB.prepare('SELECT * FROM convert_channels ORDER BY added_at LIMIT 5').all(),
    env.DB.prepare('SELECT * FROM image_channels ORDER BY added_at LIMIT 5').all(),
  ]);
  const channels = [
    ...conv.results.map((c) => ({ ...c, kind: 'convert', table: 'convert_channels' })),
    ...img.results.map((c) => ({ ...c, kind: 'image', table: 'image_channels' })),
  ];
  if (!channels.length) return 0;
  // Premier passage : on répond aux messages postés depuis l'ajout du salon (pas à tout l'historique).
  for (const c of channels) {
    c.cursor = c.last_message_id || snowflakeAt(c.added_at || Date.now());
    c.done = 0;
    c.dead = false;
  }

  let ctx = null;
  const found = [];
  const pollLimit = MAX_CALLS - WORK_RESERVE;
  while (Date.now() < deadline) {
    const round = Date.now();
    for (const c of channels) {
      if (c.dead || used() >= pollLimit || Date.now() >= deadline) continue;
      let messages;
      try {
        messages = await discordApi(env, 'GET', `/channels/${c.channel_id}/messages?limit=20&after=${c.cursor}`);
        external++;
      } catch (err) {
        external++;
        c.dead = true; // pas d'accès au salon : on le signale une fois et on n'insiste pas
        await logError(env, c.kind === 'image' ? 'recherche image' : 'conversion', `<#${c.channel_id}> : ${String(err.message || err).slice(0, 200)}`);
        continue;
      }
      for (const m of messages.sort((a, b) => (newer(a.id, b.id) ? 1 : -1))) {
        if (used() >= MAX_CALLS - 6) break; // plus de place : la suite à la prochaine exécution
        c.cursor = m.id;
        if (m.author && m.author.bot) continue;
        if (!ctx) ctx = await postContext(env);
        try {
          if (c.kind === 'convert') external += await convertMessage(env, ctx, c, m);
          else external += await imageMessage(env, ctx, c, m, found);
        } catch (err) {
          console.log('salon', c.channel_id, String(err).slice(0, 200));
        }
      }
    }
    if (used() >= pollLimit) break;
    const wait = ROUND_MS - (Date.now() - round);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  // Positions de lecture et compteurs, en un seul lot.
  const stmts = channels.filter((c) => c.cursor !== c.last_message_id || c.done).map((c) => env.DB.prepare(
    `UPDATE ${c.table} SET last_message_id = ?, ${c.kind === 'image' ? 'searched = searched' : 'converted = converted'} + ? WHERE channel_id = ?`,
  ).bind(c.cursor, c.done, c.channel_id));
  if (found.length) {
    const b = await budget(env, 'items');
    const { stmts: add, count } = popularItemStatements(env, found.slice(0, b.left), 'finderqc');
    stmts.push(...add);
    if (count) await b.use(count).catch(() => {});
  }
  if (stmts.length) await env.DB.batch(stmts).catch((err) => console.log('salons', String(err).slice(0, 120)));
  return channels.reduce((n, c) => n + c.done, 0);
}

// Lien(s) d'item dans un message : réponse avec les boutons d'achat. Renvoie le nombre de requêtes faites.
async function convertMessage(env, ctx, c, m) {
  let calls = 0;
  await collectQc(env, m, c.guild_id, c.channel_id).catch(() => {});
  const refs = extractItemRefs(messageText(m)).slice(0, 3);
  if (!refs.length) return calls;
  const cards = [];
  const ids = refs.map((r) => `${r.platform}:${r.itemId}`);
  const { results } = await env.DB.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const known = new Map(results.map((i) => [i.id, i]));
  for (const ref of refs) cards.push(...await convertView(env, ref, known.get(`${ref.platform}:${ref.itemId}`) || null, ctx));
  await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, {
    flags: COMPONENTS_V2, components: cards, allowed_mentions: { parse: [] },
    message_reference: { message_id: m.id, fail_if_not_exists: false },
  });
  c.done++;
  return calls + 1;
}

// Photo(s) dans un message : « recherche en cours » tout de suite, puis les items qui ressemblent.
async function imageMessage(env, ctx, c, m, found) {
  const images = (m.attachments || []).filter(isImage).slice(0, 2);
  let calls = 0;
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  for (const a of images) {
    const pending = await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, {
      flags: COMPONENTS_V2, allowed_mentions: { parse: [] },
      components: [container([text('### 🔎 Recherche en cours…\n-# Je cherche les items qui ressemblent à ta photo.')], accent)],
      message_reference: { message_id: m.id, fail_if_not_exists: false },
    });
    calls++;
    let components;
    try {
      const items = await searchByImage(a.url, a.filename);
      found.push(...items);
      components = imageResultsView(ctx, items, c.channel_id);
    } catch (err) {
      console.log('image', String(err).slice(0, 120));
      components = [container([text('### 🔎 Recherche impossible pour le moment\n-# La recherche par image est surchargée. Reposte ta photo dans une minute.')], accent)];
    }
    calls += 3;
    await discordApi(env, 'PATCH', `/channels/${c.channel_id}/messages/${pending.id}`, { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } });
    calls++;
    c.done++;
  }
  return calls;
}
