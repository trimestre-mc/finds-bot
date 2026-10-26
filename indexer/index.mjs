// Indexeur Weidian : ouvre chaque boutique dans Chromium (comme un visiteur normal)
// et lit la liste de ses items, page par page, avec la même API que le site.
//
// Variables : WORKER_URL, INDEXER_SECRET
// Test local sans Worker : SHOP=1784277725 node index.mjs

import { chromium } from 'playwright';
import { collectJadeship } from './jadeship.mjs';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SECRET = process.env.INDEXER_SECRET || '';
const LOCAL_SHOP = process.env.SHOP || '';
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 5000);
const PAGE_DELAY_MS = 400;
const SHOP_DELAY_MS = 3000;
const TIME_BUDGET_MS = 40 * 60 * 1000;
const ITEM_DELAY_MS = 1500;
const CONCURRENCY = 1;
// Plusieurs jobs GitHub tournent en parallèle, chacun avec sa part des boutiques et des items.
const SHARD = Number(process.env.SHARD || 0);
const SHARDS = Number(process.env.SHARDS || 1);
const SHARD_QS = `&shard=${SHARD}&shards=${SHARDS}`;
const LIST_API = 'getCateItemListForCommonItemSection';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

class StopAll extends Error {}

async function api(path, body) {
  const res = await fetch(WORKER_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Worker ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Deux variantes du contexte selon la mise en page de la boutique : on essaie les deux.
const CTX_VARIANTS = (shopId) => [
  `0;0;0;${shopId};0;1;1;0;0;-1;1;0;0;0;0`,
  `0;0;0;${shopId};0;0;0;0;0;-1;1;0;0;0;0`,
];

function listUrl(shopId, ctx, cateId, start, wdOffset, fxOffset) {
  const param = {
    ctx, sectionId: 501, shopId: String(shopId), cateId: String(cateId),
    wdOffset, fxOffset, limitStart: start, limitNum: 20, sort: 0,
  };
  return `https://thor.weidian.com/decorate/shopDetail.sync.${LIST_API}/1.0?param=${encodeURIComponent(JSON.stringify(param))}`;
}

function looksBlocked(url) {
  return /captcha|verify|punish|risk|slide/i.test(url);
}

// Ouvre la boutique comme un visiteur (les appels de liste se font ensuite depuis cette page).
async function openShop(page, shopId) {
  let ctx = null;
  const onRequest = (req) => {
    if (ctx || !req.url().includes(LIST_API)) return;
    try { ctx = JSON.parse(new URL(req.url()).searchParams.get('param')).ctx; } catch {}
  };
  page.on('request', onRequest);
  await page.goto(`https://weidian.com/?userid=${shopId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 6 && !ctx; i++) {
    await sleep(1000);
    if (looksBlocked(page.url())) throw new StopAll(`Weidian demande une vérification (${page.url().slice(0, 80)})`);
    await page.mouse.wheel(0, 2000).catch(() => {});
  }
  page.off('request', onRequest);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
  if (/店铺不存在/.test(body)) throw new Error('boutique introuvable sur Weidian');
  const title = (await page.title()).trim();
  const contexts = [...new Set([ctx, ...CTX_VARIANTS(shopId)].filter(Boolean))];
  return { contexts, shopName: title && title !== '微店' ? title : null };
}

async function fetchJson(page, url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: { code: -1, message: `HTTP ${res.status}: ${text.slice(0, 120)}` } }; }
  }, url);
}

// Catégories de la boutique (feuilles de l'arbre).
async function shopCategories(page, shopId) {
  const url = `https://thor.weidian.com/decorate/itemCate.getCateTree/1.0?param=${encodeURIComponent(JSON.stringify({ shopId: String(shopId), attrQuery: [], from: 'h5' }))}`;
  const data = await fetchJson(page, url);
  const leaves = [];
  const walk = (list) => (list || []).forEach((c) => (c.childCateList && c.childCateList.length ? walk(c.childCateList) : leaves.push(c.cateId)));
  walk(data && data.result && data.result.cateList);
  return leaves;
}

// Lit tous les items d'une boutique : la liste « tout » (deux contextes), puis chaque catégorie.
// onBatch reçoit seulement les items pas encore vus.
async function crawlShop(page, shopId, onBatch) {
  const { contexts, shopName } = await openShop(page, shopId);
  const seen = new Set();
  let refused = 0;

  const listCategory = async (ctx, cateId) => {
    let start = 0;
    let wdOffset = 0;
    let fxOffset = 0;
    for (let p = 0; p < 300 && seen.size < MAX_ITEMS; p++) {
      const data = await fetchJson(page, listUrl(shopId, ctx, cateId, start, wdOffset, fxOffset));
      const code = data && data.status ? data.status.code : -1;
      if (code !== 0) {
        const msg = data && data.status ? `${data.status.code} ${data.status.message}` : 'réponse vide';
        if (/risk|captcha|verify|频繁|限制/i.test(msg)) throw new StopAll(`Weidian bloque : ${msg}`);
        refused++;
        return;
      }
      const r = data.result || {};
      const list = r.itemList || [];
      const fresh = list.filter((i) => i.itemId && !seen.has(i.itemId));
      fresh.forEach((i) => seen.add(i.itemId));
      if (fresh.length) {
        await onBatch(fresh.map((i) => ({
          itemId: i.itemId, name: i.itemName, price: i.price, img: i.itemImg, stock: i.stock,
        })), shopName);
      }
      if (!r.hasData || !list.length || (!fresh.length && p > 0)) return;
      start += list.length;
      wdOffset = r.wdOffset != null ? r.wdOffset : wdOffset;
      fxOffset = r.fxOffset != null ? r.fxOffset : fxOffset;
      await sleep(PAGE_DELAY_MS);
    }
  };

  for (const ctx of contexts) await listCategory(ctx, 0);
  const cats = await shopCategories(page, shopId);
  for (const cateId of cats) {
    if (seen.size >= MAX_ITEMS) break;
    await listCategory(contexts[0], cateId);
  }
  if (!seen.size && refused) throw new Error('liste refusée par Weidian');
  return { count: seen.size, shopName, categories: cats.length };
}

// Page produit Weidian publique : photos, boutique et titre (déjà en anglais pour les visiteurs étrangers).
async function fetchItemPage(itemId) {
  const res = await fetch(`https://weidian.com/item.html?itemID=${itemId}`);
  if (res.status === 429 || res.status === 403) throw new StopAll(`Weidian refuse (${res.status})`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).replaceAll('&#34;', '"').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  const block = (html.match(/"imgs"\s*:\s*\[([^\]]*)\]/) || [])[1] || '';
  return {
    images: [...new Set((block.match(/https:\/\/[^"]+/g) || []).map((u) => u.split('?')[0]))].slice(0, 8),
    shopId: (html.match(/"shop_id"\s*:\s*"?(\d+)/) || [])[1] || null,
    shopName: (html.match(/"shopName"\s*:\s*"([^"]+)"/) || [])[1] || null,
    title: (html.match(/"item_name"\s*:\s*"([^"]+)"/) || [])[1] || null,
  };
}

// Lit des pages produit en parallèle (CONCURRENCY à la fois), envoie les résultats par lots.
// S'arrête si Weidian refuse ou après 8 erreurs d'affilée.
async function crawlItemPages(itemIds, endpoint, label, budgetMs) {
  let i = 0;
  let errors = 0;
  let stop = null;
  let batch = [];
  let sent = 0;
  let shopsAdded = 0;
  const flush = async () => {
    if (!batch.length) return;
    const out = batch;
    batch = [];
    const r = await api(endpoint, { items: out });
    sent += out.length;
    shopsAdded += r.shopsAdded || 0;
  };
  const worker = async () => {
    while (!stop && i < itemIds.length) {
      if (Date.now() - started > budgetMs) { stop = 'temps écoulé, la suite au prochain passage'; break; }
      const itemId = itemIds[i++];
      try {
        batch.push({ itemId, ...(await fetchItemPage(itemId)) });
        errors = 0;
      } catch (err) {
        if (err instanceof StopAll) { stop = err.message; break; }
        batch.push({ itemId, images: [] });
        if (++errors >= 8) { stop = `8 erreurs d'affilée (${err.message})`; break; }
      }
      if (batch.length >= 100) await flush();
      await sleep(ITEM_DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();
  console.log(`${label} : ${sent} pages lues${shopsAdded ? `, ${shopsAdded} boutique(s) découverte(s)` : ''}${stop ? ` (arrêt : ${stop})` : ''}`);
}

// Retrouve la boutique des items trouvés (Jadeship, salons Discord, ajout en masse).
async function resolveLinks() {
  const { items } = await api(`/api/indexer/link-queue?limit=2000${SHARD_QS}`);
  if (items.length) await crawlItemPages(items, '/api/indexer/resolved', `🔍 ${items.length} items à rattacher`, TIME_BUDGET_MS / 3);
}

// Photos + titre anglais des items indexés.
async function fillImages() {
  const { items } = await api(`/api/indexer/missing-images?limit=8000${SHARD_QS}`);
  if (items.length) await crawlItemPages(items, '/api/indexer/images', `📸 ${items.length} items sans photos`, TIME_BUDGET_MS);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    if (LOCAL_SHOP) {
      let total = 0;
      const res = await crawlShop(page, LOCAL_SHOP, async (items) => {
        total += items.length;
        if (total <= 20) items.slice(0, 3).forEach((i) => console.log(`  ${i.itemId} · ¥${i.price} · ${i.name}`));
      });
      console.log(`Boutique ${LOCAL_SHOP} (${res.shopName || '?'}) : ${res.count} items`);
      return;
    }

    if (!WORKER_URL || !SECRET) throw new Error('WORKER_URL et INDEXER_SECRET sont requis');
    const first = await api(`/api/indexer/jobs?x=1${SHARD_QS}`);
    if (SHARD === 0 && first.jadeship && !process.env.SKIP_JADESHIP) {
      console.log('🟢 Collecte Jadeship');
      try {
        const r = await collectJadeship((data) => api('/api/indexer/jadeship', data), (m) => console.log(m));
        console.log(`🟢 Jadeship : ${r.items} items, ${r.shops} boutiques Weidian`);
      } catch (err) {
        console.log(`Jadeship : ${err.message}`);
      }
    }
    await resolveLinks();
    const { shops } = await api(`/api/indexer/jobs?x=1${SHARD_QS}`);
    console.log(`${shops.length} catalogue(s) à indexer`);

    for (const shop of shops) {
      if (Date.now() - started > TIME_BUDGET_MS) { console.log('Temps écoulé, la suite au prochain passage.'); break; }
      const { runId } = await api('/api/indexer/start', { shopId: shop.id });
      try {
        // On compare avec ce qui est déjà en base : seuls les items nouveaux, modifiés ou disparus sont envoyés.
        const state = new Map((await api(`/api/indexer/shop-state?shopId=${shop.id}`)).items.map(([id, price, name]) => [String(id), [price, name]]));
        const found = [];
        let shopName = null;
        const res = await crawlShop(page, shop.id, async (items, name) => { found.push(...items); shopName = name || shopName; });
        const changed = found.filter((i) => {
          const old = state.get(String(i.itemId));
          return !old || Number(old[0]) !== Number(i.price) || (old[1] || '') !== (i.name || '');
        });
        for (let i = 0; i < changed.length; i += 200) {
          await api('/api/indexer/items', { shopId: shop.id, runId, shopName, items: changed.slice(i, i + 200) });
        }
        // Items disparus de la boutique (seulement si la lecture est complète).
        const seen = new Set(found.map((i) => String(i.itemId)));
        const gone = res.count && res.count < MAX_ITEMS ? [...state.keys()].filter((id) => !seen.has(id)) : [];
        for (let i = 0; i < gone.length; i += 500) {
          await api('/api/indexer/removed', { shopId: shop.id, runId, ids: gone.slice(i, i + 500) });
        }
        const done = await api('/api/indexer/finish', { shopId: shop.id, runId, ok: res.count > 0, error: res.count ? null : 'aucun item trouvé' });
        console.log(`✅ ${shop.id} (${res.shopName || shop.name || '?'}) : ${res.count} items lus, ${changed.length} nouveaux ou modifiés, ${gone.length} disparus, ${done.items ?? 0} en base`);
      } catch (err) {
        console.log(`❌ ${shop.id} : ${err.message}`);
        await api('/api/indexer/finish', { shopId: shop.id, runId, ok: false, error: err.message }).catch(() => {});
        if (err instanceof StopAll) { console.log('Arrêt : Weidian demande une vérification. Rien n\'est contourné, on réessaiera plus tard.'); break; }
      }
      await sleep(SHOP_DELAY_MS);
    }
    await fillImages();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
