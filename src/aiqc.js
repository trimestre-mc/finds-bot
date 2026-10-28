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
import { fetchQc, fetchQcPage, goldPhoto } from './qc.js';
import { cacheGet, cacheSet, dayAdd, kvGet, kvSet, rateLimit, LIMITS, limitText, logEvent } from './kvstore.js';
import { expandQuery } from './synonyms.js';
import { detectCategory } from './categories.js';

export const AIQC_PER_DAY = 40; // plafond de sécurité sans Groq ; la vraie limite est le quota d'IA du jour (neurons)
const AIQC_PER_DAY_GROQ = 150; // avec Groq (~1 000 requêtes/jour gratuites, ~6 par analyse)
const CACHE_MS = 30 * 86400000;
const PHOTOS = 5; // analysées une par une (3 sans Groq, voir analyzeQc)

// Titre de la carte selon la note (ou le verdict s'il n'y a pas de note).
const TIERS = [
  { min: 9, label: 'Excellent batch', emoji: 'fb_crown', color: 0x22c55e },
  { min: 7, label: 'Bon batch (GL)', emoji: 'fb_gl', color: 0x22c55e },
  { min: 5, label: 'Batch mitigé', emoji: 'fb_mid', color: 0xf59e0b },
  { min: 3, label: 'Retour conseillé (RL)', emoji: 'fb_rl', color: 0xef4444 },
  { min: 0, label: 'Article à éviter', emoji: 'fb_bad', color: 0xb91c1c },
];
const BY_VERDICT = { ok: TIERS[1], a_verifier: { ...TIERS[2], label: 'Points à vérifier' }, probleme: TIERS[3] };
const POINT = { ok: 'fb_ok', attention: 'fb_mid', probleme: 'fb_bad' };

