// Photos QC : nombre et galerie (Jadeship → UUFinds), lien FinderQC, et QC postés par la communauté sur Discord.

import { link } from './components.js';
import { finderQcUrl } from './links.js';

const JADESHIP_UA = 'finds-bot/1.0 (+https://github.com/trimestre-mc/finds-bot)';

// Données de la page Jadeship (flux Next.js) puis nombre de QC et lien de la galerie UUFinds.
export function parseJadeshipQc(html) {
  const text = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } }).join('');
  const url = (text.match(/https:\/\/www\.uufinds\.com\/goodItemDetail\/qc\/[A-Za-z0-9]+(?:\?fromId=\d+)?/) || [])[0] || null;
  const count = Number((text.match(/" ",(\d+)," QC pics available"/) || [])[1] || 0);
  return { count, url };
}

// Vérifie les QC d'un item sur Jadeship (une requête), une fois par semaine au plus. Renvoie l'item à jour.
export async function refreshQc(env, item) {
  if (item.qc_checked_at && Date.now() - item.qc_checked_at < 7 * 86400000) return item;
  let qc = { count: item.qc_count || 0, url: item.qc_url || null };
  try {
    const res = await fetch(`https://www.jadeship.com/item/${item.platform}/${item.item_id}`, { headers: { 'User-Agent': JADESHIP_UA } });
    if (res.ok) qc = parseJadeshipQc(await res.text());
  } catch (err) {
    console.log('qc', item.id, String(err).slice(0, 120));
  }
  await env.DB.prepare('UPDATE items SET qc_count = ?, qc_url = ?, qc_checked_at = ? WHERE id = ?')
    .bind(qc.count, qc.url, Date.now(), item.id).run();
  return { ...item, qc_count: qc.count, qc_url: qc.url, qc_checked_at: Date.now() };
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

const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/ | /g, ' ');

// Ligne de boutons QC d'une carte (suivis par /go comme les boutons d'achat).
export function qcButtons(track, item, community, lang = 'fr') {
  const en = lang === 'en';
  const buttons = [];
  if (item.qc_count > 0) {
    buttons.push(link(en ? `${fmt(item.qc_count)} QC photos` : `${fmt(item.qc_count)} photos QC`, track('qc', item.qc_url || finderQcUrl(item)), '📸'));
  } else if (item.popularity > 0 && finderQcUrl(item)) {
    buttons.push(link(en ? 'QC photos' : 'Photos QC', track('qc', finderQcUrl(item)), '📸'));
  }
  if (community) {
    buttons.push(link(en ? `Community QC (${community.images})` : `QC communauté (${community.images})`, track('qcc', community.jump), '🧑‍🤝‍🧑'));
  }
  return buttons;
}

// Résumé texte (« 📸 4 278 QC · 🧑‍🤝‍🧑 3 QC ») pour les listes.
export function qcSummary(item, community) {
  const parts = [];
  if (item.qc_count > 0) parts.push(`📸 ${fmt(item.qc_count)} QC`);
  if (community) parts.push(`🧑‍🤝‍🧑 ${community.images} QC`);
  return parts.join('  ·  ');
}
