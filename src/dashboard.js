// Dashboard privé du propriétaire (servi par le bot) : état des services, catalogue, index de recherche, quotas et
// activité en direct (rafraîchi toutes les 5 s). Accès par lien signé valable 7 jours, donné par /dashboard
// (réservé au propriétaire) : aucune donnée sans le lien.

import { neon, kvGet, kvMany, readActivity, hasRedis } from './kvstore.js';
import { neonParts } from './searchindex.js';
import { CAPS } from './budget.js';
import { discordApi } from './discord.js';

const DAYS = 7;
const TYPES = ['aiqc', 'image', 'convert', 'search', 'brand', 'sync', 'pub', 'error'];

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// Lien signé : « expiration.signature ».
export async function dashboardToken(env) {
  const exp = Date.now() + DAYS * 86400000;
  return `${exp}.${await hmac(env.INDEXER_SECRET, `dash:${exp}`)}`;
}

async function validToken(env, token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmac(env.INDEXER_SECRET, `dash:${exp}`);
}

// Parties lentes (Discord, tailles Neon) gardées 60 s en mémoire.
let slow = null;
async function slowParts(env) {
  if (slow && Date.now() - slow.at < 60000) return slow.data;
  const [guilds, index, channels] = await Promise.all([
    discordApi(env, 'GET', '/users/@me/guilds').then((g) => g.length).catch(() => null),
    env.NEON_URL ? Promise.all(neonParts(env).map((pe) => neon(pe, `SELECT count(*) AS items, count(*) FILTER (WHERE popularity > 0) AS sold,
        count(brand) AS brands, count(brand_checked) AS checked, count(*) FILTER (WHERE popularity >= 20) AS popular,
        pg_database_size(current_database()) AS bytes FROM items_search`).then((r) => r[0])))
      // Deux projets Neon : totaux, et place du projet le plus rempli (chaque projet a sa limite de 0,5 Go).
      .then((rows) => ({ ...Object.fromEntries(['items', 'sold', 'brands', 'checked', 'popular'].map((k) => [k, rows.reduce((t, x) => t + Number(x[k]), 0)])),
        bytes: Math.max(...rows.map((x) => Number(x.bytes))), parts: rows.map((x) => Number(x.bytes)) }))
      .catch(() => null) : null,
    Promise.all(['convert_channels', 'image_channels', 'aiqc_channels'].map((t) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()
      .then((r) => (r ? r.n : 0)).catch(() => 0))),
  ]);
  slow = { at: Date.now(), data: { guilds, index, channels: { convert: channels[0], image: channels[1], aiqc: channels[2] } } };
  return slow.data;
}

async function readSetting(db, key) {
  if (!db) return null;
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first().catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return row ? row.value : null; }
}

