// Onglet « Secret » de /menu : tous les outils réservés au propriétaire du bot, au même endroit (pub, serveurs du bot,
// dashboard). Invisible et refusé pour tout autre membre.

import { container, text, sep, row, btn, Style } from './components.js';
import { panel, update, userId } from './respond.js';
import { loadEmojis, etxt, emo } from './emojis.js';
import { dashboardToken } from './dashboard.js';

export const isOwner = (env, it) => !!env.AGENTS_OWNER_ID && !!it && userId(it) === env.AGENTS_OWNER_ID;

export async function secretView(env, it) {
  const emojis = await loadEmojis(env);
  const e = (n) => etxt(emojis, n);
  const dash = `${(env.PUBLIC_URL || '').replace(/\/$/, '')}/dashboard?t=${await dashboardToken(env)}`;
  return [container([
    text(`## ${e('fb_crown')} Secret\n-# Outils réservés au propriétaire du bot. Personne d'autre ne voit cet onglet.`),
    sep(),
    text(`${e('fb_stats')} **Dashboard** : services, catalogue, quotas et activité en direct (lien personnel valable 7 jours).\n` +
      `${e('fb_bell')} **Pub (bêta)** : message en MP aux membres des rôles choisis.\n` +
      `${e('fb_shop')} **Serveurs du bot** : la liste des serveurs, et faire quitter le bot d'un serveur.`),
    sep(),
    row(
      { type: 2, style: Style.LINK, label: 'Dashboard', url: dash, emoji: emo(emojis, 'fb_stats') },
      btn('Pub (bêta)', 'ad:open', Style.SECONDARY, { emoji: emo(emojis, 'fb_bell') }),
      btn('Serveurs du bot', 'srv:open', Style.SECONDARY, { emoji: emo(emojis, 'fb_shop') }),
    ),
    row(btn('Retour', 'home', Style.SECONDARY, { emoji: emo(emojis, 'fb_bot') })),
  ], 0xeab308)];
}

export async function handleSecretComponent(it, env) {
  if (!isOwner(env, it)) return panel([container([text('Réservé au propriétaire du bot.')])]);
  return update(await secretView(env, it));
}
