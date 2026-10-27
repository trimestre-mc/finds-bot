// Écrans : drops automatiques, statistiques, historique, réglages, santé, et vues publiques (/find, /convert).

import {
  Style, container, section, text, sep, row, thumb, btn, emojiBtn, modal, escape, fmtInt, ago, link,
} from './components.js';
import { formatPrice, itemTitle, PLATFORM_NAMES, postContext, agentButtons, signupButton, cardTitle } from './post.js';
import { searchIds, itemsByIds } from './search.js';
import { CATEGORY_BY_KEY, CATEGORIES } from './categories.js';
import { getConfig, getCoupon, CURRENCIES, ACCENTS, LANGS } from './config.js';
import { loadSearch, bigCounts } from './ui.js';
import { communityQc, qcSummary } from './qc.js';
import { itemsWhereIds, countAll, itemDbs } from './shard.js';
import { aiNeurons, AI_NEURONS_PER_DAY } from './translate.js';
import { etxt, emo } from './emojis.js';

const notice = (msg) => (msg ? text(`> ${msg}`) : null);
const backHome = () => emojiBtn('🏠', 'Menu', 'home');

function everyLabel(min) {
  if (min % 1440 === 0) return min === 1440 ? 'chaque jour' : `tous les ${min / 1440} jours`;
  if (min % 60 === 0) return min === 60 ? 'chaque heure' : `toutes les ${min / 60} h`;
  return `toutes les ${min} min`;
}

export function describeParams(p) {
  const parts = [];
  if (p.q) parts.push(`« ${escape(p.q)} »`);
  if (p.trending) parts.push('🔥 tendances');
  if (p.latest) parts.push('✨ nouveautés');
  if (p.drops) parts.push('📉 baisses de prix');
  if (p.category && CATEGORY_BY_KEY[p.category]) parts.push(`${CATEGORY_BY_KEY[p.category].emoji} ${CATEGORY_BY_KEY[p.category].label}`);
  if (p.shopName) parts.push(`🏪 ${escape(p.shopName)}`);
  if (p.min != null) parts.push(`≥ ${p.min}`);
  if (p.max != null) parts.push(`≤ ${p.max}`);
  return parts.join(' · ') || 'tous les items';
}

// ---------------------------------------------------------------- Salons par catégorie

// Rythme commun à tous les salons de catégorie.
export const CATEGORY_RHYTHMS = {
  '5x10m': { per: 5, every: 10, label: '5 items toutes les 10 min' },
  '1x5m': { per: 1, every: 5, label: '1 item toutes les 5 min' },
  '10m': { per: 1, every: 10, label: '1 item toutes les 10 min' },
  '30m': { per: 2, every: 30, label: '2 items toutes les 30 min' },
  '1h': { per: 3, every: 60, label: '3 items par heure' },
  '3h': { per: 5, every: 180, label: '5 items toutes les 3 h' },
  '1d': { per: 10, every: 1440, label: '10 items par jour' },
};

export async function categoryChannels(env, guildId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM schedules WHERE guild_id = ? AND json_extract(params, '$.catChannel') IS NOT NULL",
  ).bind(guildId).all();
  return new Map(results.map((s) => [JSON.parse(s.params).catChannel, s]));
}

// Rythme choisi : un préréglage, ou « custom:<items>:<minutes> » (modale « Personnalisé »).
export async function categoryRhythm(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cat_rhythm'").first();
  return rhythmOf(row ? row.value : '1h');
}

export function rhythmOf(key) {
  if (CATEGORY_RHYTHMS[key]) return { key, ...CATEGORY_RHYTHMS[key] };
  const m = /^custom:(\d+):(\d+)$/.exec(String(key || ''));
  if (m) {
    const per = Number(m[1]);
    const every = Number(m[2]);
    return { key, per, every, label: `${per} item${per > 1 ? 's' : ''} ${everyLabel(every)}` };
  }
  return { key: '1h', ...CATEGORY_RHYTHMS['1h'] };
}

export function categoryRhythmModal(current) {
  return modal('m:cch:rhythm', '⏱️ Rythme des salons par catégorie', [
    { id: 'count', label: 'Combien d\'items à chaque fois ?', description: 'Entre 1 et 10', placeholder: '3', value: current.per, required: true, max: 2 },
    { id: 'minutes', label: 'Toutes les combien de minutes ?', description: 'Entre 5 et 1440 (une fois par jour)', placeholder: '60', value: current.every, required: true, max: 4 },
  ]);
}

