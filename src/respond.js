// Réponses aux interactions Discord (panneaux Components V2).

import { Reply, EPHEMERAL, editOriginal, json } from './discord.js';
import { COMPONENTS_V2 } from './components.js';
import { errorView } from './ui.js';

export const MODAL = 9;

export const panel = (components, ephemeral = true) => json({
  type: Reply.MESSAGE,
  data: { flags: (ephemeral ? EPHEMERAL : 0) | COMPONENTS_V2, components, allowed_mentions: { parse: [] } },
});

export const update = (components) => json({
  type: Reply.UPDATE_MESSAGE,
  data: { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } },
});

export const openModal = (m) => json({ type: MODAL, data: m });

// Répond tout de suite, puis remplace le panneau quand la tâche (lente) est finie.
// newMessage = true : réponse à une commande (message éphémère « en cours… »), sinon mise à jour du panneau.
export function later(it, env, ctx, task, newMessage = false) {
  ctx.waitUntil((async () => {
    let components;
    try {
      components = await task();
    } catch (err) {
      console.log('tâche', err && err.stack ? err.stack : String(err));
      components = errorView(err.message || err);
    }
    await editOriginal(env, it.token, { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } })
      .catch((e) => console.log('édition', String(e)));
  })());
  return json(newMessage
    ? { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL | COMPONENTS_V2 } }
    : { type: Reply.DEFERRED_UPDATE });
}

export function userId(it) {
  return (it.member && it.member.user && it.member.user.id) || (it.user && it.user.id);
}
