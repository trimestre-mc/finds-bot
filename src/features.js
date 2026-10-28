// Fonctions ajoutées au panneau et au bot : suivi des clics, /find et /convert publics, drops automatiques,
// conversion automatique des liens, filtres, liste noire, historique, réglages, santé.

import { discordApi, followup, editOriginal } from './discord.js';
import { COMPONENTS_V2, container, text, escape, section, thumb, row } from './components.js';
import { panel, update, openModal, later, userId } from './respond.js';
import { buildAgentLink, canonicalUrl, extractItemRefs } from './links.js';
import { communityQc, refreshQc, communityPhotos, qcWindow, qcShareMessage, qcPagePhotos, goldPhoto } from './qc.js';
import { qcAnalysis, analysisView, tracker } from './aiqc.js';
import { cachedIds, withoutCache } from './search.js';
import { postContext, processQueue, logError, FORUM } from './post.js';
import { getConfig, setConfig, getSignup, CURRENCIES, LANGS, ACCENTS } from './config.js';
import { messageText, collectQc } from './discover.js';
import { CATEGORY_BY_KEY } from './categories.js';
import { expandQuery } from './synonyms.js';
import { homeView, loadSearch, createSearch, resultsView, filtersView, catalogsView } from './ui.js';
import {
  schedulesView, scheduleView, scheduleModal, statsView, historyView, settingsView, healthView, findView, convertView, couponView, guideView,
  categoryChannelsView, categoryChannels, categoryRhythm, CATEGORY_RHYTHMS, categoryRhythmModal, rhythmOf,
} from './views.js';
import { itemDb, itemById, batchByDb, deleteShopItems } from './shard.js';
import { compareView } from './compare.js';
import { loadEmojis, emo, etxt } from './emojis.js';
import { toggleWatch, watchesView, toggleSearchAlert, deleteSearchAlert } from './alerts.js';
import { cacheGet, cacheSet, cacheClear, rateLimit, LIMITS, limitText } from './kvstore.js';

// ---------------------------------------------------------------- Indexeur GitHub

// Lance l'indexeur tout de suite si un token GitHub est configuré.
export async function triggerIndexer(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  // Heure du lancement dans Upstash (la base peut refuser les écritures : sans elle, l'indexeur était relancé chaque
  // minute et chaque lancement annulait le précédent, 59 sur 60 le 28/10).
  const { kvSet } = await import('./kvstore.js');
  if (!(await kvSet(env, 'last_dispatch', Date.now(), 86400))) {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_dispatch', ?)").bind(String(Date.now())).run().catch(() => {});
  }
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/indexer.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'finds-bot' },
    body: JSON.stringify({ ref: 'main' }),
  }).catch((e) => ({ ok: false, status: String(e) }));
  if (!res.ok) await logError(env, 'indexeur', `lancement GitHub refusé (${res.status})`);
}

// Liste des salons surveillés modifiée : la connexion permanente à Discord la relit tout de suite (gateway.js).
async function refreshGateway(env) {
  if (!env.GATEWAY || env.GATEWAY_OFF === '1') return;
  await env.GATEWAY.get(env.GATEWAY.idFromName('main')).fetch('https://gateway/refresh').catch((err) => console.log('gateway', String(err).slice(0, 100)));
}

// ---------------------------------------------------------------- Suivi des clics (/go)

