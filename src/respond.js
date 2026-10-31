// Réponses aux interactions Discord (panneaux Components V2).

import { Reply, EPHEMERAL, editOriginal, followup, json } from './discord.js';
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
      components = errorView();
    }
    await editOriginal(env, it.token, { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } })
      .catch((e) => console.log('édition', String(e)));
  })());
  return json(newMessage
    ? { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL | COMPONENTS_V2 } }
    : { type: Reply.DEFERRED_UPDATE });
}

// Bouton ou formulaire : Discord abandonne une réponse arrivée après 3 s (« L'interaction a échoué »). Passé 2,5 s,
// on accuse réception, puis le panneau est mis à jour (ou le message privé envoyé) quand le travail est fini.
export async function inTime(it, env, ctx, work) {
  const job = work();
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r(null), 2500); });
  const res = await Promise.race([job, late]);
  clearTimeout(timer);
  if (res) return res;
  ctx.waitUntil(job.then(async (r) => {
    const body = await r.json();
    if (body.type === Reply.UPDATE_MESSAGE) await editOriginal(env, it.token, body.data);
    else if (body.type === Reply.MESSAGE) await followup(env, it.token, { flags: EPHEMERAL, ...body.data });
    else console.log('réponse tardive ignorée', body.type);
  }).catch(async (err) => {
    console.log('tâche', err && err.stack ? err.stack : String(err));
    await editOriginal(env, it.token, { flags: COMPONENTS_V2, components: errorView(), allowed_mentions: { parse: [] } }).catch(() => {});
  }));
  return json({ type: Reply.DEFERRED_UPDATE });
}

export function userId(it) {
  return (it.member && it.member.user && it.member.user.id) || (it.user && it.user.id);
}