export async function dashboardData(env) {
  const day = new Date().toISOString().slice(0, 10);
  const keys = ['gateway:alive', 'groq:rest', 'aiqc:avg', `ai_qc:${day}`, `ai_vision:${day}`, `ai_neurons:${day}`,
    ...Object.keys(CAPS).map((k) => `budget:d1:${k}:${day}`), 'sidx:done:d1', 'sidx:done:db1', 'sidx:done:db2'];
  const [kv, activity, parts, gateway, queue, month2, reads2] = await Promise.all([
    kvMany(env, keys),
    readActivity(env, TYPES),
    slowParts(env),
    env.GATEWAY ? env.GATEWAY.get(env.GATEWAY.idFromName('main')).fetch('https://gateway/status').then((r) => r.json()).catch(() => null) : null,
    env.DB.prepare('SELECT COUNT(*) AS n FROM post_queue').first().then((r) => (r ? r.n : 0)).catch(() => null),
    readSetting(env.DB2, 'budget:month'),
    readSetting(env.DB2, 'reads:month'),
  ]);
  const num = (v) => (v == null ? null : Number(v));
  return {
    now: Date.now(),
    services: {
      bot: true,
      discord: !!(gateway && gateway.connected),
      upstash: hasRedis(env) && activity !== null,
      neon: !!parts.index,
      groqRest: num(kv['groq:rest']) > Date.now() ? num(kv['groq:rest']) : null,
      mainDb: env.MAIN_DB === 'd1' ? 'D1 (secours)' : 'Turso',
    },
    discord: { guilds: parts.guilds, channels: parts.channels, lastEvent: gateway && gateway.lastEvent, queue },
    catalog: parts.index && {
      items: num(parts.index.items), sold: num(parts.index.sold), popular: num(parts.index.popular),
      brands: num(parts.index.brands), checked: num(parts.index.checked), bytes: num(parts.index.bytes), neonLimit: 512 * 1024 * 1024,
      synced: { d1: num(kv['sidx:done:d1']), db1: num(kv['sidx:done:db1']), db2: num(kv['sidx:done:db2']) },
    },
    ai: { analyses: num(kv[`ai_qc:${day}`]) || 0, vision: num(kv[`ai_vision:${day}`]) || 0, neurons: Math.round(num(kv[`ai_neurons:${day}`]) || 0),
      neuronsCap: 10000, avgMs: num(kv['aiqc:avg']) },
    budgets: Object.fromEntries(Object.entries(CAPS).map(([k, cap]) => [k, { used: Math.round(num(kv[`budget:d1:${k}:${day}`]) || 0), cap }])),
    turso2: { writes: month2 && month2.rows, writesCap: Number(env.BUDGET_MONTH_ROWS) || 9000000, reads: reads2 && reads2.rows, readsCap: Number(env.READS_MONTH_CAP) || 480000000 },
    activity,
  };
}

