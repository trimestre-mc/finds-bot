// Écrans du panneau /menu. Chaque vue renvoie la liste de composants du message.

import {
  Style, container, section, text, sep, row, thumb, btn, emojiBtn, modal,
  escape, fmtInt, ago,
} from './components.js';
import { getRate, getAgents, formatPrice, itemTitle } from './post.js';
import { buildAgentLink } from './links.js';
import { countResults, pageResults, PAGE_SIZE, MAX_BULK } from './search.js';

export const QUEUE_PER_MINUTE = 8;
const SHOPS_PER_PAGE = 6;
const STATUS_ICON = { pending: '🕒', indexing: '⏳', ok: '🟢', error: '🔴' };
const EXAMPLE_ITEM = { url: 'https://weidian.com/item.html?itemID=7863670229', item_id: '7863670229', platform: 'weidian' };

const notice = (msg) => (msg ? text(`> ${msg}`) : null);
const backHome = () => emojiBtn('🏠', 'Menu', 'home');

// ---------------------------------------------------------------- Accueil

export async function homeView(env, it, msg) {
  const [items, shops, agents, pending, queue] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM items').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM shops').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE title_en IS NULL AND translate_failed < 3').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first(),
  ]);
  const rate = await getRate(env);

  const tips = [];
  if (!shops.n) tips.push('👉 Commence par ajouter une boutique Weidian dans **Catalogues**.');
  if (!agents.n) tips.push('👉 Ajoute ton lien d\'affiliation dans **Agents** pour que les boutons « Acheter » apparaissent.');

  const sub = [];
  if (pending.n) sub.push(`🌐 ${fmtInt(pending.n)} titres en cours de traduction`);
  if (queue.n) sub.push(`📨 ${fmtInt(queue.n)} posts en file (~${Math.ceil(queue.n / QUEUE_PER_MINUTE)} min)`);
  sub.push(`💱 1 € = ${(1 / rate).toFixed(2).replace('.', ',')} ¥`);

  return [container([
    notice(msg),
    text('# 🛍️ Finds\n-# Ton catalogue de finds, prêt à poster en un clic.'),
    sep(),
    text(`**${fmtInt(items.n)}** items  ·  **${fmtInt(shops.n)}** catalogue${shops.n > 1 ? 's' : ''}  ·  **${fmtInt(agents.n)}** agent${agents.n > 1 ? 's' : ''}\n-# ${sub.join('  ·  ')}`),
    tips.length ? text(tips.join('\n')) : null,
    sep(),
    row(
      emojiBtn('🔎', 'Rechercher', 'search:new', Style.PRIMARY),
      emojiBtn('✨', 'Nouveautés', 'search:latest'),
    ),
    row(
      emojiBtn('📚', 'Catalogues', 'cat:list:0'),
      emojiBtn('🏷️', 'Agents', 'ag:list'),
      emojiBtn('➕', 'Ajouter un item', 'item:add'),
    ),
    row(
      emojiBtn('👥', 'Accès', 'acc'),
      emojiBtn('🔄', null, 'home'),
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
  return row ? { params: JSON.parse(row.params), channelId: row.channel_id } : null;
}

export async function createSearch(env, it, params) {
  const sid = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const uid = (it.member && it.member.user.id) || (it.user && it.user.id);
  await env.DB.prepare('INSERT INTO searches (id, guild_id, user_id, params, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(sid, it.guild_id, uid, JSON.stringify(params), it.channel_id, Date.now()).run();
  return sid;
}

export async function resultsView(env, sid, page, msg) {
  const s = await loadSearch(env, sid);
  if (!s) return expiredView();
  const { params, channelId } = s;
  const rate = await getRate(env);
  const total = await countResults(env, params, rate);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const items = total ? await pageResults(env, params, rate, page) : [];

  const filters = [];
  if (params.shopName) filters.push(`🏪 ${escape(params.shopName)}`);
  if (params.min != null) filters.push(`≥ ${params.min} €`);
  if (params.max != null) filters.push(`≤ ${params.max} €`);
  filters.push(params.includePosted ? 'déjà postés inclus' : 'non postés');
  const title = params.q ? `« ${escape(params.q)} »` : params.latest ? 'Nouveautés' : 'Tous les items';

  const head = [
    notice(msg),
    text(`## 🔎 ${title}\n-# ${fmtInt(total)} résultat${total > 1 ? 's' : ''}  ·  ${filters.join('  ·  ')}${total ? `  ·  page ${page + 1}/${pages}` : ''}`),
    sep(),
  ];

  if (!total) {
    return [container([
      ...head,
      text('Aucun item trouvé.\n-# Essaie d\'autres mots (l\'anglais marche le mieux), élargis les prix, ou ajoute des catalogues.'),
      sep(),
      row(
        emojiBtn('✏️', 'Modifier la recherche', `s:edit:${sid}`, Style.PRIMARY),
        emojiBtn(params.includePosted ? '🙈' : '👁️', params.includePosted ? 'Masquer postés' : 'Inclure postés', `s:posted:${sid}`),
        backHome(),
      ),
    ])];
  }

  const cards = items.map((item, i) => {
    const line = `**${page * PAGE_SIZE + i + 1}. [${escape(itemTitle(item).slice(0, 90))}](${item.url})**\n` +
      `${formatPrice(item.price_cny, rate)}  ·  🏪 ${escape((item.shop_name || '—').slice(0, 40))}` +
      (item.posted_count ? '  ·  ✅ posté' : '');
    return item.image ? section(line, thumb(item.image)) : text(line);
  });

  return [container([
    ...head,
    ...cards,
    sep(),
    row({
      type: 8,
      custom_id: `s:ch:${sid}:${page}`,
      placeholder: 'Salon où poster',
      channel_types: [0, 5],
      default_values: [{ id: channelId, type: 'channel' }],
    }),
    row({
      type: 3,
      custom_id: `s:sel:${sid}:${page}`,
      placeholder: '📤 Choisis les items à poster…',
      min_values: 1,
      max_values: items.length,
      options: items.map((item, i) => ({
        label: `${page * PAGE_SIZE + i + 1}. ${itemTitle(item)}`.slice(0, 100),
        description: formatPrice(item.price_cny, rate).slice(0, 100),
        value: item.id,
      })),
    }),
    row(
      emojiBtn('◀️', null, `s:pg:${sid}:${page - 1}`, Style.SECONDARY, { disabled: page === 0 }),
      emojiBtn('▶️', null, `s:pg:${sid}:${page + 1}`, Style.SECONDARY, { disabled: page >= pages - 1 }),
      emojiBtn('📤', `Tout poster (${fmtInt(Math.min(total, MAX_BULK))})`, `s:all:${sid}:${page}`, Style.SUCCESS),
      emojiBtn('✏️', null, `s:edit:${sid}`),
      emojiBtn(params.includePosted ? '🙈' : '👁️', null, `s:posted:${sid}`),
    ),
    row(backHome()),
  ])];
}

export async function confirmAllView(env, sid, page) {
  const s = await loadSearch(env, sid);
  if (!s) return expiredView();
  const total = Math.min(await countResults(env, s.params, await getRate(env)), MAX_BULK);
  return [container([
    text(`## 📤 Tout poster ?\n**${fmtInt(total)}** items vont partir dans <#${s.channelId}>, environ ${QUEUE_PER_MINUTE} par minute (~${Math.ceil(total / QUEUE_PER_MINUTE)} min).`),
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
      `${STATUS_ICON[s.status] || '•'} **${escape(s.name || 'Boutique')}**\n-# ${fmtInt(s.item_count)} items  ·  ${state}`,
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
      emojiBtn('➕', 'Ajouter une boutique', 'cat:add', Style.PRIMARY),
      pages > 1 ? emojiBtn('◀️', null, `cat:list:${page - 1}`, Style.SECONDARY, { disabled: page === 0 }) : null,
      pages > 1 ? emojiBtn('▶️', null, `cat:list:${page + 1}`, Style.SECONDARY, { disabled: page >= pages - 1 }) : null,
      backHome(),
    ),
  ])];
}

export function addShopModal() {
  return modal('m:shop', '➕ Ajouter une boutique', [
    {
      id: 'link', label: 'Lien de la boutique Weidian', required: true,
      description: 'Le lien de la boutique, ou le lien de n\'importe quel item de cette boutique.',
      placeholder: 'https://weidian.com/?userid=1784277725', max: 300,
    },
  ]);
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
      emojiBtn('🔁', 'Réindexer', `cat:reidx:${s.id}`),
      emojiBtn('🗑️', 'Retirer', `cat:del:${s.id}`, Style.DANGER),
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

export async function agentsView(env, msg) {
  const agents = await getAgents(env);
  const cards = agents.map((a, i) => section(
    `**${i + 1}. ${escape(a.name)}**\n-# ${escape(buildAgentLink(a.template, EXAMPLE_ITEM).slice(0, 180))}`,
    btn('Retirer', `ag:del:${encodeURIComponent(a.name)}`, Style.DANGER),
  ));
  return [container([
    notice(msg),
    text('## 🏷️ Agents\n-# Chaque agent devient un bouton « Acheter sur … » sous les items postés, avec ton code d\'affiliation.'),
    sep(),
    ...(cards.length ? cards : [text('Aucun agent configuré.\n-# Ajoute ton lien BBDBuy (ou un autre) pour gagner tes commissions.')]),
    sep(),
    row(
      emojiBtn('➕', 'Ajouter / modifier', 'ag:add', Style.PRIMARY, { disabled: agents.length >= 20 }),
      backHome(),
    ),
  ])];
}

export function agentModal() {
  return modal('m:agent', '🏷️ Ajouter un agent', [
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
