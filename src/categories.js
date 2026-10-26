// Catégories détectées depuis le titre (anglais et chinois). Servent aux filtres, aux drops et aux tags de forum.

export const CATEGORIES = [
  { key: 'shoes', label: 'Chaussures', en: 'Shoes', emoji: '👟',
    re: /\b(shoes?|sneakers?|trainers?|boots?|slides?|sandals?|loafers?|slippers?|clogs?|runners?|jordan|dunk|yeezy|air ?max|air ?force|af1|new ?balance|nb ?\d{3,4}|samba|gazelle|asics|salomon|mules?|derbys?)\b|鞋|靴|拖鞋|凉鞋/i },
  { key: 'hoodies', label: 'Sweats & hoodies', en: 'Hoodies', emoji: '🧥',
    re: /\b(hoodies?|hoody|sweatshirts?|crew ?necks?|zip[- ]?ups?|half[- ]?zip|quarter[- ]?zip|pullover)\b|卫衣|帽衫/i },
  { key: 'tees', label: 'T-shirts & polos', en: 'Tees', emoji: '👕',
    re: /\b(t-?shirts?|tees?|polos?|short[- ]sleeves?|tank ?tops?|jerseys?)\b|短袖|T恤|背心|polo/i },
  { key: 'knit', label: 'Pulls & chemises', en: 'Knitwear & shirts', emoji: '🧶',
    re: /\b(sweaters?|knit(wear|ted)?|cardigans?|jumpers?|turtlenecks?|shirts?|long[- ]sleeves?|button[- ]?ups?|flannels?)\b|毛衣|针织|衬衫|长袖/i },
  { key: 'jackets', label: 'Vestes & manteaux', en: 'Jackets', emoji: '🧥',
    re: /\b(jackets?|coats?|puffers?|parkas?|down|windbreakers?|blazers?|bombers?|gilets?|vests?|fleece|anorak|shell)\b|夹克|外套|羽绒|大衣|冲锋衣|马甲/i },
  { key: 'pants', label: 'Pantalons & shorts', en: 'Pants & shorts', emoji: '👖',
    re: /\b(pants|trousers|jeans|denim|shorts|joggers?|sweatpants|cargos?|leggings|skirts?)\b|裤|牛仔|裙/i },
  { key: 'bags', label: 'Sacs', en: 'Bags', emoji: '👜',
    re: /\b(bags?|backpacks?|totes?|handbags?|crossbody|duffle|pouch|clutch|purse)\b|包|背包|手袋/i },
  { key: 'jewelry', label: 'Bijoux & montres', en: 'Jewelry & watches', emoji: '💍',
    re: /\b(necklaces?|bracelets?|rings?|earrings?|pendants?|chains?|watch(es)?|bangles?|brooch)\b|项链|手镯|手链|戒指|耳环|手表|吊坠/i },
  { key: 'accessories', label: 'Accessoires', en: 'Accessories', emoji: '🧢',
    re: /\b(hats?|caps?|beanies?|belts?|scarf|scarves|sunglasses|glasses|wallets?|socks|gloves|ties?|keychains?|card ?holders?|bucket)\b|帽|腰带|皮带|围巾|墨镜|眼镜|钱包|袜|手套/i },
  { key: 'tech', label: 'Tech & maison', en: 'Tech & home', emoji: '🎧',
    re: /\b(airpods?|headphones?|earbuds?|phone ?cases?|iphone|chargers?|speakers?|lego|toys?|figures?|plush|perfume|fragrance|candles?|blankets?|pillows?)\b|耳机|手机壳|玩具|香水|乐高/i },
];

export const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

import { budget } from './budget.js';

// Ordre important : les chaussures avant le reste (« running shoes » ≠ « shorts »), sacs avant accessoires.
export function detectCategory(title) {
  const t = String(title || '');
  if (!t) return 'other';
  for (const c of CATEGORIES) if (c.re.test(t)) return c.key;
  return 'other';
}

// Choisit le tag d'un forum qui correspond à la catégorie (par nom, en français ou en anglais).
export function forumTagFor(tags, category) {
  const c = CATEGORY_BY_KEY[category];
  if (!c || !Array.isArray(tags)) return null;
  const words = [c.label, c.en, c.key, ...c.label.split(/\s*&\s*/), ...c.en.split(/\s*&\s*/)].map((w) => w.toLowerCase());
  const found = tags.find((t) => words.some((w) => w && String(t.name).toLowerCase().includes(w)));
  return found ? found.id : null;
}

// Catégorise les items qui ne le sont pas encore (quand le titre anglais est connu ou que la traduction a abandonné).
// Sans titre anglais au bout du délai d'attente, on catégorise avec les mots chinois (recalculé plus tard si « autre »).
// Quand il n'y a plus rien à catégoriser, on fait une pause d'une heure (la requête lirait toute la table).
let idleUntil = 0;

export async function categorizePending(env, limit, waitMs = 30 * 60000) {
  if (Date.now() < idleUntil) return 0;
  const b = await budget(env, 'categorize');
  if (!b.left) return 0;
  limit = Math.min(limit, b.left);
  const { results } = await env.DB.prepare(
    `SELECT id, title_en, title_zh FROM items
     WHERE category IS NULL AND (title_en IS NOT NULL OR translate_failed >= 3 OR manual = 1 OR first_seen < ?) LIMIT ?`,
  ).bind(Date.now() - waitMs, limit).all();
  if (results.length < limit) idleUntil = Date.now() + 3600000;
  if (!results.length) return 0;
  const stmts = results.map((r) => env.DB.prepare('UPDATE items SET category = ? WHERE id = ?')
    .bind(detectCategory(`${r.title_en || ''} ${r.title_zh || ''}`), r.id));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await b.use(results.length);
  return results.length;
}
