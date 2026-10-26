// Bot Discord "finds" : Worker Cloudflare (interactions HTTP + cron + API indexeur).
// Une seule commande, /menu, ouvre un panneau ; tout le reste passe par boutons, menus et formulaires.

import { InteractionType, Reply, verifyRequest, discordApi, json, reply } from './discord.js';
import { panel, update, openModal, later, userId } from './respond.js';
import { COMMANDS } from './commands.js';
import { modalValues, escape, fmtInt } from './components.js';
import {
  parseItemLink, isValidTemplate, canonicalUrl, buildAgentLink, AGENT_PRESETS, isValidCode, presetTemplate,
} from './links.js';
import { idsToPost, withoutCache, allResultIds, itemsByIds } from './search.js';
import { getRate, refreshRate, formatPrice, postItem, processQueue, postContext } from './post.js';
import {
  triggerIndexer, handleGo, handlePublicCommand, handlePublicComponent, handleFeatureComponent, handleFeatureModal,
  runSchedules, runQcChannels,
} from './features.js';
import { categorizePending, detectCategory, isDeadLink } from './categories.js';
import { fetchQcPage, runQcChecks, refreshQc, qcWindow, syncQcCatalog } from './qc.js';
import { popularItemStatements } from './items.js';
import { budget } from './budget.js';
import { withDb } from './turso.js';
import { searchByImage } from './imagesearch.js';
import { expandQuery } from './synonyms.js';
import { watchChannels } from './watch.js';
import { translatePending, rewriteTitles, titleWait } from './translate.js';
import { fetchWeidianItem } from './weidian.js';
import { extractWeidian, ingest, resolveQueue, scanSource, runDiscovery } from './discover.js';
import {
  QUEUE_PER_MINUTE, homeView, searchModal, loadSearch, createSearch, resultsView, confirmAllView,
  catalogsView, addShopModal, shopView, confirmDeleteShopView, agentsView, agentModal, presetModal, itemModal,
  accessView, hasAdminPermission, deniedView, sourcesView,
} from './ui.js';

// Une boutique est relue tous les 3 jours (quota gratuit D1 : 100 000 lignes écrites par jour).
const REINDEX_HOURS = 72;
const TRANSLATE_PER_MINUTE = 40;
const MODAL_SUBMIT = 5;

export default {
  async fetch(request, env, ctx) {
    env = withDb(env);
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/interactions') return await handleInteraction(request, env, ctx);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (request.method === 'GET' && url.pathname.startsWith('/go/')) return await handleGo(url, env, ctx);
      if (url.pathname === '/') return new Response('finds-bot en ligne');
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.log('erreur', err && err.stack ? err.stack : String(err));
      return json({ error: 'internal' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    env = withDb(env);
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil((async () => {
        await runDiscovery(env).catch((e) => console.log('découverte', String(e)));
        // Toutes les 15 min (la sélection des items à vérifier parcourt une bonne partie de la table).
        if (new Date().getUTCMinutes() % 15 === 0) await runQcChecks(env, 15).catch((e) => console.log('qc', String(e)));
      })());
      return;
    }
    if (event.cron === '*/2 * * * *' || event.cron === '1-59/2 * * * *') {
      // Salons de conversion et de recherche par image, relus toutes les 3 s : une exécution chaque minute
      // (minutes paires et impaires ; « */1 » serait fusionné avec « * * * * * » et ne se déclencherait pas).
      ctx.waitUntil(watchChannels(env).catch((e) => console.log('salons', String(e))));
      return;
    }
    if (event.cron === '*/3 * * * *') {
      // Synchro du catalogue FinderQC (items + nombre de QC), puis les salons QC de la communauté.
      ctx.waitUntil((async () => {
        if (env.TURSO_URL) await syncQcCatalog(env).catch((e) => console.log('synchro QC', String(e)));
        await runQcChannels(env).catch((e) => console.log('salons QC', String(e)));
      })());
      return;
    }
    // Chaque minute : la file d'envoi d'abord (seule dans l'exécution), sinon l'entretien (traduction, catégories, indexeur).
    ctx.waitUntil((async () => {
      await runSchedules(env).catch((e) => console.log('drops', String(e)));
      const queued = await env.DB.prepare('SELECT 1 AS n FROM post_queue LIMIT 1').first().catch(() => null);
      if (queued) {
        await processQueue(env, 45000).catch((e) => console.log('file', String(e)));
        return;
      }
      await ensureIndexes(env).catch((e) => console.log('index', String(e).slice(0, 120)));
      await Promise.all([
        translatePending(env, TRANSLATE_PER_MINUTE).catch((e) => console.log('traduction', String(e))),
        refreshRate(env).catch((e) => console.log('taux', String(e))),
        autoIndex(env).catch((e) => console.log('indexeur', String(e))),
        categorizePending(env, 400, titleWait(env)).catch((e) => console.log('catégories', String(e))),
      ]);
      await env.DB.prepare('DELETE FROM searches WHERE created_at < ?').bind(Date.now() - 24 * 3600 * 1000).run().catch(() => {});
      await env.DB.prepare('DELETE FROM search_cache WHERE at < ?').bind(Date.now() - 6 * 3600 * 1000).run().catch(() => {});
    })());
  },
};

// Index partiels (tâches de fond qui ne lisent que les items concernés). Créés par le bot dès que le quota
// d'écritures D1 le permet, puis plus rien à faire. Essai au plus toutes les 10 min.
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS items_nocat ON items(id) WHERE category IS NULL',
  'CREATE INDEX IF NOT EXISTS items_noimg ON items(item_id) WHERE images IS NULL',
  'CREATE INDEX IF NOT EXISTS items_qcdue ON items(qc_checked_at) WHERE popularity > 0 OR posted_count > 0 OR manual = 1',
  'CREATE INDEX IF NOT EXISTS items_recent ON items(first_seen DESC)',
  'CREATE TABLE IF NOT EXISTS search_cache (key TEXT PRIMARY KEY, ids TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS qc_requests (item_id TEXT PRIMARY KEY, user_id TEXT, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS image_channels (channel_id TEXT PRIMARY KEY, guild_id TEXT, last_message_id TEXT, searched INTEGER NOT NULL DEFAULT 0, added_at INTEGER)',
];
let indexesReady = false;
let indexesTriedAt = 0;

