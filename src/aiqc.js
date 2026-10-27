// Analyse des QC par l'IA (Llama 4 Scout, Workers AI gratuit) : défauts visibles, coutures, logo, couleur par
// rapport à la photo du vendeur, taille lue sur l'étiquette, mesure avec la règle. Un 2e avis, jamais une garantie.
// Deux entrées : le bouton « 🤖 Analyse IA » sous les photos QC d'un item, et les salons d'analyse où les membres
// postent juste leurs photos. Résultat gardé 30 jours par lot de photos (search_cache) ; au plus AIQC_PER_DAY
// analyses nouvelles par jour (quota d'IA partagé avec la traduction et la recherche par photo).

import { COMPONENTS_V2, container, text, sep, gallery, escape, section, thumb, row, link } from './components.js';
import { discordApi } from './discord.js';
import { analyzeQc, smallImageUrl } from './vision.js';
import { aiNeurons, AI_NEURONS_PER_DAY } from './translate.js';
import { etxt, emo, AGENT_EMOJI } from './emojis.js';
import { ACCENTS } from './config.js';
import { searchByImage } from './imagesearch.js';
import { trackedLink, formatPrice } from './post.js';
import { buildAgentLink, canonicalUrl } from './links.js';

export const AIQC_PER_DAY = 40; // plafond de sécurité sans Groq ; la vraie limite est le quota d'IA du jour (neurons)
const AIQC_PER_DAY_GROQ = 150; // avec Groq (~1 000 requêtes/jour gratuites, ~6 par analyse)
const CACHE_MS = 30 * 86400000;
const PHOTOS = 5; // analysées une par une (3 sans Groq, voir analyzeQc)

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
  // Sans Groq, tout passe par le quota Cloudflare (neurons) ; avec, Groq a ses propres limites (Cloudflare en secours).
  if (!env.GROQ_API_KEY && (await aiNeurons(env)).used >= AI_NEURONS_PER_DAY) return false;
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai_qc', json_object('day', ?1, 'used', 1))
     ON CONFLICT(key) DO UPDATE SET value = json_object('day', ?1, 'used',
       CASE WHEN json_extract(settings.value, '$.day') = ?1 THEN json_extract(settings.value, '$.used') + 1 ELSE 1 END)
     RETURNING json_extract(value, '$.used') AS used`,
  ).bind(day).first();
  return row && row.used <= (env.GROQ_API_KEY ? AIQC_PER_DAY_GROQ : AIQC_PER_DAY);
}

// Une analyse qui n'a pas pu se faire (IA saturée) ne compte pas dans la limite du jour.
async function uncount(env) {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `UPDATE settings SET value = json_object('day', ?1, 'used', MAX(0, json_extract(value, '$.used') - 1))
     WHERE key = 'ai_qc' AND json_extract(value, '$.day') = ?1`,
  ).bind(day).run().catch(() => {});
}

// Analyse (ou résultat déjà gardé) d'un lot de photos. { result, cached } ; result null si limite du jour ou échec.
export async function qcAnalysis(env, photos, { ref = null, what = null } = {}) {
  const shots = photos.filter((u) => /^https:\/\//.test(u || '')).slice(0, PHOTOS);
  if (!shots.length) return { result: null, reason: 'photos' };
  const key = `aiqc:${await hashKey([ref || '', ...shots])}`;
  const hit = await env.DB.prepare('SELECT ids, at FROM search_cache WHERE key = ?').bind(key).first().catch(() => null);
  if (hit && Date.now() - hit.at < CACHE_MS) return { result: JSON.parse(hit.ids), cached: true };
  if (!(await allowed(env))) return { result: null, reason: 'limite' };
  let quota = false;
  let busy = false;
  const result = await analyzeQc(env, shots, { ref, what }).catch((err) => {
    console.log('analyse QC', String(err).slice(0, 160));
    quota = /4006/.test(String(err));
    busy = /occupe/.test(String(err));
    return null;
  });
  if (busy) {
    // Groq saturé pour la minute et Cloudflare sans quota : on n'a pas compté cette analyse, réessai possible tout de suite.
    await uncount(env);
    return { result: null, reason: 'occupe' };
  }
  if (quota) {
    // Quota d'IA du jour épuisé chez Cloudflare : on le note, plus d'essai jusqu'à demain.
    await aiNeurons(env).then((b) => b.add(AI_NEURONS_PER_DAY)).catch(() => {});
    return { result: null, reason: 'limite' };
  }
  if (!result) return { result: null, reason: 'echec' };
  if (result.neurons) await aiNeurons(env).then((b) => b.add(Math.round(result.neurons))).catch(() => {});
  await env.DB.prepare('INSERT OR REPLACE INTO search_cache (key, ids, at) VALUES (?, ?, ?)').bind(key, JSON.stringify(result), Date.now()).run().catch(() => {});
  return { result, cached: false };
}

// Carte de l'analyse. title : article analysé ; photos : montrées en petit (facultatif).
export function analysisView(emojis, res, { title = null, photos = [], who = null, match = null } = {}) {
  const e = (n) => etxt(emojis, n);
  if (!res.result) {
    const why = res.reason === 'occupe'
      ? 'L\'IA est très demandée en ce moment. Reposte tes photos (ou re-clique) dans une minute.'
      : res.reason === 'limite'
      ? 'L\'analyse IA a atteint sa limite du jour (quota d\'IA gratuit). Réessaie demain, ou demande l\'avis des membres (votes GL / RL).'
      : res.reason === 'photos' ? 'Je n\'ai pas trouvé de photos à analyser.' : 'L\'IA n\'a pas pu analyser ces photos. Réessaie dans un moment.';
    return [container([text(`### ${e('fb_bot')} Analyse IA des QC\n${why}`)], 0x64748b)];
  }
  const r = res.result;
  const v = VERDICT[r.verdict] || VERDICT.a_verifier;
  const score = r.note != null ? `  ·  Note QC : **${r.note}/10** ${'★'.repeat(Math.round(r.note / 2))}${'☆'.repeat(5 - Math.round(r.note / 2))}` : '';
  const head = `## ${e('fb_bot')} Analyse IA des QC\n` +
    (title || r.article ? `**${escape(String(title || r.article).slice(0, 90))}**\n` : '') +
    `### ${v.icon} ${v.label}${score}`;
  return [container([
    text(head),
    photos.length ? gallery(photos.slice(0, PHOTOS)) : null,
    sep(),
    text(r.points.map((p) => `${ICON[p.etat] || '•'} ${escape(p.texte)}`).join('\n') || '-# Pas de détail.'),
    r.manque && r.manque.length ? text(`📸 **À demander à ton agent :** ${r.manque.map((x) => escape(x)).join(' · ')}`) : null,
    r.conseil ? text(`💡 ${escape(r.conseil)}`) : null,
    text(`-# Avis automatique de l'IA sur ${r.photos || Math.min(photos.length || PHOTOS, PHOTOS)} photo(s), pas une garantie : zoome sur les photos et compare avec les votes GL / RL des membres.` +
      (who ? `  ·  Demandé par <@${who}>` : '') + (res.cached ? '  ·  analyse déjà faite' : '')),
    ...(match || []),
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
  // En même temps : l'article qui ressemble le plus (recherche par image FinderQC, sans quota d'IA), avec ses
  // boutons d'achat et de QC. Sauf si le membre a donné le lien de l'item.
  const [res, found] = await Promise.all([
    qcAnalysis(env, shots.map(smallImageUrl), { ref, what: title }),
    refItem ? Promise.resolve([]) : searchByImage(shots[0].url, shots[0].filename, 3).catch(() => []),
  ]);
  c.done++;
  await discordApi(env, 'PATCH', `/channels/${c.channel_id}/messages/${pending.id}`, {
    flags: COMPONENTS_V2, allowed_mentions: { parse: [] },
    components: analysisView(ctx.emojis, res, { title, who: m.author && m.author.id, match: found[0] ? matchBlocks(ctx, found[0], c.channel_id) : null }),
  });
  return 8;
}

// « L'article qui ressemble le plus » sous l'analyse : photo, prix, ventes, QC, et les boutons acheter / QC / comparer.
function matchBlocks(ctx, x, channelId) {
  const e = (n) => etxt(ctx.emojis, n);
  const item = { id: `${x.platform}:${x.id}`, platform: x.platform, item_id: x.id, url: canonicalUrl(x.platform, x.id) };
  const meta = [formatPrice(x.price, ctx.money), x.sold ? `${e('fb_fire')} ${x.sold}` : null, x.qc ? `${e('fb_qc')} ${x.qc} QC` : null].filter(Boolean);
  const head = `${e('fb_search')} **L'article qui ressemble le plus**\n${escape(String(x.title || '').slice(0, 80))}\n${meta.join('  ·  ')}\n-# Vérifie que c'est bien le tien avant de comparer.`;
  const agent = ctx.agents && ctx.agents[0];
  return [
    sep(),
    /^https:\/\//.test(x.image || '') ? section(head, thumb(x.image)) : text(head),
    row(
      agent ? { ...link(`Acheter sur ${agent.name}`.slice(0, 80), trackedLink(ctx, item, agent.name, buildAgentLink(agent.template, item), channelId)),
        emoji: emo(ctx.emojis, AGENT_EMOJI[agent.preset] || 'fb_cart') } : { ...link('Voir l\'annonce', item.url), emoji: emo(ctx.emojis, 'fb_link') },
      { type: 2, style: 1, label: x.qc ? `QC · ${x.qc}` : 'Photos QC', emoji: emo(ctx.emojis, 'fb_qc'), custom_id: `pub:qc:${item.id}`.slice(0, 100) },
      { type: 2, style: 2, label: 'Comparer', emoji: emo(ctx.emojis, 'fb_compare'), custom_id: `pub:cmp:${item.id}`.slice(0, 100) },
    ),
  ];
}
