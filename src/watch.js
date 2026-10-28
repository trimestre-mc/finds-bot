// Surveillance des salons de conversion et de recherche par image, presque en direct.
// Le bot n'a pas de connexion permanente à Discord (Workers gratuit) : chaque minute, une exécution relit les
// salons pendant ~55 s, à un rythme réglé sur ses requêtes disponibles (pas de trou en fin de minute). Une photo
// reçoit tout de suite « Recherche en cours… » ; la recherche elle-même tourne dans une autre exécution du bot
// (env.SELF, son propre quota de requêtes) qui remplace ce message par les résultats.
// Workers gratuit : 50 requêtes externes par exécution (Discord, FinderQC et la base Turso comptent toutes).

import { COMPONENTS_V2, container, text } from './components.js';
import { discordApi } from './discord.js';
import { extractItemRefs } from './links.js';
import { messageText, collectQc } from './discover.js';
import { convertView } from './views.js';
import { postContext, logError } from './post.js';
import { smartImageSearch, imageResultsView, isImage } from './imagesearch.js';
import { popularItemStatements } from './items.js';
import { budget } from './budget.js';
import { ACCENTS } from './config.js';
import { itemsWhereIds, groupByDb, onDb, batchByDb } from './shard.js';
import { etxt } from './emojis.js';
import { aiqcMessage } from './aiqc.js';

const MAX_CALLS = 46;
// Compteur de chaque type de salon (colonne = colonne + n).
const COUNTER = { convert: 'converted = converted', image: 'searched = searched', aiqc: 'analyzed = analyzed' };
const WORK_RESERVE = 10; // requêtes gardées pour répondre (une photo : 2, un lien : ~3)
const MIN_ROUND_MS = 2000;
const DISCORD_EPOCH = 1420070400000n;

// Identifiant Discord correspondant à une date : « messages postés après l'ajout du salon ».
const snowflakeAt = (ms) => String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
const newer = (a, b) => BigInt(a) > BigInt(b);

export async function watchChannels(env, ms = 55000, exec = null, force = false) {
  // Connexion permanente à Discord active (gateway.js) : les messages arrivent déjà en direct, pas de relecture
  // (sauf rattrapage demandé, ex. un salon ajouté à l'instant).
  const alive = force ? null : await env.DB.prepare("SELECT value FROM settings WHERE key = 'gateway:alive'").first().catch(() => null);
  if (alive && Date.now() - Number(alive.value) < 75000) return 0;
  const deadline = Date.now() + ms;
  let external = 0;
  const used = () => external + (env.DB.calls || 0);
  const [conv, img, ai] = await Promise.all([
    env.DB.prepare('SELECT * FROM convert_channels ORDER BY added_at LIMIT 5').all(),
    env.DB.prepare('SELECT * FROM image_channels ORDER BY added_at LIMIT 5').all(),
    env.DB.prepare('SELECT * FROM aiqc_channels ORDER BY added_at LIMIT 5').all().catch(() => ({ results: [] })),
  ]);
  const channels = [
    ...conv.results.map((c) => ({ ...c, kind: 'convert', table: 'convert_channels' })),
    ...img.results.map((c) => ({ ...c, kind: 'image', table: 'image_channels' })),
    ...ai.results.map((c) => ({ ...c, kind: 'aiqc', table: 'aiqc_channels' })),
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
  // Rythme : les relectures disponibles réparties sur toute la minute (au moins toutes les 2 s).
  const rounds = Math.max(1, Math.floor((pollLimit - used()) / channels.length));
  const roundMs = Math.max(MIN_ROUND_MS, Math.floor(ms / rounds));
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
      // Messages auxquels le bot a déjà répondu (sa réponse est liée au message) : jamais deux fois, même si la
      // position de lecture n'a pas pu être enregistrée (base sans écriture possible).
      const answered = new Set(messages.filter((x) => x.author && x.author.bot && x.message_reference).map((x) => x.message_reference.message_id));
      for (const m of messages.sort((a, b) => (newer(a.id, b.id) ? 1 : -1))) {
        if (used() >= MAX_CALLS - 6) break; // plus de place : la suite à la prochaine exécution
        c.cursor = m.id;
        if (m.author && m.author.bot) continue;
        if (answered.has(m.id)) continue;
        if (!ctx) ctx = await postContext(env);
        try {
          if (c.kind === 'convert') external += await convertMessage(env, ctx, c, m);
          else if (c.kind === 'aiqc') external += await aiqcMessage(env, ctx, c, m);
          else external += await imageMessage(env, ctx, c, m, found, exec);
        } catch (err) {
          console.log('salon', c.channel_id, String(err).slice(0, 200));
        }
      }
    }
    if (used() >= pollLimit) break;
    const wait = roundMs - (Date.now() - round);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  // Positions de lecture et compteurs, en un seul lot.
  const stmts = channels.filter((c) => c.cursor !== c.last_message_id || c.done).map((c) => [env.DB, env.DB.prepare(
    `UPDATE ${c.table} SET last_message_id = ?, ${COUNTER[c.kind]} + ? WHERE channel_id = ?`,
  ).bind(c.cursor, c.done, c.channel_id)]);
  if (stmts.length) await batchByDb(stmts).catch((err) => console.log('salons', String(err).slice(0, 120)));
  if (found.length) await saveFound(env, found);
  return channels.reduce((n, c) => n + c.done, 0);
}

