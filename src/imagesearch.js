// Recherche par image : dans les salons choisis (surveillés par watch.js), chaque photo postée par un membre est
// envoyée à la recherche par image de FinderQC (avec l'accord de son propriétaire), et le bot répond avec les items
// qui ressemblent le plus : photo, prix, nombre de QC, bouton d'achat avec ton code et bouton QC.

import { container, text, sep, section, thumb, row, link, escape } from './components.js';
import { formatPrice, itemTitle, postContext, trackedLink, signupButton } from './post.js';
import { buildAgentLink, canonicalUrl } from './links.js';
import { ACCENTS } from './config.js';

const API = 'https://server.finderqc.com/api/searchImage';
const UA = 'finds-bot/1.0 (+https://finds-bot.wheatenmoon5861.workers.dev)';
const PLATFORMS = { Weidian: 'weidian', Taobao: 'taobao', Ali1688: '1688' };
const RESULTS = 4; // 4 items par réponse (limite de 40 composants d'un message Discord)
const MAX_BYTES = 8 * 1024 * 1024;
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');

export const isImage = (a) => /^image\/(jpeg|png|webp|gif)/.test(a.content_type || '') || /\.(jpe?g|png|webp)$/i.test(a.filename || '');

// Items qui ressemblent à une image (URL). Renvoie [{ platform, id, title, price, image, sold, qc }] ou [].
export async function searchByImage(imageUrl, filename = 'image.jpg') {
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
  const list = await fetch(`${API}/results/${encodeURIComponent(sid)}?page=1&pageSize=${RESULTS * 2}`, { headers: { 'User-Agent': UA } });
  if (!list.ok) throw new Error(`FinderQC ${list.status}`);
  const found = await list.json();
  return ((found && found.data && found.data.results) || []).map((x) => ({
    platform: PLATFORMS[x.mallType], id: String(x.itemId || ''), title: x.enTitle || x.originalTitle,
    price: x.cnPrice, image: x.originalThubnaiURL || x.picUrl, sold: Number(x.oneYear) || 0, qc: Number(x.qcPhotosCount) || 0,
  })).filter((x) => x.platform && /^\d{6,14}$/.test(x.id) && canonicalUrl(x.platform, x.id)).slice(0, RESULTS);
}

// Réponse du bot : les items qui ressemblent, chacun avec achat (1er agent, lien suivi) et QC dans Discord.
export function imageResultsView(ctx, found, channelId) {
  const blocks = [text(found.length ? '### 🔎 Items qui ressemblent à ta photo' : '### 🔎 Aucun item ne ressemble à cette photo')];
  for (const x of found) {
    const item = { id: `${x.platform}:${x.id}`, platform: x.platform, item_id: x.id, url: canonicalUrl(x.platform, x.id), title_en: x.title };
    const meta = [formatPrice(x.price, ctx.money)];
    if (x.qc) meta.push(`📸 ${fmt(x.qc)} QC`);
    if (x.sold) meta.push(`🔥 ${fmt(x.sold)}`);
    const head = `**${escape(itemTitle(item).slice(0, 80))}**\n${meta.join('  ·  ')}`;
    const agent = ctx.agents[0];
    const buttons = [
      agent
        ? link(`Acheter sur ${agent.name}`.slice(0, 80), trackedLink(ctx, item, agent.name, buildAgentLink(agent.template, item), channelId), '🛒')
        : link('Voir l\'annonce', item.url, '🔗'),
      { type: 2, style: 1, label: x.qc ? `Voir les QC (${fmt(x.qc)})` : 'Photos QC', emoji: { name: '📸' }, custom_id: `pub:qc:${item.id}`.slice(0, 100) },
    ];
    blocks.push(sep());
    blocks.push(/^https:\/\//.test(x.image || '') ? section(head, thumb(x.image)) : text(head));
    blocks.push(row(...buttons));
  }
  const signup = found.length ? signupButton(ctx, null, channelId) : null;
  if (signup) blocks.push(sep(), row(signup));
  return [container(blocks, (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
}
