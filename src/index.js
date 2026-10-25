// Bot Discord "finds" : Worker Cloudflare (interactions HTTP + cron + API indexeur).
// Une seule commande, /menu, ouvre un panneau ; tout le reste passe par boutons, menus et formulaires.

import { InteractionType, Reply, EPHEMERAL, verifyRequest, discordApi, editOriginal, json, reply } from './discord.js';
import { COMMANDS } from './commands.js';
import { COMPONENTS_V2, modalValues, escape, fmtInt } from './components.js';
import { parseWeidianShop, parseItemLink, isValidTemplate, buildAgentLink } from './links.js';
import { prepareQuery, allResultIds } from './search.js';
import { getRate, refreshRate, formatPrice, getAgents, postItem, processQueue } from './post.js';
import { translatePending } from './translate.js';
import {
  QUEUE_PER_MINUTE, homeView, searchModal, loadSearch, createSearch, resultsView, confirmAllView,
  catalogsView, addShopModal, shopView, confirmDeleteShopView, agentsView, agentModal, itemModal,
  accessView, hasAdminPermission, deniedView, errorView,
} from './ui.js';

const REINDEX_HOURS = 24;
const TRANSLATE_PER_MINUTE = 10;
const MODAL_SUBMIT = 5;
const MODAL = 9;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/interactions') return await handleInteraction(request, env, ctx);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (url.pathname === '/') return new Response('finds-bot en ligne');
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.log('erreur', err && err.stack ? err.stack : String(err));
      return json({ error: 'internal' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await processQueue(env, QUEUE_PER_MINUTE).catch((e) => console.log('file', String(e)));
      await translatePending(env, TRANSLATE_PER_MINUTE).catch((e) => console.log('traduction', String(e)));
      await refreshRate(env).catch((e) => console.log('taux', String(e)));
      await env.DB.prepare('DELETE FROM searches WHERE created_at < ?').bind(Date.now() - 24 * 3600 * 1000).run();
    })());
  },
};

// ---------------------------------------------------------------- Réponses

const panel = (components) => json({
  type: Reply.MESSAGE,
  data: { flags: EPHEMERAL | COMPONENTS_V2, components, allowed_mentions: { parse: [] } },
});
const update = (components) => json({
  type: Reply.UPDATE_MESSAGE,
  data: { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } },
});
const openModal = (m) => json({ type: MODAL, data: m });

// Répond tout de suite, puis remplace le panneau quand la tâche (lente) est finie.
function later(it, env, ctx, task) {
  ctx.waitUntil((async () => {
    let components;
    try {
      components = await task();
    } catch (err) {
      console.log('tâche', err && err.stack ? err.stack : String(err));
      components = errorView(err.message || err);
    }
    await editOriginal(env, it.token, { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } })
      .catch((e) => console.log('édition', String(e)));
  })());
  return json({ type: Reply.DEFERRED_UPDATE });
}

// ---------------------------------------------------------------- Interactions

async function handleInteraction(request, env, ctx) {
  const { ok, body } = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('Bad signature', { status: 401 });
  const it = JSON.parse(body);

  if (it.type === InteractionType.PING) return json({ type: Reply.PONG });
  if (!it.guild_id) return reply('Ce bot s\'utilise uniquement dans un serveur.');

  if (!(await isAdmin(env, it))) {
    return it.type === InteractionType.COMMAND ? panel(deniedView()) : update(deniedView());
  }

  if (it.type === InteractionType.COMMAND) return panel(await homeView(env, it));
  if (it.type === InteractionType.COMPONENT) return onComponent(it, env, ctx);
  if (it.type === MODAL_SUBMIT) return onModal(it, env, ctx);
  return reply('Action inconnue.');
}

function userId(it) {
  return (it.member && it.member.user && it.member.user.id) || (it.user && it.user.id);
}

async function isAdmin(env, it) {
  if (hasAdminPermission(it)) return true;
  const row = await env.DB.prepare('SELECT 1 FROM admins WHERE guild_id = ? AND user_id = ?')
    .bind(it.guild_id, userId(it)).first();
  return !!row;
}

// ---------------------------------------------------------------- Boutons et menus

