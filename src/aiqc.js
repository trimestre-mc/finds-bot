// Analyse des QC par l'IA (Llama 4 Scout, Workers AI gratuit) : défauts visibles, coutures, logo, couleur par
// rapport à la photo du vendeur, taille lue sur l'étiquette, mesure avec la règle. Un 2e avis, jamais une garantie.
// Deux entrées : le bouton « 🤖 Analyse IA » sous les photos QC d'un item, et les salons d'analyse où les membres
// postent juste leurs photos. Résultat gardé 30 jours par lot de photos (search_cache) ; au plus AIQC_PER_DAY
// analyses nouvelles par jour (quota d'IA partagé avec la traduction et la recherche par photo).

import { COMPONENTS_V2, container, text, sep, gallery, escape } from './components.js';
import { discordApi } from './discord.js';
import { analyzeQc, smallImageUrl } from './vision.js';
import { aiNeurons, AI_NEURONS_PER_DAY } from './translate.js';
import { etxt } from './emojis.js';
import { ACCENTS } from './config.js';

export const AIQC_PER_DAY = 20;
const CACHE_MS = 30 * 86400000;
const PHOTOS = 3;

const VERDICT = {
  ok: { icon: '✅', label: 'Rien d\'anormal repéré', color: 0x22c55e },
  a_verifier: { icon: '⚠️', label: 'Quelques points à vérifier', color: 0xf59e0b },
  probleme: { icon: '❌', label: 'Problème visible', color: 0xef4444 },
};
const ICON = { ok: '✅', attention: '⚠️', probleme: '❌' };

async function hashKey(parts) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(parts.join('|')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

// Une analyse de plus aujourd'hui ? (compteur du jour, et quota d'IA pas épuisé)
async function allowed(env) {
  if ((await aiNeurons(env)).used >= AI_NEURONS_PER_DAY) return false;
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai_qc', json_object('day', ?1, 'used', 1))
     ON CONFLICT(key) DO UPDATE SET value = json_object('day', ?1, 'used',
       CASE WHEN json_extract(settings.value, '$.day') = ?1 THEN json_extract(settings.value, '$.used') + 1 ELSE 1 END)
     RETURNING json_extract(value, '$.used') AS used`,
  ).bind(day).first();
  return row && row.used <= AIQC_PER_DAY;
}

// Analyse (ou résultat déjà gardé) d'un lot de photos. { result, cached } ; result null si limite du jour ou échec.
export async function qcAnalysis(env, photos, { ref = null, what = null } = {}) {
  const shots = photos.filter((u) => /^https:\/\//.test(u || '')).slice(0, PHOTOS);
  if (!shots.length) return { result: null, reason: 'photos' };
  const key = `aiqc:${await hashKey([ref || '', ...shots])}`;
  const hit = await env.DB.prepare('SELECT ids, at FROM search_cache WHERE key = ?').bind(key).first().catch(() => null);
  if (hit && Date.now() - hit.at < CACHE_MS) return { result: JSON.parse(hit.ids), cached: true };
  if (!(await allowed(env))) return { result: null, reason: 'limite' };
  const result = await analyzeQc(env, shots, { ref, what }).catch((err) => { console.log('analyse QC', String(err).slice(0, 160)); return null; });
  if (!result) return { result: null, reason: 'echec' };
  await aiNeurons(env).then((b) => b.add(Math.round(result.neurons || 160))).catch(() => {});
  await env.DB.prepare('INSERT OR REPLACE INTO search_cache (key, ids, at) VALUES (?, ?, ?)').bind(key, JSON.stringify(result), Date.now()).run().catch(() => {});
  return { result, cached: false };
}

// Carte de l'analyse. title : article analysé ; photos : montrées en petit (facultatif).
export function analysisView(emojis, res, { title = null, photos = [], who = null } = {}) {
  const e = (n) => etxt(emojis, n);
  if (!res.result) {
    const why = res.reason === 'limite'
      ? `L'analyse IA a atteint sa limite du jour (${AIQC_PER_DAY} analyses). Réessaie demain, ou demande l'avis des membres (votes GL / RL).`
      : res.reason === 'photos' ? 'Je n\'ai pas trouvé de photos à analyser.' : 'L\'IA n\'a pas pu analyser ces photos. Réessaie dans un moment.';
    return [container([text(`### ${e('fb_bot')} Analyse IA des QC\n${why}`)], 0x64748b)];
  }
  const r = res.result;
  const v = VERDICT[r.verdict] || VERDICT.a_verifier;
  const head = `## ${e('fb_bot')} Analyse IA des QC\n` +
    (title || r.article ? `**${escape(String(title || r.article).slice(0, 90))}**\n` : '') +
    `### ${v.icon} ${v.label}`;
  return [container([
    text(head),
    photos.length ? gallery(photos.slice(0, PHOTOS)) : null,
    sep(),
    text(r.points.map((p) => `${ICON[p.etat] || '•'} ${escape(p.texte)}`).join('\n') || '-# Pas de détail.'),
    r.conseil ? text(`💡 ${escape(r.conseil)}`) : null,
    text(`-# Avis automatique de l'IA sur ${Math.min(photos.length || PHOTOS, PHOTOS)} photo(s), pas une garantie : zoome sur les photos et compare avec les votes GL / RL des membres.` +
      (who ? `  ·  Demandé par <@${who}>` : '') + (res.cached ? '  ·  analyse déjà faite' : '')),
  ], v.color)];
}

// ---------------------------------------------------------------- Salons d'analyse

// Photos postées dans un salon d'analyse : « Analyse en cours… » tout de suite, puis le résultat à la place.
// Si le message contient le lien de l'item, sa photo vendeur sert de référence. Renvoie le nombre de requêtes faites.
export async function aiqcMessage(env, ctx, c, m) {
  const isImg = (a) => /^image\/(jpeg|png|webp)/.test(a.content_type || '') || /\.(jpe?g|png|webp)$/i.test(a.filename || '');
  const shots = (m.attachments || []).filter(isImg).slice(0, PHOTOS);
  if (!shots.length) return 0;
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  const pending = await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, {
    flags: COMPONENTS_V2, allowed_mentions: { parse: [] },
    components: [container([text(`### ${etxt(ctx.emojis, 'fb_loading')} Analyse de tes QC en cours…\n-# L'IA regarde tes ${shots.length} photo(s) : défauts, coutures, logo, taille, mesures.`)], accent)],
    message_reference: { message_id: m.id, fail_if_not_exists: false },
  });
  // Lien de l'item dans le message : photo du vendeur comme référence.
  let ref = null;
  let title = null;
  const { extractItemRefs } = await import('./links.js');
  const refItem = extractItemRefs(m.content || '')[0];
  if (refItem) {
    const { itemById } = await import('./shard.js');
    const item = await itemById(env, `${refItem.platform}:${refItem.itemId}`).catch(() => null);
    if (item) { ref = /^https:\/\//.test(item.image || '') ? item.image : null; title = item.title_en || item.title_zh; }
  }
  const res = await qcAnalysis(env, shots.map(smallImageUrl), { ref, what: title });
  c.done++;
  await discordApi(env, 'PATCH', `/channels/${c.channel_id}/messages/${pending.id}`, {
    flags: COMPONENTS_V2, allowed_mentions: { parse: [] },
    components: analysisView(ctx.emojis, res, { title, who: m.author && m.author.id }),
  });
  return 6;
}