// Un salon par catégorie : le bot y poste tout seul les meilleurs items de la catégorie.
export async function categoryChannelsView(env, it, pick, msg) {
  const [byCat, rhythm] = await Promise.all([categoryChannels(env, it.guild_id), categoryRhythm(env)]);
  const lines = CATEGORIES.map((c) => {
    const s = byCat.get(c.key);
    return `${c.emoji} **${c.label}** → ${s ? `<#${s.channel_id}>${s.enabled ? `  ·  prochain ${ago(s.next_at)}` : '  ·  ⏸️ en pause'}` : '-# aucun salon'}`;
  });
  const picked = pick && CATEGORY_BY_KEY[pick];
  const current = picked && byCat.get(pick);
  return [container([
    notice(msg),
    text('## 🗂️ Salons par catégorie\n-# Choisis un salon pour chaque catégorie : le bot y poste tout seul les meilleurs items de la catégorie (les plus vendus d\'abord), sans jamais reposter le même item dans le même salon.'),
    sep(),
    text(lines.join('\n')),
    sep(),
    row({
      type: 3, custom_id: 'cch:pick', placeholder: '1. Choisis une catégorie',
      options: CATEGORIES.map((c) => ({ label: c.label, value: c.key, emoji: { name: c.emoji }, default: c.key === pick, description: byCat.has(c.key) ? 'Salon configuré' : 'Aucun salon' })),
    }),
    picked ? row({
      type: 8, custom_id: `cch:set:${pick}`, placeholder: `2. Salon pour ${picked.label} (vide = arrêter)`, channel_types: [0, 5, 15],
      min_values: 0, max_values: 1, default_values: current ? [{ id: current.channel_id, type: 'channel' }] : [],
    }) : null,
    text(`**Rythme** (pour toutes les catégories) : ${rhythm.label} par salon`),
    row({
      type: 3, custom_id: 'cch:rhythm', placeholder: 'Rythme',
      options: [
        ...Object.entries(CATEGORY_RHYTHMS).map(([k, r]) => ({ label: `${r.label} par salon`, value: k, default: k === rhythm.key })),
        { label: 'Personnalisé…', value: 'custom', emoji: { name: '✏️' }, description: 'Choisis le nombre d\'items et l\'intervalle', default: rhythm.key.startsWith('custom:') },
      ],
    }),
    row(emojiBtn('⏰', 'Drops', 'sch:list'), backHome()),
  ])];
}

// ---------------------------------------------------------------- Drops automatiques

export async function schedulesView(env, it, msg) {
  const { results } = await env.DB.prepare('SELECT * FROM schedules WHERE guild_id = ? ORDER BY created_at').bind(it.guild_id).all();
  const cards = results.slice(0, 8).map((s) => section(
    `${s.enabled ? '🟢' : '⏸️'} **${escape(s.name || 'Drop')}** → <#${s.channel_id}>\n` +
      `-# ${s.per_run} item${s.per_run > 1 ? 's' : ''} ${everyLabel(s.every_minutes)}  ·  ${describeParams(JSON.parse(s.params))}` +
      (s.enabled ? `  ·  prochain ${ago(s.next_at)}` : '') + (s.ping_role ? `  ·  ping <@&${s.ping_role}>` : ''),
    btn('Gérer', `sch:view:${s.id}`),
  ));
  return [container([
    notice(msg),
    text('## ⏰ Drops automatiques\n-# Le bot poste tout seul, à intervalle régulier, les meilleurs items d\'une recherche, sans jamais reposter le même item dans le même salon.'),
    sep(),
    ...(cards.length ? cards : [text('Aucun drop pour l\'instant.\n-# Crée-en un en un clic ci-dessous, ou depuis n\'importe quelle recherche avec **⏰ Programmer**.')]),
    sep(),
    text('**Créer en un clic** (dans le salon par défaut des ⚙️ Réglages, sinon ici)'),
    row(
      emojiBtn('🔥', 'Top 5 tendances / jour', 'sch:preset:trending', Style.PRIMARY),
      emojiBtn('✨', '3 nouveautés / 2 h', 'sch:preset:latest'),
      emojiBtn('📉', 'Baisses de prix / 6 h', 'sch:preset:drops'),
    ),
    row(emojiBtn('🗂️', 'Un salon par catégorie', 'cch:open', Style.PRIMARY)),
    row(backHome()),
  ])];
}

