// Onglet « Pub » de /menu (bêta, réservé au propriétaire du bot) : un message envoyé en MP aux membres des rôles
// choisis, sauf les membres exclus (blacklist) et ceux qui se sont désinscrits. Envoi lent par une file (25 MP par
// minute, 300 personnes au plus par envoi), avec un bouton « Se désinscrire » dans chaque MP (désactivable).
// Tout est gardé dans Upstash : brouillon (ad:draft), désinscrits (ad:optout), file (ad:queue), envoi en cours (ad:job).

import { container, text, sep, row, btn, Style, escape, modal } from './components.js';
import { discordApi } from './discord.js';
import { panel, update, openModal, later, userId } from './respond.js';
import { kvGet, kvSet, redis } from './kvstore.js';
import { loadEmojis, etxt, emo } from './emojis.js';

const MAX_RECIPIENTS = 300; // bêta
export const PER_RUN = 13; // MP par exécution (2 requêtes chacun : 50 requêtes au plus par exécution)
const COLOR = 0xf97316;

const isOwner = (env, it) => !!env.AGENTS_OWNER_ID && userId(it) === env.AGENTS_OWNER_ID;

async function getDraft(env) {
  try { return JSON.parse(await kvGet(env, 'ad:draft') || '{}'); } catch { return {}; }
}
const saveDraft = (env, d) => kvSet(env, 'ad:draft', JSON.stringify(d));
async function getJob(env) {
  try { return JSON.parse(await kvGet(env, 'ad:job') || 'null'); } catch { return null; }
}
const saveJob = (env, j) => kvSet(env, 'ad:job', JSON.stringify(j));

// Modèles de messages, chargés en un clic depuis l'onglet (le texte accepte la mise en forme Discord).
export const PRESETS = {
  kijfind: {
    label: 'Partenariat · Kij Find',
    title: '',
    image: 'https://finds-bot.wheatenmoon5861.workers.dev/img/kijfind.png',
    text: [
      '## {fb_bot} Kij Find',
      '-# La communauté des finds Weidian, Taobao et 1688',
      '---',
      'Tu achètes en Chine pour toi ou pour la revente ? **Kij Find** rassemble tout ce qu\'il te faut, au même endroit.',
      '',
      '{fb_link} **Liens vérifiés** pour tous tes achats',
      '{fb_price} **Bons plans** pensés pour la revente',
      '{fb_fire} **Nouveautés** et meilleures trouvailles, chaque jour',
      '{fb_qc} **Photos QC**, analysées par un bot expert',
      '{fb_signup} **Communauté** qui partage et s\'entraide',
      '---',
      '{fb_verified} Débutant ou revendeur confirmé : **tout le monde est le bienvenu.**',
    ].join('\n'),
    btnLabel: 'Rejoindre Kij Find',
    btnUrl: 'https://discord.gg/9XpCj6p6Rg',
  },
};

// Le MP envoyé (et son aperçu), au style des cartes du bot : image en haut (facultative), titre facultatif, texte écrit
// par le propriétaire avec sa mise en forme Discord. Dans le texte, {fb_fire} devient l'emoji du bot et une ligne
// « --- » un séparateur.
export function adMessage(emojis, d) {
  const e = (n) => etxt(emojis, n);
  const buttons = [
    d.btnLabel && /^https:\/\//.test(d.btnUrl || '') ? { type: 2, style: Style.LINK, label: d.btnLabel.slice(0, 80), url: d.btnUrl, emoji: emo(emojis, 'fb_link') } : null,
    d.unsub !== false ? { type: 2, style: Style.SECONDARY, label: 'Se désinscrire', custom_id: 'pub:adoff', emoji: { name: '🔕' } } : null,
  ].filter(Boolean);
  return [container([
    /^https:\/\//.test(d.image || '') ? { type: 12, items: [{ media: { url: d.image } }] } : null,
    d.title ? text(`## ${e('fb_gift')} ${escape(d.title)}`) : null,
    ...String(d.text || '').slice(0, 3500).replace(/\{(fb_[a-z0-9_]+)\}/g, (_, n) => e(n))
      .split(/\n-{3,}\n/).flatMap((part, i) => [i ? sep() : null, part.trim() ? text(part.trim()) : null]),
    buttons.length ? sep() : null,
    buttons.length ? row(...buttons) : null,
  ], COLOR)];
}