async function hashKey(parts) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(parts.join('|')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

// Une analyse de plus aujourd'hui ? (compteur du jour, et quota d'IA pas épuisé)
async function allowed(env) {
  // Sans Groq, tout passe par le quota Cloudflare (neurons) ; avec, Groq a ses propres limites (Cloudflare en secours).
  if (!env.GROQ_API_KEY && (await aiNeurons(env)).used >= AI_NEURONS_PER_DAY) return false;
  const fast = await dayAdd(env, 'ai_qc');
  if (fast !== undefined) return fast <= (env.GROQ_API_KEY ? AIQC_PER_DAY_GROQ : AIQC_PER_DAY);
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai_qc', json_object('day', ?1, 'used', 1))
     ON CONFLICT(key) DO UPDATE SET value = json_object('day', ?1, 'used',
       CASE WHEN json_extract(settings.value, '$.day') = ?1 THEN json_extract(settings.value, '$.used') + 1 ELSE 1 END)
     RETURNING json_extract(value, '$.used') AS used`,
  ).bind(day).first().catch((err) => {
    // Base sans écriture possible (quota du jour) : le compteur ne bloque pas le service.
    console.log('compteur IA', String(err).slice(0, 100));
    return { used: 0 };
  });
  return !row || row.used <= (env.GROQ_API_KEY ? AIQC_PER_DAY_GROQ : AIQC_PER_DAY); // pas de compteur (écritures bloquées) : on laisse passer
}

// Une analyse qui n'a pas pu se faire (IA saturée) ne compte pas dans la limite du jour.
async function uncount(env) {
  if ((await dayAdd(env, 'ai_qc', -1)) !== undefined) return;
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `UPDATE settings SET value = json_object('day', ?1, 'used', MAX(0, json_extract(value, '$.used') - 1))
     WHERE key = 'ai_qc' AND json_extract(value, '$.day') = ?1`,
  ).bind(day).run().catch(() => {});
}

// Analyse (ou résultat déjà gardé) d'un lot de photos. { result, cached } ; result null si limite du jour ou échec.
export async function qcAnalysis(env, photos, { ref = null, what = null, gold = null, progress = null } = {}) {
  const shots = photos.filter((u) => /^https:\/\//.test(u || '')).slice(0, PHOTOS);
  if (!shots.length) return { result: null, reason: 'photos' };
  const key = `aiqc:${await hashKey([ref || '', ...shots])}`;
  const hit = await cacheGet(env, key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { result: JSON.parse(hit.ids), cached: true };
  if (!(await allowed(env))) return { result: null, reason: 'limite' };
  let quota = false;
  let busy = false;
  const result = await analyzeQc(env, shots, { ref, what, gold, progress }).catch((err) => {
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
  await cacheSet(env, key, JSON.stringify(result));
  await logEvent(env, 'aiqc', `${result.article || what || 'Article'} · ${result.note != null ? `${result.note}/10` : result.verdict} · ${result.photos} photo${result.photos > 1 ? 's' : ''}`).catch(() => {});
  return { result, cached: false };
}

// ---------------------------------------------------------------- Progression (message d'attente)

// Étapes affichées pendant l'analyse, avec leur part du temps total.
const STEPS = {
  match: { label: 'Identification de l\'article', weight: 0.08 },
  photos: { label: 'Examen des photos', weight: 0.42 },
  zoom: { label: 'Gros plan sur le logo et les étiquettes', weight: 0.12 },
  compare: { label: 'Comparaison avec un autre batch', weight: 0.12 },
  merge: { label: 'Rédaction de l\'avis', weight: 0.12 },
  verify: { label: 'Seconde vérification des points douteux', weight: 0.14 },
};
const DEFAULT_MS = 35000;

// Durée moyenne d'une analyse (gardée dans les réglages), pour l'estimation du temps.
async function averageMs(env) {
  const kept = await kvGet(env, 'aiqc:avg');
  const row = kept !== undefined ? { value: kept } : await env.DB.prepare("SELECT value FROM settings WHERE key = 'aiqc:avg'").first().catch(() => null);
  const v = row && Number(row.value);
  return v > 5000 && v < 300000 ? v : DEFAULT_MS;
}

async function recordMs(env, ms) {
  const avg = await averageMs(env);
  const next = String(Math.round(avg * 0.7 + ms * 0.3));
  if (!(await kvSet(env, 'aiqc:avg', next))) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('aiqc:avg', ?)").bind(next).run().catch(() => {});
}

// Carte « analyse en cours » : étapes (faite, en cours, à venir), barre de progression et temps restant (compte à
// rebours Discord, qui défile tout seul).
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export function progressView(emojis, p, accent) {
  const e = (n) => etxt(emojis, n);
  const keys = p.keys;
  const at = keys.indexOf(p.current);
  const done = keys.slice(0, Math.max(0, at)).filter((k) => p.started.has(k));
  const frac = Math.min(0.97, done.reduce((n, k) => n + STEPS[k].weight, 0) / keys.reduce((n, k) => n + STEPS[k].weight, 0) + 0.03);
  // Barre en emojis : début, 8 morceaux, fin (pleins = violet animé).
  const cells = 10;
  const full = Math.max(1, Math.round(frac * cells));
  const bar = Array.from({ length: cells }, (_, i) => e(`fb_bar${i === 0 ? 'l' : i === cells - 1 ? 'r' : 'm'}${i < full ? 1 : 0}`)).join('');
  const lines = keys.map((k, i) => {
    if (i < at && !p.started.has(k)) return null; // étape sautée (pas de batch de référence, pas de doute…)
    if (i < at) return `${e('fb_done')} ${STEPS[k].label}`;
    if (i === at) return `${e('fb_loading')} **${STEPS[k].label}…**`;
    return `-# ${e('fb_todo')} ${STEPS[k].label}${k === 'verify' ? ' (si besoin)' : ''}`;
  }).filter(Boolean);
  const end = Math.round((p.start + p.eta) / 1000);
  const left = end * 1000 - Date.now() > 3000 ? `Résultat estimé <t:${end}:R>` : 'Finalisation en cours';
  return [container([
    text(`## ${e('fb_aiscan')} Analyse des QC en cours\n-# ${p.count} photo${p.count > 1 ? 's' : ''} · logo, matière, coutures, étiquettes et mesures`),
    sep(),
    text(lines.join('\n')),
    p.logs && p.logs.length ? text(`\`\`\`\n${p.logs.slice(-6).map((l) => `${clock(l.at)}  ${l.line.replace(/`/g, "'")}`).join('\n')}\n\`\`\``) : null,
    sep(),
    text(`${bar}  **${Math.round(frac * 100)} %**\n${e('fb_clock')} ${left}`),
  ], accent)];
}