// GET /go/<item>/<agent>?c=<salon> : compte le clic puis redirige vers l'agent (ou l'annonce d'origine).
export async function handleGo(url, env, ctx) {
  const [, , rawItem, rawAgent] = url.pathname.split('/');
  const itemKey = decodeURIComponent(rawItem || '');
  const agentName = decodeURIComponent(rawAgent || 'source');
  const channel = /^\d{1,25}$/.test(url.searchParams.get('c') || '') ? url.searchParams.get('c') : null;
  if (agentName === 'signup') {
    // Bouton « S'inscrire » (gris) : lien d'inscription du propriétaire.
    const s = await getSignup(env);
    if (!s) return new Response('Lien inconnu', { status: 404 });
    ctx.waitUntil(env.DB.prepare('INSERT INTO clicks (item_id, agent, channel_id, at) VALUES (?, ?, ?, ?)')
      .bind(itemKey.slice(0, 40), 'signup', channel, Date.now()).run().catch(() => {}));
    return new Response(null, { status: 302, headers: { Location: s.url, 'Cache-Control': 'no-store' } });
  }
  const [platform, itemId] = itemKey.split(':');
  const known = await itemById(env, itemKey);
  const item = known || { id: itemKey, platform, item_id: itemId, url: canonicalUrl(platform, itemId) };
  if (!item.url || !/^\d{6,14}$/.test(String(item.item_id))) return new Response('Lien inconnu', { status: 404 });
  let target = item.url;
  if (agentName === 'qcc') {
    // QC de la communauté : le message Discord d'origine.
    const c = await communityQc(env, itemKey);
    if (c) target = c.jump;
  } else if (agentName !== 'source') {
    const agent = await env.DB.prepare('SELECT template FROM agents WHERE name = ?').bind(agentName).first();
    if (agent) target = buildAgentLink(agent.template, item);
  }
  ctx.waitUntil(env.DB.prepare('INSERT INTO clicks (item_id, agent, channel_id, at) VALUES (?, ?, ?, ?)')
    .bind(itemKey, agentName.slice(0, 40), channel, Date.now()).run().catch(() => {}));
  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------- Commandes publiques

export async function handlePublicCommand(it, env, ctx) {
  const opts = Object.fromEntries((it.data.options || []).map((o) => [o.name, o.value]));
  if (it.data.name === 'coupon') return panel(await couponView(env), false);
  if (it.data.name === 'dashboard') {
    // Lien privé (signé, 7 jours) vers le dashboard : seulement pour le propriétaire du bot.
    if (!env.AGENTS_OWNER_ID || userId(it) !== env.AGENTS_OWNER_ID) return panel([container([text('Commande réservée au propriétaire du bot.')])]);
    const { dashboardToken } = await import('./dashboard.js');
    const url = `${(env.PUBLIC_URL || '').replace(/\/$/, '')}/dashboard?t=${await dashboardToken(env)}`;
    const emojis = await loadEmojis(env);
    return panel([container([
      text(`## ${etxt(emojis, 'fb_stats')} Dashboard\nÉtat des services, catalogue, quotas et activité en direct.\n-# Lien personnel valable 7 jours : ne le partage pas.`),
      row({ type: 2, style: 5, label: 'Ouvrir le dashboard', url, emoji: emo(emojis, 'fb_stats') }),
    ])]);
  }
  if (it.data.name === 'aide') return panel(await guideView(env), true);
  if (it.data.name === 'suivis') return panel(await watchesView(env, userId(it)), true);
  if (it.data.name === 'find') {
    return later(it, env, ctx, async () => {
      const q = String(opts.recherche || '').slice(0, 100);
      const sid = await createSearch(env, it, {
        q, groups: expandQuery(q), variants: [], category: opts.categorie || null, autoCategory: null,
        max: opts.prix_max != null ? opts.prix_max : null, includePosted: true, sort: 'popular', public: true,
      });
      return findView(env, sid, 0);
    }, true);
  }
  if (it.data.name === 'qc') {
    const refs = extractItemRefs(String(opts.lien || ''));
    if (!refs.length) {
      return panel([container([text('❌ Je n\'ai trouvé aucun lien Weidian, Taobao ou 1688 (ni de lien d\'agent).')])]);
    }
    const ref = refs[0];
    return later(it, env, ctx, () => openQc(env, `${ref.platform}:${ref.itemId}`, ref.platform, ref.itemId), true);
  }
  if (it.data.name === 'convert') {
    const refs = extractItemRefs(String(opts.lien || ''));
    if (!refs.length) {
      return panel([container([text('❌ Je n\'ai trouvé aucun lien Weidian, Taobao ou 1688 (ni de lien d\'agent) à convertir.')])]);
    }
    const ref = refs[0];
    const known = await itemById(env, `${ref.platform}:${ref.itemId}`);
    // Réponse visible par tout le salon (les erreurs restent privées).
    return panel(await convertView(env, ref, known), false);
  }
  return null;
}

export async function handlePublicComponent(it, env, ctx) {
  const parts = it.data.custom_id.split(':');
  const [, kind, sid, page] = parts;
  if (kind === 'adoff') {
    // « Se désinscrire » sous un MP de pub (pub.js).
    const { pubUnsubscribe } = await import('./pub.js');
    return pubUnsubscribe(it, env);
  }
  if (kind === 'pg') return update(await findView(env, sid, Number(page) || 0));
  if (kind === 'su') {
    // Bouton « S'inscrire » coloré : petite fenêtre privée avec le vrai lien.
    const s = await getSignup(env);
    if (!s) return panel([container([text('Le lien d\'inscription n\'est plus disponible.')])]);
    ctx.waitUntil(env.DB.prepare('INSERT INTO clicks (item_id, agent, channel_id, at) VALUES (?, ?, ?, ?)')
      .bind(parts.slice(2).join(':').slice(0, 40), 'signup', it.channel_id || null, Date.now()).run().catch(() => {}));
    const b = { type: 2, style: 5, label: (s.label || 'S\'inscrire').slice(0, 80), url: s.url };
    if (s.emoji) b.emoji = { name: s.emoji };
    return panel([container([
      text(s.message ? escape(s.message).slice(0, 1500) : `### ${escape(s.label || 'S\'inscrire')}\nClique ci-dessous pour créer ton compte.`),
      { type: 1, components: [b] },
    ])]);
  }
  if (kind === 'qc') {
    // Bouton « 📸 Voir les QC » d'une carte : fenêtre privée avec les QC de l'item.
    const key = parts.slice(2).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    ctx.waitUntil(env.DB.prepare('INSERT INTO clicks (item_id, agent, channel_id, at) VALUES (?, ?, ?, ?)')
      .bind(key, 'qc_view', it.channel_id || null, Date.now()).run().catch(() => {}));
    return later(it, env, ctx, () => openQc(env, key, platform, itemId, 0), true);
  }
  if (kind === 'salert') {
    // « M'alerter des nouveautés » sous /find : crée (ou supprime) l'alerte de cette recherche, réponse privée.
    const s = await loadSearch(env, sid);
    if (!s) return panel([container([text('⌛ Recherche expirée, relance `/find`.')])]);
    return panel([container([text(await toggleSearchAlert(env, userId(it), it.guild_id, s.params))])]);
  }
  if (kind === 'salertdel') {
    await deleteSearchAlert(env, userId(it), sid);
    return update(await watchesView(env, userId(it)));
  }
  if (kind === 'watch') {
    // « 🔔 » d'une carte : suivre le prix de l'item (ou arrêter), réponse privée.
    const key = parts.slice(2).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    return panel([container([text(await toggleWatch(env, userId(it), it.guild_id, key))])]);
  }
  if (kind === 'cmp') {
    // « Comparer » d'une carte : le même article chez d'autres vendeurs (fenêtre privée).
    const key = parts.slice(2).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    ctx.waitUntil(env.DB.prepare('INSERT INTO clicks (item_id, agent, channel_id, at) VALUES (?, ?, ?, ?)')
      .bind(key, 'compare', it.channel_id || null, Date.now()).run().catch(() => {}));
    return later(it, env, ctx, () => compareView(env, key), true);
  }
  if (kind === 'vote') {
    // Vote GL/RL sur les QC : un vote par membre (modifiable), chiffres mis à jour dans la fenêtre.
    const vote = parts[parts.length - 1] === 'gl' ? 1 : -1;
    const key = parts.slice(2, -1).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    await env.DB.prepare(
      `INSERT INTO qc_votes (item_id, user_id, vote, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id, user_id) DO UPDATE SET vote = excluded.vote, at = excluded.at`,
    ).bind(key, userId(it), vote, Date.now()).run();
    const c = await env.DB.prepare('SELECT COALESCE(SUM(vote = 1), 0) AS gl, COALESCE(SUM(vote = -1), 0) AS rl FROM qc_votes WHERE item_id = ?').bind(key).first();
    ctx.waitUntil(itemDb(env, key).prepare('UPDATE items SET gl_votes = ?, rl_votes = ? WHERE id = ?').bind(c.gl, c.rl, key).run().catch(() => {}));
    const components = JSON.parse(JSON.stringify((it.message && it.message.components) || []));
    const walk = (list) => (list || []).forEach((x) => {
      if (x.custom_id === `pub:vote:${key}:gl`.slice(0, 100)) x.label = `GL · ${c.gl}`;
      if (x.custom_id === `pub:vote:${key}:rl`.slice(0, 100)) x.label = `RL · ${c.rl}`;
      walk(x.components);
      if (x.accessory) walk([x.accessory]);
    });
    walk(components);
    return update(components);
  }
  if (kind === 'aiqc' || kind === 'aiqcshare') {
    // « 🤖 Analyse IA » sous les photos QC : analyse des photos de la page (fenêtre privée) ; « Partager » la poste.
    const view = Math.max(0, Number(parts[parts.length - 1]) || 0);
    const key = parts.slice(2, -1).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    // Limite par membre (le partage d'une analyse déjà faite ne compte pas).
    if (kind === 'aiqc') {
      const lim = await rateLimit(env, 'aiqc', userId(it), LIMITS.aiqc);
      if (!lim.ok) return panel([container([text(limitText(lim, 'analyses IA', etxt(await loadEmojis(env), 'fb_clock')))])]);
    }
    return later(it, env, ctx, async () => {
      const item = (await itemById(env, key)) || { id: key, item_id: itemId, platform, url: canonicalUrl(platform, itemId) };
      const { photos, qc, batches } = await qcPagePhotos(env, item, view);
      const shots = photos.slice(0, 3);
      // Référence : un autre batch du même article (déjà téléchargé avec la page, aucune requête de plus).
      const gold = goldPhoto(qc, [...shots, ...batches.flatMap((b) => b.photos)], item);
      const emojis = await loadEmojis(env);
      // Progression dans la réponse (en attente) : étapes, barre, temps restant.
      const step = await tracker(env, emojis, {
        keys: ['photos', 'zoom', 'compare', 'merge', 'verify'], count: shots.length, accent: 0x8b5cf6,
        send: (components) => editOriginal(env, it.token, { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } }),
      });
      await step.first();
      const res = await qcAnalysis(env, shots, { ref: /^https:\/\//.test(item.image || '') ? item.image : null, what: item.title_en || item.title_zh || null, gold, progress: step });
      await step.finish(res.result && !res.cached);
      const title = item.title_en || item.title_zh || null;
      if (kind === 'aiqcshare') {
        await followup(env, it.token, { flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components: analysisView(emojis, res, { title, photos: shots, who: userId(it) }) });
        return [container([text('-# ✅ Analyse partagée dans le salon.')])];
      }
      const view0 = analysisView(emojis, res, { title, photos: shots });
      if (res.result) view0[0].components.push({ type: 1, components: [{ type: 2, style: 1, label: 'Partager l\'analyse dans le salon', emoji: emo(emojis, 'fb_photos'), custom_id: `pub:aiqcshare:${key}:${view}`.slice(0, 100) }] });
      return view0;
    }, true);
  }
  if (kind === 'qcshare') {
    // « Partager dans le salon » d'une fenêtre QC : message public (suivi de l'interaction, aucune permission de
    // salon nécessaire) ; la fenêtre privée reste, avec une ligne de confirmation en haut.
    const view = Math.max(0, Number(parts[parts.length - 1]) || 0);
    const key = parts.slice(2, -1).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    return later(it, env, ctx, async () => {
      const components = JSON.parse(JSON.stringify((it.message && it.message.components) || []));
      const notice = (msg) => {
        const box = components.find((c) => c.type === 17);
        if (box) {
          if (box.components[0] && box.components[0].type === 10 && /^-# (✅|ℹ️)/.test(box.components[0].content)) box.components.shift();
          box.components.unshift(text(`-# ${msg}`));
        }
        return components;
      };
      // Pas deux fois le même partage dans le même salon en 10 minutes.
      const recentKey = `share:${it.channel_id}:${key}:${view}`;
      const recent = await cacheGet(env, recentKey);
      if (recent && Date.now() - recent.at < 10 * 60000) return notice('ℹ️ Ces QC viennent déjà d\'être partagées dans ce salon.');
      const item = (await itemById(env, key)) || { id: key, item_id: itemId, platform, url: canonicalUrl(platform, itemId) };
      const message = await qcShareMessage(env, item, view, userId(it), await postContext(env), it.channel_id);
      if (!message) return notice('ℹ️ Pas de photos QC à partager sur cette page.');
      await followup(env, it.token, message);
      await cacheSet(env, recentKey, '[]');
      ctx.waitUntil(env.DB.prepare('INSERT INTO clicks (item_id, agent, channel_id, at) VALUES (?, ?, ?, ?)')
        .bind(key, 'qc_share', it.channel_id || null, Date.now()).run().catch(() => {}));
      return notice('✅ Partagé dans le salon : tout le monde peut voir ces QC.');
    });
  }
  if (kind === 'qcreq') {
    // « Demander un QC » : message dans le salon QC (une demande par item et par 24 h).
    const key = parts.slice(2).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    return later(it, env, ctx, () => requestQc(env, it, key, platform, itemId), true);
  }
  if (kind === 'qcp') {
    // ◀ ▶ dans la fenêtre QC (mise à jour), ou « Plus de QC » sous un post de forum (nouvelle fenêtre privée).
    const view = Math.max(0, Number(parts[parts.length - 1]) || 0);
    const key = parts.slice(2, -1).join(':');
    const [platform, itemId] = key.split(':');
    if (!canonicalUrl(platform, itemId)) return null;
    const inWindow = it.message && (it.message.flags & 64) === 64;
    return later(it, env, ctx, () => openQc(env, key, platform, itemId, view), !inWindow);
  }
  return null;
}

// Fenêtre QC d'un item, entièrement dans Discord.
async function openQc(env, key, platform, itemId, view = 0) {
  // Chaque lecture de la base tolère une base illisible (quota du jour) : les QC viennent de FinderQC de toute façon.
  let item = await itemById(env, key).catch(() => null);
  const stub = { id: key, item_id: itemId, platform, url: canonicalUrl(platform, itemId), popularity: 0 };
  item = await refreshQc(env, item || stub).catch(() => item || stub);
  const community = view === 0 ? ((await communityPhotos(env, key, 10).catch(() => null)) || { photos: [] }).photos : [];
  const { results: qcCh } = await env.DB.prepare('SELECT channel_id FROM qc_channels LIMIT 1').all().catch(() => ({ results: [] }));
  const cfg = await getConfig(env).catch(() => ({ lang: 'fr', accent: 'orange' }));
  return qcWindow(env, item, view, {
    community, qcChannel: qcCh[0] && qcCh[0].channel_id, lang: cfg.lang, accent: (ACCENTS[cfg.accent] || ACCENTS.orange).color,
    emojis: await loadEmojis(env),
  });
}

// ---------------------------------------------------------------- Actions du panneau

async function saveParams(env, sid, change) {
  const s = await loadSearch(env, sid);
  if (!s) return false;
  await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(withoutCache({ ...s.params, ...change })), sid).run();
  return true;
}

const PRESETS = {
  trending: { name: '🔥 Top tendances', params: { trending: true, sort: 'popular' }, per_run: 5, every: 1440 },
  latest: { name: '✨ Nouveautés', params: { latest: true, sort: 'recent' }, per_run: 3, every: 120 },
  drops: { name: '📉 Baisses de prix', params: { drops: true, sort: 'popular' }, per_run: 3, every: 360 },
};

async function createSchedule(env, it, name, params, perRun, everyMinutes) {
  const cfg = await getConfig(env);
  const channel = cfg.defaultChannel || it.channel_id;
  const type = cfg.defaultChannel ? cfg.defaultChannelType : (it.channel && it.channel.type === FORUM ? FORUM : 0);
  const r = await env.DB.prepare(
    `INSERT INTO schedules (guild_id, name, params, channel_id, channel_type, per_run, every_minutes, next_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(it.guild_id, name, JSON.stringify({ ...params, includePosted: true }), channel, type, perRun, everyMinutes,
    Date.now() + 60000, userId(it), Date.now()).first();
  return r.id;
}

function resolvedType(it, channelId) {
  const r = it.data.resolved && it.data.resolved.channels && it.data.resolved.channels[channelId];
  return r && r.type === FORUM ? FORUM : 0;
}

// Renvoie une réponse si l'action est gérée ici, sinon null (l'appelant gère les actions historiques).
export async function handleFeatureComponent(it, env, ctx, a, b, c, d, values) {
  if (a === 'hist' && b !== 'del') return update(await historyView(env, it, Number(b) || 0));
  switch (`${a}:${b || ''}`) {
    // --- Recherche : vues rapides, filtres, masquer, programmer
    case 'search:drops': {
      // Une baisse de prix est justement une bonne raison de reposter : on inclut les items déjà postés.
      const sid = await createSearch(env, it, { q: '', variants: [], drops: true, includePosted: true });
      return update(await resultsView(env, sid, 0));
    }
    case 's:filt': return update(await filtersView(env, c));
    case 's:cat':
      await saveParams(env, c, { category: values[0] === 'all' ? null : values[0], autoCategory: null });
      return update(await resultsView(env, c, 0));
    case 's:sort':
      await saveParams(env, c, { sort: values[0] });
      return update(await resultsView(env, c, 0));
    case 's:hide': {
      if (values.length) {
        await batchByDb(values.map((id) => [itemDb(env, id), itemDb(env, id).prepare('UPDATE items SET hidden = 1 WHERE id = ?').bind(id)]));
        await cacheClear(env); // les recherches en cache contenaient ces items
        await saveParams(env, c, {});
      }
      return update(await resultsView(env, c, Number(d) || 0, `🚫 ${values.length} item${values.length > 1 ? 's' : ''} masqué${values.length > 1 ? 's' : ''} : ils n'apparaîtront plus.`));
    }
    case 's:sched': {
      const s = await loadSearch(env, c);
      if (!s) return update(await homeView(env, it));
      return openModal(scheduleModal(`m:sch:new:${c}`));
    }

    // --- Drops automatiques
    case 'sch:list': return update(await schedulesView(env, it));
    case 'sch:view': return update(await scheduleView(env, c));
    // --- Salons par catégorie (un drop automatique par catégorie)
    case 'cch:open': return update(await categoryChannelsView(env, it, null));
    case 'cch:pick': return update(await categoryChannelsView(env, it, values[0]));
    case 'cch:set': {
      const cat = CATEGORY_BY_KEY[c];
      if (!cat) return update(await categoryChannelsView(env, it, null));
      const existing = (await categoryChannels(env, it.guild_id)).get(c);
      if (!values[0]) {
        if (existing) await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(existing.id).run();
        return update(await categoryChannelsView(env, it, c, `${cat.emoji} ${cat.label} : plus de salon.`));
      }
      const type = resolvedType(it, values[0]);
      if (existing) {
        await env.DB.prepare('UPDATE schedules SET channel_id = ?, channel_type = ?, enabled = 1, next_at = ? WHERE id = ?')
          .bind(values[0], type, Date.now() + 60000, existing.id).run();
      } else {
        const r = await categoryRhythm(env);
        await env.DB.prepare(
          `INSERT INTO schedules (guild_id, name, params, channel_id, channel_type, per_run, every_minutes, next_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(it.guild_id, `🗂️ ${cat.label}`, JSON.stringify({ category: c, sort: 'popular', includePosted: true, catChannel: c }),
          values[0], type, r.per, r.every, Date.now() + 60000, userId(it), Date.now()).run();
      }
      return update(await categoryChannelsView(env, it, c, `✅ ${cat.emoji} ${cat.label} → <#${values[0]}>. Premiers items dans environ une minute.`));
    }
    case 'cch:rhythm': {
      if (values[0] === 'custom') return openModal(categoryRhythmModal(await categoryRhythm(env)));
      if (!CATEGORY_RHYTHMS[values[0]]) return update(await categoryChannelsView(env, it, null));
      return update(await setCategoryRhythm(env, it, values[0]));
    }
    case 'sch:preset': {
      const p = PRESETS[c];
      if (!p) return update(await schedulesView(env, it));
      const id = await createSchedule(env, it, p.name, p.params, p.per_run, p.every);
      return update(await scheduleView(env, id, '✅ Drop créé. Le premier part dans environ une minute.'));
    }
    case 'sch:ch': {
      if (values[0]) await env.DB.prepare('UPDATE schedules SET channel_id = ?, channel_type = ? WHERE id = ?').bind(values[0], resolvedType(it, values[0]), c).run();
      return update(await scheduleView(env, c, `📍 Le drop sera posté dans <#${values[0]}>.`));
    }
    case 'sch:role': {
      await env.DB.prepare('UPDATE schedules SET ping_role = ? WHERE id = ?').bind(values[0] || null, c).run();
      return update(await scheduleView(env, c, values[0] ? `🔔 <@&${values[0]}> sera mentionné à chaque drop.` : '🔕 Plus de mention.'));
    }
    case 'sch:toggle': {
      await env.DB.prepare('UPDATE schedules SET enabled = 1 - enabled, next_at = ? WHERE id = ?').bind(Date.now() + 60000, c).run();
      return update(await scheduleView(env, c));
    }
    case 'sch:run': {
      const s = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(c).first();
      if (!s) return update(await schedulesView(env, it));
      const n = await runSchedule(env, s);
      ctx.waitUntil(processQueue(env, 25000).catch((e) => console.log('file', String(e))));
      return update(await scheduleView(env, c, n ? `⚡ ${n} item${n > 1 ? 's' : ''} en route vers <#${s.channel_id}>.` : '😕 Aucun nouvel item à poster pour cette recherche.'));
    }
    case 'sch:edit': {
      const s = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(c).first();
      return s ? openModal(scheduleModal(`m:sch:edit:${c}`, s)) : update(await schedulesView(env, it));
    }
    case 'sch:del':
      await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(c).run();
      return update(await schedulesView(env, it, '🗑️ Drop supprimé.'));

    // --- Statistiques, historique, santé
    case 'stats:7': return update(await statsView(env, 7));
    case 'stats:30': return update(await statsView(env, 30));
    case 'hist:del': {
      const p = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(c).first();
      let msg = '🗑️ Post supprimé de Discord.';
      if (p) {
        try {
          if (p.thread_id) await discordApi(env, 'DELETE', `/channels/${p.thread_id}`);
          else if (p.message_id) await discordApi(env, 'DELETE', `/channels/${p.channel_id}/messages/${p.message_id}`);
        } catch (err) {
          msg = /-> 404/.test(String(err)) ? '🗑️ Le message n\'existait plus, retiré de l\'historique.' : `❌ Impossible de supprimer : ${escape(String(err.message).slice(0, 100))}`;
        }
        if (!msg.startsWith('❌')) await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(c).run();
      }
      return update(await historyView(env, it, Number(d) || 0, msg));
    }
    case 'health:': return update(await healthView(env));
    case 'health:index':
      await triggerIndexer(env);
      return update(await healthView(env));

    // --- Réglages
    case 'set:': return update(await settingsView(env, it));
    case 'set:currency':
      await setConfig(env, 'currency', values[0]);
      return update(await settingsView(env, it, `💱 Prix affichés en ${CURRENCIES[values[0]].label}.`));
    case 'set:lang':
      await setConfig(env, 'lang', values[0]);
      return update(await settingsView(env, it, `🌍 Cartes postées en ${LANGS[values[0]].label}.`));
    case 'set:accent':
      await setConfig(env, 'accent', values[0]);
      return update(await settingsView(env, it, `${ACCENTS[values[0]].emoji} Couleur des cartes : ${ACCENTS[values[0]].label}.`));
    case 'set:forumqc': {
      const cfg = await getConfig(env);
      await setConfig(env, 'forumQc', cfg.forumQc ? 0 : 1);
      return update(await settingsView(env, it, cfg.forumQc ? '📸 Plus de QC automatiques sous les posts de forum.' : '📸 Les posts de forum recevront automatiquement des photos QC.'));
    }
    case 'set:weekly':
      await setConfig(env, 'weeklyTop', values[0] || null);
      return update(await settingsView(env, it, values[0] ? `🏆 Top de la semaine posté chaque lundi dans <#${values[0]}>.` : '🏆 Top de la semaine désactivé.'));
    case 'set:dedupe':
      await setConfig(env, 'dedupeDays', Number(values[0]));
      return update(await settingsView(env, it, Number(values[0]) ? '♻️ Anti-doublon mis à jour.' : '♻️ Anti-doublon désactivé.'));
    case 'set:channel':
      await setConfig(env, 'defaultChannel', values[0] || null);
      await setConfig(env, 'defaultChannelType', values[0] ? resolvedType(it, values[0]) : null);
      return update(await settingsView(env, it, values[0] ? `📍 Salon par défaut : <#${values[0]}>.` : '📍 Plus de salon par défaut.'));
    case 'set:qc': {
      const stmts = [env.DB.prepare(`DELETE FROM qc_channels WHERE guild_id = ? AND channel_id NOT IN (${values.map(() => '?').join(',') || "''"})`)
        .bind(it.guild_id, ...values)];
      for (const ch of values) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO qc_channels (channel_id, guild_id, added_at) VALUES (?, ?, ?)').bind(ch, it.guild_id, Date.now()));
      }
      await env.DB.batch(stmts);
      return update(await settingsView(env, it, values.length
        ? `📸 Le bot récupère les QC postés dans ${values.map((v) => `<#${v}>`).join(', ')} (photo + lien d'item), y compris l'historique récent.`
        : '📸 Plus de salon QC.'));
    }
    case 's:qc': {
      const s = await loadSearch(env, c);
      if (s) await saveParams(env, c, { withQc: !s.params.withQc });
      return update(await resultsView(env, c, 0));
    }
    case 'set:image': {
      const stmts = [env.DB.prepare(`DELETE FROM image_channels WHERE guild_id = ? AND channel_id NOT IN (${values.map(() => '?').join(',') || "''"})`)
        .bind(it.guild_id, ...values)];
      for (const ch of values) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO image_channels (channel_id, guild_id, added_at) VALUES (?, ?, ?)').bind(ch, it.guild_id, Date.now()));
      }
      await env.DB.batch(stmts);
      ctx.waitUntil(refreshGateway(env)); // sans faire attendre la réponse
      return update(await settingsView(env, it, values.length
        ? `🔎 Recherche par image active dans ${values.map((v) => `<#${v}>`).join(', ')}. Réponse sous chaque photo en 2 min maximum.`
        : '🔎 Recherche par image désactivée.'));
    }
    case 'set:aiqc': {
      const stmts = [env.DB.prepare(`DELETE FROM aiqc_channels WHERE guild_id = ? AND channel_id NOT IN (${values.map(() => '?').join(',') || "''"})`)
        .bind(it.guild_id, ...values)];
      for (const ch of values) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO aiqc_channels (channel_id, guild_id, added_at) VALUES (?, ?, ?)').bind(ch, it.guild_id, Date.now()));
      }
      await env.DB.batch(stmts);
      ctx.waitUntil(refreshGateway(env)); // sans faire attendre la réponse
      return update(await settingsView(env, it, values.length
        ? `🤖 Analyse IA des QC active dans ${values.map((v) => `<#${v}>`).join(', ')} : les membres y postent leurs photos QC, le bot répond tout de suite.`
        : '🤖 Salons d\'analyse IA désactivés.'));
    }
    case 'set:convert': {
      const stmts = [env.DB.prepare(`DELETE FROM convert_channels WHERE guild_id = ? AND channel_id NOT IN (${values.map(() => '?').join(',') || "''"})`)
        .bind(it.guild_id, ...values)];
      for (const ch of values) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO convert_channels (channel_id, guild_id, added_at) VALUES (?, ?, ?)').bind(ch, it.guild_id, Date.now()));
      }
      await env.DB.batch(stmts);
      ctx.waitUntil(refreshGateway(env)); // sans faire attendre la réponse
      return update(await settingsView(env, it, values.length
        ? `🔄 Conversion automatique active dans ${values.map((v) => `<#${v}>`).join(', ')}. Le bot a besoin de « Voir le salon », « Envoyer des messages » et de l'intent Message Content.`
        : '🔄 Conversion automatique désactivée.'));
    }

    // --- Boutiques : meilleurs items, bannir
    case 'cat:best': {
      const shop = await env.DB.prepare('SELECT name FROM shops WHERE id = ?').bind(c).first();
      const sid = await createSearch(env, it, { q: '', variants: [], shop: c, shopName: shop ? shop.name : c, sort: 'popular', includePosted: false });
      return update(await resultsView(env, sid, 0));
    }
    case 'cat:ban': {
      const shop = await env.DB.prepare('SELECT name FROM shops WHERE id = ?').bind(c).first();
      await env.DB.batch([
        env.DB.prepare('INSERT OR REPLACE INTO blacklist (shop_id, name, added_at) VALUES (?, ?, ?)').bind(c, shop ? shop.name : null, Date.now()),
        env.DB.prepare('DELETE FROM shops WHERE id = ?').bind(c),
      ]);
      await deleteShopItems(env, c);
      return update(await catalogsView(env, 0, `🚫 **${escape(shop ? shop.name || c : c)}** est banni : retiré, et jamais réajouté par la découverte.`));
    }
    default: return null;
  }
}

