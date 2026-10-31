// Rapport du jour, envoyé en message privé au propriétaire du bot (AGENTS_OWNER_ID) chaque soir : nouveaux items,
// clics, posts, alertes, quotas des deux bases et dernières erreurs. Seulement des lectures légères (index, compteurs).

import { COMPONENTS_V2, container, text, sep, fmtInt, escape } from './components.js';
import { discordApi } from './discord.js';
import { itemDbs } from './shard.js';
import { loadEmojis, etxt } from './emojis.js';
import { aiNeurons, AI_NEURONS_PER_DAY } from './translate.js';

const DAY = 86400000;
const pct = (a, b) => (b ? `${Math.min(100, Math.round((100 * a) / b))} %` : '—');
const millions = (n) => `${(Number(n || 0) / 1e6).toFixed(1).replace('.', ',')} M`;

// save : garde le dernier rowid de chaque base (le « +N en 24 h » du rapport suivant) ; pas pour un simple aperçu.
export async function dailyReport(env, save = false) {
  const since = Date.now() - DAY;
  const read = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first()
    .then((r) => { try { return r ? JSON.parse(r.value) : {}; } catch { return {}; } });
  const [emojis, clicks, byAgent, posts, watches, logs, ai, bases] = await Promise.all([
    loadEmojis(env),
    env.DB.prepare('SELECT COUNT(*) AS n FROM clicks WHERE at > ?').bind(since).first(),
    env.DB.prepare('SELECT agent, COUNT(*) AS n FROM clicks WHERE at > ? GROUP BY agent ORDER BY n DESC LIMIT 4').bind(since).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE posted_at > ?').bind(since).first(),
    env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM watches').first(),
    env.DB.prepare('SELECT kind, message, at FROM logs WHERE at > ? ORDER BY id DESC LIMIT 3').bind(since).all(),
    aiNeurons(env),
    Promise.all(itemDbs(env).map(async (db, i) => {
      // Base illisible (quota du mois) : rapport quand même envoyé, sans ses chiffres.
      if (!(await db.prepare('SELECT 1 FROM settings LIMIT 1').first().then(() => true).catch(() => false))) return { i, blocked: true };
      const [top, month, reads, prev] = await Promise.all([
        db.prepare('SELECT MAX(rowid) AS m FROM items').first(),
        read(db, 'budget:month'), read(db, 'reads:month'), read(db, 'report:rowid'),
      ]);
      if (save) await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('report:rowid', ?)").bind(JSON.stringify({ m: top.m, at: Date.now() })).run();
      return { i, last: top.m || 0, added: prev.m ? (top.m || 0) - prev.m : null, written: month.rows || 0, reads: reads.rows || 0 };
    })),
  ]);
  const e = (n) => etxt(emojis, n);
  const writeCap = Number(env.BUDGET_MONTH_ROWS) || 9000000;
  const readCap = Number(env.READS_MONTH_CAP) || 480000000;
  const names = ['Weidian', 'Taobao + 1688'];
  const baseLines = bases.map((b) => b.blocked ? `**Base ${b.i + 1} · ${names[b.i] || ''}** : lectures bloquées jusqu'au 1er du mois` : `**Base ${b.i + 1} · ${names[b.i] || ''}** : ≈ ${fmtInt(b.last)} items` +
    (b.added != null ? ` (**+${fmtInt(b.added)}** en 24 h)` : '') +
    `\n-# écritures ${millions(b.written)} (${pct(b.written, writeCap)})  ·  lectures ${millions(b.reads)} (${pct(b.reads, readCap)})` +
    (b.reads >= readCap ? '  ·  ⏸️ indexation en pause jusqu\'au 1er du mois' : ''));
  const agentLine = byAgent.results.map((a) => `${escape(a.agent)} ${fmtInt(a.n)}`).join(' · ');
  return [container([
    text(`## ${e('fb_stats')} Rapport du jour\n-# <t:${Math.floor(Date.now() / 1000)}:F>`),
    sep(),
    text(`### ${e('fb_trend')} Activité (24 h)\n` +
      `${e('fb_cart')} **${fmtInt(clicks.n)}** clics${agentLine ? ` (${agentLine})` : ''}\n` +
      `${e('fb_new')} **${fmtInt(posts.n)}** items postés\n` +
      `${e('fb_bell')} **${fmtInt(watches.n)}** alertes de prix (${fmtInt(watches.u)} membres)`),
    text(`### ${e('fb_box')} Catalogue\n${baseLines.join('\n')}`),
    text(`### ${e('fb_bot')} IA\n${fmtInt(Math.round(ai.used))} / ${fmtInt(AI_NEURONS_PER_DAY)} neurons aujourd'hui (titres traduits + photos lues)`),
    text(`### ${e('fb_warn')} Erreurs (24 h)\n${logs.results.map((l) => `-# ${escape(l.kind)} · ${escape(String(l.message).slice(0, 120))}`).join('\n') || '-# Aucune. 👌'}`),
  ])];
}

// Envoi au propriétaire, une fois par jour (appelé chaque soir par le cron).
export async function sendDailyReport(env) {
  if (!env.AGENTS_OWNER_ID) return false;
  const day = new Date().toISOString().slice(0, 10);
  const done = await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('report:day', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1 WHERE settings.value != ?1 RETURNING value",
  ).bind(day).first();
  if (!done) return false; // déjà envoyé aujourd'hui
  const dm = await discordApi(env, 'POST', '/users/@me/channels', { recipient_id: env.AGENTS_OWNER_ID });
  await discordApi(env, 'POST', `/channels/${dm.id}/messages`, { flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components: await dailyReport(env, true) });
  return true;
}

// Top de la semaine : le lundi vers 19 h (heure de Paris), dans le salon choisi dans les réglages, une fois par semaine.
export async function sendWeeklyTop(env) {
  const { getConfig } = await import('./config.js');
  const { weeklyTopView } = await import('./views.js');
  const cfg = await getConfig(env);
  if (!cfg.weeklyTop) return false;
  const day = new Date().toISOString().slice(0, 10);
  const fresh = await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('weekly:sent', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1 WHERE settings.value != ?1 RETURNING value",
  ).bind(day).first();
  if (!fresh) return false;
  const components = await weeklyTopView(env);
  if (!components) return false;
  await discordApi(env, 'POST', `/channels/${cfg.weeklyTop}/messages`, { flags: COMPONENTS_V2, allowed_mentions: { parse: [] }, components });
  return true;
}
