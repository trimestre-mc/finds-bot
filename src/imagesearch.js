// Recherche par image : dans les salons choisis (surveillés par watch.js), chaque photo postée par un membre est
// envoyée à la recherche par image de FinderQC (avec l'accord de son propriétaire), et le bot répond avec les items
// qui ressemblent le plus : photo, prix, nombre de QC, bouton d'achat avec ton code et bouton QC.

import { container, text, sep, section, thumb, row, link, escape } from './components.js';
import { formatPrice, itemTitle, postContext, trackedLink, signupButton } from './post.js';
import { buildAgentLink, canonicalUrl } from './links.js';
import { ACCENTS } from './config.js';
import { describeImage, smallImageUrl } from './vision.js';
import { aiNeurons, AI_NEURONS_PER_DAY } from './translate.js';
import { expandQuery, relevance } from './synonyms.js';
import { finderSearch, liveQuery } from './livesearch.js';
import { etxt, emo, AGENT_EMOJI, PLATFORM_EMOJI } from './emojis.js';

const API = 'https://server.finderqc.com/api/searchImage';
const UA = 'finds-bot/1.0 (+https://finds-bot.wheatenmoon5861.workers.dev)';
const PLATFORMS = { Weidian: 'weidian', Taobao: 'taobao', Ali1688: '1688' };
const RESULTS = 4; // 4 items par réponse (limite de 40 composants d'un message Discord)
const MAX_BYTES = 8 * 1024 * 1024;
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');

export const isImage = (a) => /^image\/(jpeg|png|webp|gif)/.test(a.content_type || '') || /\.(jpe?g|png|webp)$/i.test(a.filename || '');

