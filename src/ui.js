// Écrans du panneau /menu. Chaque vue renvoie la liste de composants du message.

import {
  Style, container, section, text, sep, row, thumb, btn, emojiBtn, modal,
  escape, fmtInt, ago,
} from './components.js';
import { getRate, getAgents, formatPrice, itemTitle, POSTS_PER_MINUTE, PLATFORM_NAMES, signupButton } from './post.js';
import { buildAgentLink, AGENT_PRESETS } from './links.js';
import { searchIds, itemsByIds, idsToPost, PAGE_SIZE, MAX_BULK, SORTS } from './search.js';
import { CATEGORIES, CATEGORY_BY_KEY } from './categories.js';
import { formatMoney, getConfig, getSignup, SIGNUP_COLORS } from './config.js';
import { communityQc, qcSummary } from './qc.js';

export const QUEUE_PER_MINUTE = POSTS_PER_MINUTE;
const SHOPS_PER_PAGE = 6;
const STATUS_ICON = { pending: '🕒', indexing: '⏳', ok: '🟢', error: '🔴' };
const TIER_BADGE = { trusted: '  ⭐ Trusted', high: '  💎 High Tier', mid: '  ✦ Mid Tier' };
const EXAMPLE_ITEM = { url: 'https://weidian.com/item.html?itemID=7863670229', item_id: '7863670229', platform: 'weidian' };

const notice = (msg) => (msg ? text(`> ${msg}`) : null);
const backHome = () => emojiBtn('🏠', 'Menu', 'home');

// ---------------------------------------------------------------- Accueil

export async function homeView(env, it, msg) {
  const [items, shops, agents, pending, queue, drops, schedules] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE hidden = 0').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM shops').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE title_en IS NULL AND translate_failed < 3").first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE hidden = 0 AND prev_price > price_cny AND price_changed_at > ?')
      .bind(Date.now() - 14 * 86400000).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1').first(),
  ]);
  const money = await getRate(env);

  const tips = [];
  if (!shops.n) tips.push('👉 Commence par ajouter des boutiques dans **📚 Catalogues**.');
  if (!agents.n) tips.push('👉 Ajoute ton code d\'affiliation dans **🏷️ Agents** pour que les boutons « Acheter » apparaissent.');

  const sub = [];
  if (pending.n) sub.push(`🌐 ${fmtInt(pending.n)} titres en traduction`);
  if (queue.n) sub.push(`📨 ${fmtInt(queue.n)} posts en file (~${Math.ceil(queue.n / QUEUE_PER_MINUTE)} min)`);
  if (schedules.n) sub.push(`⏰ ${schedules.n} drop${schedules.n > 1 ? 's' : ''} actif${schedules.n > 1 ? 's' : ''}`);
  sub.push(`💱 ¥100 = ${formatMoney(100, money)}`);

  return [container([
    notice(msg),
    text('# 🛍️ Finds\n-# Ton catalogue de finds, prêt à poster en un clic.'),
    sep(),
    text(`**${fmtInt(items.n)}** items  ·  **${fmtInt(shops.n)}** boutiques  ·  **${fmtInt(agents.n)}** agent${agents.n > 1 ? 's' : ''}\n-# ${sub.join('  ·  ')}`),
    tips.length ? text(tips.join('\n')) : null,
    sep(),
    row(
      emojiBtn('🔎', 'Rechercher', 'search:new', Style.PRIMARY),
      emojiBtn('🔥', 'Tendances', 'search:trending'),
      emojiBtn('✨', 'Nouveautés', 'search:latest'),
      emojiBtn('📉', `Baisses de prix${drops.n ? ` (${fmtInt(drops.n)})` : ''}`, 'search:drops'),
    ),
    row(
      emojiBtn('📚', 'Catalogues', 'cat:list:0'),
      emojiBtn('⏰', 'Drops auto', 'sch:list'),
      emojiBtn('🗂️', 'Salons catégories', 'cch:open'),
      emojiBtn('🏷️', 'Agents', 'ag:list'),
      emojiBtn('➕', 'Ajouter un item', 'item:add'),
    ),
    row(
      emojiBtn('📊', 'Stats', 'stats:7'),
      emojiBtn('🧾', 'Historique', 'hist:0'),
      emojiBtn('⚙️', 'Réglages', 'set'),
      emojiBtn('👥', 'Accès', 'acc'),
      emojiBtn('🩺', 'Santé', 'health'),
    ),
  ])];
}