function parseNum(v) {
  const n = parseFloat(String(v || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export async function handleFeatureModal(it, env, kind, rest, v) {
  if (kind === 'cch' && rest[0] === 'rhythm') {
    const count = Math.round(parseNum(v.count) || 0);
    const minutes = Math.round(parseNum(v.minutes) || 0);
    if (count < 1 || count > 10 || minutes < 5 || minutes > 1440) {
      return update(await categoryChannelsView(env, it, null, '❌ Entre 1 et 10 items, toutes les 5 à 1440 minutes.'));
    }
    return update(await setCategoryRhythm(env, it, `custom:${count}:${minutes}`));
  }
  if (kind !== 'sch') return null;
  const hours = parseNum(v.hours);
  const count = Math.round(parseNum(v.count) || 0);
  if (!hours || hours < 0.25 || hours > 336 || count < 1 || count > 10) {
    const msg = '❌ Intervalle entre 0,25 et 336 heures, et entre 1 et 10 items par drop.';
    return update(rest[0] === 'edit' ? await scheduleView(env, rest[1], msg) : await schedulesView(env, it, msg));
  }
  const name = (v.name || '').slice(0, 60) || 'Drop';
  if (rest[0] === 'edit') {
    await env.DB.prepare('UPDATE schedules SET name = ?, per_run = ?, every_minutes = ? WHERE id = ?')
      .bind(name, count, Math.round(hours * 60), rest[1]).run();
    return update(await scheduleView(env, rest[1], '✅ Drop mis à jour.'));
  }
  const s = await loadSearch(env, rest[1]);
  if (!s) return update(await schedulesView(env, it, '⌛ Recherche expirée, recommence depuis une recherche.'));
  const id = await createSchedule(env, it, name, s.params, count, Math.round(hours * 60));
  await env.DB.prepare('UPDATE schedules SET channel_id = ?, channel_type = ? WHERE id = ?').bind(s.channelId, s.channelType, id).run();
  return update(await scheduleView(env, id, '✅ Drop programmé. Le premier part dans environ une minute.'));
}

// Rythme commun des salons par catégorie : enregistré, et appliqué tout de suite aux drops existants.
async function setCategoryRhythm(env, it, key) {
  const r = rhythmOf(key);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cat_rhythm', ?)").bind(r.key),
    env.DB.prepare("UPDATE schedules SET per_run = ?, every_minutes = ? WHERE guild_id = ? AND json_extract(params, '$.catChannel') IS NOT NULL")
      .bind(r.per, r.every, it.guild_id),
  ]);
  return categoryChannelsView(env, it, null, `⏱️ Rythme : ${r.label} par salon.`);
}

// ---------------------------------------------------------------- Exécution des drops (cron chaque minute)

// Met dans la file les meilleurs items jamais postés dans ce salon. Renvoie le nombre d'items.
export async function runSchedule(env, s) {
  const ctx = await postContext(env);
  const params = JSON.parse(s.params);
  // Cache partagé de 6 h : sans lui, chaque drop relisait toute la catégorie (jusqu'à ~100 000 lignes).
  const ids = await cachedIds(env, { ...withoutCache(params), includePosted: true }, ctx.money);
  const picked = [];
  for (let i = 0; i < ids.length && picked.length < s.per_run; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT item_id FROM posts WHERE channel_id = ? AND item_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(s.channel_id, ...chunk).all();
    const done = new Set(results.map((r) => r.item_id));
    for (const id of chunk) if (!done.has(id) && picked.length < s.per_run) picked.push(id);
  }
  const now = Date.now();
  const stmts = picked.map((id, i) => env.DB.prepare(
    'INSERT INTO post_queue (item_id, channel_id, channel_type, ping, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, s.channel_id, s.channel_type, i === 0 && s.ping_role ? `<@&${s.ping_role}> 🔔 **${s.name || 'Nouveau drop'}**` : null, now));
  stmts.push(env.DB.prepare('UPDATE schedules SET next_at = ?, last_run = ?, runs = runs + ? WHERE id = ?')
    .bind(now + s.every_minutes * 60000, now, picked.length ? 1 : 0, s.id));
  await env.DB.batch(stmts);
  return picked.length;
}

export async function runSchedules(env) {
  // Trois drops par minute au plus (requêtes à la base limitées par exécution) : assez pour une dizaine de salons
  // par catégorie, même à un rythme rapide.
  const { results } = await env.DB.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_at <= ? ORDER BY next_at LIMIT 3')
    .bind(Date.now()).all();
  for (const s of results) {
    try {
      await runSchedule(env, s);
    } catch (err) {
      await logError(env, 'drop', `${s.name} : ${String(err.message || err).slice(0, 200)}`);
      await env.DB.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').bind(Date.now() + 15 * 60000, s.id).run();
    }
  }
}

// Liste des QC de la communauté pour un item (les plus récents d'abord).
export async function communityQcList(env, itemId) {
  const { results } = await env.DB.prepare('SELECT * FROM qc_posts WHERE item_id = ? ORDER BY at DESC LIMIT 6').bind(itemId).all();
  return results;
}

// ---------------------------------------------------------------- Salons QC (cron toutes les 2 min)

// Lit les salons QC : chaque message avec photo + lien d'item devient un QC de la communauté.
// À l'ajout d'un salon, on lit aussi les 500 derniers messages.
export async function runQcChannels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM qc_channels ORDER BY added_at LIMIT 5').all();
  for (const ch of results) {
    try {
      const pages = [];
      if (ch.last_message_id) {
        pages.push(await discordApi(env, 'GET', `/channels/${ch.channel_id}/messages?limit=100&after=${ch.last_message_id}`));
      } else {
        let before = '';
        for (let p = 0; p < 5; p++) {
          const page = await discordApi(env, 'GET', `/channels/${ch.channel_id}/messages?limit=100${before ? `&before=${before}` : ''}`);
          pages.push(page);
          if (page.length < 100) break;
          before = page[page.length - 1].id;
        }
      }
      const messages = pages.flat();
      if (!messages.length) continue;
      let collected = 0;
      for (const m of messages) if (await collectQc(env, m, ch.guild_id, ch.channel_id)) collected++;
      const newest = messages.reduce((acc, x) => (!acc || BigInt(x.id) > BigInt(acc) ? x.id : acc), ch.last_message_id);
      await env.DB.prepare('UPDATE qc_channels SET last_message_id = ?, collected = collected + ? WHERE channel_id = ?')
        .bind(newest, collected, ch.channel_id).run();
    } catch (err) {
      await logError(env, 'salon QC', `<#${ch.channel_id}> : ${String(err.message || err).slice(0, 200)}`);
    }
  }
}

// Demande de QC à la communauté pour un item qui n'en a aucune.
async function requestQc(env, it, key, platform, itemId) {
  const { results: qcCh } = await env.DB.prepare('SELECT channel_id FROM qc_channels WHERE guild_id = ? LIMIT 1').bind(it.guild_id).all();
  if (!qcCh.length) return [container([text('Aucun salon QC n\'est configuré sur ce serveur.')])];
  const channel = qcCh[0].channel_id;
  const recent = await env.DB.prepare('SELECT at FROM qc_requests WHERE item_id = ?').bind(key).first();
  if (recent && Date.now() - recent.at < 86400000) {
    return [container([text(`🙋 Des QC ont déjà été demandés pour cet item dans <#${channel}> il y a moins de 24 h. Elles apparaîtront ici dès qu'un membre les poste.`)])];
  }
  const item = await itemById(env, key)
    || { id: key, item_id: itemId, platform, url: canonicalUrl(platform, itemId) };
  const title = escape((item.title_en || item.title_zh || `${platform} ${itemId}`).slice(0, 90));
  const lines = `## 🙋 QC demandés\n<@${userId(it)}> cherche des photos QC pour **${title}**.\n` +
    `Tu l'as acheté ? Poste tes photos ici avec ce lien : ${item.url}`;
  await discordApi(env, 'POST', `/channels/${channel}/messages`, {
    flags: COMPONENTS_V2, allowed_mentions: { users: [userId(it)] },
    components: [container([item.image ? section(lines, thumb(item.image)) : text(lines)], 0x5865f2)],
  });
  await env.DB.prepare('INSERT OR REPLACE INTO qc_requests (item_id, user_id, at) VALUES (?, ?, ?)').bind(key, userId(it), Date.now()).run().catch(() => {});
  return [container([text(`✅ Demande envoyée dans <#${channel}>. Dès qu'un membre poste ses QC avec le lien, elles apparaîtront dans le bouton « 📸 QC ».`)])];
}
