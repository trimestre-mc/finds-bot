// Bot Discord "finds" : Worker Cloudflare (interactions HTTP + cron + API indexeur).

import {
  InteractionType, Reply, EPHEMERAL, ADMINISTRATOR,
  verifyRequest, discordApi, followup, editOriginal, json, reply,
} from './discord.js';
import { COMMANDS } from './commands.js';
import { parseWeidianShop, parseItemLink, isValidTemplate } from './links.js';
import { prepareQuery, countResults, pageResults, allResultIds, PAGE_SIZE, MAX_BULK } from './search.js';
import {
  getRate, refreshRate, formatPrice, itemTitle, getAgents, postItem, processQueue,
} from './post.js';
import { translatePending } from './translate.js';

const REINDEX_HOURS = 24;
const QUEUE_PER_MINUTE = 8;
const TRANSLATE_PER_MINUTE = 10;

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

// ---------------------------------------------------------------- Interactions

async function handleInteraction(request, env, ctx) {
  const { ok, body } = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('Bad signature', { status: 401 });
  const it = JSON.parse(body);

  if (it.type === InteractionType.PING) return json({ type: Reply.PONG });
  if (!it.guild_id) return reply('Ce bot s\'utilise uniquement dans un serveur.');

  if (it.type === InteractionType.AUTOCOMPLETE) return autocomplete(it, env);

  if (!(await isAdmin(env, it))) {
    return reply('⛔ Réservé aux administrateurs du serveur et aux membres ajoutés avec `/admin ajouter`.');
  }

  if (it.type === InteractionType.COMMAND) {
    const name = it.data.name;
    const sub = it.data.options && it.data.options[0] && it.data.options[0].type === 1 ? it.data.options[0] : null;
    const opts = optionMap(sub ? sub.options : it.data.options);
    if (name === 'catalogue') return catalogue(sub.name, opts, it, env, ctx);
    if (name === 'recherche') return recherche(opts, it, env, ctx);
    if (name === 'item') return itemAdd(opts, it, env, ctx);
    if (name === 'agent') return agent(sub.name, opts, env);
    if (name === 'admin') return admin(sub.name, opts, it, env);
    if (name === 'statut') return statut(env);
  }
  if (it.type === InteractionType.COMPONENT) return component(it, env, ctx);
  return reply('Commande inconnue.');
}

function optionMap(options) {
  const out = {};
  for (const o of options || []) out[o.name] = o.value;
  return out;
}

function userId(it) {
  return (it.member && it.member.user && it.member.user.id) || (it.user && it.user.id);
}

function hasAdminPermission(it) {
  return it.member && (BigInt(it.member.permissions || '0') & ADMINISTRATOR) === ADMINISTRATOR;
}

async function isAdmin(env, it) {
  if (hasAdminPermission(it)) return true;
  const row = await env.DB.prepare('SELECT 1 FROM admins WHERE guild_id = ? AND user_id = ?')
    .bind(it.guild_id, userId(it)).first();
  return !!row;
}

