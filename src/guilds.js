// Approbation des serveurs : quand le bot est ajouté à un nouveau serveur, le propriétaire reçoit un MP avec
// « Approuver » / « Refuser ». Tant que ce n'est pas approuvé, le bot est présent mais ne fait rien dans ce serveur
// (chaque commande ou bouton répond qu'il attend l'approbation). « Refuser » le fait quitter le serveur.
// Upstash : guilds:ok (approuvés), guilds:pending (en attente, déjà signalés). Sans Upstash, tout est autorisé.

import { container, text, sep, row, btn, Style, escape } from './components.js';
import { discordApi } from './discord.js';
import { redis } from './kvstore.js';
import { loadEmojis, etxt, emo } from './emojis.js';
import { panel, update, userId } from './respond.js';

// Approuvé ? (gardé 60 s en mémoire par serveur ; en cas de doute, oui)
const memo = new Map();
export async function guildApproved(env, guildId) {
  if (!guildId) return true;
  const m = memo.get(guildId);
  if (m && Date.now() - m.at < 60000) return m.ok;
  const r = await redis(env, [['SISMEMBER', 'guilds:ok', guildId], ['SCARD', 'guilds:ok']]);
  // Upstash absent, ou liste encore vide (première mise en route) : autorisé.
  const ok = !r || !Number(r[1]) || Number(r[0]) === 1;
  memo.set(guildId, { at: Date.now(), ok });
  return ok;
}

export function notApprovedView() {
  return [container([text('### ⏳ Serveur en attente d\'approbation\nLe propriétaire du bot doit approuver ce serveur avant que le bot puisse y être utilisé. Merci de patienter.')], 0x64748b)];
}

// Toutes les 3 min : serveurs du bot pas encore approuvés ni signalés → MP au propriétaire. Au premier passage,
// les serveurs déjà là sont approuvés d'office.
export async function checkNewGuilds(env) {
  if (!env.AGENTS_OWNER_ID) return 0;
  const guilds = await discordApi(env, 'GET', '/users/@me/guilds?with_counts=true');
  const state = await redis(env, [['SMEMBERS', 'guilds:ok'], ['SMEMBERS', 'guilds:pending']]);
  if (!state) return 0;
  const ok = new Set(state[0] || []);
  const pending = new Set(state[1] || []);
  if (!ok.size) {
    if (guilds.length) await redis(env, [['SADD', 'guilds:ok', ...guilds.map((g) => g.id)]]);
    return 0;
  }
  let sent = 0;
  for (const g of guilds) {
    if (ok.has(g.id) || pending.has(g.id)) continue;
    await redis(env, [['SADD', 'guilds:pending', g.id]]);
    await dmOwner(env, g).catch((err) => console.log('approbation (MP)', String(err).slice(0, 120)));
    sent++;
  }
  return sent;
}

async function dmOwner(env, g) {
  const emojis = await loadEmojis(env);
  const e = (n) => etxt(emojis, n);
  const icon = g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null;
  const head = `## ${e('fb_bell')} Nouveau serveur à approuver\n**${escape(g.name)}**` +
    `${g.approximate_member_count ? `\n-# ${g.approximate_member_count.toLocaleString('fr-FR')} membres` : ''}\n-# Identifiant : ${g.id}`;
  const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: env.AGENTS_OWNER_ID });
  await discordApi(env, 'POST', `/channels/${dm.id}/messages`, {
    flags: 32768, allowed_mentions: { parse: [] },
    components: [container([
      icon ? { type: 9, components: [text(head)], accessory: { type: 11, media: { url: icon } } } : text(head),
      text('Le bot a été ajouté à ce serveur. Il n\'y fera rien tant que tu n\'as pas approuvé.'),
      sep(),
      row(btn('Approuver', `pub:gok:${g.id}`, Style.SUCCESS, { emoji: emo(emojis, 'fb_ok') }),
        btn('Refuser et quitter', `pub:gno:${g.id}`, Style.DANGER, { emoji: emo(emojis, 'fb_bad') })),
    ], 0xf59e0b)],
  });
}

// Boutons du MP d'approbation (propriétaire seulement).
export async function handleGuildDecision(it, env, kind, guildId) {
  if (!env.AGENTS_OWNER_ID || userId(it) !== env.AGENTS_OWNER_ID) return panel([container([text('Réservé au propriétaire du bot.')])]);
  memo.delete(guildId);
  if (kind === 'gok') {
    await redis(env, [['SADD', 'guilds:ok', guildId], ['SREM', 'guilds:pending', guildId]]);
    return update([container([text(`### ✅ Serveur approuvé\nLe bot fonctionne maintenant sur ce serveur (${guildId}).`)], 0x22c55e)]);
  }
  await redis(env, [['SREM', 'guilds:pending', guildId], ['SREM', 'guilds:ok', guildId]]);
  const left = await discordApi(env, 'DELETE', `/users/@me/guilds/${guildId}`).then(() => true).catch(() => false);
  return update([container([text(left ? `### ❌ Serveur refusé\nLe bot a quitté ce serveur (${guildId}).` : `### ❌ Serveur refusé\nLe bot n'était déjà plus sur ce serveur (${guildId}).`)], 0xef4444)]);
}