async function onComponent(it, env, ctx) {
  const [a, b, c, d] = it.data.custom_id.split(':');
  const values = it.data.values || [];

  switch (`${a}:${b || ''}`) {
    case 'home:': return update(await homeView(env, it));

    case 'search:new': return openModal(searchModal());
    case 'search:latest': {
      const sid = await createSearch(env, it, { q: '', variants: [], latest: true, includePosted: false });
      return update(await resultsView(env, sid, 0));
    }

    case 'cat:list': return update(await catalogsView(env, Number(c) || 0));
    case 'cat:add': return openModal(addShopModal());
    case 'cat:shop': return update(await shopView(env, c));
    case 'cat:items': {
      const shop = await env.DB.prepare('SELECT name FROM shops WHERE id = ?').bind(c).first();
      const sid = await createSearch(env, it, { q: '', variants: [], shop: c, shopName: shop ? shop.name : c, includePosted: true });
      return update(await resultsView(env, sid, 0));
    }
    case 'cat:reidx': {
      await env.DB.prepare("UPDATE shops SET status = 'pending', last_error = NULL WHERE id = ?").bind(c).run();
      await triggerIndexer(env);
      return update(await shopView(env, c, '🔁 Réindexation demandée, elle démarre dans 30 min maximum.'));
    }
    case 'cat:del': return update(await confirmDeleteShopView(env, c));
    case 'cat:delok': {
      const shop = await env.DB.prepare('SELECT name FROM shops WHERE id = ?').bind(c).first();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM items WHERE shop_id = ? AND manual = 0').bind(c),
        env.DB.prepare('DELETE FROM shops WHERE id = ?').bind(c),
      ]);
      return update(await catalogsView(env, 0, `🗑️ **${escape(shop ? shop.name || c : c)}** a été retirée.`));
    }

    case 'ag:list': return update(await agentsView(env));
    case 'ag:add': return openModal(agentModal());
    case 'ag:del': {
      const name = decodeURIComponent(c);
      await env.DB.prepare('DELETE FROM agents WHERE name = ?').bind(name).run();
      return update(await agentsView(env, `🗑️ Agent **${escape(name)}** retiré.`));
    }

    case 'item:add': return openModal(itemModal());

    case 'acc:': return update(await accessView(env, it));
    case 'acc:add':
    case 'acc:rm': {
      if (!hasAdminPermission(it)) return update(await accessView(env, it, '🔒 Seuls les administrateurs du serveur peuvent modifier cette liste.'));
      const stmts = values.map((id) => (b === 'add'
        ? env.DB.prepare('INSERT OR IGNORE INTO admins (guild_id, user_id, added_by) VALUES (?, ?, ?)').bind(it.guild_id, id, userId(it))
        : env.DB.prepare('DELETE FROM admins WHERE guild_id = ? AND user_id = ?').bind(it.guild_id, id)));
      if (stmts.length) await env.DB.batch(stmts);
      const who = values.map((id) => `<@${id}>`).join(', ');
      return update(await accessView(env, it, b === 'add' ? `✅ Accès donné à ${who}.` : `➖ Accès retiré à ${who}.`));
    }

    case 's:pg': return update(await resultsView(env, c, Number(d) || 0));
    case 's:edit': {
      const s = await loadSearch(env, c);
      return openModal(searchModal(s ? s.params : {}, c));
    }
    case 's:posted': {
      const s = await loadSearch(env, c);
      if (s) {
        s.params.includePosted = !s.params.includePosted;
        await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(s.params), c).run();
      }
      return update(await resultsView(env, c, 0));
    }
    case 's:ch': {
      const channel = values[0];
      if (channel) await env.DB.prepare('UPDATE searches SET channel_id = ? WHERE id = ?').bind(channel, c).run();
      return update(await resultsView(env, c, Number(d) || 0, `📍 Les items seront postés dans <#${channel}>.`));
    }
    case 's:sel': return later(it, env, ctx, () => postSelected(env, c, Number(d) || 0, values));
    case 's:all': return update(await confirmAllView(env, c, Number(d) || 0));
    case 's:ok': {
      const s = await loadSearch(env, c);
      if (!s) return update(await homeView(env, it));
      const ids = await allResultIds(env, s.params, await getRate(env));
      const now = Date.now();
      for (let i = 0; i < ids.length; i += 50) {
        await env.DB.batch(ids.slice(i, i + 50).map((id) =>
          env.DB.prepare('INSERT INTO post_queue (item_id, channel_id, created_at) VALUES (?, ?, ?)').bind(id, s.channelId, now)));
      }
      const queued = await env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first();
      return update(await resultsView(env, c, Number(d) || 0,
        `📨 **${fmtInt(ids.length)}** items en route vers <#${s.channelId}>. Fin estimée dans ~${Math.ceil(queued.n / QUEUE_PER_MINUTE)} min.`));
    }
    default: return update(await homeView(env, it, '❓ Action inconnue, retour au menu.'));
  }
}