// Suivi de progression : renvoie step(clé) qui met à jour le message (au plus une modification par seconde, sauf
// changement d'étape) ; send(components) publie la carte.
export async function tracker(env, emojis, { keys, count, accent, send }) {
  const p = { keys, count, current: keys[0], started: new Set([keys[0]]), start: Date.now(), eta: await averageMs(env), logs: [] };
  let chain = Promise.resolve();
  // Une modification du message à la fois ; plusieurs lignes de journal arrivées entre-temps partent ensemble.
  let queued = false;
  const push = () => {
    if (queued) return chain;
    queued = true;
    chain = chain.then(() => { queued = false; return send(progressView(emojis, p, accent)); })
      .catch((err) => console.log('progression', String(err).slice(0, 120)));
    return chain;
  };
  const step = (key) => {
    if (!keys.includes(key) || key === p.current) return chain;
    if (keys.indexOf(key) < keys.indexOf(p.current)) return chain;
    p.current = key;
    p.started.add(key);
    return push();
  };
  step.first = () => push();
  // Ligne de journal (« 00:07  Photos 1 et 2 : 4 points relevés »).
  step.log = (line) => { p.logs.push({ at: Date.now() - p.start, line: String(line).slice(0, 90) }); return push(); };
  step.finish = async (counted) => { await chain; if (counted) await recordMs(env, Date.now() - p.start); };
  return step;
}

// Ce que l'IA a fait en plus de lire les photos.
function extrasText(x) {
  if (!x) return '';
  const done = [x.zoom && 'gros plan du logo / de l\'étiquette', x.compared && 'comparée à un autre batch', x.verified && 'doutes revérifiés'].filter(Boolean);
  return done.length ? ` (${done.join(', ')})` : '';
}