// Items qui ressemblent à une image (URL). Renvoie [{ platform, id, title, price, image, sold, qc }] ou [].
export async function searchByImage(imageUrl, filename = 'image.jpg', limit = RESULTS) {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`image ${img.status}`);
  const type = img.headers.get('content-type') || '';
  if (!/^image\//.test(type)) throw new Error(`pas une image (${type || 'type inconnu'})`);
  const blob = await img.blob();
  if (blob.size > MAX_BYTES || blob.size < 1000) throw new Error(`image de ${blob.size} octets`);
  const form = new FormData();
  // Nom unique : FinderQC garde en cache les recherches par nom de fichier (« image.png » renverrait toujours
  // les résultats d'une autre photo).
  const ext = (String(filename).match(/\.(jpe?g|png|webp|gif)$/i) || ['.jpg'])[0].toLowerCase();
  form.append('file', blob, `${crypto.randomUUID()}${ext}`);
  const res = await fetch(`${API}/search`, { method: 'POST', body: form, headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  const sid = data && data.code === 0 && data.data && data.data.search_id;
  if (!sid) return [];
  const list = await fetch(`${API}/results/${encodeURIComponent(sid)}?page=1&pageSize=${Math.max(limit, 8)}`, { headers: { 'User-Agent': UA } });
  if (!list.ok) throw new Error(`FinderQC ${list.status}`);
  const found = await list.json();
  return toResults((found && found.data && found.data.results) || []).slice(0, limit);
}

// Produits FinderQC (recherche par image ou par texte) → [{ platform, id, title, price, image, sold, qc }].
export function toResults(list) {
  return list.map((x) => ({
    platform: PLATFORMS[x.mallType], id: String(x.itemId || ''), title: x.enTitle || x.originalTitle,
    price: x.cnPrice, image: x.originalThubnaiURL || x.picUrl, sold: Number(x.oneYear) || 0, qc: Number(x.qcPhotosCount) || 0,
  })).filter((x) => x.platform && /^\d{6,14}$/.test(x.id) && canonicalUrl(x.platform, x.id));
}

// Photos lues par le modèle de vision : au plus VISION_PER_DAY par jour (quota d'IA gratuit, partagé avec la
// traduction des titres).
const VISION_PER_DAY = 200;

const VISION_NEURONS = 40; // estimation par photo (Llama 4 Scout, image réduite à 512 px)

async function visionAllowed(env) {
  if (!env.GROQ_API_KEY && (await aiNeurons(env)).used >= AI_NEURONS_PER_DAY) return false;
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai_vision', json_object('day', ?1, 'used', 1))
     ON CONFLICT(key) DO UPDATE SET value = json_object('day', ?1, 'used',
       CASE WHEN json_extract(settings.value, '$.day') = ?1 THEN json_extract(settings.value, '$.used') + 1 ELSE 1 END)
     RETURNING json_extract(value, '$.used') AS used`,
  ).bind(day).first().catch((err) => {
    // Base sans écriture possible (quota du jour) : le compteur ne bloque pas le service.
    console.log('compteur IA', String(err).slice(0, 100));
    return { used: 0 };
  });
  return !row || row.used <= VISION_PER_DAY; // pas de compteur (écritures bloquées) : on laisse passer
}

// Recherche par image complète : formes (FinderQC) + marque lue sur la photo (modèle de vision). Les items de la
// bonne marque passent devant ; s'il en manque, une recherche par texte (« chrome hearts hoodie ») complète.
// Renvoie { items, seen } (seen : ce que le modèle a reconnu, ou null).
export async function smartImageSearch(env, attachment) {
  // FinderQC parfois surchargé : un 2e essai ; s'il échoue encore, la marque lue sur la photo suffit (recherche par
  // texte). « Impossible » seulement si les deux manquent.
  const once = () => searchByImage(attachment.url, attachment.filename, 12);
  const [found, seen] = await Promise.all([
    once().catch(() => new Promise((r) => setTimeout(r, 1500)).then(once))
      .catch((err) => { console.log('recherche image FinderQC', String(err).slice(0, 160)); return null; }),
    visionAllowed(env).then(async (ok) => {
      if (!ok) return null;
      const seen = await describeImage(env, smallImageUrl(attachment));
      // Neurons Cloudflare vraiment utilisés (0 si Groq a répondu).
      if (!seen || seen.neurons) await aiNeurons(env).then((b) => b.add(seen ? seen.neurons : VISION_NEURONS)).catch(() => {});
      return seen;
    })
      .catch((err) => { console.log('vision', String(err).slice(0, 120)); return null; }),
  ]);
  if (!found && !(seen && seen.brand)) throw new Error('recherche par image indisponible');
  const shapes = found || [];
  if (!seen || !seen.brand) return { items: shapes.slice(0, RESULTS), seen };
  const brandGroups = expandQuery(seen.brand).filter((g) => g.kind === 'brand');
  const groups = brandGroups.length ? brandGroups : expandQuery(seen.brand);
  const typeGroups = seen.item ? expandQuery(seen.item).filter((g) => g.kind === 'type') : [];
  const isBrand = (x) => relevance(groups, { title_en: x.title }) > 0;
  const score = (x) => (isBrand(x) ? 2 : 0) + (typeGroups.length && relevance(typeGroups, { title_en: x.title }) > 0 ? 1 : 0);
  const ranked = shapes.map((x, i) => ({ x, i, s: score(x) })).sort((a, b) => b.s - a.s || a.i - b.i).map((r) => r.x);
  let items = ranked.filter(isBrand).slice(0, RESULTS);
  if (items.length < RESULTS) {
    // Pas assez de résultats de la bonne marque : recherche par texte, les plus vendus d'abord.
    const query = liveQuery(expandQuery([seen.brand, seen.model, seen.item].filter(Boolean).join(' ')));
    const extra = await finderSearch(query).then(toResults).catch(() => []);
    const ids = new Set(items.map((x) => `${x.platform}:${x.id}`));
    for (const x of extra) {
      if (items.length >= RESULTS) break;
      if (!isBrand(x) || ids.has(`${x.platform}:${x.id}`)) continue;
      ids.add(`${x.platform}:${x.id}`);
      items.push(x);
    }
  }
  // Toujours 4 propositions : on complète avec les formes les plus proches.
  for (const x of ranked) if (items.length < RESULTS && !items.includes(x)) items.push(x);
  return { items, seen };
}

// Réponse du bot : les items qui ressemblent, chacun avec achat (1er agent, lien suivi) et QC dans Discord.
export function imageResultsView(ctx, found, channelId, seen = null) {
  const e = (n) => etxt(ctx.emojis, n);
  const what = seen && seen.brand ? `\n${e('fb_verified')} Repéré sur ta photo : **${escape(seen.brand)}**${seen.model ? ` ${escape(seen.model)}` : ''}${seen.item ? ` · ${escape(seen.item)}` : ''}` : '';
  const blocks = [text(found.length ? `### ${e('fb_search')} Items qui ressemblent à ta photo${what}` : `### ${e('fb_search')} Aucun item ne ressemble à cette photo`)];
  for (const x of found) {
    const item = { id: `${x.platform}:${x.id}`, platform: x.platform, item_id: x.id, url: canonicalUrl(x.platform, x.id), title_en: x.title };
    const meta = [formatPrice(x.price, ctx.money)];
    if (x.qc) meta.push(`${e('fb_qc')} ${fmt(x.qc)} QC`);
    if (x.sold) meta.push(`${e('fb_fire')} ${fmt(x.sold)}`);
    const head = `**${escape(itemTitle(item).slice(0, 80))}**\n${meta.join('  ·  ')}`;
    const agent = ctx.agents[0];
    const buttons = [
      agent
        ? { ...link(`Acheter sur ${agent.name}`.slice(0, 80), trackedLink(ctx, item, agent.name, buildAgentLink(agent.template, item), channelId)),
          emoji: emo(ctx.emojis, AGENT_EMOJI[agent.preset] || 'fb_cart') }
        : { ...link('Voir l\'annonce', item.url), emoji: emo(ctx.emojis, PLATFORM_EMOJI[item.platform] || 'fb_link') },
      { type: 2, style: 1, label: x.qc ? `QC · ${fmt(x.qc)}` : 'Photos QC', emoji: emo(ctx.emojis, 'fb_qc'), custom_id: `pub:qc:${item.id}`.slice(0, 100) },
      { type: 2, style: 2, label: 'Comparer', emoji: emo(ctx.emojis, 'fb_compare'), custom_id: `pub:cmp:${item.id}`.slice(0, 100) },
      { type: 2, style: 2, emoji: emo(ctx.emojis, 'fb_bell'), custom_id: `pub:watch:${item.id}`.slice(0, 100) },
    ];
    blocks.push(sep());
    blocks.push(/^https:\/\//.test(x.image || '') ? section(head, thumb(x.image)) : text(head));
    blocks.push(row(...buttons));
  }
  const signup = found.length ? signupButton(ctx, null, channelId) : null;
  if (signup) blocks.push(row(signup)); // sans séparateur : 40 composants au plus par message
  return [container(blocks, (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
}