async function postSelected(env, sid, page, ids) {
  const s = await loadSearch(env, sid);
  if (!s) return resultsView(env, sid, page);
  const agents = await getAgents(env);
  const rate = await getRate(env);
  let ok = 0;
  let error = null;
  for (const id of ids) {
    const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!item) continue;
    try {
      await postItem(env, item, s.channelId, agents, rate);
      ok++;
    } catch (err) {
      error = String(err.message || err);
      if (/-> (403|404)/.test(error)) break;
    }
  }
  let msg = `✅ **${ok}** item${ok > 1 ? 's' : ''} posté${ok > 1 ? 's' : ''} dans <#${s.channelId}>.`;
  if (error) {
    msg = /-> (403|404)/.test(error)
      ? `❌ Le bot ne peut pas écrire dans <#${s.channelId}>. Donne-lui « Voir le salon » et « Envoyer des messages ».`
      : `${ok ? msg + ' ' : ''}❌ Un envoi a échoué : ${escape(error.slice(0, 120))}`;
  }
  return resultsView(env, sid, page, msg);
}

// ---------------------------------------------------------------- Formulaires

function parseNumber(v) {
  if (!v) return null;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function onModal(it, env, ctx) {
  const v = modalValues(it.data);
  const [, kind, sid] = it.data.custom_id.split(':');

  if (kind === 'search') {
    return later(it, env, ctx, async () => {
      const q = (v.q || '').slice(0, 100);
      const fields = { q, variants: await prepareQuery(env, q), min: parseNumber(v.min), max: parseNumber(v.max), latest: false };
      const existing = sid ? await loadSearch(env, sid) : null;
      if (existing) {
        const params = { ...existing.params, ...fields };
        await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(params), sid).run();
        return resultsView(env, sid, 0);
      }
      const newSid = await createSearch(env, it, { ...fields, includePosted: false });
      return resultsView(env, newSid, 0);
    });
  }

  if (kind === 'shop') {
    const link = v.link || '';
    if (/taobao\.com|tmall\.com|1688\.com/.test(link)) {
      return update(await catalogsView(env, 0, '⚠️ Taobao et 1688 demandent une connexion : impossible de les indexer automatiquement. Ajoute leurs items un par un avec **➕ Ajouter un item**.'));
    }
    const shopId = parseWeidianShop(link);
    if (shopId) return update(await catalogsView(env, 0, await addShop(env, shopId, null, userId(it))));
    const item = parseItemLink(link);
    if (!item || item.platform !== 'weidian') {
      return update(await catalogsView(env, 0, '❌ Lien non reconnu. Exemple : `https://weidian.com/?userid=1784277725` ou le lien d\'un item de la boutique.'));
    }
    return later(it, env, ctx, async () => {
      const info = await fetchWeidianItem(item.itemId);
      if (!info.shopId) return catalogsView(env, 0, '❌ Impossible de trouver la boutique de cet item.');
      return catalogsView(env, 0, await addShop(env, info.shopId, info.shopName, userId(it)));
    });
  }

  if (kind === 'agent') {
    const name = (v.name || '').replace(/:/g, '').trim().slice(0, 40);
    const template = (v.template || '').trim();
    if (!name) return update(await agentsView(env, '❌ Il faut un nom.'));
    if (!isValidTemplate(template)) {
      return update(await agentsView(env, '❌ Le lien doit commencer par `https://` et contenir `{url}` (ou `{id}`) à la place du lien produit.'));
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first();
    const position = Math.round(parseNumber(v.position) || count.n + 1);
    await env.DB.prepare(
      'INSERT INTO agents (name, template, position) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET template = excluded.template, position = excluded.position',
    ).bind(name, template, position).run();
    const example = buildAgentLink(template, { url: 'https://weidian.com/item.html?itemID=7863670229', item_id: '7863670229', platform: 'weidian' });
    return update(await agentsView(env, `✅ **${escape(name)}** enregistré. [Tester un lien généré](${example})`));
  }

  if (kind === 'item') return addItem(it, env, ctx, v);

  return update(await homeView(env, it));
}

async function addItem(it, env, ctx, v) {
  const parsed = parseItemLink(v.link || '');
  if (!parsed) return update(await homeView(env, it, '❌ Lien d\'item non reconnu (Weidian, Taobao ou 1688).'));
  const price = parseNumber(v.price);
  const image = v.image && /^https:\/\//.test(v.image) ? v.image : null;

  const save = async (f) => {
    await env.DB.prepare(
      `INSERT INTO items (id, platform, item_id, shop_id, shop_name, title_zh, title_en, price_cny, image, url, manual, first_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET title_zh = excluded.title_zh, title_en = excluded.title_en,
         price_cny = excluded.price_cny, image = excluded.image, shop_name = excluded.shop_name, manual = 1`,
    ).bind(`${parsed.platform}:${parsed.itemId}`, parsed.platform, parsed.itemId, f.shopId || null, f.shopName || null,
      f.titleZh || null, f.titleEn || null, f.price, f.image || null, parsed.url, Date.now()).run();
    return homeView(env, it, `✅ Item ajouté : **${escape(f.titleEn || f.titleZh)}** (${formatPrice(f.price, await getRate(env))}). Retrouve-le dans **✨ Nouveautés**.`);
  };

  if (parsed.platform === 'weidian') {
    return later(it, env, ctx, async () => {
      const info = await fetchWeidianItem(parsed.itemId);
      return save({
        titleZh: info.title, titleEn: v.title || null, price: price != null ? price : info.price,
        image: image || info.image, shopId: info.shopId, shopName: info.shopName,
      });
    });
  }
  if (!v.title || price == null) {
    return update(await homeView(env, it, '❌ Pour Taobao et 1688, le **titre** et le **prix** sont obligatoires.'));
  }
  return update(await save({ titleEn: v.title, price, image }));
}

// ---------------------------------------------------------------- Catalogues

async function addShop(env, shopId, name, by) {
  const existing = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(shopId).first();
  if (existing) return `ℹ️ **${escape(existing.name || shopId)}** est déjà dans tes catalogues (${fmtInt(existing.item_count)} items).`;
  await env.DB.prepare(
    "INSERT INTO shops (id, platform, name, url, status, added_by, added_at) VALUES (?, 'weidian', ?, ?, 'pending', ?, ?)",
  ).bind(shopId, name, `https://weidian.com/?userid=${shopId}`, by, Date.now()).run();
  await triggerIndexer(env);
  return `✅ Boutique ${name ? `**${escape(name)}** ` : ''}ajoutée. Ses items arrivent dans 30 min maximum, puis leurs titres sont traduits petit à petit.`;
}

// Lance l'indexeur tout de suite si un token GitHub est configuré (optionnel).
async function triggerIndexer(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/indexer.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'finds-bot',
    },
    body: JSON.stringify({ ref: 'main' }),
  }).catch((e) => console.log('dispatch', String(e)));
}