// Carte de l'analyse. title : article analysé ; photos : montrées en petit (facultatif).
export function analysisView(emojis, res, { title = null, photos = [], who = null, match = null } = {}) {
  const e = (n) => etxt(emojis, n);
  if (!res.result) {
    const why = {
      occupe: `${e('fb_clock')} **Service très sollicité.** Merci de renvoyer les photos dans une minute.`,
      limite: `${e('fb_clock')} **Limite quotidienne du serveur atteinte.** Les analyses reprennent demain ; les votes GL / RL des membres restent disponibles.`,
      photos: `${e('fb_ask')} **Aucune photo détectée.** Formats acceptés : jpg, png et webp.`,
    }[res.reason] || `${e('fb_bad')} **Les photos n'ont pas pu être analysées.** Merci de réessayer dans un moment, si possible avec des photos plus nettes.`;
    return [container([text(`### ${e('fb_aiscan')} Analyse des QC\n${why}`)], 0x64748b)];
  }
  const r = res.result;
  const tier = r.note != null ? TIERS.find((t) => r.note >= t.min) : (BY_VERDICT[r.verdict] || BY_VERDICT.a_verifier);
  const full = r.note != null ? Math.round(r.note / 2) : 0;
  const stars = r.note != null ? `${e('fb_s1').repeat(full)}${e('fb_s0').repeat(5 - full)}` : '';
  const name = title || r.article;
  const head = `## ${e(tier.emoji)} ${tier.label}${r.note != null ? `  ·  ${r.note}/10` : ''}\n` +
    (stars ? `${stars}\n` : '') +
    (name ? `${e('fb_qc')} **${escape(String(name).slice(0, 90))}**` : '');
  // Ce qui coince d'abord, puis ce qui est propre.
  const line = (p) => `${e(POINT[p.etat] || 'fb_mid')} ${escape(p.texte)}`;
  const bad = r.points.filter((p) => p.etat !== 'ok');
  const good = r.points.filter((p) => p.etat === 'ok');
  const body = [
    bad.length ? `**Points à surveiller**\n${bad.map(line).join('\n')}` : null,
    good.length ? `**Points conformes**\n${good.map(line).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
  const done = [`${r.photos || Math.min(photos.length || PHOTOS, PHOTOS)} photo${(r.photos || 2) > 1 ? 's' : ''}`];
  if (r.extras && r.extras.zoom) done.push('gros plan');
  if (r.extras && r.extras.compared) done.push('comparé à un autre batch');
  if (r.extras && r.extras.verified) done.push('revérifié');
  return [container([
    text(head),
    photos.length ? gallery(photos.slice(0, PHOTOS)) : null,
    sep(),
    text(body || '-# Aucun point particulier à signaler.'),
    r.manque && r.manque.length ? text(`${e('fb_ask')} **Photos à demander à l'agent :** ${r.manque.map((x) => escape(x)).join(' · ')}`) : null,
    r.conseil ? text(`${e('fb_tip')} **Recommandation :** ${escape(r.conseil)}`) : null,
    sep(false),
    text(`-# ${e('fb_brain')} Analyse sur ${done.join(' · ')}${who ? `  ·  demandée par <@${who}>` : ''}${res.cached ? '  ·  résultat déjà disponible' : ''}\n` +
      '-# Avis indicatif, sans garantie. Les votes GL / RL des membres complètent cette analyse.'),
    ...(match || []),
  ], tier.color)];
}

// ---------------------------------------------------------------- Salons d'analyse