// Exécute une tâche longue après une réponse différée, et affiche l'erreur si besoin.
function deferred(it, env, ctx, task, update = false) {
  ctx.waitUntil((async () => {
    try {
      await task();
    } catch (err) {
      console.log('tâche', err && err.stack ? err.stack : String(err));
      await editOriginal(env, it.token, { content: `❌ Erreur : ${String(err.message || err).slice(0, 300)}` }).catch(() => {});
    }
  })());
  return json(update ? { type: Reply.DEFERRED_UPDATE } : { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
}

// ---------------------------------------------------------------- Autocomplétion

async function autocomplete(it, env) {
  const sub = it.data.options && it.data.options[0] && it.data.options[0].type === 1 ? it.data.options[0] : null;
  const opts = sub ? sub.options : it.data.options;
  const focused = (opts || []).find((o) => o.focused);
  const value = focused ? String(focused.value || '') : '';
  let choices = [];
  if (it.data.name === 'agent') {
    const { results } = await env.DB.prepare('SELECT name FROM agents WHERE name LIKE ? ORDER BY position LIMIT 25')
      .bind(`%${value}%`).all();
    choices = results.map((r) => ({ name: r.name, value: r.name }));
  } else {
    const { results } = await env.DB.prepare(
      'SELECT id, name, item_count FROM shops WHERE id LIKE ? OR name LIKE ? ORDER BY name LIMIT 25',
    ).bind(`%${value}%`, `%${value}%`).all();
    choices = results.map((r) => ({ name: `${r.name || 'Boutique'} (${r.id}) · ${r.item_count} items`.slice(0, 100), value: r.id }));
  }
  return json({ type: Reply.AUTOCOMPLETE, data: { choices } });
}

// ---------------------------------------------------------------- /catalogue

async function catalogue(sub, opts, it, env, ctx) {
  if (sub === 'ajouter') {
    const link = String(opts.lien);
    if (/taobao\.com|tmall\.com|1688\.com/.test(link)) {
      return reply('⚠️ Les boutiques Taobao et 1688 demandent une connexion, elles ne peuvent pas être indexées automatiquement. Ajoute leurs items avec `/item ajouter`.');
    }
    let shopId = parseWeidianShop(link);
    if (!shopId) {
      const item = parseItemLink(link);
      if (!item || item.platform !== 'weidian') {
        return reply('❌ Lien non reconnu. Exemple : `https://weidian.com/?userid=1784277725` ou le lien d\'un item de la boutique.');
      }
      return deferred(it, env, ctx, async () => {
        const info = await fetchWeidianItem(item.itemId);
        if (!info.shopId) throw new Error('impossible de trouver la boutique de cet item');
        await editOriginal(env, it.token, { content: await addShop(env, info.shopId, info.shopName, userId(it)) });
      });
    }
    return reply(await addShop(env, shopId, null, userId(it)));
  }

  if (sub === 'liste') {
    const { results } = await env.DB.prepare('SELECT * FROM shops ORDER BY added_at').all();
    if (!results.length) return reply('Aucun catalogue. Ajoute une boutique avec `/catalogue ajouter`.');
    const icons = { pending: '🕒', indexing: '⏳', ok: '✅', error: '❌' };
    const lines = results.map((s) => {
      const when = s.last_indexed ? `<t:${Math.floor(s.last_indexed / 1000)}:R>` : 'jamais';
      const err = s.status === 'error' && s.last_error ? ` · ${s.last_error.slice(0, 80)}` : '';
      return `${icons[s.status] || '•'} **${s.name || 'Boutique'}** \`${s.id}\` · ${s.item_count} items · indexé ${when}${err}`;
    });
    return reply(chunkLines(lines, 1900)[0] + (lines.length > 30 ? `\n… ${results.length} catalogues au total` : ''));
  }

  if (sub === 'retirer') {
    const id = String(opts.id);
    const shop = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(id).first();
    if (!shop) return reply('❌ Catalogue introuvable.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM items WHERE shop_id = ? AND manual = 0').bind(id),
      env.DB.prepare('DELETE FROM shops WHERE id = ?').bind(id),
    ]);
    return reply(`🗑️ **${shop.name || id}** retiré, avec ses ${shop.item_count} items.`);
  }

  if (sub === 'reindexer') {
    const id = String(opts.id);
    const r = await env.DB.prepare("UPDATE shops SET status = 'pending', last_error = NULL WHERE id = ?").bind(id).run();
    if (!r.meta.changes) return reply('❌ Catalogue introuvable.');
    await triggerIndexer(env);
    return reply('🔁 Réindexation demandée. Elle démarre au prochain passage de l\'indexeur (30 min maximum).');
  }
  return reply('Sous-commande inconnue.');
}