export async function handleDashboard(url, env) {
  if (!(await validToken(env, url.searchParams.get('t')))) {
    return new Response('Lien expiré ou invalide. Utilise /dashboard sur Discord pour en obtenir un nouveau.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (url.pathname === '/dashboard/data') {
    return Response.json(await dashboardData(env), { headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Finds · Dashboard</title>
<style>
:root{--bg:#0b0d12;--card:#141821;--line:#232a36;--txt:#e6e9ef;--mut:#8b94a7;--acc:#8b5cf6;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--cy:#22d3ee}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 10% -10%,#1b1430 0,transparent 60%),var(--bg);color:var(--txt);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:20px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,13,18,.85);backdrop-filter:blur(8px);z-index:2}
h1{font-size:18px;margin:0;letter-spacing:.2px}.live{display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px;margin-left:auto}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:p 2s infinite}@keyframes p{70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
main{padding:20px 24px;display:grid;grid-template-columns:repeat(12,1fr);gap:14px;max-width:1400px;margin:0 auto}
.card{background:linear-gradient(180deg,rgba(255,255,255,.02),transparent),var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.c3{grid-column:span 3}.c4{grid-column:span 4}.c5{grid-column:span 5}.c6{grid-column:span 6}.c7{grid-column:span 7}.c8{grid-column:span 8}.c12{grid-column:span 12}
@media(max-width:1000px){.c3,.c4,.c5,.c6,.c7,.c8{grid-column:span 12}}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--mut);margin:0 0 12px;font-weight:600}
.big{font-size:30px;font-weight:700;letter-spacing:-.5px}.sub{color:var(--mut);font-size:12px}
.svc{display:flex;flex-direction:column;gap:8px}.svc div{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:9px;background:#0f131b;border:1px solid var(--line)}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600}.on{background:rgba(34,197,94,.14);color:var(--ok)}.off{background:rgba(239,68,68,.14);color:var(--bad)}.mid{background:rgba(245,158,11,.14);color:var(--warn)}
.bar{height:8px;border-radius:99px;background:#0f131b;border:1px solid var(--line);overflow:hidden;margin:6px 0 2px}.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--acc),var(--cy));transition:width .6s}
.bar i.w{background:linear-gradient(90deg,var(--warn),#f97316)}.bar i.b{background:linear-gradient(90deg,var(--bad),#f43f5e)}
.row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.row b{font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.kpi{background:#0f131b;border:1px solid var(--line);border-radius:10px;padding:10px}
.spark{display:flex;align-items:flex-end;gap:3px;height:34px;margin-top:6px}.spark span{flex:1;background:linear-gradient(180deg,var(--acc),#5b21b6);border-radius:3px 3px 0 0;min-height:2px;opacity:.85}
.feed{max-height:430px;overflow:auto;display:flex;flex-direction:column;gap:6px}.ev{display:grid;grid-template-columns:62px 92px 1fr;gap:10px;align-items:center;padding:8px 10px;border-radius:9px;background:#0f131b;border:1px solid var(--line);font-size:13px}
.ev .t{color:var(--mut);font-variant-numeric:tabular-nums}.tag{font-size:11px;padding:2px 8px;border-radius:6px;text-align:center;font-weight:600}
.new{animation:f 1.2s ease}@keyframes f{from{background:rgba(139,92,246,.18)}to{background:#0f131b}}
.empty{color:var(--mut);text-align:center;padding:30px}
</style></head><body>
<header><svg width="26" height="26" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="32" fill="url(#g)"/><path d="M64 26l30 18v38L64 102 34 82V44z" fill="#fff"/></svg>
<h1>Finds · Dashboard</h1><span class="sub" id="upd"></span><span class="live"><span class="dot" id="dot"></span>En direct</span></header>
<main id="app"><div class="card c12 empty">Chargement…</div></main>
<script>
const T=new URLSearchParams(location.search).get('t');const fmt=n=>n==null?'–':Number(n).toLocaleString('fr-FR');
const pct=(a,b)=>b?Math.min(100,Math.round(100*a/b)):0;const mb=b=>b==null?'–':(b/1048576).toFixed(0)+' Mo';
const ago=ms=>{if(!ms)return'–';const s=Math.round((Date.now()-ms)/1000);return s<60?s+' s':s<3600?Math.round(s/60)+' min':s<86400?Math.round(s/3600)+' h':Math.round(s/86400)+' j'};
const hh=ms=>new Date(ms).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TAG={aiqc:['Analyse IA','#8b5cf6'],image:['Image','#22d3ee'],convert:['Conversion','#f97316'],search:['Recherche','#3b82f6'],brand:['Marque','#ec4899'],sync:['Synchro','#10b981'],pub:['Pub (MP)','#f97316'],error:['Erreur','#ef4444']};
let seen=new Set(),first=true;
function bar(v,cap,label,unit=''){const p=pct(v,cap);const c=p>90?'b':p>70?'w':'';return '<div class="row"><span>'+label+'</span><b>'+fmt(v)+unit+' <span class="sub">/ '+fmt(cap)+unit+'</span></b></div><div class="bar"><i class="'+c+'" style="width:'+p+'%"></i></div>'}
function spark(list){const m=Math.max(1,...list.map(x=>x.n));return '<div class="spark">'+list.map(x=>'<span title="'+x.day+' : '+x.n+'" style="height:'+Math.max(4,Math.round(100*x.n/m))+'%"></span>').join('')+'</div>'}
function svc(name,on,txt){return '<div><span>'+name+'</span><span class="pill '+(on===true?'on':on===false?'off':'mid')+'">'+txt+'</span></div>'}
function render(d){const a=d.activity||{events:[],stats:{}};const st=a.stats||{};const today=t=>((st[t]||[]).slice(-1)[0]||{}).n||0;const c=d.catalog;
const ev=(a.events||[]).map(e=>{const k=e.at+e.text;const isNew=!first&&!seen.has(k);seen.add(k);const tg=TAG[e.type]||[e.type,'#64748b'];
return '<div class="ev'+(isNew?' new':'')+'"><span class="t">'+hh(e.at).slice(0,5)+'</span><span class="tag" style="background:'+tg[1]+'22;color:'+tg[1]+'">'+tg[0]+'</span><span>'+esc(e.text)+'</span></div>'}).join('');first=false;
const kpi=(t,l)=>'<div class="kpi"><div class="sub">'+l+'</div><div class="big" style="font-size:24px">'+fmt(today(t))+'</div>'+spark(st[t]||[])+'</div>';
document.getElementById('app').innerHTML=
'<div class="card c3"><h2>Services</h2><div class="svc">'+svc('Bot Cloudflare',true,'En ligne')+svc('Connexion Discord',d.services.discord,d.services.discord?'Connectée':'Hors ligne')+svc('Upstash',d.services.upstash,d.services.upstash?'OK':'Hors ligne')+svc('Neon',d.services.neon,d.services.neon?'OK':'Hors ligne')+svc('Groq',d.services.groqRest?null:true,d.services.groqRest?'Quota atteint':'Disponible')+svc('Base principale',d.services.mainDb==='Turso'?true:null,d.services.mainDb)+'</div></div>'+
'<div class="card c3"><h2>Discord</h2><div class="big">'+fmt(d.discord.guilds)+'</div><div class="sub">serveurs</div><div class="row"><span>Salons convertisseur</span><b>'+fmt(d.discord.channels.convert)+'</b></div><div class="row"><span>Salons image</span><b>'+fmt(d.discord.channels.image)+'</b></div><div class="row"><span>Salons analyse IA</span><b>'+fmt(d.discord.channels.aiqc)+'</b></div><div class="row"><span>Publications en attente</span><b>'+fmt(d.discord.queue)+'</b></div><div class="row"><span>Dernier événement</span><b>il y a '+ago(d.discord.lastEvent)+'</b></div></div>'+
'<div class="card c6"><h2>Aujourd&#39;hui</h2><div class="kpis">'+kpi('aiqc','Analyses IA')+kpi('image','Recherches par image')+kpi('search','Recherches')+kpi('convert','Conversions')+kpi('brand','Marques lues (photo)')+kpi('error','Erreurs')+'</div></div>'+
'<div class="card c4"><h2>Catalogue et recherche</h2><div class="big">'+fmt(c&&c.items)+'</div><div class="sub">articles indexés dans Neon · '+fmt(c&&c.sold)+' avec des ventes</div>'+(c?bar(c.bytes/1048576|0,c.neonLimit/1048576,'Place Neon',' Mo')+bar(c.checked,c.popular,'Articles populaires vérifiés (marque)')+'<div class="row"><span>Marques lues sur photo</span><b>'+fmt(c.brands)+'</b></div><div class="row"><span>Dernière copie complète</span><b>il y a '+ago(Math.max(c.synced.d1||0,c.synced.db2||0))+'</b></div>':'')+'</div>'+
'<div class="card c4"><h2>IA du jour</h2>'+bar(d.ai.neurons,d.ai.neuronsCap,'Cloudflare (neurons)')+'<div class="row"><span>Analyses QC lancées</span><b>'+fmt(d.ai.analyses)+'</b></div><div class="row"><span>Photos lues (recherche)</span><b>'+fmt(d.ai.vision)+'</b></div><div class="row"><span>Durée moyenne d&#39;une analyse</span><b>'+(d.ai.avgMs?Math.round(d.ai.avgMs/1000)+' s':'–')+'</b></div><div class="row"><span>Groq</span><b>'+(d.services.groqRest?'reprise dans '+ago(2*Date.now()-d.services.groqRest):'disponible')+'</b></div></div>'+
'<div class="card c4"><h2>Quotas des bases</h2>'+Object.entries(d.budgets).map(([k,v])=>bar(v.used,v.cap,{items:'Indexation (articles)',pages:'Pages produit',categorize:'Catégories',qcsync:'Synchro QC'}[k]||k)).join('')+(d.turso2.writes!=null?bar(d.turso2.writes,d.turso2.writesCap,'Turso base 2 · écritures du mois'):'')+(d.turso2.reads!=null?bar(d.turso2.reads,d.turso2.readsCap,'Turso base 2 · lectures du mois'):'')+'</div>'+
'<div class="card c12"><h2>Activité en direct</h2><div class="feed">'+(ev||'<div class="empty">Aucune activité pour le moment.</div>')+'</div></div>';
document.getElementById('upd').textContent='Mis à jour à '+hh(d.now);}
async function tick(){try{const r=await fetch('/dashboard/data?t='+encodeURIComponent(T),{cache:'no-store'});if(!r.ok)throw 0;render(await r.json());document.getElementById('dot').style.background='var(--ok)'}catch(e){document.getElementById('dot').style.background='var(--bad)'}}
tick();setInterval(tick,5000);
</script></body></html>`;