async function ensureIndexes(env) {
  if (indexesReady || Date.now() - indexesTriedAt < 600000) return;
  indexesTriedAt = Date.now();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('items_nocat', 'items_noimg', 'items_qcdue', 'items_recent', 'search_cache', 'qc_requests', 'image_channels')").first();
  if (row.n === INDEXES.length) { indexesReady = true; return; }
  for (const sql of INDEXES) await env.DB.prepare(sql).run();
  indexesReady = true;
}

// Réponses : voir respond.js.

// ---------------------------------------------------------------- Interactions

async function handleInteraction(request, env, ctx) {
  const { ok, body } = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('Bad signature', { status: 401 });
  const it = JSON.parse(body);

  if (it.type === InteractionType.PING) return json({ type: Reply.PONG });
  if (!it.guild_id) return reply('Ce bot s\'utilise uniquement dans un serveur.');

  // Commandes et boutons publics (/find, /convert) : ouverts à tous les membres.
  if (it.type === InteractionType.COMMAND && it.data.name !== 'menu') {
    return (await handlePublicCommand(it, env, ctx)) || reply('Commande inconnue.');
  }
  if (it.type === InteractionType.COMPONENT && it.data.custom_id.startsWith('pub:')) {
    return (await handlePublicComponent(it, env, ctx)) || reply('Action inconnue.');
  }

  if (!(await isAdmin(env, it))) {
    return it.type === InteractionType.COMMAND ? panel(deniedView()) : update(deniedView());
  }

  if (it.type === InteractionType.COMMAND) return panel(await homeView(env, it));
  if (it.type === InteractionType.COMPONENT) return onComponent(it, env, ctx);
  if (it.type === MODAL_SUBMIT) return onModal(it, env, ctx);
  return reply('Action inconnue.');
}

const AGENTS_LOCKED = '🔒 Seul le propriétaire du bot peut modifier les agents.';