async function addShop(env, shopId, name, by) {
  const existing = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(shopId).first();
  if (existing) return `ℹ️ Ce catalogue existe déjà : **${existing.name || shopId}** (${existing.item_count} items).`;
  await env.DB.prepare(
    "INSERT INTO shops (id, platform, name, url, status, added_by, added_at) VALUES (?, 'weidian', ?, ?, 'pending', ?, ?)",
  ).bind(shopId, name, `https://weidian.com/?userid=${shopId}`, by, Date.now()).run();
  await triggerIndexer(env);
  return `✅ Boutique \`${shopId}\`${name ? ` (**${name}**)` : ''} ajoutée. L'indexation démarre au prochain passage de l'indexeur (30 min maximum), puis les titres sont traduits petit à petit. Suis l'avancement avec \`/catalogue liste\`.`;
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
  const imgs = pick(/"imgs"\s*:\s*\[\s*"([^"]+)"/);
  return {
    title: pick(/"item_name"\s*:\s*"([^"]+)"/),
    price: parseFloat(pick(/"price"\s*:\s*"?([0-9.]+)/)) || null,
    image: imgs,
    shopName: pick(/"shopName"\s*:\s*"([^"]+)"/),
    shopId: pick(/"shop_id"\s*:\s*"?(\d+)/),
  };
}

// ---------------------------------------------------------------- /item

async function itemAdd(opts, it, env, ctx) {
  const parsed = parseItemLink(String(opts.lien));
  if (!parsed) return reply('❌ Lien non reconnu. Il faut un lien d\'item Weidian, Taobao ou 1688.');
  const save = async (fields) => {
    const id = `${parsed.platform}:${parsed.itemId}`;
    await env.DB.prepare(
      `INSERT INTO items (id, platform, item_id, shop_id, shop_name, title_zh, title_en, price_cny, image, url, manual, first_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET title_zh = excluded.title_zh, title_en = excluded.title_en,
         price_cny = excluded.price_cny, image = excluded.image, shop_name = excluded.shop_name, manual = 1`,
    ).bind(id, parsed.platform, parsed.itemId, fields.shopId || null, fields.shopName || null,
      fields.titleZh || null, fields.titleEn || null, fields.price, fields.image || null, parsed.url, Date.now()).run();
    return `✅ Item ajouté : **${fields.titleEn || fields.titleZh}** (${formatPrice(fields.price, await getRate(env))}). Tu le retrouveras avec \`/recherche\`.`;
  };

  if (parsed.platform === 'weidian') {
    return deferred(it, env, ctx, async () => {
      const info = await fetchWeidianItem(parsed.itemId);
      const msg = await save({
        titleZh: info.title, titleEn: opts.titre || null, price: opts.prix != null ? opts.prix : info.price,
        image: opts.image || info.image, shopId: info.shopId, shopName: info.shopName,
      });
      await editOriginal(env, it.token, { content: msg });
    });
  }
  if (!opts.titre || opts.prix == null) {
    return reply('❌ Pour Taobao et 1688, il faut remplir `titre` et `prix` (en ¥). L\'image est conseillée.');
  }
  if (opts.image && !/^https:\/\//.test(opts.image)) return reply('❌ L\'image doit être un lien https.');
  return reply(await save({ titleEn: opts.titre, price: opts.prix, image: opts.image }));
}

// ---------------------------------------------------------------- /agent

async function agent(sub, opts, env) {
  if (sub === 'ajouter') {
    const template = String(opts.modele).trim();
    if (!isValidTemplate(template)) {
      return reply('❌ Le modèle doit commencer par `https://` et contenir `{url}` (lien produit encodé), `{url_raw}` ou `{id}`.\nExemple : `https://agent.com/product?url={url}&inviteCode=TONCODE`');
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first();
    if (count.n >= 20) return reply('❌ 20 agents maximum.');
    await env.DB.prepare(
      'INSERT INTO agents (name, template, position) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET template = excluded.template, position = excluded.position',
    ).bind(opts.nom, template, opts.position || count.n + 1).run();
    const example = template.replaceAll('{url}', encodeURIComponent('https://weidian.com/item.html?itemID=7863670229'))
      .replaceAll('{url_raw}', 'https://weidian.com/item.html?itemID=7863670229')
      .replaceAll('{id}', '7863670229').replaceAll('{platform}', 'weidian');
    return reply(`✅ Agent **${opts.nom}** enregistré.\nExemple de lien généré : ${example}`);
  }
  if (sub === 'liste') {
    const agents = await getAgents(env);
    if (!agents.length) return reply('Aucun agent. Ajoute ton lien d\'affiliation avec `/agent ajouter`.');
    return reply(agents.map((a) => `**${a.position}. ${a.name}** · \`${a.template}\``).join('\n').slice(0, 1900));
  }
  if (sub === 'retirer') {
    const r = await env.DB.prepare('DELETE FROM agents WHERE name = ?').bind(opts.nom).run();
    return reply(r.meta.changes ? `🗑️ Agent **${opts.nom}** retiré.` : '❌ Agent introuvable.');
  }
  return reply('Sous-commande inconnue.');
}

// ---------------------------------------------------------------- /admin

async function admin(sub, opts, it, env) {
  if (sub === 'liste') {
    const { results } = await env.DB.prepare('SELECT user_id FROM admins WHERE guild_id = ?').bind(it.guild_id).all();
    const extra = results.length ? results.map((r) => `<@${r.user_id}>`).join(', ') : 'aucun';
    return reply(`👑 Accès automatique : le propriétaire et les membres avec la permission **Administrateur**.\n➕ Membres ajoutés : ${extra}`, { allowed_mentions: { parse: [] } });
  }
  if (!hasAdminPermission(it)) return reply('⛔ Seuls les administrateurs du serveur peuvent ajouter ou retirer des membres.');
  const target = String(opts.membre);
  if (sub === 'ajouter') {
    await env.DB.prepare('INSERT OR IGNORE INTO admins (guild_id, user_id, added_by) VALUES (?, ?, ?)')
      .bind(it.guild_id, target, userId(it)).run();
    return reply(`✅ <@${target}> peut maintenant utiliser le bot.`, { allowed_mentions: { parse: [] } });
  }
  if (sub === 'retirer') {
    await env.DB.prepare('DELETE FROM admins WHERE guild_id = ? AND user_id = ?').bind(it.guild_id, target).run();
    return reply(`🗑️ <@${target}> n'a plus accès au bot (sauf s'il est administrateur du serveur).`, { allowed_mentions: { parse: [] } });
  }
  return reply('Sous-commande inconnue.');
}

// ---------------------------------------------------------------- /statut

async function statut(env) {
  const [shops, items, untranslated, queue] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM shops').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM items').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE title_en IS NULL AND translate_failed < 3').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first(),
  ]);
  const rate = await getRate(env);
  return reply([
    `📦 **${items.n}** items dans **${shops.n}** catalogues`,
    `🌐 ${untranslated.n} titres en attente de traduction (~${TRANSLATE_PER_MINUTE}/min)`,
    `📨 ${queue.n} items dans la file « tout poster » (~${QUEUE_PER_MINUTE}/min)`,
    `💱 1 ¥ = ${rate.toFixed(4)} €`,
  ].join('\n'));
}