export async function scheduleView(env, id, msg) {
  const s = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
  if (!s) return [container([text('## ⏰ Drop introuvable'), row(emojiBtn('↩️', 'Drops', 'sch:list'))])];
  return [container([
    notice(msg),
    text(`## ${s.enabled ? '🟢' : '⏸️'} ${escape(s.name || 'Drop')}\n` +
      `**${s.per_run}** item${s.per_run > 1 ? 's' : ''} ${everyLabel(s.every_minutes)} dans <#${s.channel_id}>\n` +
      `-# ${describeParams(JSON.parse(s.params))}  ·  ${fmtInt(s.runs)} drop${s.runs > 1 ? 's' : ''} faits  ·  dernier ${ago(s.last_run)}` +
      (s.enabled ? `  ·  prochain ${ago(s.next_at)}` : '')),
    sep(),
    row({ type: 8, custom_id: `sch:ch:${s.id}`, placeholder: 'Salon ou forum du drop', channel_types: [0, 5, 15], default_values: [{ id: s.channel_id, type: 'channel' }] }),
    row({
      type: 6, custom_id: `sch:role:${s.id}`, placeholder: '🔔 Rôle à mentionner à chaque drop (optionnel)', min_values: 0, max_values: 1,
      default_values: s.ping_role ? [{ id: s.ping_role, type: 'role' }] : [],
    }),
    row(
      emojiBtn('⚡', 'Lancer maintenant', `sch:run:${s.id}`, Style.PRIMARY),
      emojiBtn(s.enabled ? '⏸️' : '▶️', s.enabled ? 'Pause' : 'Reprendre', `sch:toggle:${s.id}`),
      emojiBtn('✏️', 'Modifier', `sch:edit:${s.id}`),
      emojiBtn('🗑️', 'Supprimer', `sch:del:${s.id}`, Style.DANGER),
    ),
    row(emojiBtn('↩️', 'Drops', 'sch:list'), backHome()),
  ])];
}

export function scheduleModal(customId, current = {}) {
  return modal(customId, '⏰ Drop automatique', [
    { id: 'name', label: 'Nom du drop', placeholder: 'Sneakers du soir', value: current.name, max: 60 },
    { id: 'hours', label: 'Toutes les combien d\'heures ?', description: 'Ex : 1, 2, 6, 24 (une fois par jour)', placeholder: '2', value: current.every_minutes ? current.every_minutes / 60 : '', required: true, max: 4 },
    { id: 'count', label: 'Combien d\'items par drop ?', description: 'Entre 1 et 10', placeholder: '3', value: current.per_run, required: true, max: 2 },
  ]);
}

// ---------------------------------------------------------------- Statistiques

function bar(n, max) {
  const w = max ? Math.round((n / max) * 12) : 0;
  return '▰'.repeat(w) + '▱'.repeat(12 - w);
}

