// Photos QC, toujours affichées dans Discord (jamais de lien vers un site de QC) :
// - QC des agents via l'API FinderQC (avec l'accord de son propriétaire), mises en cache ;
// - QC postées par la communauté dans les salons QC.

import { COMPONENTS_V2, container, gallery, row, text, sep, escape, section, thumb } from './components.js';
import { discordApi, discordUpload } from './discord.js';
import { popularItemStatements } from './items.js';
import { canonicalUrl } from './links.js';
import { detectCategory, isDeadLink } from './categories.js';
import { budget, rowsWritten, readsOver } from './budget.js';
import { itemDb, onDb, perDb, groupByDb, batchByDb } from './shard.js';
import { emo, etxt } from './emojis.js';
import { kvGet, kvSet, kvLock, kvDel, logEvent, finderBusy, finderPaused, redis } from './kvstore.js';
import { ADULT } from './titles.js';

const UA = 'finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)';
const API = 'https://server.finderqc.com/api/spu/webSpuInfo';
export const BATCHES_PER_API_PAGE = 12;
export const BATCHES_PER_VIEW = 3;
const RECHECK_MS = 3 * 86400000;

const fmt = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');
const isImg = (u) => /^https:\/\/(img\.finderqc\.com|cdn\.repfind\.ai)\//.test(u || '');

// Une page de lots QC FinderQC (12 lots). Renvoie { count, batches: [{ agent, date, attrs, photos }] } ou null.
export async function fetchQcPage(itemId, page = 1) {
  const url = `${API}?id=${encodeURIComponent(itemId)}&page=${page}&pageSize=${BATCHES_PER_API_PAGE}`;
  let res = await fetch(url, { headers: { 'User-Agent': UA } });
  // Trop de requêtes : une seconde de pause et un nouvel essai.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1200));
    res = await fetch(url, { headers: { 'User-Agent': UA } });
  }
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  const s = data && data.code === 0 && data.data && data.data.spuInfo;
  if (!s) return { count: 0, batches: [], similar: [] };
  const batches = (s.spuQcName || []).map((b) => ({
    agent: b.name || '',
    date: b.CreatedAt ? Date.parse(b.CreatedAt) : null,
    attrs: ((b.spuImg || []).find((i) => i.attributes) || {}).attributes || '',
    photos: (b.spuImg || []).map((i) => i.url).filter(isImg),
  })).filter((b) => b.photos.length);
  // Items similaires qui ont des QC : de nouvelles découvertes pour le catalogue.
  const similar = (s.similarSpuList || []).map((x) => ({
    platform: PLATFORMS[x.mallType], id: String(x.originItemId || x.itemId || ''), title: x.enTitle || x.originalTitle,
    price: x.cnPrice, image: x.originalThubnaiURL || x.picUrl, sold: x.oneYear || 0, qc: Number(x.qcPhotosCount) || 0,
  })).filter((x) => x.platform && /^\d{6,14}$/.test(x.id) && x.qc >= 10);
  return { count: Number(s.qcPhotosCount) || 0, batches, similar };
}

const PLATFORMS = { Weidian: 'weidian', Taobao: 'taobao', Ali1688: '1688' };

// Photo produit FinderQC des items sans photo (fiches venues de l'index Neon quand leur base est illisible).
// Gardée 30 jours dans Upstash ; au plus 1,5 s d'attente, sinon l'item reste sans photo. { id: url }
export async function finderPhotos(env, ids) {
  if (!ids.length) return {};
  const known = (await redis(env, [['MGET', ...ids.map((id) => `img:${id}`)]])) || [[]];
  const out = {};
  ids.forEach((id, i) => { if (known[0] && known[0][i]) out[id] = known[0][i]; });
  const missing = ids.filter((id) => !out[id]);
  if (!missing.length) return out;
  const found = await Promise.all(missing.map(async (id) => {
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(id.split(':')[1])}&page=1&pageSize=1`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const s = ((await res.json()).data || {}).spuInfo || {};
      const url = s.picUrl || s.originalThubnaiUrl || s.originalThubnaiURL;
      return /^https:\/\//.test(url || '') ? [id, url] : null;
    } catch { return null; }
  }));
  const fresh = found.filter(Boolean);
  for (const [id, url] of fresh) out[id] = url;
  if (fresh.length) await redis(env, fresh.map(([id, url]) => ['SET', `img:${id}`, url, 'EX', '2592000'])).catch(() => {});
  return out;
}

// Repfind (2e source, avec l'accord de son propriétaire) : utilisé quand FinderQC n'a rien pour l'item.
const REPFIND = 'https://www.repfind.ai/client';

export async function fetchRepfindPage(itemId, page = 1) {
  const get = async (path) => {
    const res = await fetch(REPFIND + path, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Repfind ${res.status}`);
    const text = await res.text();
    if (!text) throw new Error('Repfind : réponse vide (rythme limité)');
    return JSON.parse(text);
  };
  const d = await get(`/product/detail?id=${encodeURIComponent(itemId)}`);
  if (d.code !== 200 || !d.data || !d.data.id) return { count: 0, batches: [], similar: [], running: false };
  const q = await get(`/product/qc/search?productId=${encodeURIComponent(d.data.id)}&pageNum=${page}&pageSize=${BATCHES_PER_API_PAGE}`);
  const batches = (q.rows || []).map((r) => {
    let attrs = '';
    try { attrs = JSON.parse(((r.images || [])[0] || {}).label || '{}').skuName || ''; } catch {}
    return { agent: r.platform || '', date: r.qcTime ? Date.parse(r.qcTime) : null, attrs, photos: (r.images || []).map((i) => i.imgUrl).filter(isImg) };
  }).filter((b) => b.photos.length);
  return { count: Number(q.qcTotal) || 0, batches, similar: [], running: !!q.qcRunning };
}

