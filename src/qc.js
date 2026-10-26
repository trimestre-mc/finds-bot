// Photos QC, toujours affichées dans Discord (jamais de lien vers un site de QC) :
// - QC des agents via l'API FinderQC (avec l'accord de son propriétaire), mises en cache ;
// - QC postées par la communauté dans les salons QC.

import { COMPONENTS_V2, container, gallery, row, text, sep, escape } from './components.js';
import { discordApi, discordUpload } from './discord.js';
import { popularItemStatements } from './items.js';
import { canonicalUrl } from './links.js';
import { detectCategory } from './categories.js';
import { budget } from './budget.js';

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
    } catch (err) { console.log('repfind', String(err).slice(0, 100)); }
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
    `SELECT * FROM items WHERE hidden = 0 AND (popularity > 0 OR posted_count > 0 OR manual = 1)
       AND (qc_checked_at IS NULL OR qc_checked_at < ?)
     ORDER BY qc_checked_at IS NOT NULL, popularity DESC, posted_count DESC LIMIT ?`,
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
  const b = await budget(env, 'items');
  const take = found.slice(0, Math.min(10, b.left));
  if (take.length) {
    stmts.push(...popularItemStatements(env, take, 'finderqc').stmts);
    await b.use(take.length);
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
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
  await env.DB.prepare('UPDATE items SET qc_count = ?, qc_preview = ?, qc_checked_at = ? WHERE id = ?')
    .bind(qc.count, preview, checkedAt, item.id).run().catch((err) => console.log('qc cache', String(err).slice(0, 100)));
  return { ...item, qc_count: qc.count, qc_preview: preview, qc_checked_at: checkedAt, qc_running: qc.running };
}

// QC de la communauté pour un item : nombre de posts, de photos, et le plus récent.
export async function communityQc(env, itemId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS posts, COALESCE(SUM(images), 0) AS images,
       (SELECT guild_id || '/' || channel_id || '/' || message_id FROM qc_posts WHERE item_id = ? ORDER BY at DESC LIMIT 1) AS latest
     FROM qc_posts WHERE item_id = ?`,
  ).bind(itemId, itemId).first();
  return row && row.posts ? { posts: row.posts, images: row.images, jump: `https://discord.com/channels/${row.latest}` } : null;
}