// ---------------------------------------------------------------- /recherche

async function recherche(opts, it, env, ctx) {
  return deferred(it, env, ctx, async () => {
    const params = {
      q: opts.mots || '',
      variants: await prepareQuery(env, opts.mots || ''),
      min: opts.prix_min != null ? opts.prix_min : null,
      max: opts.prix_max != null ? opts.prix_max : null,
      shop: opts.vendeur || null,
      includePosted: !!opts.inclure_postes,
    };
    const channelId = opts.salon || it.channel_id;
    const sid = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    await env.DB.prepare('INSERT INTO searches (id, guild_id, user_id, params, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(sid, it.guild_id, userId(it), JSON.stringify(params), channelId, Date.now()).run();
    await editOriginal(env, it.token, await renderSearch(env, sid, params, channelId, 0));
  });
}

async function loadSearch(env, sid) {
  const row = await env.DB.prepare('SELECT * FROM searches WHERE id = ?').bind(sid).first();
  return row ? { params: JSON.parse(row.params), channelId: row.channel_id } : null;
}

async function renderSearch(env, sid, params, channelId, page) {
  const rate = await getRate(env);
  const total = await countResults(env, params, rate);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const items = total ? await pageResults(env, params, rate, page) : [];

  const filters = [];
  if (params.min != null) filters.push(`≥ ${params.min} €`);
  if (params.max != null) filters.push(`≤ ${params.max} €`);
  if (params.shop) filters.push(`vendeur ${params.shop}`);
  if (!params.includePosted) filters.push('non postés');
  const header = `🔎 **${params.q || 'tout'}** · ${total} résultat${total > 1 ? 's' : ''}` +
    (filters.length ? ` (${filters.join(', ')})` : '') +
    (total ? ` · page ${page + 1}/${pages}` : '') + ` · salon <#${channelId}>`;

  if (!total) {
    return { content: `${header}\nAucun item trouvé. Essaie d'autres mots (en anglais, c'est mieux) ou ajoute des catalogues.`, embeds: [], components: [] };
  }

  const embeds = items.map((item, i) => {
    const e = {
      title: `${page * PAGE_SIZE + i + 1}. ${itemTitle(item)}`.slice(0, 256),
      url: item.url,
      description: `${formatPrice(item.price_cny, rate)} · ${item.shop_name || '—'}${item.posted_count ? ' · ✅ déjà posté' : ''}`,
      color: 0x2b2d31,
    };
    if (item.image) e.thumbnail = { url: item.image };
    return e;
  });

  const components = [
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `sel:${sid}:${page}`,
        placeholder: 'Choisir un ou plusieurs items à poster',
        min_values: 1,
        max_values: items.length,
        options: items.map((item, i) => ({
          label: `${page * PAGE_SIZE + i + 1}. ${itemTitle(item)}`.slice(0, 100),
          description: formatPrice(item.price_cny, rate).slice(0, 100),
          value: item.id,
        })),
      }],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: '◀', custom_id: `pg:${sid}:${page - 1}`, disabled: page === 0 },
        { type: 2, style: 2, label: '▶', custom_id: `pg:${sid}:${page + 1}`, disabled: page >= pages - 1 },
        { type: 2, style: 3, label: `Tout poster (${Math.min(total, MAX_BULK)})`, custom_id: `all:${sid}` },
      ],
    },
  ];
  return { content: header, embeds, components, allowed_mentions: { parse: [] } };
}

