// Recherche par image (cron toutes les 2 min) : dans les salons choisis, chaque photo postée par un membre est
// envoyée à la recherche par image de FinderQC (avec l'accord de son propriétaire), et le bot répond avec les items
// qui ressemblent le plus : photo, prix, nombre de QC, bouton d'achat avec ton code et bouton QC.

import { COMPONENTS_V2, container, text, sep, section, thumb, row, link, escape } from './components.js';
import { discordApi } from './discord.js';
import { formatPrice, itemTitle, postContext, trackedLink } from './post.js';
import { buildAgentLink, canonicalUrl } from './links.js';
import { popularItemStatements } from './items.js';
import { budget } from './budget.js';
import { ACCENTS } from './config.js';
import { logError } from './post.js';

const API = 'https://server.finderqc.com/api/searchImage';
const UA = 'finds-bot/1.0 (+https://finds-bot.wheatenmoon5861.workers.dev)';
const PLATFORMS = { Weidian: 'weidian', Taobao: 'taobao', Ali1688: '1688' };
const RESULTS = 4; // 4 items par réponse (limite de 40 composants d'un message Discord)
const MAX_BYTES = 8 * 1024 * 1024;
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');

const isImage = (a) => /^image\/(jpeg|png|webp|gif)/.test(a.content_type || '') || /\.(jpe?g|png|webp)$/i.test(a.filename || '');

// Items qui ressemblent à une image (URL). Renvoie [{ platform, id, title, price, image, sold, qc }] ou [].
export async function searchByImage(imageUrl, filename = 'image.jpg') {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`image ${img.status}`);
  const blob = await img.blob();
  if (blob.size > MAX_BYTES) return [];
  const form = new FormData();
  form.append('file', blob, filename.replace(/[^\w.-]/g, '_').slice(0, 60) || 'image.jpg');
  const res = await fetch(`${API}/search`, { method: 'POST', body: form, headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FinderQC ${res.status}`);
  const data = await res.json();
  const sid = data && data.code === 0 && data.data && data.data.search_id;
  if (!sid) return [];
  const list = await fetch(`${API}/results/${encodeURIComponent(sid)}?page=1&pageSize=${RESULTS * 2}`, { headers: { 'User-Agent': UA } });
  if (!list.ok) throw new Error(`FinderQC ${list.status}`);
  const found = await list.json();
  return ((found && found.data && found.data.results) || []).map((x) => ({
    platform: PLATFORMS[x.mallType], id: String(x.itemId || ''), title: x.enTitle || x.originalTitle,
    price: x.cnPrice, image: x.originalThubnaiURL || x.picUrl, sold: Number(x.oneYear) || 0, qc: Number(x.qcPhotosCount) || 0,
  })).filter((x) => x.platform && /^\d{6,14}$/.test(x.id) && canonicalUrl(x.platform, x.id)).slice(0, RESULTS);
}

// Réponse du bot : les items qui ressemblent, chacun avec achat (1er agent, lien suivi) et QC dans Discord.
export function imageResultsView(ctx, found, channelId) {
  const blocks = [text(found.length ? '### 🔎 Items qui ressemblent à ta photo' : '### 🔎 Aucun item ne ressemble à cette photo')];
  for (const x of found) {
    const item = { id: `${x.platform}:${x.id}`, platform: x.platform, item_id: x.id, url: canonicalUrl(x.platform, x.id), title_en: x.title };
    const meta = [formatPrice(x.price, ctx.money)];
    if (x.qc) meta.push(`📸 ${fmt(x.qc)} QC`);
    if (x.sold) meta.push(`🔥 ${fmt(x.sold)}`);
    const head = `**${escape(itemTitle(item).slice(0, 80))}**\n${meta.join('  ·  ')}`;
    const agent = ctx.agents[0];
    const buttons = [
      agent
        ? link(`Acheter sur ${agent.name}`.slice(0, 80), trackedLink(ctx, item, agent.name, buildAgentLink(agent.template, item), channelId), '🛒')
        : link('Voir l\'annonce', item.url, '🔗'),
      { type: 2, style: 1, label: x.qc ? `Voir les QC (${fmt(x.qc)})` : 'Photos QC', emoji: { name: '📸' }, custom_id: `pub:qc:${item.id}`.slice(0, 100) },
    ];
    blocks.push(sep());
    blocks.push(/^https:\/\//.test(x.image || '') ? section(head, thumb(x.image)) : text(head));
    blocks.push(row(...buttons));
  }
  return [container(blocks, (ACCENTS[ctx.cfg.accent] || ACCENTS.orange).color)];
}

export async function runImageSearch(env) {
  const { results } = await env.DB.prepare('SELECT * FROM image_channels ORDER BY added_at LIMIT 5').all();
  if (!results.length) return;
  let calls = 0;
  let searched = 0;
  let ctx = null;
  const found = [];
  for (const ch of results) {
    if (calls > 30) break;
    try {
      const path = `/channels/${ch.channel_id}/messages?limit=50${ch.last_message_id ? `&after=${ch.last_message_id}` : ''}`;
      const messages = await discordApi(env, 'GET', path);
      calls++;
      if (!messages.length) continue;
      const newest = messages.reduce((m, x) => (BigInt(x.id) > BigInt(m) ? x.id : m), messages[0].id);
      // Première lecture : on démarre à partir de maintenant, sans répondre aux anciennes photos.
      if (!ch.last_message_id) {
        await env.DB.prepare('UPDATE image_channels SET last_message_id = ? WHERE channel_id = ?').bind(newest, ch.channel_id).run();
        continue;
      }
      let done = 0;
      let last = ch.last_message_id;
      for (const m of messages.slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
        // Au plus 5 photos par passage : le reste attend le prochain (dans 2 min).
        if (searched >= 5 || calls > 40) break;
        last = m.id;
        if (m.author && m.author.bot) continue;
        const images = (m.attachments || []).filter(isImage).slice(0, 2);
        for (const a of images) {
          const items = await searchByImage(a.url, a.filename).catch((err) => { console.log('image', String(err).slice(0, 120)); return null; });
          calls += 3;
          searched++;
          if (!items) continue;
          found.push(...items);
          if (!ctx) ctx = await postContext(env);
          await discordApi(env, 'POST', `/channels/${ch.channel_id}/messages`, {
            flags: COMPONENTS_V2, components: imageResultsView(ctx, items, ch.channel_id), allowed_mentions: { parse: [] },
            message_reference: { message_id: m.id, fail_if_not_exists: false },
          });
          calls++;
          done++;
        }
      }
      await env.DB.prepare('UPDATE image_channels SET last_message_id = ?, searched = searched + ? WHERE channel_id = ?')
        .bind(searched >= 5 ? last : newest, done, ch.channel_id).run();
    } catch (err) {
      await logError(env, 'recherche image', `<#${ch.channel_id}> : ${String(err.message || err).slice(0, 200)}`);
    }
  }
  // Les items trouvés rejoignent le catalogue (budget du jour).
  if (found.length) {
    const b = await budget(env, 'items');
    const { stmts, count } = popularItemStatements(env, found.slice(0, b.left), 'finderqc');
    if (count) await env.DB.batch(stmts).then(() => b.use(count)).catch(() => {});
  }
}