// QC d'un item, toutes sources : FinderQC d'abord, Repfind si FinderQC n'a rien (ou si Repfind est la source connue).
export async function fetchQc(item, page = 1, opts = {}) {
  let hint = null;
  try { hint = JSON.parse(item.qc_preview || 'null'); } catch {}
  const preferRepfind = hint && !Array.isArray(hint) && hint.s === 'repfind';
  let qc = { count: 0, batches: [], similar: [], running: false };
  let failed = false;
  if (!preferRepfind) {
    try { qc = await fetchQcPage(item.item_id, page); qc.source = 'finderqc'; } catch (err) { failed = true; console.log('finderqc', String(err).slice(0, 100)); }
  }
  if (!qc.count && opts.repfind !== false) {
    try {
      const r = await fetchRepfindPage(item.item_id, page);
      if (r.count || r.running) qc = { ...r, similar: qc.similar || [], source: 'repfind' };
    } catch (err) {
      // Repfind injoignable : « on ne sait pas » seulement s'il est la source connue de l'item (sinon FinderQC a répondu).
      if (preferRepfind) failed = true;
      console.log('repfind', String(err).slice(0, 100));
    }
  }
  // Source injoignable (et rien ailleurs) : « on ne sait pas », surtout pas « aucune QC ».
  if (failed && !qc.count && !qc.running) qc.failed = true;
  return qc;
}

function previewJson(qc) {
  return JSON.stringify({ s: qc.source || 'finderqc', p: qc.batches.flatMap((b) => b.photos).slice(0, 8) });
}

// Toutes les 5 minutes : QC des items qui comptent (populaires, déjà postés, ajoutés à la main), revérifiées tous
// les 3 jours, et découverte de leurs items similaires. Renvoie le nombre de requêtes externes faites.
export async function runQcChecks(env, limit) {
  const { results } = await env.DB.prepare(
    // Ordre de l'index (jamais vérifiés, puis les plus anciennes vérifications) : sans tri, on ne lit que les lignes
    // prises. Le tri par popularité lisait ~400 000 lignes à chaque passage (quota de lectures Turso).
    `SELECT * FROM items INDEXED BY items_qcdue WHERE (popularity > 0 OR posted_count > 0 OR manual = 1)
       AND hidden = 0 AND (qc_checked_at IS NULL OR qc_checked_at < ?)
     ORDER BY qc_checked_at LIMIT ?`,
  ).bind(Date.now() - RECHECK_MS, limit).all();
  const stmts = [];
  const found = [];
  let calls = 0;
  let repfindLeft = 3; // Repfind limite le rythme : quelques appels par passage seulement
  for (const item of results) {
    calls++;
    const qc = await fetchQc(item, 1, { repfind: repfindLeft > 0 });
    if (qc.source === 'repfind' || !qc.count) { repfindLeft--; calls += 2; }
    if (qc.failed) continue;
    stmts.push(env.DB.prepare('UPDATE items SET qc_count = ?, qc_preview = ?, qc_checked_at = ? WHERE id = ?')
      .bind(qc.count, previewJson(qc), qc.running ? null : Date.now(), item.id));
    found.push(...(qc.similar || []).slice(0, 10));
  }
  // Items similaires : au plus 10 par passage, pris sur le budget quotidien « items » (quota D1 gratuit).
  // Les items similaires vont dans la base qui leur revient (voir shard.js), sur le budget de cette base.
  const routed = stmts.map((st) => [env.DB, st]);
  for (const [db, list] of groupByDb(env, found.slice(0, 10).map((x) => `${x.platform}:${x.id}`))) {
    const e = onDb(env, db);
    const b = await budget(e, 'items');
    const take = found.filter((x) => list.includes(`${x.platform}:${x.id}`)).slice(0, b.left);
    if (!take.length) continue;
    routed.push(...popularItemStatements(e, take, 'finderqc').stmts.map((st) => [db, st]));
    await b.use(take.length);
  }
  await batchByDb(routed);
  return calls;
}

