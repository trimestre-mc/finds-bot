// Enregistrement des items « populaires » venus d'une source externe (Jadeship, items similaires FinderQC).

import { canonicalUrl } from './links.js';
import { detectCategory, isDeadLink } from './categories.js';

// Requêtes d'insertion / mise à jour (à exécuter en lot). items = [{ platform, id, title, price, image, sold }].
export function popularItemStatements(env, items, source) {
  const now = Date.now();
  const valid = items.filter((i) => canonicalUrl(i.platform, i.id) && /^\d{6,14}$/.test(String(i.id))).slice(0, 300);
  const stmts = valid.map((i) => env.DB.prepare(
    `INSERT INTO items (id, platform, item_id, title_en, price_cny, image, url, popularity, source, first_seen, category, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET popularity = MAX(items.popularity, excluded.popularity),
       title_en = COALESCE(items.title_en, excluded.title_en), price_cny = COALESCE(items.price_cny, excluded.price_cny),
       image = COALESCE(items.image, excluded.image)`,
  ).bind(`${i.platform}:${i.id}`, i.platform, String(i.id), i.title ? String(i.title).slice(0, 200) : null,
    i.price != null ? Number(i.price) : null, /^https:\/\//.test(i.image || '') ? i.image : null,
    canonicalUrl(i.platform, i.id), Math.max(0, Number(i.sold) || 0), source, now, detectCategory(i.title),
    isDeadLink(i.title, i.price) ? 2 : 0));
  // Items Weidian sans boutique connue : on retrouvera leur boutique (puis toute la boutique sera indexée).
  for (const i of valid.filter((x) => x.platform === 'weidian')) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO link_queue (item_id, source, added_at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM items WHERE id = ? AND shop_id IS NOT NULL)`,
    ).bind(String(i.id), source, now, `weidian:${i.id}`));
  }
  return { stmts, count: valid.length };
}