// Photos postées dans un salon d'analyse : « Analyse en cours… » tout de suite, puis le résultat à la place.
// Si le message contient le lien de l'item, sa photo vendeur sert de référence. Renvoie le nombre de requêtes faites.
export async function aiqcMessage(env, ctx, c, m) {
  const isImg = (a) => /^image\/(jpeg|png|webp)/.test(a.content_type || '') || /\.(jpe?g|png|webp)$/i.test(a.filename || '');
  const shots = (m.attachments || []).filter(isImg).slice(0, PHOTOS);
  if (!shots.length) return 0;
  const lim = await rateLimit(env, 'aiqc', m.author && m.author.id, LIMITS.aiqc);
  if (!lim.ok) {
    await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, {
      content: limitText(lim, 'analyses IA', etxt(ctx.emojis, 'fb_clock')), allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false },
    }).catch(() => {});
    return 1;
  }
  const accent = (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color;
  // Message d'attente tout de suite, mis à jour à chaque étape (barre de progression, temps restant).
  let pending = null;
  const step = await tracker(env, ctx.emojis, {
    keys: ['match', 'photos', 'zoom', 'compare', 'merge', 'verify'], count: shots.length, accent,
    send: async (components) => {
      const body = { flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components };
      if (pending) return discordApi(env, 'PATCH', `/channels/${c.channel_id}/messages/${pending.id}`, body);
      pending = await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, { ...body, message_reference: { message_id: m.id, fail_if_not_exists: false } });
    },
  });
  await step.first();
  // Lien de l'item dans le message : photo du vendeur comme référence, et un autre batch de l'article.
  let ref = null;
  let title = null;
  let gold = null;
  const { extractItemRefs } = await import('./links.js');
  const refItem = extractItemRefs(m.content || '')[0];
  const urls = shots.map(smallImageUrl);
  if (refItem) {
    const { itemById } = await import('./shard.js');
    const item = await itemById(env, `${refItem.platform}:${refItem.itemId}`).catch(() => null)
      || { id: `${refItem.platform}:${refItem.itemId}`, platform: refItem.platform, item_id: refItem.itemId };
    if (item.image || item.title_en) { ref = /^https:\/\//.test(item.image || '') ? item.image : null; title = item.title_en || item.title_zh; }
    step.log(title ? `Lien de l'article détecté : ${String(title).slice(0, 50)}` : 'Lien de l\'article détecté');
    gold = goldPhoto(await fetchQc(item, 1).catch(() => null), urls, item);
  } else step.log('Recherche de l\'article dans le catalogue…');
  // Sinon : l'article qui ressemble le plus (recherche par image FinderQC, sans quota d'IA), montré avec ses boutons
  // d'achat et de QC ; une de ses QC sert de référence (l'IA vérifie d'abord que c'est le même article).
  const found = refItem ? [] : await searchByImage(shots[0].url, shots[0].filename, 3).catch(() => []);
  if (!refItem) step.log(found[0] ? `Article correspondant probable : ${String(found[0].title || '').slice(0, 45)}` : 'Aucun article correspondant : analyse sans référence');
  if (!gold && found[0] && found[0].qc) {
    gold = goldPhoto(await fetchQcPage(found[0].id, 1).catch(() => null), urls, {}, false);
  }
  step('photos');
  const res = await qcAnalysis(env, urls, { ref, what: title, gold, progress: step });
  await step.finish(res.result && !res.cached);
  c.done++;
  const body = { flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components: analysisView(ctx.emojis, res, { title, who: m.author && m.author.id, match: (() => { const x = res.result && found.find((f) => sameArticle(res.result.article || title, f.title)); return x ? matchBlocks(ctx, x, c.channel_id) : null; })() }) };
  if (pending) await discordApi(env, 'PATCH', `/channels/${c.channel_id}/messages/${pending.id}`, body);
  else await discordApi(env, 'POST', `/channels/${c.channel_id}/messages`, { ...body, message_reference: { message_id: m.id, fail_if_not_exists: false } });
  return 8;
}

// Le résultat de la recherche par image correspond-il à l'article analysé ? Même marque (si les deux en ont une),
// sinon même catégorie (si les deux sont connues). Dans le doute, non : mieux vaut ne rien proposer qu'un article
// sans rapport (ex. un caleçon pour un maillot de foot).
export function sameArticle(analysed, candidate) {
  const brands = (t) => new Set(expandQuery(String(t || '')).filter((g) => g.kind === 'brand').map((g) => g.alt[0]));
  const a = brands(analysed);
  const b = brands(candidate);
  if (a.size && b.size) return [...a].some((x) => b.has(x));
  if (a.size || b.size) return false;
  const ca = detectCategory(String(analysed || ''));
  const cb = detectCategory(String(candidate || ''));
  return ca !== 'other' && ca === cb;
}

// « L'article qui ressemble le plus » sous l'analyse : photo, prix, ventes, QC, et les boutons acheter / QC / comparer.
function matchBlocks(ctx, x, channelId) {
  const e = (n) => etxt(ctx.emojis, n);
  const item = { id: `${x.platform}:${x.id}`, platform: x.platform, item_id: x.id, url: canonicalUrl(x.platform, x.id) };
  const meta = [formatPrice(x.price, ctx.money), x.sold ? `${e('fb_fire')} ${x.sold}` : null, x.qc ? `${e('fb_qc')} ${x.qc} QC` : null].filter(Boolean);
  const head = `${e('fb_search')} **Article correspondant probable**\n${escape(String(x.title || '').slice(0, 80))}\n${meta.join('  ·  ')}\n-# Correspondance à vérifier avant tout achat.`;
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