// ---------------------------------------------------------------- Boutons et menus

async function component(it, env, ctx) {
  const [kind, sid, arg] = it.data.custom_id.split(':');
  const search = await loadSearch(env, sid);
  if (!search) return json({ type: Reply.UPDATE_MESSAGE, data: { content: '⌛ Recherche expirée, relance `/recherche`.', embeds: [], components: [] } });
  const { params, channelId } = search;

  if (kind === 'pg') {
    return json({ type: Reply.UPDATE_MESSAGE, data: await renderSearch(env, sid, params, channelId, Number(arg)) });
  }

  if (kind === 'sel') {
    const ids = it.data.values || [];
    return deferred(it, env, ctx, async () => {
      const agents = await getAgents(env);
      const rate = await getRate(env);
      let ok = 0;
      const errors = [];
      for (const id of ids) {
        const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
        if (!item) continue;
        try {
          await postItem(env, item, channelId, agents, rate);
          ok++;
        } catch (err) {
          errors.push(String(err.message || err));
          if (/-> (403|404)/.test(String(err))) break;
        }
      }
      let msg = `✅ ${ok} item${ok > 1 ? 's' : ''} posté${ok > 1 ? 's' : ''} dans <#${channelId}>.`;
      if (errors.length) msg += `\n❌ ${errors.length} échec(s). Vérifie que le bot peut écrire dans ce salon. (${errors[0].slice(0, 150)})`;
      await followup(env, it.token, { content: msg, flags: EPHEMERAL });
      await discordApi(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${it.token}/messages/${it.message.id}`,
        await renderSearch(env, sid, params, channelId, Number(arg))).catch(() => {});
    }, true);
  }

  if (kind === 'all') {
    const total = Math.min(await countResults(env, params, await getRate(env)), MAX_BULK);
    const minutes = Math.ceil(total / QUEUE_PER_MINUTE);
    return json({
      type: Reply.MESSAGE,
      data: {
        flags: EPHEMERAL,
        content: `Poster **${total}** items dans <#${channelId}> ? Ils partiront à environ ${QUEUE_PER_MINUTE} par minute (~${minutes} min).`,
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Confirmer', custom_id: `ok:${sid}` },
            { type: 2, style: 4, label: 'Annuler', custom_id: `no:${sid}` },
          ],
        }],
      },
    });
  }

  if (kind === 'ok') {
    const ids = await allResultIds(env, params, await getRate(env));
    const already = await env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first();
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 50) {
      await env.DB.batch(ids.slice(i, i + 50).map((id) =>
        env.DB.prepare('INSERT INTO post_queue (item_id, channel_id, created_at) VALUES (?, ?, ?)').bind(id, channelId, now)));
    }
    const minutes = Math.ceil((already.n + ids.length) / QUEUE_PER_MINUTE);
    return json({
      type: Reply.UPDATE_MESSAGE,
      data: { content: `⏳ ${ids.length} items ajoutés à la file pour <#${channelId}>. Fin estimée dans ~${minutes} min. Suivi avec \`/statut\`.`, components: [] },
    });
  }

  if (kind === 'no') {
    return json({ type: Reply.UPDATE_MESSAGE, data: { content: 'Annulé.', components: [] } });
  }
  return reply('Action inconnue.');
}

function chunkLines(lines, max) {
  const chunks = [''];
  for (const l of lines) {
    if ((chunks[chunks.length - 1] + l).length + 1 > max) chunks.push('');
    chunks[chunks.length - 1] += (chunks[chunks.length - 1] ? '\n' : '') + l;
  }
  return chunks;
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