export async function statsView(env, days = 7) {
  const since = Date.now() - days * 86400000;
  const [posts, clicks, byAgent, topItems, byChannel, perDay] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE posted_at > ?').bind(since).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM clicks WHERE at > ?').bind(since).first(),
    env.DB.prepare('SELECT agent, COUNT(*) AS n FROM clicks WHERE at > ? GROUP BY agent ORDER BY n DESC LIMIT 6').bind(since).all(),
    // Titres lus ensuite dans la base de chaque item (voir shard.js).
    env.DB.prepare('SELECT item_id, COUNT(*) AS n FROM clicks WHERE at > ? GROUP BY item_id ORDER BY n DESC LIMIT 5').bind(since).all()
      .then(async (r) => {
        const info = new Map((await itemsWhereIds(env, r.results.map((x) => x.item_id), 'id, title_en, title_zh, item_id, url')).map((i) => [i.id, i]));
        return { results: r.results.map((x) => ({ ...x, ...(info.has(x.item_id) ? { title_en: info.get(x.item_id).title_en, title_zh: info.get(x.item_id).title_zh, iid: info.get(x.item_id).item_id, url: info.get(x.item_id).url } : {}) })) };
      }),
    env.DB.prepare('SELECT channel_id, COUNT(*) AS n FROM clicks WHERE at > ? AND channel_id IS NOT NULL GROUP BY channel_id ORDER BY n DESC LIMIT 3').bind(since).all(),
    env.DB.prepare("SELECT CAST((at / 86400000) AS INTEGER) AS d, COUNT(*) AS n FROM clicks WHERE at > ? GROUP BY d ORDER BY d").bind(Date.now() - 7 * 86400000).all(),
  ]);
  const rate = posts.n ? (clicks.n / posts.n).toFixed(1).replace('.', ',') : '—';
  const BUTTON_NAMES = { source: '🔗 Annonce d\'origine', signup: '✍️ Inscription', qc_view: '📸 Voir les QC' };
  const agentLines = byAgent.results.map((a) => `${BUTTON_NAMES[a.agent] || `🛒 ${escape(a.agent)}`} — **${fmtInt(a.n)}**`);
  const itemLines = topItems.results.map((r, i) => `${i + 1}. ${r.url ? `[${escape(itemTitle({ title_en: r.title_en, title_zh: r.title_zh, item_id: r.iid }).slice(0, 60))}](${r.url})` : escape(r.item_id)} — **${fmtInt(r.n)}** clics`);
  const maxDay = Math.max(0, ...perDay.results.map((d) => d.n));
  const today = Math.floor(Date.now() / 86400000);
  const dayLines = [];
  for (let d = today - 6; d <= today; d++) {
    const n = (perDay.results.find((x) => x.d === d) || { n: 0 }).n;
    dayLines.push(`\`${new Date(d * 86400000).toISOString().slice(5, 10)}\` ${bar(n, maxDay)} ${n}`);
  }
  return [container([
    text(`## 📊 Statistiques · ${days} derniers jours\n**${fmtInt(posts.n)}** items postés  ·  **${fmtInt(clicks.n)}** clics  ·  **${rate}** clic${rate === '1,0' ? '' : 's'} par post`),
    sep(),
    text(`**Clics par jour**\n${dayLines.join('\n')}`),
    text(`**Par bouton**\n${agentLines.join('\n') || '-# Pas encore de clic.'}`),
    text(`**Items les plus cliqués**\n${itemLines.join('\n') || '-# Pas encore de clic.'}`),
    byChannel.results.length ? text(`**Salons qui cliquent le plus**\n${byChannel.results.map((c) => `<#${c.channel_id}> — ${fmtInt(c.n)}`).join('\n')}`) : null,
    text('-# Les clics sont comptés quand quelqu\'un appuie sur un bouton d\'une carte (aucune donnée personnelle n\'est gardée).'),
    sep(),
    row(
      emojiBtn('📅', '7 jours', 'stats:7', days === 7 ? Style.PRIMARY : Style.SECONDARY),
      emojiBtn('🗓️', '30 jours', 'stats:30', days === 30 ? Style.PRIMARY : Style.SECONDARY),
      backHome(),
    ),
  ])];
}

// ---------------------------------------------------------------- Historique des posts

const HIST_PAGE = 6;

export async function historyView(env, it, page = 0, msg) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first()).n;
  const pages = Math.max(1, Math.ceil(total / HIST_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const { results: posts } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM clicks c WHERE c.item_id = p.item_id AND c.channel_id = p.channel_id AND c.at >= p.posted_at) AS clicks
     FROM posts p ORDER BY p.posted_at DESC LIMIT ? OFFSET ?`,
  ).bind(HIST_PAGE, page * HIST_PAGE).all();
  // Titres lus dans la base de chaque item (voir shard.js).
  const info = new Map((await itemsWhereIds(env, [...new Set(posts.map((p) => p.item_id))], 'id, title_en, title_zh, item_id, image')).map((i) => [i.id, i]));
  const results = posts.map((p) => {
    const i = info.get(p.item_id) || {};
    return { ...p, title_en: i.title_en, title_zh: i.title_zh, iid: i.item_id, image: i.image };
  });
  const cards = results.map((p) => {
    const where = p.thread_id ? `<#${p.thread_id}>` : `<#${p.channel_id}>`;
    const jump = p.message_id && !p.thread_id ? `  ·  [voir](https://discord.com/channels/${it.guild_id}/${p.channel_id}/${p.message_id})` : '';
    return section(
      `**${escape(itemTitle({ title_en: p.title_en, title_zh: p.title_zh, item_id: p.iid || p.item_id }).slice(0, 70))}**\n` +
        `-# ${where}  ·  ${ago(p.posted_at)}  ·  🖱️ ${fmtInt(p.clicks)} clic${p.clicks > 1 ? 's' : ''}${jump}`,
      btn('Supprimer', `hist:del:${p.id}:${page}`, Style.DANGER, { disabled: !p.message_id }),
    );
  });
  return [container([
    notice(msg),
    text(`## 🧾 Historique des posts\n-# ${fmtInt(total)} posts  ·  page ${page + 1}/${pages}  ·  « Supprimer » retire le message (ou le post de forum) de Discord.`),
    sep(),
    ...(cards.length ? cards : [text('Aucun post pour l\'instant.')]),
    sep(),
    row(
      emojiBtn('◀️', null, `hist:${page - 1}`, Style.SECONDARY, { disabled: page === 0 }),
      emojiBtn('▶️', null, `hist:${page + 1}`, Style.SECONDARY, { disabled: page >= pages - 1 }),
      backHome(),
    ),
  ])];
}