// Lit une page produit Weidian publique.
async function fetchWeidianItem(itemId) {
  const res = await fetch(`https://weidian.com/item.html?itemID=${itemId}`);
  if (!res.ok) throw new Error(`Weidian a répondu ${res.status}`);
  const html = (await res.text()).replaceAll('&#34;', '"').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  return {
    title: pick(/"item_name"\s*:\s*"([^"]+)"/),
    price: parseFloat(pick(/"price"\s*:\s*"?([0-9.]+)/)) || null,
    image: pick(/"imgs"\s*:\s*\[\s*"([^"]+)"/),
    shopName: pick(/"shopName"\s*:\s*"([^"]+)"/),
    shopId: pick(/"shop_id"\s*:\s*"?(\d+)/),
  };
}

// ---------------------------------------------------------------- API de l'indexeur

async function handleApi(request, env, url) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.INDEXER_SECRET || auth !== `Bearer ${env.INDEXER_SECRET}`) return json({ error: 'unauthorized' }, 401);
  const path = url.pathname;

  if (path === '/api/register-commands' && request.method === 'POST') {
    const data = await discordApi(env, 'PUT', `/applications/${env.DISCORD_APP_ID}/commands`, COMMANDS);
    return json({ ok: true, commands: data.map((c) => c.name) });
  }

  if (path === '/api/indexer/jobs' && request.method === 'GET') {
    const now = Date.now();
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM shops
       WHERE status = 'pending'
          OR (status IN ('ok', 'error') AND (last_indexed IS NULL OR last_indexed < ?))
          OR (status = 'indexing' AND (last_indexed IS NULL OR last_indexed < ?))
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, last_indexed LIMIT 10`,
    ).bind(now - REINDEX_HOURS * 3600 * 1000, now - 3 * 3600 * 1000).all();
    return json({ shops: results });
  }

  const body = request.method === 'POST' ? await request.json() : {};

  if (path === '/api/indexer/start') {
    const runId = crypto.randomUUID();
    await env.DB.prepare("UPDATE shops SET status = 'indexing', run_id = ?, last_indexed = ? WHERE id = ?")
      .bind(runId, Date.now(), body.shopId).run();
    return json({ runId });
  }

  if (path === '/api/indexer/items') {
    const now = Date.now();
    const shop = await env.DB.prepare('SELECT run_id FROM shops WHERE id = ?').bind(body.shopId).first();
    if (!shop || shop.run_id !== body.runId) return json({ error: 'run inconnu' }, 409);
    const stmts = (body.items || []).slice(0, 200).map((i) => env.DB.prepare(
      `INSERT INTO items (id, platform, item_id, shop_id, shop_name, title_zh, price_cny, image, url, stock, first_seen, last_seen_run)
       VALUES (?, 'weidian', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title_en = CASE WHEN items.title_zh IS excluded.title_zh THEN items.title_en ELSE NULL END,
         title_zh = excluded.title_zh, price_cny = excluded.price_cny, image = excluded.image,
         stock = excluded.stock, shop_id = excluded.shop_id, shop_name = excluded.shop_name,
         last_seen_run = excluded.last_seen_run`,
    ).bind(`weidian:${i.itemId}`, String(i.itemId), body.shopId, body.shopName || null, i.name || null,
      i.price != null ? Number(i.price) : null, i.img || null, `https://weidian.com/item.html?itemID=${i.itemId}`,
      i.stock != null ? Number(i.stock) : null, now, body.runId));
    if (stmts.length) await env.DB.batch(stmts);
    if (body.shopName) await env.DB.prepare('UPDATE shops SET name = ? WHERE id = ?').bind(body.shopName, body.shopId).run();
    return json({ ok: true, saved: stmts.length });
  }

  if (path === '/api/indexer/finish') {
    const shop = await env.DB.prepare('SELECT run_id FROM shops WHERE id = ?').bind(body.shopId).first();
    if (!shop || shop.run_id !== body.runId) return json({ error: 'run inconnu' }, 409);
    if (body.ok) {
      await env.DB.prepare('DELETE FROM items WHERE shop_id = ? AND manual = 0 AND last_seen_run IS NOT ?')
        .bind(body.shopId, body.runId).run();
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE shop_id = ?').bind(body.shopId).first();
      await env.DB.prepare("UPDATE shops SET status = 'ok', item_count = ?, last_indexed = ?, last_error = NULL WHERE id = ?")
        .bind(c.n, Date.now(), body.shopId).run();
      return json({ ok: true, items: c.n });
    }
    await env.DB.prepare("UPDATE shops SET status = 'error', last_error = ?, last_indexed = ? WHERE id = ?")
      .bind(String(body.error || 'erreur inconnue').slice(0, 300), Date.now(), body.shopId).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