export async function pubView(env, it, msg = null) {
  const emojis = await loadEmojis(env);
  const e = (n) => etxt(emojis, n);
  const [d, job0, counts] = await Promise.all([getDraft(env), getJob(env),
    redis(env, [['SCARD', 'ad:optout'], ['LLEN', 'ad:queue'], ['LLEN', 'ad:pending'], ['GET', 'ad:sent'], ['GET', 'ad:failed']])]);
  const [optout, queued, pending, sentN, failedN] = (counts || [0, 0, 0, 0, 0]).map((n) => Number(n) || 0);
  const job = job0 && { ...job0, sent: sentN, failed: failedN };
  const roles = d.roles || [];
  const blacklist = d.blacklist || [];
  const status = job && job.total
    ? `${e(job.state === 'running' ? 'fb_loading' : 'fb_done')} **Envoi ${job.state === 'running' ? 'en cours' : job.state === 'stopped' ? 'arrêté' : 'terminé'}** : ${job.sent}/${job.total} envoyés` +
      `${job.failed ? `  ·  ${job.failed} impossibles (MP fermés)` : ''}${queued ? `  ·  ${queued} en attente` : ''}`
    : '-# Aucun envoi en cours.';
  return [container([
    msg ? text(msg) : null,
    text(`## ${e('fb_bell')} Pub (bêta)\n-# Réservé au propriétaire. MP aux membres des rôles choisis, ${PER_RUN * 2} par minute, ${MAX_RECIPIENTS} personnes au plus par envoi.`),
    sep(),
    text(d.text ? `**Message** (aperçu)${d.title ? ` · ${escape(d.title)}` : ''}\n${String(d.text).slice(0, 700)}${d.btnLabel ? `\n-# Bouton : ${escape(d.btnLabel)} → ${escape(d.btnUrl || '')}` : ''}`
      : '**Message** : aucun pour l\'instant. Clique sur « Modifier le message » ou choisis un modèle.'),
    text(`**Rôles ciblés** : ${roles.length ? roles.map((r) => `<@&${r}>`).join(' ') : 'aucun'}\n` +
      `**Exclus** : ${blacklist.length ? blacklist.map((u) => `<@${u}>`).join(' ') : 'personne'}\n` +
      `**Bouton « Se désinscrire »** : ${d.unsub !== false ? 'activé' : 'désactivé'}  ·  **Désinscrits** : ${optout}`),
    pending ? text(`${e('fb_mid')} **${pending} membres** vont recevoir ce message. Confirme pour lancer l'envoi.`) : null,
    text(status),
    sep(),
    { type: 1, components: [{ type: 3, custom_id: 'ad:preset', placeholder: 'Charger un modèle de message', min_values: 1, max_values: 1,
      options: Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label.slice(0, 100) })) }] },
    { type: 1, components: [{ type: 6, custom_id: 'ad:roles', placeholder: 'Rôles qui recevront le message', min_values: 0, max_values: 10,
      default_values: roles.map((id) => ({ id, type: 'role' })) }] },
    { type: 1, components: [{ type: 5, custom_id: 'ad:bl', placeholder: 'Membres exclus (ne recevront rien)', min_values: 0, max_values: 25,
      default_values: blacklist.map((id) => ({ id, type: 'user' })) }] },
    row(
      btn('Modifier le message', 'ad:edit', Style.PRIMARY, { emoji: emo(emojis, 'fb_signup') }),
      btn('Aperçu en MP', 'ad:preview', Style.SECONDARY, { emoji: emo(emojis, 'fb_search') }),
      btn(d.unsub !== false ? 'Désactiver « Se désinscrire »' : 'Activer « Se désinscrire »', 'ad:unsub', Style.SECONDARY, { emoji: { name: '🔕' } }),
    ),
    row(
      pending ? btn(`Confirmer l'envoi (${pending})`, 'ad:go', Style.SUCCESS) : btn('Préparer l\'envoi', 'ad:send', Style.SUCCESS, { disabled: !d.text || !roles.length || (job && job.state === 'running') }),
      pending ? btn('Annuler', 'ad:cancel', Style.SECONDARY) : null,
      job && job.state === 'running' ? btn('Arrêter l\'envoi', 'ad:stop', Style.DANGER) : null,
      btn('Retour', 'sec:open', Style.SECONDARY),
    ),
  ], COLOR)];
}