// Les liens d'affiliation ne peuvent être changés que par AGENTS_OWNER_ID (si défini).
function canEditAgents(env, it) {
  return !env.AGENTS_OWNER_ID || userId(it) === env.AGENTS_OWNER_ID;
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
  const handled = await handleFeatureComponent(it, env, ctx, a, b, c, d, values);
  if (handled) return handled;

  switch (`${a}:${b || ''}`) {
    case 'home:': return update(await homeView(env, it));

    case 'search:new': return openModal(searchModal());
    case 'search:trending': {
      const sid = await createSearch(env, it, { q: '', variants: [], trending: true, includePosted: false });
      return update(await resultsView(env, sid, 0));
    }
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
      return update(await shopView(env, c, `🔁 Réindexation demandée, elle ${indexerDelay(env)}.`));
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

    case 'ag:list': return update(await agentsView(env, null, canEditAgents(env, it)));
    case 'ag:pick': {
      if (!canEditAgents(env, it)) return update(await agentsView(env, AGENTS_LOCKED, false));
      const key = values[0];
      if (!AGENT_PRESETS[key]) return openModal(agentModal());
      const current = await env.DB.prepare('SELECT code, position FROM agents WHERE preset = ?').bind(key).first();
      return openModal(presetModal(key, current));
    }
    case 'ag:del': {
      if (!canEditAgents(env, it)) return update(await agentsView(env, AGENTS_LOCKED, false));
      const name = decodeURIComponent(c);
      await env.DB.prepare('DELETE FROM agents WHERE name = ?').bind(name).run();
      return update(await agentsView(env, `🗑️ Agent **${escape(name)}** retiré.`, true));
    }

    case 'item:add': return openModal(itemModal());

    case 'src:': return update(await sourcesView(env, it));
    case 'src:add': return later(it, env, ctx, async () => {
      const notes = [];
      for (const ch of values.slice(0, 5)) {
        await env.DB.prepare('INSERT OR IGNORE INTO sources (channel_id, guild_id, added_by, added_at) VALUES (?, ?, ?, ?)')
          .bind(ch, it.guild_id, userId(it), Date.now()).run();
        const s = await env.DB.prepare('SELECT * FROM sources WHERE channel_id = ?').bind(ch).first();
        try {
          const r = await scanSource(env, s, 5);
          notes.push(r.noContent
            ? `⚠️ <#${ch}> : messages illisibles. Active **Message Content Intent** (portail Discord → Bot).`
            : `✅ <#${ch}> : ${fmtInt(r.messages)} messages lus, **${r.shopsAdded}** boutique(s) ajoutée(s), ${fmtInt(r.queued)} item(s) à analyser.`);
        } catch (err) {
          const msg = String(err.message || err);
          await env.DB.prepare('UPDATE sources SET error = ? WHERE channel_id = ?').bind(msg.slice(0, 200), ch).run();
          notes.push(/-> (403|404)/.test(msg)
            ? `❌ <#${ch}> : le bot n'y a pas accès. Donne-lui « Voir le salon » et « Voir les anciens messages ».`
            : `❌ <#${ch}> : ${escape(msg.slice(0, 100))}`);
        }
      }
      await resolveQueue(env, 15);
      await triggerIndexer(env);
      return sourcesView(env, it, notes.join('\n'));
    });
    case 'src:del': {
      await env.DB.prepare('DELETE FROM sources WHERE channel_id = ? AND guild_id = ?').bind(c, it.guild_id).run();
      return update(await sourcesView(env, it, `🗑️ <#${c}> n'est plus surveillé.`));
    }
    case 'src:scan': return later(it, env, ctx, async () => {
      await runDiscovery(env);
      await triggerIndexer(env);
      return sourcesView(env, it, '🔄 Scan terminé.');
    });

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
        await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(withoutCache(s.params)), c).run();
      }
      return update(await resultsView(env, c, 0));
    }
    case 's:ch': {
      const channel = values[0];
      const resolved = it.data.resolved && it.data.resolved.channels && it.data.resolved.channels[channel];
      const type = resolved && resolved.type === 15 ? 15 : 0;
      if (channel) await env.DB.prepare('UPDATE searches SET channel_id = ?, channel_type = ? WHERE id = ?').bind(channel, type, c).run();
      return update(await resultsView(env, c, Number(d) || 0, type === 15
        ? `📍 Forum <#${channel}> : chaque item aura son propre post.`
        : `📍 Les items seront postés dans <#${channel}>.`));
    }
    case 's:sel': return later(it, env, ctx, () => postSelected(env, c, Number(d) || 0, values));
    case 's:all': return update(await confirmAllView(env, c, Number(d) || 0));
    case 's:ok': {
      const s = await loadSearch(env, c);
      if (!s) return update(await homeView(env, it));
      const ids = await idsToPost(env, c, s.params, await getRate(env));
      const now = Date.now();
      for (let i = 0; i < ids.length; i += 50) {
        await env.DB.batch(ids.slice(i, i + 50).map((id) =>
          env.DB.prepare('INSERT INTO post_queue (item_id, channel_id, channel_type, created_at) VALUES (?, ?, ?, ?)').bind(id, s.channelId, s.channelType, now)));
      }
      const queued = await env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first();
      // On commence tout de suite, le cron prend le relais chaque minute.
      ctx.waitUntil(processQueue(env, 25000).catch((e) => console.log('file', String(e))));
      return update(await resultsView(env, c, Number(d) || 0,
        `📨 **${fmtInt(ids.length)}** items en route vers <#${s.channelId}>. Fin estimée dans ~${Math.ceil(queued.n / QUEUE_PER_MINUTE)} min.`));
    }
    default: return update(await homeView(env, it, '❓ Action inconnue, retour au menu.'));
  }
}

