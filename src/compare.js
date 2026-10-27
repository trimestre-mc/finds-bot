// Comparateur de vendeurs (« batchs ») : le même article chez plusieurs vendeurs, trouvé par la recherche par image
// de FinderQC sur la photo de l'item, dans la même catégorie. Le moins cher, le plus vendu, le plus de QC.
// Résultat gardé 24 h (search_cache) : rouvrir la fenêtre ne redemande rien à FinderQC.

import { container, text, sep, section, thumb, row, link, escape } from './components.js';
import { postContext, trackedLink, formatPrice, cardTitle } from './post.js';
import { buildAgentLink, canonicalUrl } from './links.js';
import { searchByImage } from './imagesearch.js';
import { detectCategory } from './categories.js';
import { itemById } from './shard.js';
import { emo, etxt, AGENT_EMOJI } from './emojis.js';
import { ACCENTS } from './config.js';
import { finderItem } from './livesearch.js';

const CACHE_MS = 24 * 3600000;
const SHOWN = 5;
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');

async function sellers(env, item) {
  const key = `cmp:${item.id}`;
  const row0 = await env.DB.prepare('SELECT ids, at FROM search_cache WHERE key = ?').bind(key).first().catch(() => null);
  if (row0 && Date.now() - row0.at < CACHE_MS) return JSON.parse(row0.ids);
  const cat = item.category && item.category !== 'other' ? item.category : detectCategory(`${item.title_en || ''} ${item.title_zh || ''}`);
  const found = await searchByImage(item.image, 'item.jpg', 16);
  const same = found.filter((x) => !(x.platform === item.platform && x.id === String(item.item_id))
    && (!cat || cat === 'other' || detectCategory(x.title) === cat));
  await env.DB.prepare('INSERT OR REPLACE INTO search_cache (key, ids, at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(same), Date.now()).run().catch(() => {});
  return same;
}

export async function compareView(env, key) {
  const [ctx, known] = await Promise.all([postContext(env), itemById(env, key)]);
  // Pas dans la base (ou sans photo) : sa fiche chez FinderQC.
  const item = known && known.image ? known : (await finderItem(key).catch(() => null)) || known;
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  const e = (n) => etxt(ctx.emojis, n);
  if (!item || !/^https:\/\//.test(item.image || '')) {
    return [container([text(`### ${e('fb_compare')} Comparer les vendeurs\nPas de photo pour cet article : impossible de le comparer.`)], accent)];
  }
  const others = await sellers(env, item);
  const self = { platform: item.platform, id: String(item.item_id), title: cardTitle(item, 80), price: item.price_cny, image: item.image,
    sold: item.popularity || 0, qc: item.qc_count || 0, self: true };
  const all = [self, ...others];
  if (!others.length) {
    return [container([text(`### ${e('fb_compare')} Comparer les vendeurs\nJe n'ai pas trouvé cet article chez d'autres vendeurs pour l'instant.`)], accent)];
  }
  const priced = all.filter((x) => x.price > 0);
  const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a), priced[0]);
  const best = all.reduce((a, b) => (b.sold > a.sold ? b : a));
  const mostQc = all.reduce((a, b) => (b.qc > a.qc ? b : a));
  const tags = (x) => [x === cheapest ? `${e('fb_price')} **le moins cher**` : null, x === best && x.sold ? `${e('fb_crown')} **le plus vendu**` : null,
    x === mostQc && x.qc ? `${e('fb_qc')} **le plus de QC**` : null, x.self ? '👈 **celui-ci**' : null].filter(Boolean).join('  ');
  // Les meilleurs d'abord (moins cher, plus vendu, plus de QC), puis cet article, puis les autres.
  const order = [...new Set([cheapest, best, mostQc, self, ...others])].filter(Boolean).slice(0, SHOWN);
  const agent = ctx.agents[0];
  const blocks = order.flatMap((x) => {
    const it = { id: `${x.platform}:${x.id}`, platform: x.platform, item_id: x.id, url: canonicalUrl(x.platform, x.id) };
    const meta = [formatPrice(x.price, ctx.money), x.sold ? `${e('fb_fire')} ${fmt(x.sold)}` : null, x.qc ? `${e('fb_qc')} ${fmt(x.qc)} QC` : null].filter(Boolean);
    const head = `**${escape(String(x.title || '').slice(0, 70))}**\n${meta.join('  ·  ')}${tags(x) ? `\n${tags(x)}` : ''}`;
    const buttons = [
      agent ? { ...link(`Acheter sur ${agent.name}`.slice(0, 80), trackedLink(ctx, it, agent.name, buildAgentLink(agent.template, it), null)),
        emoji: emo(ctx.emojis, AGENT_EMOJI[agent.preset] || 'fb_cart') } : { ...link('Voir l\'annonce', it.url), emoji: emo(ctx.emojis, 'fb_link') },
      { type: 2, style: 1, label: x.qc ? `QC · ${fmt(x.qc)}` : 'Photos QC', emoji: emo(ctx.emojis, 'fb_qc'), custom_id: `pub:qc:${it.id}`.slice(0, 100) },
    ];
    return [sep(), /^https:\/\//.test(x.image || '') ? section(head, thumb(x.image)) : text(head), row(...buttons)];
  });
  return [container([
    text(`## ${e('fb_compare')} Comparer les vendeurs\n-# Le même article chez **${fmt(all.length)}** vendeurs (trouvés par la photo). Vérifie bien les QC avant d'acheter.`),
    ...blocks,
  ], accent)];
}