// ---------------------------------------------------------------- Réglages

export async function settingsView(env, it, msg) {
  const cfg = await getConfig(env);
  const { results: conv } = await env.DB.prepare('SELECT * FROM convert_channels WHERE guild_id = ?').bind(it.guild_id).all();
  const { results: qcCh } = await env.DB.prepare('SELECT * FROM qc_channels WHERE guild_id = ?').bind(it.guild_id).all();
  const { results: imgCh } = await env.DB.prepare('SELECT * FROM image_channels WHERE guild_id = ?').bind(it.guild_id).all().catch(() => ({ results: [] }));
  return [container([
    notice(msg),
    text('## ⚙️ Réglages'),
    sep(),
    text('**Devise des prix** · **Langue des cartes** · **Couleur des cartes**'),
    row({
      type: 3, custom_id: 'set:currency', placeholder: 'Devise',
      options: Object.entries(CURRENCIES).map(([k, c]) => ({ label: c.label, value: k, default: cfg.currency === k })),
    }),
    row({
      type: 3, custom_id: 'set:lang', placeholder: 'Langue des cartes postées',
      options: Object.entries(LANGS).map(([k, l]) => ({ label: `Cartes en ${l.label}`, value: k, default: cfg.lang === k })),
    }),
    row({
      type: 3, custom_id: 'set:accent', placeholder: 'Couleur des cartes',
      options: Object.entries(ACCENTS).map(([k, a]) => ({ label: a.label, value: k, emoji: { name: a.emoji }, default: cfg.accent === k })),
    }),
    text('**Salon par défaut** (recherches et drops) · **Anti-doublon**'),
    row({
      type: 8, custom_id: 'set:channel', placeholder: 'Salon par défaut (sinon : le salon où tu ouvres /menu)', channel_types: [0, 5, 15],
      min_values: 0, max_values: 1, default_values: cfg.defaultChannel ? [{ id: cfg.defaultChannel, type: 'channel' }] : [],
    }),
    row({
      type: 3, custom_id: 'set:dedupe', placeholder: 'Anti-doublon',
      options: [[0, 'Désactivé'], [1, '1 jour'], [3, '3 jours'], [7, '7 jours'], [30, '30 jours'], [3650, 'Jamais reposter']]
        .map(([d, l]) => ({ label: d ? `Ne pas reposter un item dans le même salon pendant : ${l}` : 'Anti-doublon désactivé', value: String(d), default: cfg.dedupeDays === d })),
    }),
    text(`**🔄 Conversion automatique des liens**\n-# Dans ces salons, quand un membre poste un lien Weidian, Taobao, 1688 (ou d'agent), le bot répond avec les boutons « Acheter » et ton code.\n${conv.length ? conv.map((c) => `<#${c.channel_id}> · ${fmtInt(c.converted)} liens convertis`).join('\n') : '-# Aucun salon.'}`),
    row({
      type: 8, custom_id: 'set:convert', placeholder: 'Salons de conversion automatique', channel_types: [0, 5],
      min_values: 0, max_values: 10, default_values: conv.map((c) => ({ id: c.channel_id, type: 'channel' })),
    }),
    text(`**🔎 Recherche par image**\n-# Dans ces salons, chaque photo postée par un membre reçoit une réponse avec les items qui ressemblent le plus (prix, QC, bouton d'achat avec ton code).\n${imgCh.length ? imgCh.map((c) => `<#${c.channel_id}> · ${fmtInt(c.searched)} photos recherchées`).join('\n') : '-# Aucun salon.'}`),
    row({
      type: 8, custom_id: 'set:image', placeholder: 'Salons de recherche par image', channel_types: [0, 5],
      min_values: 0, max_values: 10, default_values: imgCh.map((c) => ({ id: c.channel_id, type: 'channel' })),
    }),
    row(emojiBtn('📸', cfg.forumQc ? 'QC sous les posts de forum : activé' : 'QC sous les posts de forum : désactivé', 'set:forumqc', cfg.forumQc ? Style.SUCCESS : Style.SECONDARY)),
    text(`**📸 Salons QC**\n-# Les membres y postent leurs photos QC avec le lien de l'item : chaque item gagne un bouton « QC communauté ».\n${qcCh.length ? qcCh.map((c) => `<#${c.channel_id}> · ${fmtInt(c.collected)} QC récupérés`).join('\n') : '-# Aucun salon.'}`),
    row({
      type: 8, custom_id: 'set:qc', placeholder: 'Salons QC', channel_types: [0, 5],
      min_values: 0, max_values: 10, default_values: qcCh.map((c) => ({ id: c.channel_id, type: 'channel' })),
    }),
    row(backHome()),
  ])];
}

// ---------------------------------------------------------------- Santé

export async function healthView(env) {
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
  const [shops, counts, links, queue, last, jade, rates, srcErr, logs] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM shops GROUP BY status').all(),
    bigCounts(env),
    countAll(env, 'SELECT COUNT(*) AS n FROM link_queue').then((n) => ({ n })),
    q('SELECT COUNT(*) AS n FROM post_queue'),
    q("SELECT value FROM settings WHERE key = 'last_dispatch'"),
    q("SELECT value FROM settings WHERE key = 'jadeship_at'"),
    q("SELECT value FROM settings WHERE key = 'rates_at'"),
    q('SELECT COUNT(*) AS n FROM sources WHERE error IS NOT NULL'),
    env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 5').all(),
  ]);
  const items = { n: counts.items };
  const noPhoto = { n: counts.noPhoto };
  const untranslated = { n: counts.untranslated };
  const st = Object.fromEntries(shops.results.map((r) => [r.status, r.n]));
  // Quotas gratuits : lectures et écritures du mois de chaque base, neurons d'IA du jour (compteurs du bot).
  const okq = (cond) => (cond ? '🟢' : '🟠');
  const readsCap = Number(env.READS_MONTH_CAP) || 480000000;
  const writesCap = Number(env.BUDGET_MONTH_ROWS) || 9000000;
  const M = (n) => `${(Number(n || 0) / 1e6).toFixed(1).replace('.', ',')} M`;
  const quotas = await Promise.all(itemDbs(env).map(async (db, i) => {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('reads:month', 'budget:month')").all();
    const v = Object.fromEntries(results.map((r) => { try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, {}]; } }));
    const reads = (v['reads:month'] || {}).rows || 0;
    const written = (v['budget:month'] || {}).rows || 0;
    return `${okq(reads < readsCap)} **Base ${i + 1}${i ? ' (Taobao + 1688)' : env.DB2 ? ' (Weidian)' : ''}** : lectures ${M(reads)} / ${M(readsCap)} · écritures ${M(written)} / ${M(writesCap)}` +
      (reads >= readsCap ? ' · ⏸️ indexation en pause jusqu\'au 1er' : '');
  }));
  const neurons = await aiNeurons(env);
  quotas.push(`${okq(neurons.used < AI_NEURONS_PER_DAY)} **IA du jour** : ${fmtInt(Math.round(neurons.used))} / ${fmtInt(AI_NEURONS_PER_DAY)} neurons`);
  const ok = (cond) => (cond ? '🟢' : '🟠');
  return [container([
    text('## 🩺 Santé du bot'),
    sep(),
    text([
      `${ok(!st.error)} **Boutiques** : ${fmtInt(st.ok || 0)} indexées · ${fmtInt(st.pending || 0)} en attente · ${fmtInt(st.indexing || 0)} en cours · ${fmtInt(st.error || 0)} en erreur`,
      `🟢 **Items** : ${fmtInt(items.n)}`,
      `${ok(noPhoto.n < 2000)} **Photos à récupérer** : ${fmtInt(noPhoto.n)}`,
      `${ok(untranslated.n < 2000)} **Titres à traduire** : ${fmtInt(untranslated.n)}`,
      `${ok(links.n < 500)} **Liens à rattacher à une boutique** : ${fmtInt(links.n)}`,
      `${ok(queue.n < 200)} **Posts en file** : ${fmtInt(queue.n)}`,
      `${ok(last && Date.now() - Number(last.value) < 3600000)} **Dernier lancement de l'indexeur** : ${last ? ago(Number(last.value)) : 'jamais'}`,
      `${ok(jade && Date.now() - Number(jade.value) < 8 * 3600000)} **Dernière collecte Jadeship** : ${jade ? ago(Number(jade.value)) : 'jamais'}`,
      `${ok(rates && Date.now() - Number(rates.value) < 12 * 3600000)} **Taux de change** : ${rates ? ago(Number(rates.value)) : 'jamais'}`,
      `${ok(!srcErr.n)} **Sources Discord en erreur** : ${srcErr.n}`,
      ...quotas,
    ].join('\n')),
    sep(),
    text(`**Dernières erreurs**\n${logs.results.map((l) => `-# ${ago(l.at)} · ${escape(l.kind)} · ${escape(String(l.message).slice(0, 140))}`).join('\n') || '-# Aucune erreur récente. 👌'}`),
    sep(),
    row(emojiBtn('🔄', 'Actualiser', 'health'), emojiBtn('⚡', 'Relancer l\'indexeur', 'health:index'), backHome()),
  ])];
}