// Un message reçu en direct par la connexion permanente (gateway.js) : même traitement que la relecture, une seule
// fois par message (la position de lecture du salon sert de verrou : un message plus ancien est ignoré).
export async function handleLiveMessage(env, channelId, m) {
  for (const [table, kind] of [['convert_channels', 'convert'], ['image_channels', 'image'], ['aiqc_channels', 'aiqc']]) {
    const c = await env.DB.prepare(
      `UPDATE ${table} SET last_message_id = ? WHERE channel_id = ?
         AND (last_message_id IS NULL OR CAST(last_message_id AS INTEGER) < CAST(? AS INTEGER)) RETURNING *`,
    ).bind(m.id, channelId, m.id).first();
    // Écriture refusée (quota du jour de la base) : le verrou ne renvoie rien ; on relit le salon et on traite le
    // message s'il est plus récent que la dernière position enregistrée.
    const row = c || await env.DB.prepare(`SELECT * FROM ${table} WHERE channel_id = ?`).bind(channelId).first()
      .then((r) => (r && (!r.last_message_id || BigInt(r.last_message_id) < BigInt(m.id)) ? r : null)).catch(() => null);
    if (!row) continue;
    const ctx = await postContext(env);
    const ch = { ...row, kind, table, done: 0 };
    const found = [];
    if (kind === 'convert') await convertMessage(env, ctx, ch, m);
    else if (kind === 'aiqc') await aiqcMessage(env, ctx, ch, m);
    else await imageMessage(env, ctx, ch, m, found, null);
    if (found.length) await saveFound(env, found);
    if (ch.done) {
      await env.DB.prepare(`UPDATE ${table} SET ${COUNTER[kind]} + ? WHERE channel_id = ?`)
        .bind(ch.done, channelId).run().catch(() => {});
    }
    return ch.done;
  }
  return 0;
}

// Lien(s) d'item dans un message : réponse avec les boutons d'achat. Renvoie le nombre de requêtes faites.
async function convertMessage(env, ctx, c, m) {
  let calls = 0;
  await collectQc(env, m, c.guild_id, c.channel_id).catch(() => {});
  const refs = extractItemRefs(messageText(m)).slice(0, 3);
  if (!refs.length) return calls;
  const cards = [];
  const ids = refs.map((r) => `${r.platform}:${r.itemId}`);
  const results = await itemsWhereIds(env, ids);
  const known = new Map(results.map((i) => [i.id, i]));
  for (const ref of refs) cards.push(...await convertView(env, ref, known.get(`${ref.platform}:${ref.itemId}`) || null, ctx));
  await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, {
    flags: COMPONENTS_V2, components: cards, allowed_mentions: { parse: [] },
    message_reference: { message_id: m.id, fail_if_not_exists: false },
  });
  c.done++;
  return calls + 1;
}

// Photo(s) dans un message : « recherche en cours » tout de suite, puis la recherche dans une autre exécution du
// bot (son propre quota de requêtes ; sans env.SELF, ici même). Renvoie le nombre de requêtes faites.
async function imageMessage(env, ctx, c, m, found, exec) {
  const images = (m.attachments || []).filter(isImage).slice(0, 2);
  let calls = 0;
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  for (const a of images) {
    const pending = await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, {
      flags: COMPONENTS_V2, allowed_mentions: { parse: [] },
      components: [container([text(`### ${etxt(ctx.emojis, 'fb_loading')} Recherche en cours…\n-# Je lis ta photo et je cherche les items qui ressemblent.`)], accent)],
      message_reference: { message_id: m.id, fail_if_not_exists: false },
    });
    calls++;
    c.done++;
    const job = { channel_id: c.channel_id, pending_id: pending.id, attachment: { url: a.url, proxy_url: a.proxy_url, filename: a.filename } };
    if (env.SELF && exec) {
      // Si l'autre exécution ne répond pas, la recherche se fait ici (le membre a toujours sa réponse).
      exec.waitUntil(env.SELF.fetch('https://finds-bot/api/watch/image', {
        method: 'POST', headers: { Authorization: `Bearer ${env.INDEXER_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(job),
      }).then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
        .catch(async (err) => {
          console.log('recherche image (autre exécution)', String(err).slice(0, 120));
          await saveFound(env, await imageJob(env, job, ctx)).catch(() => {});
        }));
      calls++;
    } else {
      const items = await imageJob(env, job, ctx);
      found.push(...items);
      calls += 7;
    }
  }
  return calls;
}

// Recherche d'une photo et mise à jour du message « Recherche en cours… ». Renvoie les items proposés.
export async function imageJob(env, job, ctx = null) {
  ctx = ctx || await postContext(env);
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  let items = [];
  let components;
  try {
    const res = await smartImageSearch(env, job.attachment);
    items = res.items;
    components = imageResultsView(ctx, items, job.channel_id, res.seen);
  } catch (err) {
    console.log('image', String(err).slice(0, 200));
    components = [container([text(`### ${etxt(ctx.emojis, 'fb_warn')} Recherche impossible pour le moment\n-# La recherche par image ne répond pas. Reposte ta photo dans une minute.`)], accent)];
  }
  await discordApi(env, 'PATCH', `/channels/${job.channel_id}/messages/${job.pending_id}`, { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } });
  return items;
}

// Items proposés par une recherche d'image : enregistrés dans leur base (voir shard.js), sur le budget de cette base.
export async function saveFound(env, found) {
  const stmts = [];
  for (const [db, keys] of groupByDb(env, found.map((x) => `${x.platform}:${x.id}`))) {
    const e = onDb(env, db);
    const b = await budget(e, 'items');
    const { stmts: add, count } = popularItemStatements(e, found.filter((x) => keys.includes(`${x.platform}:${x.id}`)).slice(0, b.left), 'finderqc');
    stmts.push(...add.map((st) => [db, st]));
    if (count) await b.use(count).catch(() => {});
  }
  if (stmts.length) await batchByDb(stmts).catch((err) => console.log('items trouvés', String(err).slice(0, 120)));
}
