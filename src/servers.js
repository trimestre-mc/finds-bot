// Serveurs du bot (/menu, réservé au propriétaire) : la liste des serveurs où il est, et faire quitter le bot d'un
// serveur après confirmation (il ne peut y revenir que si quelqu'un le réinvite).

import { container, text, sep, row, btn, Style, escape } from './components.js';
import { discordApi } from './discord.js';
import { panel, update, userId } from './respond.js';
import { loadEmojis, etxt, emo } from './emojis.js';

const isOwner = (env, it) => !!env.AGENTS_OWNER_ID && userId(it) === env.AGENTS_OWNER_ID;

export async function serversView(env, it, msg = null, confirm = null) {
  const emojis = await loadEmojis(env);
  const e = (n) => etxt(emojis, n);
  const guilds = await discordApi(env, 'GET', '/users/@me/guilds?with_counts=true').catch(() => []);
  const lines = guilds.map((g) => `${g.id === it.guild_id ? e('fb_live') : '•'} **${escape(g.name)}**` +
    `${g.approximate_member_count ? `  ·  ${g.approximate_member_count.toLocaleString('fr-FR')} membres` : ''}${g.id === it.guild_id ? '  ·  serveur actuel' : ''}`);
  const target = confirm && guilds.find((g) => g.id === confirm);
  return [container([
    msg ? text(msg) : null,
    text(`## ${e('fb_shop')} Serveurs du bot\n-# Réservé au propriétaire. ${guilds.length} serveur${guilds.length > 1 ? 's' : ''}.`),
    sep(),
    text(lines.join('\n') || '-# Aucun serveur.'),
    sep(),
    target
      ? text(`${e('fb_warn')} **Faire quitter le bot de « ${escape(target.name)} » ?**\n-# Ses salons configurés n'y fonctionneront plus, et il ne pourra revenir que si quelqu'un le réinvite.`)
      : null,
    target
      ? row(btn('Oui, quitter ce serveur', `srv:leave:${target.id}`, Style.DANGER), btn('Annuler', 'srv:open', Style.SECONDARY))
      : { type: 1, components: [{ type: 3, custom_id: 'srv:pick', placeholder: 'Choisir un serveur à quitter', min_values: 1, max_values: 1,
        options: guilds.slice(0, 25).map((g) => ({ value: g.id, label: g.name.slice(0, 100), description: g.id === it.guild_id ? 'Serveur actuel' : undefined })) }] },
    row(btn('Retour', 'sec:open', Style.SECONDARY, { emoji: emo(emojis, 'fb_crown') })),
  ], 0x64748b)];
}

export async function handleServersComponent(it, env, b, c, values) {
  if (!isOwner(env, it)) return panel([container([text('Réservé au propriétaire du bot.')])]);
  if (b === 'open') return update(await serversView(env, it));
  if (b === 'pick') return update(await serversView(env, it, null, values[0]));
  if (b === 'leave' && c) {
    try {
      await discordApi(env, 'DELETE', `/users/@me/guilds/${c}`);
      // Plus de panneau à mettre à jour si le bot vient de quitter le serveur actuel.
      if (c === it.guild_id) return panel([container([text('✅ Le bot a quitté ce serveur.')])]);
      return update(await serversView(env, it, '✅ Le bot a quitté le serveur.'));
    } catch (err) {
      return update(await serversView(env, it, `❌ Impossible de quitter ce serveur : ${escape(String(err.message || err).slice(0, 120))}`));
    }
  }
  return null;
}