// Membres du serveur qui ont un des rôles, hors bots, exclus et désinscrits (permission « Server Members Intent »).
async function recipients(env, guildId, roles, blacklist) {
  const optout = new Set((await redis(env, [['SMEMBERS', 'ad:optout']]) || [[]])[0] || []);
  const skip = new Set(blacklist);
  const out = [];
  let after = '0';
  for (let page = 0; page < 10 && out.length < MAX_RECIPIENTS; page++) {
    const list = await discordApi(env, 'GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    for (const m of list) {
      if (out.length >= MAX_RECIPIENTS) break;
      if (!m.user || m.user.bot || skip.has(m.user.id) || optout.has(m.user.id)) continue;
      if ((m.roles || []).some((r) => roles.includes(r))) out.push(m.user.id);
    }
    if (list.length < 1000) break;
    after = list[list.length - 1].user.id;
  }
  return out;
}

export async function handlePubComponent(it, env, ctx, b, values) {
  if (!isOwner(env, it)) return panel([container([text('Onglet réservé au propriétaire du bot.')])]);
  const d = await getDraft(env);
  switch (b) {
    case 'open': return update(await pubView(env, it));
    case 'edit': return openModal(modal('m:ad', 'Message de la pub', [
      { id: 'title', label: 'Titre (facultatif)', placeholder: 'ex : -20 % sur BBDBuy ce week-end', value: d.title, max: 100 },
      { id: 'text', label: 'Message', description: 'Mise en forme Discord, {fb_fire} = emoji du bot, ligne --- = séparateur', long: true, value: d.text, max: 3000, required: true },
      { id: 'btnLabel', label: 'Texte du bouton (facultatif)', placeholder: 'ex : J\'en profite', value: d.btnLabel, max: 60 },
      { id: 'btnUrl', label: 'Lien du bouton (facultatif)', placeholder: 'https://…', value: d.btnUrl, max: 300 },
      { id: 'image', label: 'Image en haut (lien, facultatif)', placeholder: 'https://…/banniere.png', value: d.image, max: 300 },
    ]));
    case 'preset': {
      const p = PRESETS[values[0]];
      if (!p) return update(await pubView(env, it));
      await saveDraft(env, { ...d, title: p.title, text: p.text, image: p.image || '', btnLabel: p.btnLabel, btnUrl: p.btnUrl });
      return update(await pubView(env, it, `✅ Modèle « ${p.label} » chargé. Vérifie-le avec « Aperçu en MP ».`));
    }
    case 'roles': await saveDraft(env, { ...d, roles: values.slice(0, 10), guild: it.guild_id }); return update(await pubView(env, it));
    case 'bl': await saveDraft(env, { ...d, blacklist: values.slice(0, 25) }); return update(await pubView(env, it));
    case 'unsub': await saveDraft(env, { ...d, unsub: d.unsub === false }); return update(await pubView(env, it));
    case 'preview': {
      if (!d.text) return update(await pubView(env, it, '❌ Écris d\'abord le message.'));
      try {
        const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: userId(it) });
        await discordApi(env, 'POST', `/channels/${dm.id}/messages`, { flags: 32768, allowed_mentions: { parse: [] }, components: adMessage(await loadEmojis(env), d) });
        return update(await pubView(env, it, '✅ Aperçu envoyé en MP.'));
      } catch (err) {
        return update(await pubView(env, it, `❌ Aperçu impossible : ${escape(String(err.message || err).slice(0, 120))}`));
      }
    }
    case 'send': return later(it, env, ctx, async () => {
      try {
        const list = await recipients(env, d.guild || it.guild_id, d.roles || [], d.blacklist || []);
        await redis(env, [['DEL', 'ad:pending'], ...(list.length ? [['RPUSH', 'ad:pending', ...list]] : [])]);
        return pubView(env, it, list.length ? null : '❌ Aucun membre ne correspond (rôles vides, ou tous exclus ou désinscrits).');
      } catch (err) {
        const why = /50001|403|Missing Access/i.test(String(err))
          ? 'Le bot ne peut pas lire la liste des membres : active **Server Members Intent** dans le Developer Portal (Bot → Privileged Gateway Intents).'
          : escape(String(err.message || err).slice(0, 150));
        return pubView(env, it, `❌ ${why}`);
      }
    });
    case 'cancel': await redis(env, [['DEL', 'ad:pending']]); return update(await pubView(env, it, 'Envoi annulé.'));
    case 'go': {
      const n = Number(((await redis(env, [['LLEN', 'ad:pending']])) || [0])[0]) || 0;
      if (!n) return update(await pubView(env, it));
      await redis(env, [['DEL', 'ad:queue'], ['RENAME', 'ad:pending', 'ad:queue']]);
      await redis(env, [['SET', 'ad:sent', '0'], ['SET', 'ad:failed', '0']]);
      await saveJob(env, { state: 'running', total: n, at: Date.now(), draft: d });
      await kvSet(env, 'ad:active', '1');
      return update(await pubView(env, it, `✅ Envoi lancé : ${n} membres, ${PER_RUN * 2} par minute (environ ${Math.ceil(n / (PER_RUN * 2))} min).`));
    }
    case 'stop': {
      const job = await getJob(env);
      await redis(env, [['DEL', 'ad:queue'], ['DEL', 'ad:active']]);
      if (job) await saveJob(env, { ...job, state: 'stopped' });
      return update(await pubView(env, it, 'Envoi arrêté.'));
    }
    default: return null;
  }
}