// ---------------------------------------------------------------- Vues publiques (/find, /convert)

const FIND_PAGE = 3;

export async function findView(env, sid, page) {
  const s = await loadSearch(env, sid);
  if (!s) return [container([text('⌛ Recherche expirée, relance `/find`.')])];
  const ctx = await postContext(env);
  const params = { ...s.params };
  const ids = await searchIds(env, sid, params, ctx.money);
  const total = ids.length;
  const pages = Math.max(1, Math.ceil(total / FIND_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const items = await itemsByIds(env, ids.slice(page * FIND_PAGE, (page + 1) * FIND_PAGE));
  const communities = Object.fromEntries(await Promise.all(items.map(async (i) => [i.id, await communityQc(env, i.id)])));
  if (!total) {
    return [container([text(`## 🔎 ${escape(s.params.q || 'Recherche')}\nAucun item trouvé. Essaie en anglais (ex : *hoodie*, *jordan 4*, *bag*).`)])];
  }
  const blocks = items.flatMap((item) => {
    const qc = (item.qc_count || 0) + (communities[item.id] ? communities[item.id].images : 0);
    const line = `**${escape(cardTitle(item, 80))}**\n### ${formatPrice(item.price_cny, ctx.money)}\n-# ` +
      [item.popularity ? `${etxt(ctx.emojis, 'fb_fire')} ${fmtInt(item.popularity)}` : null, qc ? `${etxt(ctx.emojis, 'fb_qc')} ${fmtInt(qc)} QC` : null,
        `${etxt(ctx.emojis, 'fb_shop')} ${escape((item.shop_name || PLATFORM_NAMES[item.platform]).slice(0, 30))}`].filter(Boolean).join('  ·  ');
    const rows = agentButtons(ctx, item, null, communities[item.id]);
    return [item.image ? section(line, thumb(item.image)) : text(line), ...rows, sep()];
  });
  // Discord : 40 composants au plus par message. Avec beaucoup d'agents, on garde la 1re ligne de boutons de chaque item.
  const size = (c) => 1 + (c.components || []).reduce((n, x) => n + size(x), 0) + (c.accessory ? 1 : 0);
  if (blocks.filter(Boolean).reduce((n, c) => n + size(c), 0) > 34) {
    for (let i = blocks.length - 1; i > 0; i--) if (blocks[i] && blocks[i].type === 1 && blocks[i - 1] && blocks[i - 1].type === 1) blocks.splice(i, 1);
  }
  return [container([
    text(`## ${etxt(ctx.emojis, 'fb_search')} ${escape(s.params.q || 'Résultats')}\n-# ${fmtInt(total)} résultats  ·  page ${page + 1}/${pages}`),
    sep(),
    ...blocks,
    row(
      emojiBtn('◀️', null, `pub:pg:${sid}:${page - 1}`, Style.SECONDARY, { disabled: page === 0 }),
      emojiBtn('▶️', null, `pub:pg:${sid}:${page + 1}`, Style.SECONDARY, { disabled: page >= pages - 1 }),
    ),
  ], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
}

export async function convertView(env, ref, known, ctx = null) {
  ctx = ctx || await postContext(env);
  const item = known || { id: `${ref.platform}:${ref.itemId}`, item_id: ref.itemId, platform: ref.platform, url: ref.url };
  const platform = PLATFORM_NAMES[item.platform];
  const head = known
    ? `**${escape(cardTitle(known, 90))}**\n### ${formatPrice(known.price_cny, ctx.money)}\n-# 🏪 ${escape(known.shop_name || platform)}` +
      (known.popularity ? `  ·  🔥 ${fmtInt(known.popularity)}` : '')
    : `**Lien ${platform} converti** · \`${ref.itemId}\``;
  const rows = agentButtons(ctx, item, null, await communityQc(env, item.id));
  return [container([
    known && known.image ? section(head, thumb(known.image)) : text(head),
    ...(ctx.agents.length ? [] : [text('-# Aucun agent configuré pour l\'instant.')]),
    ...rows,
  ], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
}



// Guide « comment acheter » (/aide, ou épinglé dans un salon par un admin) : les étapes, avec les liens
// d'inscription et les coupons du propriétaire, et les outils du bot à chaque étape.
export async function guideView(env) {
  const [coupon, ctx] = await Promise.all([getCoupon(env), postContext(env)]);
  const e = (n) => etxt(ctx.emojis, n);
  const agent = ctx.agents[0];
  const links = ((coupon && coupon.links) || []).map((l) => ({ ...link(l.label, l.url), emoji: emo(ctx.emojis, 'fb_coupon') }));
  const signup = signupButton(ctx, null, null);
  if (signup && !links.some((l) => l.url === signup.url)) links.unshift(signup);
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  return [container([
    text(`## ${e('fb_bot')} Comment acheter tes reps\n-# 5 étapes, tout se fait ici sur Discord.`),
    sep(),
    text(`### ${e('fb_signup')} 1 · Crée ton compte chez l'agent\n` +
      `L'agent${agent ? ` (**${escape(agent.name)}**)` : ''} achète l'article en Chine pour toi, le contrôle et te l'envoie. ` +
      (links.length ? 'Inscris-toi avec les liens ci-dessous pour avoir les **coupons de bienvenue**.' : 'Inscris-toi sur son site.')),
    links.length ? row(...links.slice(0, 5)) : null,
    text(`### ${e('fb_search')} 2 · Trouve ton article\n` +
      `• \`/find\` + ce que tu cherches (ex : *nike tech*, *chaussette nike*, *jordan 4*)\n` +
      `• Poste une **photo** dans le salon de recherche par image : le bot reconnaît la marque et trouve l'article\n` +
      `• Les **salons par catégorie** postent les meilleurs items tout seuls`),
    text(`### ${e('fb_qc')} 3 · Vérifie les QC\n` +
      `Bouton **QC** sous chaque item : les vraies photos d'autres acheteurs. Vote **GL** (bon) ou **RL** (à refaire), ` +
      `et **Comparer** montre le même article chez d'autres vendeurs : le moins cher, le plus vendu, le plus de QC.`),
    text(`### ${e('fb_cart')} 4 · Achète avec le bouton\n` +
      `**Acheter sur ${escape(agent ? agent.name : 'l\'agent')}** ouvre l'article chez l'agent avec le bon code. Tu as un lien Weidian, ` +
      `Taobao ou 1688 ? \`/convert\` le transforme.`),
    text(`### ${e('fb_box')} 5 · Reçois et partage\n` +
      `L'agent t'envoie ses photos QC avant l'expédition. Poste-les avec le lien de l'item pour aider les autres, ` +
      `ou partage celles que tu regardes avec **Partager dans le salon**.`),
    sep(),
    text(`-# ${e('fb_coupon')} \`/coupon\` : les réductions du moment  ·  ${e('fb_search')} \`/find\`  ·  ${e('fb_link')} \`/convert\`  ·  ${e('fb_qc')} \`/qc\``),
  ], accent)];
}

// Message de /coupon (public) : le texte choisi par le propriétaire et ses liens, sinon le bouton d'inscription.
export async function couponView(env) {
  const [coupon, ctx] = await Promise.all([getCoupon(env), postContext(env)]);
  const links = ((coupon && coupon.links) || []).map((l) => ({ ...link(l.label, l.url), emoji: emo(ctx.emojis, 'fb_coupon') }));
  const signup = signupButton(ctx, null, null);
  if (!links.length && signup) links.push(signup);
  if (!links.length) {
    return [container([text(`## ${etxt(ctx.emojis, 'fb_gift')} Coupons\nAucun coupon pour l'instant, reviens bientôt !`)], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
  }
  const title = (coupon && coupon.title) || 'Coupons & réductions';
  const message = (coupon && coupon.message) || 'Inscris-toi avec ces liens pour avoir des coupons sur ta première commande. 🎁';
  return [container([
    text(`## ${etxt(ctx.emojis, 'fb_gift')} ${escape(title)}\n${escape(message)}`),
    sep(),
    row(...links.slice(0, 5)),
  ], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
}

export { qcSummary };