// Met à jour le nombre de QC et l'aperçu d'un item (une requête, au plus tous les 3 jours). Renvoie l'item à jour.
export async function refreshQc(env, item) {
  if (item.qc_checked_at && Date.now() - item.qc_checked_at < RECHECK_MS) return item;
  const qc = await fetchQc(item, 1);
  if (qc.failed) return item; // source indisponible : on garde ce qu'on savait
  const preview = previewJson(qc);
  // Récupération en cours chez Repfind : on revérifiera (pas de date de vérification).
  const checkedAt = qc.running ? null : Date.now();
  // Le cache est un plus : si la base refuse l'écriture (quota du jour), on affiche quand même les QC.
  await itemDb(env, item.id).prepare('UPDATE items SET qc_count = ?, qc_preview = ?, qc_checked_at = ? WHERE id = ?')
    .bind(qc.count, preview, checkedAt, item.id).run().catch((err) => console.log('qc cache', String(err).slice(0, 100)));
  return { ...item, qc_count: qc.count, qc_preview: preview, qc_checked_at: checkedAt, qc_running: qc.running };
}

// QC de la communauté pour un item : nombre de posts, de photos, et le plus récent.
export async function communityQc(env, itemId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS posts, COALESCE(SUM(images), 0) AS images,
       (SELECT guild_id || '/' || channel_id || '/' || message_id FROM qc_posts WHERE item_id = ? ORDER BY at DESC LIMIT 1) AS latest
     FROM qc_posts WHERE item_id = ?`,
  ).bind(itemId, itemId).first().catch(() => null); // base illisible : pas de QC de la communauté, le reste marche
  return row && row.posts ? { posts: row.posts, images: row.images, jump: `https://discord.com/channels/${row.latest}` } : null;
}

// Bouton QC d'une carte : toujours présent, il ouvre les QC dans Discord (fenêtre visible par la personne qui clique).
export function qcButtons(item, community, lang = 'fr', emojis = null) {
  const en = lang === 'en';
  const n = (item.qc_count || 0) + (community ? community.images : 0);
  const label = n ? `QC · ${fmt(n)}` : (en ? 'QC photos' : 'Photos QC');
  return [{ type: 2, style: 1, label, emoji: emo(emojis, 'fb_qc'), custom_id: `pub:qc:${item.id}`.slice(0, 100) }];
}

// Photos QC de la communauté (les plus récentes), avec des liens Discord tout frais.
// Renvoie { photos: [{ url, filename, jump }], calls }.
export async function communityPhotos(env, itemId, max = 4) {
  const { results } = await env.DB.prepare('SELECT * FROM qc_posts WHERE item_id = ? ORDER BY at DESC LIMIT 4').bind(itemId).all();
  const photos = [];
  let calls = 0;
  for (const q of results) {
    if (photos.length >= max) break;
    try {
      const m = await discordApi(env, 'GET', `/channels/${q.channel_id}/messages/${q.message_id}`);
      calls++;
      for (const a of m.attachments || []) {
        if (photos.length >= max) break;
        if (/^image\//.test(a.content_type || '') || /\.(jpe?g|png|webp)$/i.test(a.filename || '')) {
          photos.push({ url: a.url, filename: a.filename || 'qc.jpg', jump: `https://discord.com/channels/${q.guild_id}/${q.channel_id}/${q.message_id}` });
        }
      }
    } catch (err) {
      calls++;
      // Message supprimé : on oublie ce QC.
      if (/-> 404/.test(String(err))) await env.DB.prepare('DELETE FROM qc_posts WHERE id = ?').bind(q.id).run().catch(() => {});
    }
  }
  return { photos, calls };
}

function batchCaption(b, en) {
  const parts = [`🧾 **${escape(b.agent || (en ? 'Agent' : 'Agent'))}**`];
  if (b.date) parts.push(`<t:${Math.floor(b.date / 1000)}:D>`);
  if (b.attrs) parts.push(escape(String(b.attrs).slice(0, 80)));
  return parts.join('  ·  ');
}

