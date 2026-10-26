// Indexeur Weidian : ouvre chaque boutique dans Chromium (comme un visiteur normal)
// et lit la liste de ses items, page par page, avec la même API que le site.
//
// Variables : WORKER_URL, INDEXER_SECRET
// Test local sans Worker : SHOP=1784277725 node index.mjs

import { chromium } from 'playwright';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SECRET = process.env.INDEXER_SECRET || '';
const LOCAL_SHOP = process.env.SHOP || '';
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 5000);
const PAGE_DELAY_MS = 600;
const SHOP_DELAY_MS = 3000;
const TIME_BUDGET_MS = 40 * 60 * 1000;
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

function fallbackListUrl(shopId) {
  const param = {
    ctx: `0;0;0;${shopId};0;0;0;0;0;-1;1;0;0;0;0`,
    sectionId: 501, shopId: String(shopId), cateId: '0',
    wdOffset: 0, fxOffset: 0, limitStart: 0, limitNum: 20, sort: 0,
  };
  return `https://thor.weidian.com/decorate/shopDetail.sync.${LIST_API}/1.0?param=${encodeURIComponent(JSON.stringify(param))}`;
}

function looksBlocked(url) {
  return /captcha|verify|punish|risk|slide/i.test(url);
}

// Ouvre la boutique et récupère l'URL de liste que la page appelle elle-même.
async function openShop(page, shopId) {
  let listUrl = null;
  const onRequest = (req) => { if (!listUrl && req.url().includes(LIST_API)) listUrl = req.url(); };
  page.on('request', onRequest);
  await page.goto(`https://weidian.com/?userid=${shopId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 12 && !listUrl; i++) {
    await sleep(1000);
    if (looksBlocked(page.url())) throw new StopAll(`Weidian demande une vérification (${page.url().slice(0, 80)})`);
    await page.mouse.wheel(0, 2000).catch(() => {});
  }
  page.off('request', onRequest);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
  if (/店铺不存在/.test(body)) throw new Error('boutique introuvable sur Weidian');
  const title = (await page.title()).trim();
  return { listUrl: listUrl || fallbackListUrl(shopId), shopName: title && title !== '微店' ? title : null };
}

async function fetchListPage(page, url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: { code: -1, message: `HTTP ${res.status}: ${text.slice(0, 120)}` } }; }
  }, url);
}

// Parcourt toutes les pages de la liste et appelle onBatch avec les nouveaux items.
async function crawlShop(page, shopId, onBatch) {
  const { listUrl, shopName } = await openShop(page, shopId);
  const u = new URL(listUrl);
  const param = JSON.parse(u.searchParams.get('param'));
  param.limitNum = 20;
  const seen = new Set();
  let start = 0;
  let wdOffset = param.wdOffset || 0;
  let fxOffset = param.fxOffset || 0;

  while (seen.size < MAX_ITEMS) {
    Object.assign(param, { limitStart: start, wdOffset, fxOffset });
    u.searchParams.set('param', JSON.stringify(param));
    const data = await fetchListPage(page, u.toString());
    const code = data && data.status ? data.status.code : -1;
    if (code !== 0) {
      const msg = data && data.status ? `${data.status.code} ${data.status.message}` : 'réponse vide';
      if (/risk|captcha|verify|频繁|限制/i.test(msg)) throw new StopAll(`Weidian bloque : ${msg}`);
      if (start === 0) throw new Error(`liste refusée : ${msg}`);
      break;
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
    if (!r.hasData || !list.length || !fresh.length) break;
    start += list.length;
    wdOffset = r.wdOffset != null ? r.wdOffset : wdOffset;
    fxOffset = r.fxOffset != null ? r.fxOffset : fxOffset;
    await sleep(PAGE_DELAY_MS);
  }
  return { count: seen.size, shopName };
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
    const { shops } = await api('/api/indexer/jobs');
    console.log(`${shops.length} catalogue(s) à indexer`);

    for (const shop of shops) {
      if (Date.now() - started > TIME_BUDGET_MS) { console.log('Temps écoulé, la suite au prochain passage.'); break; }
      const { runId } = await api('/api/indexer/start', { shopId: shop.id });
      try {
        const res = await crawlShop(page, shop.id, async (items, shopName) => {
          for (let i = 0; i < items.length; i += 200) {
            await api('/api/indexer/items', { shopId: shop.id, runId, shopName, items: items.slice(i, i + 200) });
          }
        });
        const done = await api('/api/indexer/finish', { shopId: shop.id, runId, ok: res.count > 0, error: res.count ? null : 'aucun item trouvé' });
        console.log(`✅ ${shop.id} (${res.shopName || shop.name || '?'}) : ${res.count} items lus, ${done.items ?? 0} en base`);
      } catch (err) {
        console.log(`❌ ${shop.id} : ${err.message}`);
        await api('/api/indexer/finish', { shopId: shop.id, runId, ok: false, error: err.message }).catch(() => {});
        if (err instanceof StopAll) { console.log('Arrêt : Weidian demande une vérification. Rien n\'est contourné, on réessaiera plus tard.'); break; }
      }
      await sleep(SHOP_DELAY_MS);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