export async function handlePubModal(it, env, v) {
  if (!isOwner(env, it)) return panel([container([text('Onglet réservé au propriétaire du bot.')])]);
  const d = await getDraft(env);
  const url = String(v.btnUrl || '').trim();
  await saveDraft(env, { ...d, title: String(v.title || '').slice(0, 100), text: String(v.text || '').slice(0, 3000),
    btnLabel: url ? String(v.btnLabel || 'Voir').slice(0, 60) : '', btnUrl: /^https:\/\//.test(url) ? url : '',
    image: /^https:\/\//.test(String(v.image || '').trim()) ? String(v.image).trim() : '' });
  return update(await pubView(env, it, url && !/^https:\/\//.test(url) ? '⚠️ Le lien doit commencer par https:// : bouton retiré.' : '✅ Message enregistré.'));
}

// « Se désinscrire » dans un MP : plus aucun MP de pub pour ce membre.
export async function pubUnsubscribe(it, env) {
  await redis(env, [['SADD', 'ad:optout', userId(it)]]);
  return panel([container([text('🔕 C\'est noté : tu ne recevras plus ces messages.')])]);
}

// Chaque minute (deux exécutions en parallèle) : les MP suivants de la file.
export async function runPubQueue(env) {
  const job = await getJob(env);
  if (!job || job.state !== 'running') return 0;
  const popped = (await redis(env, [['LPOP', 'ad:queue', String(PER_RUN)]]) || [null])[0] || [];
  if (!popped.length) {
    await redis(env, [['DEL', 'ad:active']]);
    await saveJob(env, { ...job, state: 'done' });
    return 0;
  }
  const emojis = await loadEmojis(env);
  const components = adMessage(emojis, job.draft || {});
  let sent = 0;
  let failed = 0;
  for (const [i, id] of popped.entries()) {
    try {
      const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: id });
      await discordApi(env, 'POST', `/channels/${dm.id}/messages`, { flags: 32768, allowed_mentions: { parse: [] }, components });
      sent++;
    } catch (err) {
      if (/429/.test(String(err))) {
        // Discord demande de ralentir : le reste repart en tête de file pour la minute suivante.
        await redis(env, [['LPUSH', 'ad:queue', ...popped.slice(i).reverse()]]);
        break;
      }
      failed++; // MP fermés ou membre parti
    }
  }
  // Compteurs atomiques : deux exécutions envoient en même temps.
  await redis(env, [['INCRBY', 'ad:sent', String(sent)], ['INCRBY', 'ad:failed', String(failed)]]);
  return sent;
}