async function postSelected(env, sid, page, ids) {
  const s = await loadSearch(env, sid);
  if (!s) return resultsView(env, sid, page);
  const pctx = await postContext(env);
  let ok = 0;
  let error = null;
  for (const id of ids) {
    const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!item) continue;
    try {
      await postItem(env, item, s.channelId, pctx, true, s.channelType, true);
      ok++;
    } catch (err) {
      error = String(err.message || err);
      if (/-> (403|404)/.test(error)) break;
    }
  }
  let msg = `✅ **${ok}** item${ok > 1 ? 's' : ''} posté${ok > 1 ? 's' : ''} dans <#${s.channelId}>.`;
  if (error) {
    msg = /-> (403|404)/.test(error)
      ? `❌ Le bot ne peut pas écrire dans <#${s.channelId}>. Donne-lui « Voir le salon » et « Envoyer des messages »${s.channelType === 15 ? ' (« Créer des posts » pour un forum)' : ''}.`
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
  const handled = await handleFeatureModal(it, env, kind, it.data.custom_id.split(':').slice(2), v);
  if (handled) return handled;
  const count = () => env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first();

  if (kind === 'search') {
    return later(it, env, ctx, async () => {
      const q = (v.q || '').slice(0, 100);
      const fields = { q, groups: expandQuery(q), variants: [], autoCategory: null, min: parseNumber(v.min), max: parseNumber(v.max), latest: false, trending: false };
      const existing = sid ? await loadSearch(env, sid) : null;
      if (existing) {
        const params = withoutCache({ ...existing.params, ...fields });
        await env.DB.prepare('UPDATE searches SET params = ? WHERE id = ?').bind(JSON.stringify(params), sid).run();
        return resultsView(env, sid, 0);
      }
      const newSid = await createSearch(env, it, { ...fields, includePosted: false });
      return resultsView(env, newSid, 0);
    });
  }

  if (kind === 'shop') {
    const found = extractWeidian(v.links || '');
    if (!found.shops.size && !found.items.size) {
      return update(await catalogsView(env, 0, found.others
        ? '⚠️ Taobao et 1688 demandent une connexion : impossible de les indexer automatiquement. Ajoute leurs items un par un avec **➕ Ajouter un item**.'
        : '❌ Aucun lien Weidian trouvé. Exemple : `https://weidian.com/?userid=1784277725` ou le lien d\'un item.'));
    }
    return later(it, env, ctx, async () => {
      const res = await ingest(env, found, 'bulk', userId(it));
      const resolved = await resolveQueue(env, 30);
      const total = res.shopsAdded + resolved;
      if (total) await triggerIndexer(env);
      const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM link_queue').first()).n;
      const parts = [total
        ? `✅ **${total}** nouvelle${total > 1 ? 's' : ''} boutique${total > 1 ? 's' : ''} ajoutée${total > 1 ? 's' : ''}. L'indexation ${indexerDelay(env)}.`
        : 'ℹ️ Aucune nouvelle boutique : elles sont déjà toutes dans tes catalogues.'];
      if (left) parts.push(`🔍 ${fmtInt(left)} liens d'items encore en analyse (quelques minutes).`);
      if (found.others) parts.push(`-# ${found.others} lien(s) Taobao/1688 ignoré(s).`);
      return catalogsView(env, 0, parts.join('\n'));
    });
  }

  if (kind === 'agent' && AGENT_PRESETS[sid]) {
    if (!canEditAgents(env, it)) return update(await agentsView(env, AGENTS_LOCKED, false));
    const preset = AGENT_PRESETS[sid];
    const code = (v.code || '').trim();
    if (!isValidCode(code)) {
      return update(await agentsView(env, '❌ Colle juste ton **code** (lettres, chiffres, - ou _), pas un lien.', true));
    }
    const position = Math.round(parseNumber(v.position) || (await count()).n + 1);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM agents WHERE preset = ? AND name != ?').bind(sid, preset.name),
      env.DB.prepare(
        `INSERT INTO agents (name, template, position, preset, code) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET template = excluded.template, position = excluded.position, preset = excluded.preset, code = excluded.code`,
      ).bind(preset.name, presetTemplate(sid, code), position, sid, code),
    ]);
    return update(await agentsView(env, `✅ **${preset.name}** enregistré avec le code \`${escape(code)}\`.`, true));
  }

  if (kind === 'agent') {
    if (!canEditAgents(env, it)) return update(await agentsView(env, AGENTS_LOCKED, false));
    const name = (v.name || '').replace(/:/g, '').trim().slice(0, 40);
    const template = (v.template || '').trim();
    if (!name) return update(await agentsView(env, '❌ Il faut un nom.', true));
    if (!isValidTemplate(template)) {
      return update(await agentsView(env, '❌ Le lien doit commencer par `https://` et contenir `{url}` (ou `{id}`) à la place du lien produit.', true));
    }
    const position = Math.round(parseNumber(v.position) || (await count()).n + 1);
    await env.DB.prepare(
      `INSERT INTO agents (name, template, position) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET template = excluded.template, position = excluded.position, preset = NULL, code = NULL`,
    ).bind(name, template, position).run();
    const example = buildAgentLink(template, { url: 'https://weidian.com/item.html?itemID=7863670229', item_id: '7863670229', platform: 'weidian' });
    return update(await agentsView(env, `✅ **${escape(name)}** enregistré. [Tester un lien généré](${example})`, true));
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

function indexerDelay(env) {
  return env.GITHUB_TOKEN && env.GITHUB_REPO ? 'démarre maintenant (2-3 min)' : 'démarre au prochain passage de l\'indexeur (10 à 20 min)';
}

// Boutiques à indexer : nouvelles, à rafraîchir (24 h) ou bloquées en cours d'indexation.
async function dueShops(env, limit, shard = { n: 1, i: 0 }) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM shops
     WHERE (status = 'pending'
        OR (status IN ('ok', 'error') AND (last_indexed IS NULL OR last_indexed < ?))
        OR (status = 'indexing' AND (last_indexed IS NULL OR last_indexed < ?)))
       AND CAST(id AS INTEGER) % ? = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, last_indexed LIMIT ?`,
  ).bind(now - REINDEX_HOURS * 3600 * 1000, now - 3 * 3600 * 1000, shard.n, shard.i, limit).all();
  return results;
}

// Part du travail d'un job d'indexation (plusieurs jobs GitHub en parallèle).
function shardOf(url) {
  const n = Math.max(1, Math.min(16, Number(url.searchParams.get('shards')) || 1));
  return { n, i: Math.max(0, Number(url.searchParams.get('shard')) || 0) % n };
}

// Titre anglais fourni par Weidian (visiteurs étrangers) : gardé s'il est surtout en caractères latins.
function englishTitle(t) {
  if (!t) return null;
  const clean = String(t).replace(/\\u[0-9a-f]{4}/gi, '').replace(/\s+/g, ' ').trim();
  const cjk = (clean.match(/[\u3400-\u9fff]/g) || []).length;
  return clean.length >= 4 && cjk / clean.length < 0.15 ? clean.slice(0, 200) : null;
}

// Appelé chaque minute : le planificateur de GitHub étant peu fiable, le bot lance l'indexeur lui-même.
async function autoIndex(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_dispatch'").first();
  if (last && Date.now() - Number(last.value) < 8 * 60 * 1000) return;
  if ((await dueShops(env, 1)).length || await jadeshipDue(env)) await triggerIndexer(env);
}


// Collecte Jadeship (Best Items, Live Feed, vendeurs) : toutes les 6 heures.
async function jadeshipDue(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'jadeship_at'").first();
  return !row || Date.now() - Number(row.value) > 6 * 3600 * 1000;
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

  // Diagnostic : aperçu des titres réécrits pour une liste de titres chinois.
  if (path === '/api/titles-preview' && request.method === 'POST') {
    const { titles, model } = await request.json();
    const t = Date.now();
    try {
      return json({ titles: await rewriteTitles(env, (titles || []).slice(0, 30), model || undefined), ms: Date.now() - t });
    } catch (err) {
      return json({ error: String(err.message || err).slice(0, 300) });
    }
  }

  // Diagnostic : la fenêtre QC telle qu'un membre la verrait, pour un item du catalogue.
  if (path === '/api/qc-window' && request.method === 'GET') {
    const key = url.searchParams.get('item') || '';
    const [platform, itemId] = key.split(':');
    let item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(key).first();
    if (!item && !canonicalUrl(platform, itemId)) return json({ ok: false, error: 'item inconnu' });
    item = await refreshQc(env, item || { id: key, item_id: itemId, platform, url: canonicalUrl(platform, itemId), popularity: 0 });
    const view = await qcWindow(env, item, 0, {});
    const s = JSON.stringify(view);
    return json({
      ok: true, item: key, title: item.title_en || item.title_zh, qcCount: item.qc_count,
      galleries: (s.match(/"type":12/g) || []).length,
      photos: (s.match(/https:\/\/(img\.finderqc\.com|cdn\.repfind\.ai)[^"]+/g) || []).length,
      firstPhoto: (s.match(/https:\/\/(img\.finderqc\.com|cdn\.repfind\.ai)[^"]+/) || [null])[0],
      externalLinks: (s.match(/"url":"https:\/\/(www\.)?(uufinds|finderqc)/g) || []).length,
      text: (s.match(/"content":"[^"]{0,160}/g) || []).map((t) => t.slice(11)).join(' | ').slice(0, 600),
      platform, itemId,
    });
  }

  // Diagnostic : recherche par image d'une photo (URL), comme dans un salon de recherche par image.
  if (path === '/api/image-search' && request.method === 'GET') {
    try {
      return json({ ok: true, items: await searchByImage(url.searchParams.get('url') || '') });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) });
    }
  }

  // Diagnostic : ce que le bot voit d'un salon (accès, contenu des messages = intent Message Content).
  if (path === '/api/channel-check' && request.method === 'GET') {
    try {
      const msgs = await discordApi(env, 'GET', `/channels/${encodeURIComponent(url.searchParams.get('id') || '')}/messages?limit=5`);
      return json({ ok: true, messages: msgs.map((m) => ({ id: m.id, bot: !!(m.author && m.author.bot), text: url.searchParams.get('text') ? (m.content || '').slice(0, 300) : (m.content || '').length, attachments: (m.attachments || []).length, embeds: (m.embeds || []).length })) });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err).slice(0, 200) });
    }
  }

  // Diagnostic : résultats d'une recherche (nombre et 10 premiers titres), comme dans /find.
  if (path === '/api/search-preview' && request.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const groups = expandQuery(q);
    const ids = await allResultIds(env, { q, groups, variants: [], includePosted: true, sort: 'popular' }, { rate: 1 });
    const top = await itemsByIds(env, ids.slice(0, 10));
    return json({ q, groups, count: ids.length, top: top.map((i) => `${i.title_en || i.title_zh} · ${i.category || '?'} · 🔥${i.popularity}`) });
  }

  // Diagnostic : la source QC répond-elle au bot ? (écran Santé et dépannage)
  if (path === '/api/qc-check' && request.method === 'GET') {
    try {
      const qc = await fetchQcPage(url.searchParams.get('id') || '7779545401', 1);
      return json({ ok: true, count: qc.count, batches: qc.batches.length });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) });
    }
  }

  // Configure l'application Discord : URL des interactions + commandes.
  if (path === '/api/setup' && request.method === 'POST') {
    const app = await discordApi(env, 'PATCH', '/applications/@me', {
      interactions_endpoint_url: `${url.origin}/interactions`,
    });
    const cmds = await discordApi(env, 'PUT', `/applications/${env.DISCORD_APP_ID}/commands`, COMMANDS);
    return json({ ok: true, app: app.name, endpoint: app.interactions_endpoint_url, commands: cmds.map((c) => c.name) });
  }

  if (path === '/api/indexer/jobs' && request.method === 'GET') {
    const sh = shardOf(url);
    const missing = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE platform = 'weidian' AND images IS NULL AND CAST(item_id AS INTEGER) % ? = ?",
    ).bind(sh.n, sh.i).first();
    const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM link_queue WHERE CAST(item_id AS INTEGER) % ? = ?').bind(sh.n, sh.i).first();
    return json({
      // Budget du jour épuisé : rien à faire jusqu'à demain pour ce type de travail.
      shops: (await budget(env, 'items')).left ? await dueShops(env, 10, sh) : [],
      missingImages: (await budget(env, 'pages')).left ? missing.n : 0,
      linkQueue: (await budget(env, 'pages')).left ? links.n : 0,
      jadeship: sh.i === 0 && await jadeshipDue(env),
    });
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
    const b = await budget(env, 'items');
    if (b.left < Math.min(200, (body.items || []).length)) return json({ error: 'budget' }, 429);
    await b.use(Math.min(200, (body.items || []).length));
    const stmts = (body.items || []).slice(0, 200).map((i) => env.DB.prepare(
      `INSERT INTO items (id, platform, item_id, shop_id, shop_name, title_zh, price_cny, image, url, stock, first_seen, last_seen_run, category, hidden)
       VALUES (?, 'weidian', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         hidden = CASE WHEN items.hidden = 1 THEN 1 ELSE excluded.hidden END,
         title_en = CASE WHEN items.title_zh IS excluded.title_zh THEN items.title_en ELSE NULL END,
         prev_price = CASE WHEN excluded.price_cny < items.price_cny THEN items.price_cny
                           WHEN excluded.price_cny > items.price_cny THEN NULL ELSE items.prev_price END,
         price_changed_at = CASE WHEN excluded.price_cny != items.price_cny THEN excluded.first_seen ELSE items.price_changed_at END,
         title_zh = excluded.title_zh, price_cny = excluded.price_cny, image = excluded.image,
         stock = excluded.stock, shop_id = excluded.shop_id, shop_name = excluded.shop_name`,
    ).bind(`weidian:${i.itemId}`, String(i.itemId), body.shopId, body.shopName || null, i.name || null,
      i.price != null ? Number(i.price) : null, i.img || null, `https://weidian.com/item.html?itemID=${i.itemId}`,
      i.stock != null ? Number(i.stock) : null, now, body.runId, detectCategory(i.name), isDeadLink(i.name, i.price) ? 2 : 0));
    if (stmts.length) await env.DB.batch(stmts);
    if (body.shopName) await env.DB.prepare('UPDATE shops SET name = ? WHERE id = ?').bind(body.shopName, body.shopId).run();
    return json({ ok: true, saved: stmts.length });
  }

  // État actuel d'une boutique : l'indexeur n'envoie ensuite que les items nouveaux, modifiés ou disparus.
  if (path === '/api/indexer/shop-state' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT item_id, price_cny, title_zh FROM items WHERE shop_id = ? AND manual = 0')
      .bind(url.searchParams.get('shopId') || '').all();
    return json({ items: results.map((r) => [r.item_id, r.price_cny, r.title_zh]) });
  }

  if (path === '/api/indexer/removed') {
    const shop = await env.DB.prepare('SELECT run_id FROM shops WHERE id = ?').bind(body.shopId).first();
    if (!shop || shop.run_id !== body.runId) return json({ error: 'run inconnu' }, 409);
    const ids = (body.ids || []).filter((x) => /^\d{6,14}$/.test(String(x))).slice(0, 500);
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      await env.DB.prepare(`DELETE FROM items WHERE shop_id = ? AND manual = 0 AND item_id IN (${chunk.map(() => '?').join(',')})`)
        .bind(body.shopId, ...chunk).run();
    }
    return json({ ok: true, removed: ids.length });
  }

  // Items Weidian dont il faut trouver la boutique : l'indexeur lit leur page (boutique + photos).
  if (path === '/api/indexer/link-queue' && request.method === 'GET') {
    const sh = shardOf(url);
    const { results } = await env.DB.prepare('SELECT item_id FROM link_queue WHERE CAST(item_id AS INTEGER) % ? = ? ORDER BY added_at LIMIT ?')
      .bind(sh.n, sh.i, Math.min(Number(url.searchParams.get('limit')) || 500, 2000)).all();
    return json({ items: results.map((r) => r.item_id) });
  }

  if ((path === '/api/indexer/images' || path === '/api/indexer/resolved') && (body.items || []).length) {
    const b = await budget(env, 'pages');
    if (!b.left) return json({ error: 'budget' }, 429);
    await b.use(Math.min(300, body.items.length));
  }

  if (path === '/api/indexer/resolved') {
    // Tout en un seul lot : avec Turso, chaque requête à la base compte dans les 50 requêtes externes autorisées.
    const stmts = [];
    const shopInserts = [];
    for (const r of (body.items || []).slice(0, 300)) {
      const id = String(r.itemId);
      if (r.shopId && /^\d{5,12}$/.test(String(r.shopId))) {
        const shopId = String(r.shopId);
        shopInserts.push(stmts.length);
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO shops (id, platform, name, url, status, source, added_by, added_at)
           SELECT ?, 'weidian', ?, ?, 'pending', COALESCE((SELECT source FROM link_queue WHERE item_id = ?), 'jadeship'), NULL, ?
           WHERE NOT EXISTS (SELECT 1 FROM blacklist WHERE shop_id = ?)`,
        ).bind(shopId, r.shopName || null, `https://weidian.com/?userid=${shopId}`, id, Date.now(), shopId));
        stmts.push(env.DB.prepare(
          `UPDATE items SET shop_id = ?, shop_name = COALESCE(shop_name, ?), images = COALESCE(images, ?), title_en = COALESCE(title_en, ?),
             category = CASE WHEN category = 'other' AND title_en IS NULL THEN NULL ELSE category END WHERE id = ?`,
        ).bind(shopId, r.shopName || null, JSON.stringify((r.images || []).slice(0, 8)), englishTitle(r.title), `weidian:${id}`));
      }
      stmts.push(env.DB.prepare('DELETE FROM link_queue WHERE item_id = ?').bind(id));
    }
    const res = stmts.length ? await env.DB.batch(stmts) : [];
    const added = shopInserts.reduce((n, i) => n + ((res[i] && res[i].meta.changes) > 0 ? 1 : 0), 0);
    return json({ ok: true, shopsAdded: added });
  }

  // Items et vendeurs collectés sur Jadeship par l'indexeur.
  if (path === '/api/indexer/jadeship') {
    const now = Date.now();
    const { stmts, count } = popularItemStatements(env, body.items || [], 'jadeship');
    for (const s of (body.shops || []).slice(0, 300)) {
      if (!/^\d{5,12}$/.test(String(s.id))) continue;
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO shops (id, platform, name, url, status, source, tier, added_at)
         SELECT ?, 'weidian', ?, ?, 'pending', 'jadeship', ?, ? WHERE NOT EXISTS (SELECT 1 FROM blacklist WHERE shop_id = ?)`,
      ).bind(String(s.id), s.name || null, `https://weidian.com/?userid=${s.id}`, s.tier || null, now, String(s.id)));
      if (s.tier) stmts.push(env.DB.prepare('UPDATE shops SET tier = ? WHERE id = ?').bind(s.tier, String(s.id)));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    if (body.done) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('jadeship_at', ?)").bind(String(now)).run();
    return json({ ok: true, items: count });
  }

  if (path === '/api/indexer/missing-images' && request.method === 'GET') {
    const sh = shardOf(url);
    const { results } = await env.DB.prepare(
      `SELECT item_id FROM items WHERE platform = 'weidian' AND images IS NULL AND CAST(item_id AS INTEGER) % ? = ?
       ORDER BY popularity DESC, first_seen DESC LIMIT ?`,
    ).bind(sh.n, sh.i, Math.min(Number(url.searchParams.get('limit')) || 500, 8000)).all();
    return json({ items: results.map((r) => r.item_id) });
  }

  if (path === '/api/indexer/images') {
    const stmts = (body.items || []).slice(0, 300).map((i) => env.DB.prepare(
      `UPDATE items SET images = ?, title_en = COALESCE(title_en, ?),
         category = CASE WHEN category = 'other' AND title_en IS NULL THEN NULL ELSE category END WHERE id = ?`,
    ).bind(JSON.stringify((i.images || []).filter((u) => /^https:\/\//.test(u)).slice(0, 8)), englishTitle(i.title), `weidian:${i.itemId}`));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: stmts.length });
  }

  if (path === '/api/indexer/finish') {
    const shop = await env.DB.prepare('SELECT run_id FROM shops WHERE id = ?').bind(body.shopId).first();
    if (!shop || shop.run_id !== body.runId) return json({ error: 'run inconnu' }, 409);
    if (body.budget) {
      // Interrompue par le budget du jour : la boutique sera reprise demain.
      await env.DB.prepare("UPDATE shops SET status = 'pending' WHERE id = ?").bind(body.shopId).run();
      return json({ ok: true });
    }
    if (body.ok) {
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
