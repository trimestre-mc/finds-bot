// Collecte Jadeship (avec l'autorisation de Jadeship) : Best Items, Live Feed et annuaire des vendeurs.
// Rythme lent (une page toutes les 2 s, toutes les 6 h) et identifiant clair du bot.

const BASE = 'https://www.jadeship.com';
const UA = 'finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)';
const DELAY_MS = 2000;
const PLATFORMS = ['weidian', 'taobao', '1688'];
const TIMEFRAMES = ['24-hours', '7-days', '30-days', '3-months', '1-year'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': UA } });
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`Jadeship ${path} -> ${res.status}`);
  const html = await res.text();
  if (/\/blocked\/|rate limit/i.test(res.url) || /You hit your daily rate limit/i.test(html)) throw new Error('Jadeship : limite atteinte');
  return html;
}

// Données de la page (flux React Server Components de Next.js).
function payload(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)];
  return chunks.map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } }).join('');
}

// Extrait chaque tableau JSON qui suit une clé donnée (ex. "initialItems":[...]).
function arraysAfter(text, key) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(`"${key}":[`, from);
    if (i < 0) break;
    let j = text.indexOf('[', i);
    const start = j;
    let depth = 0;
    let inStr = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) break;
    }
    try { out.push(JSON.parse(text.slice(start, j + 1))); } catch {}
    from = j;
  }
  return out;
}

function platformOf(g) {
  const p = String(g.platform || '').toLowerCase();
  if (p === 'ali_1688') return '1688';
  if (p) return p;
  const link = String(g.goodsLink || '');
  if (/weidian\.com/.test(link)) return 'weidian';
  if (/1688\.com/.test(link)) return '1688';
  if (/taobao\.com|tmall\.com/.test(link)) return 'taobao';
  return '';
}

// Infos produit seulement : les fils contiennent aussi des infos d'acheteurs, qu'on ignore.
export function parseFeedItems(html) {
  const items = [];
  const text = payload(html);
  for (const arr of [...arraysAfter(text, 'initialItems'), ...arraysAfter(text, 'items')]) {
    for (const g of arr) {
      const id = g && (g.goodsId || g.id);
      if (!id || !g.goodsTitle) continue;
      const platform = platformOf(g);
      if (!PLATFORMS.includes(platform)) continue;
      items.push({
        platform,
        id: String(id),
        title: g.goodsTitle || null,
        price: typeof g.goodsPrice === 'number' ? g.goodsPrice : parseFloat(g.goodsPrice) || null,
        image: typeof g.goodsPicUrl === 'string' && g.goodsPicUrl.startsWith('https://') ? g.goodsPicUrl : null,
        sold: Number(g.amountSold) || 0,
      });
    }
  }
  return items;
}

const WEIDIAN_SHOP = /weidian\.com\/\?userid=(\d{5,12})|shop(\d{5,12})\.v\.weidian\.com/g;

export function parseSellers(html) {
  const out = new Map();
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const name = (row.match(/href="\/seller\/([^"]+)"/) || [])[1];
    for (const m of row.matchAll(WEIDIAN_SHOP)) {
      const id = m[1] || m[2];
      if (!out.has(id)) out.set(id, name ? decodeURIComponent(name) : null);
    }
  }
  return out;
}

async function sellerList(path, log) {
  const all = new Map();
  for (let page = 1; page <= 20; page++) {
    const found = parseSellers(await get(`${path}?page=${page}`));
    let fresh = 0;
    for (const [id, name] of found) if (!all.has(id)) { all.set(id, name); fresh++; }
    await sleep(DELAY_MS);
    if (!fresh) break;
  }
  log(`  ${path} : ${all.size} boutiques Weidian`);
  return all;
}

// Collecte complète. send(batch) envoie au Worker ; renvoie un résumé.
export async function collectJadeship(send, log = console.log) {
  const items = new Map();
  const pages = [
    ...TIMEFRAMES.flatMap((tf) => PLATFORMS.map((pf) => `/feed/top/${tf}/${pf}?sort_by=amount_sold&display=grid`)),
    ...PLATFORMS.map((pf) => `/feed/live/${pf}?sort_by=time&display=grid`),
  ];
  for (const path of pages) {
    const found = parseFeedItems(await get(path));
    for (const it of found) {
      const key = `${it.platform}:${it.id}`;
      const prev = items.get(key);
      if (!prev || it.sold > prev.sold) items.set(key, prev ? { ...prev, ...it, title: prev.title || it.title } : it);
    }
    log(`  ${path.split('?')[0]} : ${found.length} items`);
    await sleep(DELAY_MS);
  }

  const shops = new Map();
  const tiers = [['/sellers/trusted', 'trusted'], ['/sellers/tag/High%20Tier', 'high'], ['/sellers/tag/Mid%20Tier', 'mid']];
  for (const [id, name] of await sellerList('/sellers/platform/weidian', log)) shops.set(id, { id, name, tier: null });
  for (const [path, tier] of tiers) {
    for (const [id, name] of await sellerList(path, log)) {
      const s = shops.get(id) || { id, name, tier: null };
      if (!s.tier) s.tier = tier;
      shops.set(id, s);
    }
  }

  const list = [...items.values()];
  for (let i = 0; i < list.length; i += 250) await send({ items: list.slice(i, i + 250) });

  await send({ shops: [...shops.values()], done: true });
  return { items: list.length, shops: shops.size };
}