// ---------------------------------------------------------------- Recherche

export function searchModal(params = {}, sid = '') {
  return modal(`m:search:${sid}`, '🔎 Rechercher', [
    { id: 'q', label: 'Mots-clés', description: 'Anglais, français ou chinois. Vide = tout.', placeholder: 'bag, hoodie, jordan 4…', value: params.q, max: 100 },
    { id: 'min', label: 'Prix minimum (€)', placeholder: 'ex : 10', value: params.min, max: 10 },
    { id: 'max', label: 'Prix maximum (€)', placeholder: 'ex : 80', value: params.max, max: 10 },
  ]);
}

export async function loadSearch(env, sid) {
  const row = await env.DB.prepare('SELECT * FROM searches WHERE id = ?').bind(sid).first();
  return row ? { params: JSON.parse(row.params), channelId: row.channel_id, channelType: row.channel_type || 0 } : null;
}

export async function createSearch(env, it, params) {
  const sid = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const uid = (it.member && it.member.user.id) || (it.user && it.user.id);
  // Salon de publication : celui des ⚙️ Réglages s'il existe, sinon celui où le panneau est ouvert.
  const cfg = await getConfig(env);
  const channel = cfg.defaultChannel || it.channel_id;
  const type = cfg.defaultChannel ? cfg.defaultChannelType : (it.channel && it.channel.type === 15 ? 15 : 0);
  await env.DB.prepare('INSERT INTO searches (id, guild_id, user_id, params, channel_id, channel_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(sid, it.guild_id, uid, JSON.stringify(params), channel, type, Date.now()).run();
  return sid;
}

export async function resultsView(env, sid, page, msg) {
  const s = await loadSearch(env, sid);
  if (!s) return expiredView();
  const { params, channelId } = s;
  const money = await getRate(env);
  const ids = await searchIds(env, sid, params, money);
  const total = ids.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const items = await itemsByIds(env, ids.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
  const qcLine = Object.fromEntries(await Promise.all(items.map(async (i) => [i.id, qcSummary(i, await communityQc(env, i.id))])));

  const filters = [];
  if (params.shopName) filters.push(`🏪 ${escape(params.shopName)}`);
  const cat = params.category || params.autoCategory;
  if (cat && CATEGORY_BY_KEY[cat]) filters.push(`${CATEGORY_BY_KEY[cat].emoji} ${CATEGORY_BY_KEY[cat].label}`);
  if (params.min != null) filters.push(`≥ ${params.min}`);
  if (params.max != null) filters.push(`≤ ${params.max}`);
  if (params.sort && SORTS[params.sort]) filters.push(`${SORTS[params.sort].emoji} ${SORTS[params.sort].label}`);
  if (params.withQc) filters.push('📸 avec QC');
  filters.push(params.includePosted ? 'déjà postés inclus' : 'non postés');
  const title = params.q ? `« ${escape(params.q)} »` : params.drops ? '📉 Baisses de prix'
    : params.trending ? '🔥 Tendances' : params.latest ? '✨ Nouveautés' : 'Tous les items';

  const head = [
    notice(msg),
    text(`## 🔎 ${title}\n-# ${fmtInt(total)}${total >= MAX_BULK ? '+' : ''} résultat${total > 1 ? 's' : ''}  ·  ${filters.join('  ·  ')}${total ? `  ·  page ${page + 1}/${pages}` : ''}`),
    sep(),
  ];

  if (!total) {
    return [container([
      ...head,
      text('Aucun item trouvé.\n-# Essaie d\'autres mots (l\'anglais marche le mieux), une autre catégorie, ou élargis les prix.'),
      sep(),
      row(
        emojiBtn('✏️', 'Modifier la recherche', `s:edit:${sid}`, Style.PRIMARY),
        emojiBtn('🎛️', 'Filtres', `s:filt:${sid}`),
        backHome(),
      ),
    ])];
  }

  const cards = items.map((item, i) => {
    const dropped = item.prev_price > item.price_cny;
    const line = `**${page * PAGE_SIZE + i + 1}. [${escape(itemTitle(item).slice(0, 90))}](${item.url})**\n` +
      `${formatPrice(item.price_cny, money)}${dropped ? ` 📉 ~~${formatMoney(item.prev_price, money)}~~` : ''}` +
      `  ·  🏪 ${escape((item.shop_name || PLATFORM_NAMES[item.platform] || '—').slice(0, 40))}` +
      (item.popularity ? `  ·  🔥 ${fmtInt(item.popularity)}` : '') +
      (qcLine[item.id] ? `  ·  ${qcLine[item.id]}` : '') +
      (item.posted_count ? '  ·  ✅ posté' : '');
    return item.image ? section(line, thumb(item.image)) : text(line);
  });
  const options = items.map((item, i) => ({
    label: `${page * PAGE_SIZE + i + 1}. ${itemTitle(item)}`.slice(0, 100),
    description: formatPrice(item.price_cny, money).slice(0, 100),
    value: item.id,
  }));

  return [container([
    ...head,
    ...cards,
    sep(),
    row({
      type: 8, custom_id: `s:ch:${sid}:${page}`, placeholder: 'Salon ou forum où poster',
      channel_types: [0, 5, 15], default_values: [{ id: channelId, type: 'channel' }],
    }),
    row({ type: 3, custom_id: `s:sel:${sid}:${page}`, placeholder: '📤 Poster les items choisis…', min_values: 1, max_values: items.length, options }),
    row({ type: 3, custom_id: `s:hide:${sid}:${page}`, placeholder: '🚫 Masquer des items (n\'apparaîtront plus)…', min_values: 1, max_values: items.length, options }),
    row(
      emojiBtn('◀️', null, `s:pg:${sid}:${page - 1}`, Style.SECONDARY, { disabled: page === 0 }),
      emojiBtn('▶️', null, `s:pg:${sid}:${page + 1}`, Style.SECONDARY, { disabled: page >= pages - 1 }),
      emojiBtn('📤', `Tout poster (${fmtInt(Math.min(total, MAX_BULK))})`, `s:all:${sid}:${page}`, Style.SUCCESS),
      emojiBtn('🎛️', 'Filtres', `s:filt:${sid}`),
      emojiBtn('⏰', 'Programmer', `s:sched:${sid}`),
    ),
    row(emojiBtn('✏️', 'Modifier', `s:edit:${sid}`), backHome()),
  ])];
}

// Filtres d'une recherche : catégorie, tri, déjà postés.
export async function filtersView(env, sid) {
  const s = await loadSearch(env, sid);
  if (!s) return expiredView();
  const p = s.params;
  return [container([
    text('## 🎛️ Filtres\n-# Les changements s\'appliquent tout de suite.'),
    sep(),
    row({
      type: 3, custom_id: `s:cat:${sid}`, placeholder: 'Catégorie',
      options: [{ label: 'Toutes les catégories', value: 'all', emoji: { name: '🗂️' }, default: !p.category },
        ...CATEGORIES.map((c) => ({ label: c.label, value: c.key, emoji: { name: c.emoji }, default: p.category === c.key })),
        { label: 'Autres', value: 'other', emoji: { name: '📦' }, default: p.category === 'other' }],
    }),
    row({
      type: 3, custom_id: `s:sort:${sid}`, placeholder: 'Tri',
      options: Object.entries(SORTS).map(([k, v]) => ({
        label: v.label, value: k, emoji: { name: v.emoji },
        default: (p.sort || (p.latest ? 'recent' : 'popular')) === k,
      })),
    }),
    row(
      emojiBtn('📸', p.withQc ? 'Tous les items' : 'Seulement avec QC', `s:qc:${sid}`, p.withQc ? Style.PRIMARY : Style.SECONDARY),
      emojiBtn(p.includePosted ? '🙈' : '👁️', p.includePosted ? 'Masquer les déjà postés' : 'Inclure les déjà postés', `s:posted:${sid}`),
      emojiBtn('💶', 'Prix', `s:edit:${sid}`),
      emojiBtn('✅', 'Voir les résultats', `s:pg:${sid}:0`, Style.PRIMARY),
    ),
  ])];
}

export async function confirmAllView(env, sid, page) {
  const s = await loadSearch(env, sid);
  if (!s) return expiredView();
  const total = (await idsToPost(env, sid, s.params, await getRate(env))).length;
  return [container([
    text(`## 📤 Tout poster ?\n**${fmtInt(total)}** items vont partir dans <#${s.channelId}>${s.channelType === 15 ? ' (1 post de forum par item)' : ''}, environ ${QUEUE_PER_MINUTE} par minute (~${Math.ceil(total / QUEUE_PER_MINUTE)} min).`),
    text('-# Ils partent un par un pour ne pas spammer le salon. Tu peux suivre l\'avancement depuis le menu.'),
    sep(),
    row(
      emojiBtn('✅', 'Confirmer', `s:ok:${sid}:${page}`, Style.SUCCESS),
      emojiBtn('↩️', 'Annuler', `s:pg:${sid}:${page}`),
    ),
  ])];
}

export function expiredView() {
  return [container([
    text('## ⌛ Recherche expirée\n-# Les recherches sont gardées 24 h. Relance-en une depuis le menu.'),
    row(backHome()),
  ])];
}

// ---------------------------------------------------------------- Catalogues

export async function catalogsView(env, page = 0, msg) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(item_count), 0) AS items FROM shops').first());
  const pages = Math.max(1, Math.ceil(total.n / SHOPS_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const { results } = await env.DB.prepare('SELECT * FROM shops ORDER BY added_at LIMIT ? OFFSET ?')
    .bind(SHOPS_PER_PAGE, page * SHOPS_PER_PAGE).all();

  const cards = results.map((s) => {
    const state = s.status === 'error'
      ? `erreur : ${escape((s.last_error || '').slice(0, 60))}`
      : s.status === 'pending' ? 'en attente d\'indexation'
        : s.status === 'indexing' ? 'indexation en cours…'
          : `indexé ${ago(s.last_indexed)}`;
    return section(
      `${STATUS_ICON[s.status] || '•'} **${escape(s.name || 'Boutique')}**${TIER_BADGE[s.tier] || ''}\n-# ${fmtInt(s.item_count)} items  ·  ${state}`,
      btn('Gérer', `cat:shop:${s.id}`),
    );
  });

  return [container([
    notice(msg),
    text(`## 📚 Catalogues\n-# ${fmtInt(total.n)} boutique${total.n > 1 ? 's' : ''}  ·  ${fmtInt(total.items)} items  ·  réindexées automatiquement chaque jour`),
    sep(),
    ...(cards.length ? cards : [text('Aucune boutique pour l\'instant.\n-# Ajoute une boutique Weidian : tous ses items seront indexés automatiquement.')]),
    sep(),
    row(
      emojiBtn('➕', 'Ajouter des liens', 'cat:add', Style.PRIMARY),
      emojiBtn('📡', 'Sources auto', 'src'),
      pages > 1 ? emojiBtn('◀️', null, `cat:list:${page - 1}`, Style.SECONDARY, { disabled: page === 0 }) : null,
      pages > 1 ? emojiBtn('▶️', null, `cat:list:${page + 1}`, Style.SECONDARY, { disabled: page >= pages - 1 }) : null,
      backHome(),
    ),
  ])];
}

export function addShopModal() {
  return modal('m:shop', '➕ Ajouter des boutiques', [
    {
      id: 'links', label: 'Liens Weidian (autant que tu veux)', required: true, long: true, max: 4000,
      description: 'Boutiques ou items, même des liens d\'agents. Le bot retrouve les boutiques tout seul.',
      placeholder: 'https://weidian.com/?userid=1784277725\nhttps://weidian.com/item.html?itemID=7863670229\nhttps://www.kakobuy.com/item/details?url=…',
    },
  ]);
}

// ---------------------------------------------------------------- Sources Discord

export async function sourcesView(env, it, msg) {
  const { results } = await env.DB.prepare('SELECT * FROM sources WHERE guild_id = ? ORDER BY added_at').bind(it.guild_id).all();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM link_queue').first();
  const cards = results.slice(0, 8).map((s) => section(
    `<#${s.channel_id}>\n-# ${fmtInt(s.messages)} messages lus  ·  ${fmtInt(s.links)} liens trouvés  ·  scanné ${ago(s.scanned_at)}` +
      (s.error ? `\n-# ⚠️ ${escape(s.error.slice(0, 120))}` : ''),
    btn('Retirer', `src:del:${s.channel_id}`, Style.DANGER),
  ));
  return [container([
    notice(msg),
    text('## 📡 Sources automatiques\n-# Choisis des salons où des gens postent des finds. Toutes les 5 min, le bot lit les nouveaux messages, retrouve les boutiques Weidian des liens et les ajoute à tes catalogues.'),
    sep(),
    ...(cards.length ? cards : [text('Aucun salon surveillé.\n-# À l\'ajout, le bot lit aussi les 500 derniers messages du salon.')]),
    pending.n ? text(`-# 🔍 ${fmtInt(pending.n)} liens d'items en cours d'analyse`) : null,
    sep(),
    row({ type: 8, custom_id: 'src:add', placeholder: '➕ Surveiller un salon…', channel_types: [0, 5], min_values: 1, max_values: 5 }),
    row(
      emojiBtn('🔄', 'Scanner maintenant', 'src:scan', Style.SECONDARY, { disabled: !results.length }),
      emojiBtn('↩️', 'Catalogues', 'cat:list:0'),
      backHome(),
    ),
    text('-# Le bot doit pouvoir **voir le salon** et **lire l\'historique**. L\'intent « Message Content » doit être activé dans le portail Discord.'),
  ])];
}

export async function shopView(env, shopId, msg) {
  const s = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(shopId).first();
  if (!s) return catalogsView(env, 0, '❌ Boutique introuvable.');
  const sample = await env.DB.prepare('SELECT image FROM items WHERE shop_id = ? AND image IS NOT NULL ORDER BY first_seen DESC LIMIT 1').bind(shopId).first();
  const posted = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE shop_id = ? AND posted_count > 0').bind(shopId).first();
  const info = `## ${STATUS_ICON[s.status] || '•'} ${escape(s.name || 'Boutique')}\n` +
    `**${fmtInt(s.item_count)}** items  ·  ${fmtInt(posted.n)} déjà postés\n` +
    `-# Indexée ${ago(s.last_indexed)}  ·  ID ${s.id}  ·  [ouvrir sur Weidian](${s.url})` +
    (s.status === 'error' && s.last_error ? `\n-# ⚠️ ${escape(s.last_error.slice(0, 150))}` : '');
  return [container([
    notice(msg),
    sample ? section(info, thumb(sample.image)) : text(info),
    sep(),
    row(
      emojiBtn('🔎', 'Voir ses items', `cat:items:${s.id}`, Style.PRIMARY, { disabled: !s.item_count }),
      emojiBtn('🔥', 'Ses meilleurs', `cat:best:${s.id}`, Style.SECONDARY, { disabled: !s.item_count }),
      emojiBtn('🔁', 'Réindexer', `cat:reidx:${s.id}`),
    ),
    row(
      emojiBtn('🗑️', 'Retirer', `cat:del:${s.id}`, Style.DANGER),
      emojiBtn('🚫', 'Bannir (ne plus jamais l\'ajouter)', `cat:ban:${s.id}`, Style.DANGER),
    ),
    row(emojiBtn('↩️', 'Catalogues', 'cat:list:0'), backHome()),
  ])];
}

export async function confirmDeleteShopView(env, shopId) {
  const s = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(shopId).first();
  if (!s) return catalogsView(env, 0, '❌ Boutique introuvable.');
  return [container([
    text(`## 🗑️ Retirer ${escape(s.name || 'cette boutique')} ?\nSes **${fmtInt(s.item_count)}** items indexés seront supprimés. Les messages déjà postés restent.`),
    sep(),
    row(
      emojiBtn('🗑️', 'Retirer', `cat:delok:${s.id}`, Style.DANGER),
      emojiBtn('↩️', 'Annuler', `cat:shop:${s.id}`),
    ),
  ], 0xed4245)];
}

// ---------------------------------------------------------------- Agents

export async function agentsView(env, msg, canEdit = true) {
  const [agents, signup] = await Promise.all([getAgents(env), getSignup(env)]);
  const cards = agents.map((a, i) => section(
    `**${i + 1}. ${escape(a.name)}**\n-# ` + (a.code
      ? `Code : \`${escape(a.code)}\`  ·  [tester le lien](${buildAgentLink(a.template, EXAMPLE_ITEM)})`
      : escape(buildAgentLink(a.template, EXAMPLE_ITEM).slice(0, 180))),
    btn('Retirer', `ag:del:${encodeURIComponent(a.name)}`, Style.DANGER, { disabled: !canEdit }),
  ));
  const options = [
    ...Object.entries(AGENT_PRESETS).map(([key, p]) => ({
      label: p.name, value: key, emoji: { name: '🛒' },
      description: agents.some((a) => a.preset === key) ? 'Changer ton code' : 'Juste ton code d\'affiliation',
    })),
    { label: 'Autre agent', value: 'custom', emoji: { name: '🔗' }, description: 'Avec un lien complet' },
  ];
  return [container([
    notice(msg),
    text('## 🏷️ Agents\n-# Chaque agent devient un bouton « Acheter sur … » sous les items postés, avec ton code d\'affiliation.'),
    sep(),
    ...(cards.length ? cards : [text('Aucun agent configuré.\n-# Choisis ton agent ci-dessous et colle ton code : le bot fait les liens tout seul.')]),
    canEdit ? null : text('-# 🔒 Seul le propriétaire du bot peut modifier les agents.'),
    sep(),
    row({
      type: 3, custom_id: 'ag:pick', placeholder: '➕ Ajouter ou modifier un agent…', options,
      disabled: !canEdit || agents.length >= 20,
    }),
    sep(),
    text('### ✍️ Bouton d\'inscription\n-# Un bouton sous chaque item pour créer un compte chez ton agent (avec ton lien de parrainage).' +
      (signup ? `\nLien : ${escape(signup.url.slice(0, 120))}${signup.message ? `\nMessage : ${escape(signup.message.slice(0, 120))}` : ''}\n-# Aperçu :` : '\n-# Pas encore configuré.')),
    signup ? row(signupButton({ signup }, null, null)) : null,
    row(
      emojiBtn('✏️', signup ? 'Modifier lien et texte' : 'Configurer', 'ag:su', Style.PRIMARY, { disabled: !canEdit }),
      signup ? emojiBtn('🗑️', 'Retirer', 'ag:sudel', Style.DANGER, { disabled: !canEdit }) : null,
    ),
    signup ? row({
      type: 3, custom_id: 'ag:sucol', placeholder: '🎨 Couleur du bouton', disabled: !canEdit,
      options: Object.entries(SIGNUP_COLORS).map(([key, c]) => ({
        label: c.label, value: key, emoji: { name: c.emoji }, default: key === signup.color,
      })),
    }) : null,
    row(backHome()),
  ])];
}

export function signupModal(current) {
  const s = current || {};
  return modal('m:signup:', '✍️ Bouton d\'inscription', [
    {
      id: 'url', label: 'Lien d\'inscription', required: true, max: 400, value: s.url,
      description: 'Ton lien de parrainage pour créer un compte.', placeholder: 'https://www.bbdbuy.com/register?inviteCode=TONCODE',
    },
    { id: 'label', label: 'Texte du bouton', required: true, max: 60, value: s.label || 'S\'inscrire sur BBDBuy', placeholder: 'S\'inscrire et gagner un coupon' },
    { id: 'emoji', label: 'Emoji (optionnel)', max: 8, value: s.emoji || '✍️', placeholder: '🎁', description: 'Un seul emoji, ou vide.' },
    {
      id: 'message', label: 'Message (optionnel)', long: true, max: 400, value: s.message,
      description: 'Affiché avec le lien quand le bouton est en couleur.', placeholder: '🎁 Coupons offerts à l\'inscription !',
    },
  ]);
}

// Agent préréglé : juste le code.
export function presetModal(key, current) {
  const p = AGENT_PRESETS[key];
  return modal(`m:agent:${key}`, `🛒 ${p.name}`, [
    {
      id: 'code', label: `Ton code d'affiliation ${p.name}`, required: true, max: 64, value: current && current.code,
      description: 'Juste le code, pas le lien. Le bot fabrique les liens tout seul.', placeholder: 'ex : wBxYkx123',
    },
    { id: 'position', label: 'Position du bouton (optionnel)', description: '1 = premier bouton', placeholder: '1', max: 2, value: current && current.position },
  ]);
}

export function agentModal() {
  return modal('m:agent:custom', '🔗 Autre agent', [
    { id: 'name', label: 'Nom', description: 'Affiché sur le bouton. Même nom = modifier.', placeholder: 'BBDBuy', required: true, max: 40 },
    {
      id: 'template', label: 'Lien d\'affiliation', required: true, long: true, max: 500,
      description: 'Mets {url} à la place du lien du produit (ou {id} pour son numéro).',
      placeholder: 'https://agent.com/product?url={url}&inviteCode=TONCODE',
    },
    { id: 'position', label: 'Position (optionnel)', description: '1 = premier bouton', placeholder: '1', max: 2 },
  ]);
}

// ---------------------------------------------------------------- Item manuel

export function itemModal() {
  return modal('m:item', '➕ Ajouter un item', [
    { id: 'link', label: 'Lien de l\'item', description: 'Weidian (rempli tout seul), Taobao ou 1688.', placeholder: 'https://weidian.com/item.html?itemID=…', required: true, max: 400 },
    { id: 'title', label: 'Titre', description: 'Obligatoire pour Taobao et 1688.', placeholder: 'Ralph Lauren knit sweater', max: 150 },
    { id: 'price', label: 'Prix en ¥', description: 'Obligatoire pour Taobao et 1688.', placeholder: '199', max: 10 },
    { id: 'image', label: 'Lien de l\'image (optionnel)', placeholder: 'https://…jpg', max: 500 },
  ]);
}

// ---------------------------------------------------------------- Accès

export async function accessView(env, it, msg) {
  const { results } = await env.DB.prepare('SELECT user_id FROM admins WHERE guild_id = ?').bind(it.guild_id).all();
  const canEdit = hasAdminPermission(it);
  const list = results.length ? results.map((r) => `<@${r.user_id}>`).join('  ') : '-# Personne pour l\'instant.';
  return [container([
    notice(msg),
    text('## 👥 Accès\n-# Le propriétaire et les membres avec la permission **Administrateur** ont toujours accès.'),
    sep(),
    text(`**Membres ajoutés**\n${list}`),
    canEdit ? null : text('-# 🔒 Seuls les administrateurs du serveur peuvent modifier cette liste.'),
    row({ type: 5, custom_id: 'acc:add', placeholder: '➕ Donner l\'accès à…', min_values: 1, max_values: 10, disabled: !canEdit }),
    row({ type: 5, custom_id: 'acc:rm', placeholder: '➖ Retirer l\'accès à…', min_values: 1, max_values: 10, disabled: !canEdit || !results.length }),
    row(backHome()),
  ])];
}

export function hasAdminPermission(it) {
  return !!it.member && (BigInt(it.member.permissions || '0') & (1n << 3n)) === (1n << 3n);
}

// ---------------------------------------------------------------- Divers

export function deniedView() {
  return [container([
    text('## 🔒 Accès réservé\n-# Ce panneau est réservé aux administrateurs du serveur et aux membres qu\'ils ont ajoutés.'),
  ], 0xed4245)];
}

export function errorView(message) {
  return [container([
    text(`## ❌ Oups\n${escape(String(message).slice(0, 400))}`),
    row(backHome()),
  ], 0xed4245)];
}