// Bouton QC d'une carte : toujours présent, il ouvre les QC dans Discord (fenêtre visible par la personne qui clique).
export function qcButtons(item, community, lang = 'fr') {
  const en = lang === 'en';
  const n = (item.qc_count || 0) + (community ? community.images : 0);
  const label = n ? (en ? `View QC (${fmt(n)})` : `Voir les QC (${fmt(n)})`) : (en ? 'QC photos' : 'Photos QC');
  return [{ type: 2, style: 1, label, emoji: { name: '📸' }, custom_id: `pub:qc:${item.id}`.slice(0, 100) }];
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

// Fenêtre QC (dans Discord) : page `view` des lots d'agents, et les QC de la communauté en première page.
export async function qcWindow(env, item, view = 0, opts = {}) {
  const en = opts.lang === 'en';
  const first = view * BATCHES_PER_VIEW;
  const apiPage = Math.floor(first / BATCHES_PER_API_PAGE) + 1;
  const qc = await fetchQc(item, apiPage);
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
  const head = `## 📸 ${title}\n-# ${known ? (en ? `${fmt(known)} QC photos` : `${fmt(known)} photos QC`) : (en ? 'No agent QC yet' : 'Pas encore de QC d\'agents')}` +
    (batches.length ? `  ·  ${en ? 'batches' : 'lots'} ${first + 1}–${first + batches.length}${hasNext ? '' : ` / ${totalBatchesSeen}`}` : '');
  if (!blocks.length && qc.running) {
    blocks.push(text(en ? '⏳ QC photos for this item are being fetched right now. Come back in a few minutes.'
      : '⏳ Les photos QC de cet item sont en cours de récupération. Reviens dans quelques minutes.'));
  }
  if (!blocks.length && qc.failed) {
    blocks.push(text(en ? '⏳ The QC source is busy right now. Try again in a minute.'
      : '⏳ La source des QC est surchargée en ce moment. Réessaie dans une minute.'));
  }
  let ask = null;
  if (!blocks.length) {
    blocks.push(text(opts.qcChannel
      ? (en ? `No QC photos anywhere yet for this item. Bought it? Post your QC photos with the item link in <#${opts.qcChannel}>.`
        : `Aucune photo QC n'existe encore pour cet item. Tu l'as acheté ? Poste tes photos QC avec le lien de l'item dans <#${opts.qcChannel}> : elles apparaîtront ici.`)
      : (en ? 'Nobody has shared QC photos for this item yet.' : 'Personne n\'a encore partagé de QC pour cet item.')));
    // Pas de QC nulle part : on peut les demander à la communauté.
    if (opts.qcChannel) ask = row({ type: 2, style: 1, emoji: { name: '🙋' }, label: en ? 'Ask for QC' : 'Demander un QC', custom_id: `pub:qcreq:${item.id}`.slice(0, 100) });
  }
  const retry = qc.failed && !batches.length
    ? row({ type: 2, style: 1, emoji: { name: '🔄' }, label: en ? 'Retry' : 'Réessayer', custom_id: `pub:qcp:${item.id}:${view}` }) : null;
  const nav = (view > 0 || hasNext) ? row(
    { type: 2, style: 2, emoji: { name: '◀️' }, custom_id: `pub:qcp:${item.id}:${view - 1}`, disabled: view === 0 },
    { type: 2, style: 2, label: en ? 'More QC' : 'Plus de QC', emoji: { name: '▶️' }, custom_id: `pub:qcp:${item.id}:${view + 1}`, disabled: !hasNext },
  ) : null;
  return [container([text(head), sep(), ...blocks, nav, retry, ask], opts.accent || 0x5865f2)];
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
const SYNC_PAGE_SIZE = 100;
const SYNC_LIMIT = 10000; // résultats max par filtre côté FinderQC
const SYNC_MAX_CENTS = 2000000; // au-delà de 20 000 ¥ : une dernière tranche ouverte
const SYNC_PAGES_PER_RUN = 8; // temps CPU limité, et FinderQC doit rester disponible pour les fenêtres QC

async function listPage(filter, page) {
  const qs = new URLSearchParams({ ...filter, page: String(page), pageSize: String(SYNC_PAGE_SIZE) });
  const res = await fetch(`https://server.finderqc.com/api/spu/webSpuList?${qs}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  if (!data || data.code !== 0 || !data.data) throw new Error('FinderQC : réponse inattendue');
  return { list: data.data.list || [], total: Number(data.data.total) || 0 };
}

const yuan = (cents) => (cents / 100).toFixed(2);

function sliceFilter(state) {
  const last = state.lo >= SYNC_MAX_CENTS;
  return {
    mallType: SYNC_PLATFORMS[state.plat],
    minPrice: yuan(state.lo),
    maxPrice: last ? '9999999' : yuan(state.lo + state.w - 1),
  };
}

export async function syncQcCatalog(env) {
  let external = 0;
  const used = () => external + (env.DB.calls || 0);
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'qcsync'").first();
  let state = null;
  try { state = row ? JSON.parse(row.value) : null; } catch {}
  if (!state || state.v !== 2 || (state.done && state.cycle !== day)) {
    state = { v: 2, cycle: day, plat: 0, lo: 0, w: 1000, page: 1, done: false, seen: 0 };
  }
  if (state.done || (state.pauseUntil && Date.now() < state.pauseUntil)) return 0;
  const b = await budget(env, 'qcsync');
  if (!b.left) return 0;

  const now = Date.now();
  let stmts = [];
  let written = 0;
  let pages = 0;
  const flush = async () => {
    if (!stmts.length) return;
    const out = stmts;
    stmts = [];
    await env.DB.batch(out);
  };
  while (used() < 40 && written < b.left && pages < SYNC_PAGES_PER_RUN) {
    if (state.plat >= SYNC_PLATFORMS.length) { state.done = true; break; }
    let page;
    try {
      page = await listPage(sliceFilter(state), state.page);
      external++;
      pages++;
    } catch (err) {
      console.log('synchro QC', String(err).slice(0, 100));
      // FinderQC demande de ralentir : pause de 15 min (les fenêtres QC des membres passent avant la synchro).
      if (/429/.test(String(err))) state.pauseUntil = Date.now() + 15 * 60000;
      break;
    }
    // Tranche trop large (plus de 10 000 produits) : on la coupe en deux et on recommence.
    if (state.page === 1 && page.total >= SYNC_LIMIT && state.w > 1 && state.lo < SYNC_MAX_CENTS) {
      state.w = Math.max(1, Math.floor(state.w / 2));
      continue;
    }
    for (const x of page.list) {
      const platform = PLATFORMS[x.mallType];
      const id = String(x.itemId || '');
      if (!platform || !/^\d{6,14}$/.test(id)) continue;
      const key = `${platform}:${id}`;
      const title = x.enTitle || x.originalTitle || null;
      const qc = Math.max(0, Number(x.qcPhotosCount) || 0);
      const image = /^https:\/\//.test(x.originalThubnaiURL || x.picUrl || '') ? (x.originalThubnaiURL || x.picUrl) : null;
      stmts.push(env.DB.prepare(
        `INSERT INTO items (id, platform, item_id, title_en, price_cny, image, url, popularity, source, first_seen, category, qc_count, qc_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finderqc', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET qc_count = excluded.qc_count, qc_checked_at = excluded.qc_checked_at,
           popularity = MAX(items.popularity, excluded.popularity), image = COALESCE(items.image, excluded.image),
           title_en = COALESCE(items.title_en, excluded.title_en), price_cny = COALESCE(items.price_cny, excluded.price_cny)
         WHERE items.qc_count IS NOT excluded.qc_count OR items.popularity < excluded.popularity
           OR items.image IS NULL OR items.title_en IS NULL`,
      ).bind(key, platform, id, title ? String(title).slice(0, 200) : null, x.cnPrice != null ? Number(x.cnPrice) : null,
        image, canonicalUrl(platform, id), Math.max(0, Number(x.oneYear) || 0), now, detectCategory(title), qc, now));
      // Boutique Weidian inconnue : retrouvée puis indexée en entier par l'indexeur.
      if (platform === 'weidian') {
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO link_queue (item_id, source, added_at)
           SELECT ?, 'finderqc', ? WHERE NOT EXISTS (SELECT 1 FROM items WHERE id = ? AND shop_id IS NOT NULL)`,
        ).bind(id, now, key));
      }
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
  await b.use(written);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qcsync', ?)").bind(JSON.stringify(state)).run();
  return written;
}