// Article qui ressemble (recherche par image FinderQC), de la même catégorie, avec des QC. { item, photos } ou null.
async function lookAlikeQc(item) {
  const { searchByImage } = await import('./imagesearch.js');
  const cat = item.category || detectCategory(`${item.title_en || ''} ${item.title_zh || ''}`);
  if (!cat || cat === 'other') return null;
  const found = await searchByImage(item.image, 'item.jpg');
  const x = found.find((f) => f.qc > 0 && f.id !== String(item.item_id) && detectCategory(f.title) === cat && /^https:\/\//.test(f.image || ''));
  if (!x) return null;
  const page = await fetchQcPage(x.id, 1);
  const photos = page.batches.flatMap((b) => b.photos);
  return photos.length ? { item: x, photos } : null;
}

// Article qui ressemble, gardé avec l'item (qc_preview) : rouvrir la fenêtre ne coûte aucune requête à FinderQC.
// La recherche est refaite à la prochaine vérification des QC de l'item (refreshQc remplace qc_preview).
async function cachedLookAlike(env, item) {
  let saved = null;
  try { saved = JSON.parse(item.qc_preview || 'null'); } catch {}
  if (saved && saved.s === 'similar') return saved.item ? { item: saved.item, photos: (saved.p || []).filter(isImg) } : null;
  const look = await lookAlikeQc(item).catch((err) => { console.log('qc similaire', String(err).slice(0, 120)); return undefined; });
  if (look === undefined) return null; // erreur (source surchargée) : on réessaiera
  const keep = JSON.stringify({ s: 'similar', item: look ? look.item : null, p: look ? look.photos.slice(0, 8) : [] });
  if (env && env.DB) await itemDb(env, item.id).prepare('UPDATE items SET qc_preview = ? WHERE id = ? AND COALESCE(qc_count, 0) = 0').bind(keep, item.id).run().catch(() => {});
  return look;
}

// Fenêtre QC (dans Discord) : page `view` des lots d'agents, et les QC de la communauté en première page.
export async function qcWindow(env, item, view = 0, opts = {}) {
  const en = opts.lang === 'en';
  const first = view * BATCHES_PER_VIEW;
  const apiPage = Math.floor(first / BATCHES_PER_API_PAGE) + 1;
  // Item vérifié récemment et sans QC (pas de récupération en cours) : inutile de redemander à la source.
  let hint = null;
  try { hint = JSON.parse(item.qc_preview || 'null'); } catch {}
  const knownEmpty = view === 0 && !(item.qc_count > 0) && !item.qc_running && item.qc_checked_at
    && Date.now() - item.qc_checked_at < RECHECK_MS && !(hint && hint.s === 'repfind');
  const qc = knownEmpty ? { count: 0, batches: [], similar: [] } : await fetchQc(item, apiPage);
  if (qc.failed && env) await finderBusy(env); // FinderQC limite le bot : la synchro laisse la place aux membres
  const offset = first % BATCHES_PER_API_PAGE;
  const batches = qc.batches.slice(offset, offset + BATCHES_PER_VIEW);
  const totalBatchesSeen = (apiPage - 1) * BATCHES_PER_API_PAGE + qc.batches.length;
  const hasNext = offset + BATCHES_PER_VIEW < qc.batches.length || qc.batches.length === BATCHES_PER_API_PAGE;

  const blocks = [];
  if (view === 0 && opts.community && opts.community.length) {
    blocks.push(text(en ? '### 🧑‍🤝‍🧑 Community QC' : '### 🧑‍🤝‍🧑 QC de la communauté'));
    blocks.push(gallery(opts.community.slice(0, 10).map((p) => p.url)));
  }
  for (const b of batches) {
    blocks.push(text(batchCaption(b, en)));
    blocks.push(gallery(b.photos.slice(0, 10)));
  }
  const title = escape((item.title_en || item.title_zh || `${item.platform} ${item.item_id}`).slice(0, 80));
  const known = qc.count || (qc.failed ? item.qc_count : 0);
  const head = `## ${etxt(opts.emojis, 'fb_qc')} ${title}\n-# ${known ? (en ? `${fmt(known)} QC photos` : `${fmt(known)} photos QC`) : (en ? 'No agent QC yet' : 'Pas encore de QC d\'agents')}` +
    (batches.length ? `  ·  ${en ? 'batches' : 'lots'} ${first + 1}–${first + batches.length}${hasNext ? '' : ` / ${totalBatchesSeen}`}` : '');
  if (!blocks.length && qc.running) {
    blocks.push(text(en ? '⏳ QC photos for this item are being fetched right now. Come back in a few minutes.'
      : '⏳ Les photos QC de cet item sont en cours de récupération. Reviens dans quelques minutes.'));
  }
  if (!blocks.length && qc.failed) {
    // Source indisponible : les photos déjà enregistrées pour cet item, sinon « réessaie ».
    let saved = [];
    try { const h = JSON.parse(item.qc_preview || 'null'); saved = (Array.isArray(h) ? h : (h && h.p) || []).filter(isImg); } catch {}
    if (saved.length && view === 0) {
      blocks.push(text(en ? '🗂️ Saved QC photos (the source is busy, more in a minute)' : '🗂️ Photos QC enregistrées (la source est surchargée, plus de photos dans une minute)'));
      blocks.push(gallery(saved.slice(0, 10)));
    } else {
      blocks.push(text(en ? '⏳ The QC source is busy right now. Try again in a minute.'
        : '⏳ La source des QC est surchargée en ce moment. Réessaie dans une minute.'));
    }
  }
  // Aucune QC pour cet item : les QC d'un article qui ressemble (même catégorie), vendu par un autre vendeur.
  let similarBtn = null;
  if (!blocks.length && !qc.failed && view === 0 && /^https:\/\//.test(item.image || '')) {
    const look = await cachedLookAlike(env, item);
    if (look) {
      const x = look.item;
      blocks.push(text(en ? '### 🔍 QC of a look-alike item (other seller)\n-# No QC for this exact item yet. Compare with the photo before buying.'
        : '### 🔍 QC d\'un article qui ressemble (autre vendeur)\n-# Pas encore de QC pour cet item précis : compare bien avec sa photo avant d\'acheter.'));
      blocks.push(section(`**${escape(String(x.title || '').slice(0, 80))}**\n-# ${en ? `${fmt(x.qc)} QC photos` : `${fmt(x.qc)} photos QC`}${x.price != null ? `  ·  ¥${x.price}` : ''}`, thumb(x.image)));
      blocks.push(gallery(look.photos.slice(0, 8)));
      similarBtn = { type: 2, style: 2, emoji: { name: '📸' }, label: en ? 'All its QC' : 'Toutes ses QC', custom_id: `pub:qc:${x.platform}:${x.id}`.slice(0, 100) };
    }
  }
  let ask = null;
  if (!blocks.length || similarBtn) {
    if (!similarBtn) blocks.push(text(opts.qcChannel
      ? (en ? `No QC photos anywhere yet for this item. Bought it? Post your QC photos with the item link in <#${opts.qcChannel}>.`
        : `Aucune photo QC n'existe encore pour cet item. Tu l'as acheté ? Poste tes photos QC avec le lien de l'item dans <#${opts.qcChannel}> : elles apparaîtront ici.`)
      : (en ? 'Nobody has shared QC photos for this item yet.' : 'Personne n\'a encore partagé de QC pour cet item.')));
    // Pas de QC nulle part : on peut les demander à la communauté.
    const askBtn = opts.qcChannel
      ? { type: 2, style: 1, emoji: { name: '🙋' }, label: en ? 'Ask for QC' : 'Demander un QC', custom_id: `pub:qcreq:${item.id}`.slice(0, 100) } : null;
    // Le même article chez d'autres vendeurs : souvent l'un d'eux a des QC.
    const cmpBtn = /^https:\/\//.test(item.image || '')
      ? { type: 2, style: 2, emoji: emo(opts.emojis, 'fb_compare'), label: en ? 'Other sellers' : 'Autres vendeurs', custom_id: `pub:cmp:${item.id}`.slice(0, 100) } : null;
    if (askBtn || similarBtn || cmpBtn) ask = row(...[similarBtn, cmpBtn, askBtn].filter(Boolean));
  }
  const retry = qc.failed && !batches.length
    ? row({ type: 2, style: 1, emoji: { name: '🔄' }, label: en ? 'Retry' : 'Réessayer', custom_id: `pub:qcp:${item.id}:${view}` }) : null;
  const nav = (view > 0 || hasNext) ? row(
    { type: 2, style: 2, emoji: { name: '◀️' }, custom_id: `pub:qcp:${item.id}:${view - 1}`, disabled: view === 0 },
    { type: 2, style: 2, label: en ? 'More QC' : 'Plus de QC', emoji: { name: '▶️' }, custom_id: `pub:qcp:${item.id}:${view + 1}`, disabled: !hasNext },
  ) : null;
  // Avis des membres sur les QC de cet item (GL = bon, RL = à refaire), seulement s'il y a des photos.
  const votes = batches.length || (view === 0 && opts.community && opts.community.length) ? voteRow(item, en, opts.emojis, view) : null;
  return [container([text(head), sep(), ...blocks, votes, nav, retry, ask], opts.accent || 0x5865f2)];
}

// Boutons de vote GL/RL (avec le nombre de votes ; un clic met juste à jour les chiffres), et « Partager » : les
// photos affichées sont postées dans le salon, visibles par tout le monde.
export function voteRow(item, en = false, emojis = null, view = 0) {
  return row(
    { type: 2, style: 3, emoji: emo(emojis, 'fb_gl'), label: `GL · ${fmt(item.gl_votes || 0)}`, custom_id: `pub:vote:${item.id}:gl`.slice(0, 100) },
    { type: 2, style: 4, emoji: emo(emojis, 'fb_rl'), label: `RL · ${fmt(item.rl_votes || 0)}`, custom_id: `pub:vote:${item.id}:rl`.slice(0, 100) },
    { type: 2, style: 1, emoji: emo(emojis, 'fb_photos'), label: en ? 'Share in channel' : 'Partager dans le salon', custom_id: `pub:qcshare:${item.id}:${view}`.slice(0, 100) },
    // Analyse des photos par l'IA (aiqc.js).
    { type: 2, style: 2, emoji: emo(emojis, 'fb_bot'), label: en ? 'AI check' : 'Analyse IA', custom_id: `pub:aiqc:${item.id}:${view}`.slice(0, 100) },
  );
}

// Message public des QC partagées par un membre : les photos de la page qu'il regardait (communauté + lots
// d'agents), qui les a partagées, et les boutons de la carte (acheter, toutes les QC, comparer…). null : rien à montrer.
// Photo de référence pour l'analyse IA : la vue d'ensemble d'un autre batch du même article (pas un de ceux analysés).
// Pas de référence si les membres jugent l'article plutôt RL. { url, same, gl } ou null.
export function goldPhoto(qc, exclude = [], item = {}, same = true) {
  const gl = Number(item.gl_votes) || 0;
  const rl = Number(item.rl_votes) || 0;
  if (rl > gl) return null;
  const skip = new Set(exclude);
  const b = ((qc && qc.batches) || []).find((x) => x.photos.length && !x.photos.some((u) => skip.has(u)));
  return b ? { url: b.photos[0], same, gl: gl > rl } : null;
}

// Photos QC d'une page de la fenêtre QC (communauté en 1re page, puis lots d'agents). { qc, batches, photos }
export async function qcPagePhotos(env, item, view) {
  const first = view * BATCHES_PER_VIEW;
  const qc = await fetchQc(item, Math.floor(first / BATCHES_PER_API_PAGE) + 1);
  const batches = qc.batches.slice(first % BATCHES_PER_API_PAGE, first % BATCHES_PER_API_PAGE + BATCHES_PER_VIEW);
  const community = view === 0 ? (await communityPhotos(env, item.id, 10)).photos.map((p) => p.url) : [];
  // Photos de la communauté (Discord) et des agents (déjà filtrées par fetchQcPage).
  const photos = [...new Set([...community, ...batches.flatMap((b) => b.photos)])].filter((u) => /^https:\/\//.test(u || '')).slice(0, 10);
  return { qc, batches, photos };
}

export async function qcShareMessage(env, item, view, userId, ctx, channelId = null) {
  const en = ctx.cfg.lang === 'en';
  const { qc, batches, photos } = await qcPagePhotos(env, item, view);
  if (!photos.length) return null;
  const { agentButtons } = await import('./post.js'); // post.js importe déjà qc.js
  const { ACCENTS } = await import('./config.js');
  const e = (n) => etxt(ctx.emojis, n);
  const votes = (item.gl_votes || 0) + (item.rl_votes || 0);
  const title = escape(String(item.title_en || item.title_zh || `${item.platform} ${item.item_id}`).slice(0, 90));
  const info = [
    en ? `Shared by <@${userId}>` : `Partagé par <@${userId}>`,
    qc.count ? `${e('fb_qc')} ${fmt(qc.count)} ${en ? 'QC photos in total' : 'photos QC au total'}` : null,
    batches[0] && batches[0].agent ? `🧾 ${escape(batches[0].agent)}` : null,
    votes >= 3 ? `${e('fb_gl')} ${Math.round((100 * item.gl_votes) / votes)} % GL` : null,
  ].filter(Boolean);
  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [container([
      text(`## ${e('fb_qc')} QC · ${title}\n-# ${info.join('  ·  ')}`),
      gallery(photos),
      sep(),
      ...agentButtons(ctx, item, channelId, null),
    ], (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)],
  };
}

// Sous un post de forum : photos QC (communauté + dernier lot des agents) et bouton « Plus de QC ».
// Renvoie le nombre de requêtes externes faites.
export async function postForumQc(env, threadId, item, lang = 'fr') {
  const en = lang === 'en';
  const { photos, calls: got } = await communityPhotos(env, item.id, 4);
  let calls = got;
  const qc = await fetchQc(item, 1);
  calls += qc.source === 'repfind' ? 3 : 1;
  if (!photos.length && !qc.batches.length) return calls;

  const files = [];
  for (const [i, p] of photos.entries()) {
    try {
      const res = await fetch(p.url);
      calls++;
      if (res.ok) files.push({ name: `qc${i + 1}.${(p.filename.split('.').pop() || 'jpg').toLowerCase()}`, blob: await res.blob() });
    } catch {}
  }
  const blocks = [text(en ? `### 📸 QC photos${qc.count ? ` · ${fmt(qc.count)}` : ''}` : `### 📸 Photos QC${qc.count ? ` · ${fmt(qc.count)}` : ''}`)];
  if (files.length) {
    blocks.push(text(en ? '🧑‍🤝‍🧑 From the community' : '🧑‍🤝‍🧑 De la communauté'));
    blocks.push(gallery(files.map((f) => `attachment://${f.name}`)));
  }
  for (const b of qc.batches.slice(0, 2)) {
    blocks.push(text(batchCaption(b, en)));
    blocks.push(gallery(b.photos.slice(0, 10)));
  }
  if (qc.batches.length > 2 || qc.count > 8) {
    blocks.push(row({ type: 2, style: 1, emoji: { name: '📸' }, label: en ? 'More QC' : 'Plus de QC', custom_id: `pub:qcp:${item.id}:0` }));
  }
  const payload = { flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components: [container(blocks, 0x5865f2)] };
  if (files.length) await discordUpload(env, `/channels/${threadId}/messages`, payload, files);
  else await discordApi(env, 'POST', `/channels/${threadId}/messages`, payload);
  return calls + 1;
}

// Résumé texte (« 📸 4 882 QC · 🧑‍🤝‍🧑 3 QC ») pour les listes.
export function qcSummary(item, community) {
  const parts = [];
  if (item.qc_count > 0) parts.push(`📸 ${fmt(item.qc_count)} QC`);
  if (community) parts.push(`🧑‍🤝‍🧑 ${community.images} QC`);
  return parts.join('  ·  ');
}

// ---------------------------------------------------------------- Synchro en masse du catalogue FinderQC
// Toutes les 2 min, minutes impaires (son propre cron) : quelques pages de 100 produits du catalogue FinderQC, TOUS les produits (avec ou
// sans QC). L'API s'arrête à 10 000 résultats par filtre : on découpe chaque plateforme en tranches de prix assez
// fines pour rester sous cette limite (la largeur s'adapte toute seule). Chaque produit est ajouté ou mis à jour
// (nombre de QC, ventes), et les items Weidian partent dans la file de découverte de boutiques (boutique entière
// indexée ensuite par GitHub). Un cycle complet, puis on recommence le lendemain pour les nouveautés.

const SYNC_PLATFORMS = ['Weidian', 'Taobao', 'Ali1688'];
// Avec une 2e base (Taobao et 1688, voir shard.js) : deux parcours en parallèle, chacun vers sa base.
export const SYNC_LANES = { all: { key: 'qcsync', platforms: SYNC_PLATFORMS }, weidian: { key: 'qcsync', platforms: ['Weidian'] },
  others: { key: 'qcsync:2', platforms: ['Taobao', 'Ali1688'] } };
const SYNC_PAGE_SIZE = 100;
const SYNC_LIMIT = 10000; // résultats max par filtre côté FinderQC
const SYNC_MAX_CENTS = 2000000; // au-delà de 20 000 ¥ : une dernière tranche ouverte
const SYNC_PAGES_PER_RUN = 8; // temps CPU limité, et FinderQC doit rester disponible pour les fenêtres QC
// Exécution dédiée (SELF, chaque minute) : plus de pages, toujours sous la limite de 50 requêtes par exécution.
export const SYNC_PAGES_DEDICATED = 6; // 10 faisait encore limiter le bot par FinderQC (28/10)
const SYNC_PAGE_GAP_MS = 400; // petite pause entre deux pages : FinderQC reste disponible pour les membres

// Un produit du catalogue FinderQC (liste ou recherche) → enregistrement de l'item (titre, prix, ventes, nombre de
// QC) ; un item déjà connu n'est réécrit que si quelque chose a changé. Item Weidian sans boutique connue : sa
// boutique sera retrouvée puis indexée en entier.
// Clé « plateforme:numéro » d'un produit FinderQC (null si inconnu).
export function finderKey(x) {
  const platform = PLATFORMS[x.mallType];
  const id = String(x.itemId || '');
  return platform && /^\d{6,14}$/.test(id) ? `${platform}:${id}` : null;
}

export function finderItemStatements(env, x, now = Date.now()) {
  const platform = PLATFORMS[x.mallType];
  const id = String(x.itemId || '');
  if (!platform || !/^\d{6,14}$/.test(id)) return [];
  const key = `${platform}:${id}`;
  const title = x.enTitle || x.originalTitle || null;
  const qc = Math.max(0, Number(x.qcPhotosCount) || 0);
  const image = /^https:\/\//.test(x.originalThubnaiURL || x.picUrl || '') ? (x.originalThubnaiURL || x.picUrl) : null;
  const stmts = [env.DB.prepare(
    `INSERT INTO items (id, platform, item_id, title_en, price_cny, image, url, popularity, source, first_seen, category, qc_count, qc_checked_at, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finderqc', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET qc_count = excluded.qc_count, qc_checked_at = excluded.qc_checked_at,
       popularity = MAX(items.popularity, excluded.popularity), image = COALESCE(items.image, excluded.image),
       title_en = COALESCE(items.title_en, excluded.title_en), price_cny = COALESCE(items.price_cny, excluded.price_cny)
     WHERE items.qc_count IS NOT excluded.qc_count OR items.popularity < excluded.popularity
       OR items.image IS NULL OR items.title_en IS NULL`,
  ).bind(key, platform, id, title ? String(title).slice(0, 200) : null, x.cnPrice != null ? Number(x.cnPrice) : null,
    image, canonicalUrl(platform, id), Math.max(0, Number(x.oneYear) || 0), now, detectCategory(title), qc, now,
    isDeadLink(title, x.cnPrice) ? 2 : x.isAdult || ADULT.test(String(title || "")) ? 1 : 0)];
  if (platform === 'weidian') {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO link_queue (item_id, source, added_at)
       SELECT ?, 'finderqc', ? WHERE NOT EXISTS (SELECT 1 FROM items WHERE id = ? AND shop_id IS NOT NULL)`,
    ).bind(id, now, key));
  }
  return stmts;
}

async function listPage(filter, page) {
  const qs = new URLSearchParams({ ...filter, page: String(page), pageSize: String(SYNC_PAGE_SIZE) });
  const res = await fetch(`https://server.finderqc.com/api/spu/webSpuList?${qs}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  if (!data || data.code !== 0 || !data.data) throw new Error('FinderQC : réponse inattendue');
  return { list: data.data.list || [], total: Number(data.data.total) || 0 };
}

const yuan = (cents) => (cents / 100).toFixed(2);

function sliceFilter(state, platforms) {
  const last = state.lo >= SYNC_MAX_CENTS;
  return {
    mallType: platforms[state.plat],
    minPrice: yuan(state.lo),
    maxPrice: last ? '9999999' : yuan(state.lo + state.w - 1),
  };
}

export async function syncQcCatalog(env, lane = SYNC_LANES.all, pagesPerRun = SYNC_PAGES_PER_RUN) {
  const day = new Date().toISOString().slice(0, 10);
  // Position du parcours dans Upstash (sinon les réglages) : elle doit s'enregistrer même si la base refuse les écritures.
  let raw = await kvGet(env, `${lane.key}:state`);
  if (!raw) raw = ((await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(lane.key).first().catch(() => null)) || {}).value;
  let state = null;
  try { state = raw ? JSON.parse(raw) : null; } catch {}
  if (!state || state.v !== 2 || (state.done && state.cycle !== day)) {
    state = { v: 2, cycle: day, plat: 0, lo: 0, w: 1000, page: 1, done: false, seen: 0 };
  }
  if (state.done || (state.pauseUntil && Date.now() < state.pauseUntil)) return 0;
  // Un membre vient d'être limité par FinderQC : pas de synchro pendant 10 min.
  if (await finderPaused(env)) return 0;
  // Un seul passage à la fois par parcours (il tourne chaque minute et toutes les 3 minutes).
  const lockKey = `${lane.key}:lock`;
  const fast = await kvLock(env, lockKey, 60);
  if (fast === false) return 0;
  if (fast === undefined) {
    const lock = await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?3 RETURNING value`,
    ).bind(lockKey, String(Date.now() + 50000), Date.now()).first();
    if (!lock) return 0;
  }
  try {
    return await syncLane(env, lane, state, pagesPerRun);
  } finally {
    if (fast) await kvDel(env, lockKey);
    else await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = ?").bind(lockKey).run().catch(() => {});
  }
}

async function syncLane(env, lane, state, pagesPerRun = SYNC_PAGES_PER_RUN) {
  let external = 0;
  const used = () => external + (env.DB.calls || 0);
  // Un budget par base du catalogue : un produit dont la base a épuisé le sien est sauté (il reviendra au tour suivant).
  // Seulement les bases où vont les plateformes de ce parcours.
  const laneDbs = new Set(lane.platforms.map((p) => itemDb(env, `${PLATFORMS[p]}:0`)));
  const shards = await Promise.all(perDb(env).filter((e) => laneDbs.has(e.DB))
    .map(async (e) => ({ e, b: (await readsOver(e)) ? { left: 0 } : await budget(e, 'qcsync'), written: 0, rows: 0 }))); // base aux lectures bloquées : sautée
  const open = (db) => shards.find((x) => x.e.DB === db && x.written < x.b.left);
  if (!shards.some((x) => x.b.left)) return 0;

  const now = Date.now();
  let stmts = [];
  let written = 0;
  let pages = 0;
  const flush = async () => {
    if (!stmts.length) return;
    const out = stmts;
    stmts = [];
    for (const [db, results] of await batchByDb(out)) {
      const x = shards.find((y) => y.e.DB === db);
      const r = rowsWritten(results);
      x.rows = x.rows == null || r == null ? null : x.rows + r;
    }
  };
  while (used() < 40 && shards.some((x) => x.written < x.b.left) && pages < pagesPerRun) {
    if (state.plat >= lane.platforms.length) { state.done = true; break; }
    let page;
    try {
      page = await listPage(sliceFilter(state, lane.platforms), state.page);
      external++;
      pages++;
    } catch (err) {
      console.log('synchro QC', String(err).slice(0, 100));
      // FinderQC demande de ralentir : pause de 15 min (les fenêtres QC des membres passent avant la synchro).
      if (/429/.test(String(err))) { state.pauseUntil = Date.now() + 15 * 60000; await finderBusy(env); }
      break;
    }
    if (SYNC_PAGE_GAP_MS) await new Promise((r) => setTimeout(r, SYNC_PAGE_GAP_MS));
    // Tranche trop large (plus de 10 000 produits) : on la coupe en deux et on recommence.
    if (state.page === 1 && page.total >= SYNC_LIMIT && state.w > 1 && state.lo < SYNC_MAX_CENTS) {
      state.w = Math.max(1, Math.floor(state.w / 2));
      continue;
    }
    for (const x of page.list) {
      const shard = open(itemDb(env, finderKey(x)));
      if (!shard) continue;
      const out = finderItemStatements(shard.e, x, now);
      if (!out.length) continue;
      stmts.push(...out.map((st) => [shard.e.DB, st]));
      shard.written++;
      written++;
      state.seen++;
    }
    if (stmts.length >= 300) await flush();
    const lastPage = page.list.length < SYNC_PAGE_SIZE || state.page * SYNC_PAGE_SIZE >= Math.min(page.total, SYNC_LIMIT);
    if (lastPage) {
      // Tranche finie : la suivante, plus large si celle-ci était creuse, plus fine si elle était pleine.
      if (state.lo >= SYNC_MAX_CENTS) {
        state.plat++;
        state.lo = 0;
        state.w = 1000;
      } else {
        state.lo += state.w;
        if (page.total < 3000) state.w *= 2;
        else if (page.total > 7000) state.w = Math.max(1, Math.floor(state.w * 0.7));
      }
      state.page = 1;
    } else state.page++;
  }
  await flush();
  for (const x of shards) if (x.written) await x.b.use(x.written, x.rows);
  if (!(await kvSet(env, `${lane.key}:state`, JSON.stringify(state)))) {
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(lane.key, JSON.stringify(state)).run();
  }
  if (written) await logEvent(env, 'sync', `${written} articles ${lane.platforms.join(' / ')} synchronisés`).catch(() => {});
  return written;
}
