// Test de bout en bout en local : Worker (wrangler dev) + faux Discord + vrai indexeur Weidian.
// Vérifie aussi que chaque message respecte les limites de Discord (Components V2).
// Usage : npm run test:e2e

import { spawn, execSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const WORKER = 'http://localhost:8787';
const MOCK_PORT = 8790;
const SECRET = 'test-secret';
const GUILD = '111', CHANNEL = '222', OTHER_CHANNEL = '333', ADMIN_PERMS = String(1n << 3n);
const V2 = 1 << 15;

// ---- Faux Discord : enregistre tous les appels
const calls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = { raw: body }; }
    calls.push({ method: req.method, path: req.url, body: parsed });
    // Photos QC simulées (CDN Discord)
    if (req.method === 'GET' && req.url.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    // Message QC 9003 relu pour avoir des liens de photos frais
    if (req.method === 'GET' && req.url === '/channels/999/messages/9003') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: '9003', attachments: [
        { filename: 'qc1.jpg', content_type: 'image/jpeg', url: `http://localhost:${MOCK_PORT}/img/qc1.jpg` },
        { filename: 'qc2.png', content_type: 'image/png', url: `http://localhost:${MOCK_PORT}/img/qc2.png` }] }));
    }
    // Salons « sources » simulés : 555 contient des finds, 403 est interdit au bot.
    if (req.method === 'GET' && req.url.startsWith('/channels/403/')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end('{"message":"Missing Access","code":50001}');
    }
    if (req.method === 'GET' && req.url.startsWith('/channels/555/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('after=') ? [] : [
        { id: '1002', content: 'W2C ce hoodie https://weidian.com/item.html?itemID=7874663131&spider_token=x', embeds: [] },
        { id: '1001', content: '', embeds: [], components: [{ type: 1, components: [{ type: 2, style: 5, url: 'https://www.bbdbuy.com/goods/WEIDIAN/7863670229?inviteCode=Z' }] }] },
      ]));
    }
    // Forum 444 : un tag « Shoes », tag obligatoire.
    if (req.method === 'GET' && req.url === '/channels/444') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: '444', type: 15, flags: 16, available_tags: [{ id: 't-shoes', name: 'Shoes' }, { id: 't-other', name: 'Autre' }] }));
    }
    // Salon 777 : conversion automatique (un message d'avant l'ajout du salon, puis un lien d'un membre et un d'un bot).
    if (req.method === 'GET' && req.url.startsWith('/channels/777/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const after = BigInt((req.url.match(/after=(\d+)/) || [])[1] || '0');
      return res.end(JSON.stringify(CHANNEL_777.filter((m) => BigInt(m.id) > after)));
    }
    // Salon QC 999 : une photo QC d'un membre avec le lien de l'item Margiela, un message sans photo, un bot.
    if (req.method === 'GET' && req.url.startsWith('/channels/999/messages?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('after=') ? [] : [
        { id: '9003', author: { id: 'u1', bot: false }, timestamp: new Date().toISOString(), content: 'QC GATS https://weidian.com/item.html?itemID=7779545401',
          attachments: [{ id: 'a1', filename: 'qc1.jpg', content_type: 'image/jpeg', url: 'https://cdn.discordapp.com/x/qc1.jpg' }, { id: 'a2', filename: 'qc2.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/x/qc2.png' }] },
        { id: '9002', author: { id: 'u2', bot: false }, content: 'sans photo https://weidian.com/item.html?itemID=7779545401', attachments: [] },
        { id: '9001', author: { id: 'b', bot: true }, content: 'https://weidian.com/item.html?itemID=7779545401', attachments: [{ filename: 'x.jpg', content_type: 'image/jpeg' }] },
      ]));
    }
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: String(Date.now()) }));
  });
}).listen(MOCK_PORT);

// ---- Clés de signature de test
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
writeFileSync(ROOT + '.dev.vars', [
  `DISCORD_PUBLIC_KEY=${pubHex}`, 'DISCORD_APP_ID=999', 'DISCORD_BOT_TOKEN=fake',
  `INDEXER_SECRET=${SECRET}`, `DISCORD_API=http://localhost:${MOCK_PORT}`, 'AGENTS_OWNER_ID=1', 'PUBLIC_URL=https://finds-bot.test', 'TITLE_WAIT_MS=0',
].join('\n'));

const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString();
rmSync(ROOT + '.wrangler/state', { recursive: true, force: true });
sh('npx wrangler d1 execute finds-bot --local --file schema.sql');
const sql = (q) => JSON.parse(sh(`npx wrangler d1 execute finds-bot --local --json --command "${q}"`))[0].results;
// Requête contenant des guillemets doubles (JSON) : passée par un fichier.
const sqlFile = (q) => { const f = ROOT + '.wrangler/e2e.sql'; writeFileSync(f, q); sh(`npx wrangler d1 execute finds-bot --local --file ${f}`); };

const dev = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--test-scheduled'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => (devLog += d));
dev.stderr.on('data', (d) => (devLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pages produit Weidian : weidian.com bloque parfois l'adresse IP de la machine de test (en production, chaque job
// GitHub a sa propre adresse). Les vérifications qui en dépendent sont alors signalées « non testables ici ».
const WEIDIAN_PAGES = await fetch('https://weidian.com/item.html?itemID=7548868293', { signal: AbortSignal.timeout(15000) })
  .then((r) => r.ok).catch(() => false);
const checkPages = (name, cond, extra) => (WEIDIAN_PAGES ? check(name, cond, extra)
  : console.log(`⚠️ ${name} : non testable depuis cette machine (weidian.com refuse la connexion)`));
const snowflake = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);
const CHANNEL_777 = [
  { id: snowflake(Date.now() - 3600000), author: { bot: false }, content: 'vieux lien https://item.taobao.com/item.htm?id=111111111' },
  { id: snowflake(Date.now() + 3600000), author: { bot: false }, content: 'W2C https://item.taobao.com/item.htm?id=730344766230 svp' },
  { id: snowflake(Date.now() + 3600001), author: { bot: true }, content: 'https://item.taobao.com/item.htm?id=222222222' },
];
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// ---- Validation des limites Discord pour un message Components V2
function validate(label, data) {
  const errors = [];
  let count = 0;
  let textLen = 0;
  const walk = (list, parentType) => {
    for (const c of list || []) {
      count++;
      if (c.type === 1) {
        if (!c.components.length || c.components.length > 5) errors.push(`ligne avec ${c.components.length} éléments`);
        if (c.components.some((x) => x.type !== 2) && c.components.length > 1) errors.push('menu non seul sur sa ligne');
      }
      if (c.type === 2) {
        if (c.label && c.label.length > 80) errors.push(`libellé trop long: ${c.label}`);
        if (!c.label && !c.emoji) errors.push('bouton vide');
        if (c.style === 5 ? !/^https:\/\//.test(c.url) : !c.custom_id) errors.push('bouton sans action');
      }
      if (c.custom_id && c.custom_id.length > 100) errors.push(`custom_id trop long: ${c.custom_id}`);
      if ([3, 5, 8].includes(c.type) && c.placeholder && c.placeholder.length > 150) errors.push('placeholder trop long');
      if (c.type === 3) {
        if (!c.options.length || c.options.length > 25) errors.push(`${c.options.length} options`);
        if (c.max_values > c.options.length) errors.push('max_values > options');
        for (const o of c.options) if (o.label.length > 100 || (o.description || '').length > 100) errors.push('option trop longue');
      }
      if (c.type === 9) {
        if (!c.accessory) errors.push('section sans accessoire');
        else count++;
        if (c.components.length > 3) errors.push('section > 3 textes');
      }
      if (c.type === 10) textLen += c.content.length;
      if (c.type === 11 && !/^https:\/\//.test(c.media.url)) errors.push('vignette sans https');
      if (c.type === 17 && parentType) errors.push('conteneur imbriqué');
      if (c.components) walk(c.components, c.type);
    }
  };
  if (!(data.flags & V2)) errors.push('flag Components V2 manquant');
  if (data.content || data.embeds) errors.push('content/embeds interdits en V2');
  walk(data.components, null);
  if (count > 40) errors.push(`${count} composants (> 40)`);
  if (textLen > 4000) errors.push(`${textLen} caractères (> 4000)`);
  if (errors.length) console.log(`   ⚠️ ${label}: ${errors.join(' | ')}`);
  return errors.length === 0;
}

const allText = (data) => {
  const out = [];
  const walk = (list) => { for (const c of list || []) { if (c.type === 10) out.push(c.content); if (c.components) walk(c.components); } };
  walk(data.components);
  return out.join('\n');
};
const findComp = (data, pred) => {
  let found = null;
  const walk = (list) => { for (const c of list || []) { if (!found && pred(c)) found = c; if (c.components) walk(c.components); if (c.accessory) walk([c.accessory]); } };
  walk(data.components);
  return found;
};

async function interact(payload) {
  const body = JSON.stringify({ application_id: '999', token: 'tok', guild_id: GUILD, channel_id: CHANNEL, ...payload });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + body), privateKey).toString('hex');
  const res = await fetch(WORKER + '/interactions', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts },
  });
  return { status: res.status, data: res.status === 200 ? await res.json() : await res.text() };
}
const member = (admin) => ({ member: { user: { id: admin ? '1' : '2' }, permissions: admin ? ADMIN_PERMS : '0' } });
const menu = (admin = true) => interact({ type: 2, ...member(admin), data: { name: 'menu' } });
const click = (custom_id, values, admin = true) => interact({
  type: 3, ...member(admin), message: { id: 'm1' }, data: { custom_id, component_type: values ? 3 : 2, values },
});
const submit = (custom_id, fields) => interact({
  type: 5, ...member(true), message: { id: 'm1' },
  data: { custom_id, components: Object.entries(fields).map(([k, v]) => ({ type: 18, component: { type: 4, custom_id: k, value: v } })) },
});
const waitCall = async (pred, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const c = calls.find(pred); if (c) return c; await sleep(300); }
  return null;
};
const lastEdit = async (since) => waitCall((c) => c.method === 'PATCH' && c.path.endsWith('/messages/@original') && calls.indexOf(c) >= since);

try {
  for (let i = 0; i < 60; i++) { try { await fetch(WORKER); break; } catch { await sleep(1000); } }

  check('PING -> PONG', (await interact({ type: 1 })).data.type === 1);
  const bad = await fetch(WORKER + '/interactions', { method: 'POST', body: '{"type":1}' });
  check('signature invalide refusée', bad.status === 401);

  const denied = await menu(false);
  check('non-admin : panneau refusé', /Accès réservé/.test(allText(denied.data.data)));

  const home = await menu();
  check('/menu ouvre le panneau (éphémère, V2)', home.data.type === 4 && home.data.data.flags === (64 | V2) && /# 🛍️ Finds/.test(allText(home.data.data)));
  check('accueil : limites Discord', validate('accueil', home.data.data));
  check('accueil : conseils de démarrage', /Commence par ajouter/.test(allText(home.data.data)));

  const agModal = await click('ag:pick', ['bbdbuy']);
  check('menu Agents → BBDBuy → formulaire « code »', agModal.data.type === 9 && agModal.data.data.custom_id === 'm:agent:bbdbuy');
  const agLink = await submit('m:agent:bbdbuy', { code: 'https://bbdbuy.com/?inviteCode=X', position: '' });
  check('un lien à la place du code est refusé', /juste ton \*\*code\*\*/.test(allText(agLink.data.data)));
  const ag = await submit('m:agent:bbdbuy', { code: 'TEST', position: '' });
  check('BBDBuy enregistré avec juste le code', ag.data.type === 7 && /BBDBuy\*\* enregistré avec le code/.test(allText(ag.data.data)));
  check('vue agents : limites Discord', validate('agents', ag.data.data));
  const custom = await click('ag:pick', ['custom']);
  check('menu Agents → Autre agent → formulaire lien', custom.data.data.custom_id === 'm:agent:custom');
  const agBad = await submit('m:agent:custom', { name: 'X', template: 'https://x.com/no-placeholder' });
  check('agent invalide refusé', /doit commencer/.test(allText(agBad.data.data)));
  const otherAdmin = { member: { user: { id: '7' }, permissions: ADMIN_PERMS } };
  const lockedView = await interact({ type: 3, ...otherAdmin, message: { id: 'm1' }, data: { custom_id: 'ag:list', component_type: 2 } });
  const addBtn = findComp(lockedView.data.data, (c) => c.custom_id === 'ag:pick');
  check('agents : autre admin voit les boutons verrouillés', addBtn && addBtn.disabled === true && /propriétaire du bot/.test(allText(lockedView.data.data)));
  const lockedSubmit = await interact({ type: 5, ...otherAdmin, message: { id: 'm1' },
    data: { custom_id: 'm:agent:custom', components: [{ type: 18, component: { type: 4, custom_id: 'name', value: 'Pirate' } }, { type: 18, component: { type: 4, custom_id: 'template', value: 'https://evil.com/?u={url}' } }] } });
  check('agents : autre admin ne peut pas modifier', /Seul le propriétaire/.test(allText(lockedSubmit.data.data)) && sql("SELECT COUNT(*) AS n FROM agents WHERE name = 'Pirate'")[0].n === 0);

  const shopModal = await click('cat:add');
  check('bouton Ajouter boutique → formulaire', shopModal.data.type === 9);
  let mark = calls.length;
  await submit('m:shop', { links: 'https://weidian.com/?userid=1784277725' });
  const shop = await lastEdit(mark);
  check('boutique ajoutée', shop && /\*\*1\*\* nouvelle boutique ajoutée/.test(allText(shop.body)), shop && allText(shop.body).split('\n')[0]);
  check('vue catalogues : limites Discord', shop && validate('catalogues', shop.body));
  const tb = await submit('m:shop', { links: 'https://shop123.taobao.com/item.htm' });
  check('boutique Taobao refusée proprement', /demandent une connexion/.test(allText(tb.data.data)));

  console.log('… indexation réelle (60 items max)');
  execSync('node indexer/index.mjs', {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, WORKER_URL: WORKER, INDEXER_SECRET: SECRET, MAX_ITEMS: '60', SKIP_JADESHIP: '1', SKIP_QC: '1' },
  });
  console.log('… traduction (3 passages du cron)');
  for (let i = 0; i < 3; i++) { await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*'); await sleep(8000); }
  const translated = sql('SELECT COUNT(*) AS n FROM items WHERE title_en IS NOT NULL')[0].n;
  if (!translated && /4006|daily free allocation/.test(devLog)) console.log('⚠️ titres traduits : quota IA du jour épuisé, non testable aujourd\'hui');
  else check('titres traduits', translated > 0);

  const latest = await click('search:latest');
  const ld = latest.data.data;
  check('Nouveautés → résultats', latest.data.type === 7 && /Nouveautés/.test(allText(ld)) && /60 résultats/.test(allText(ld)), allText(ld).split('\n')[1]);
  check('résultats : limites Discord', validate('résultats', ld));
  check('résultats : vignettes', !!findComp(ld, (c) => c.type === 11));
  const sel = findComp(ld, (c) => c.type === 3);
  const sid = sel.custom_id.split(':')[2];

  const p2 = await click(`s:pg:${sid}:1`);
  check('page suivante', /page 2\//.test(allText(p2.data.data)));

  const ch = await click(`s:ch:${sid}:0`, [OTHER_CHANNEL]);
  check('choix du salon', /postés dans <#333>/.test(allText(ch.data.data)));

  mark = calls.length;
  const post = await click(`s:sel:${sid}:0`, [sel.options[0].value]);
  check('poster la sélection (réponse différée)', post.data.type === 6);
  const posted = await waitCall((c) => c.method === 'POST' && c.path === `/channels/${OTHER_CHANNEL}/messages`);
  check('carte postée : limites Discord', posted && validate('carte postée', posted.body));
  const cardText = posted ? allText(posted.body) : '';
  const pics = posted && findComp(posted.body, (c) => c.type === 12);
  checkPages('carte postée : galerie de photos', pics && pics.items.length >= 2 && pics.items.length <= 4, pics && `${pics.items.length} photos`);
  check('carte postée : prix en € en avant', /### 💶 \d+,\d{2} €  ·  ¥\d/.test(cardText), cardText.split('\n').find((l) => l.includes('💶')));
  const buy = posted && findComp(posted.body, (c) => c.type === 2 && c.label === 'Acheter sur BBDBuy');
  const view = posted && findComp(posted.body, (c) => c.type === 2 && c.label === 'Voir l\'annonce Weidian');
  check('carte postée : bouton « Acheter sur BBDBuy » avec code, à côté de « Voir l\'annonce »',
    buy && view && /^https:\/\/finds-bot\.test\/go\/weidian%3A\d+\/BBDBuy\?c=333$/.test(buy.url) && !cardText.includes('Acheter sur'), buy && buy.url);
  const go = await fetch(WORKER + buy.url.replace('https://finds-bot.test', ''), { redirect: 'manual' });
  check('clic suivi : redirection vers BBDBuy avec le code', go.status === 302 && /^https:\/\/www\.bbdbuy\.com\/goods\/WEIDIAN\/\d+\?inviteCode=TEST$/.test(go.headers.get('location') || ''),
    go.headers.get('location'));
  await sleep(500);
  check('clic enregistré (sans donnée personnelle)', sql("SELECT COUNT(*) AS n FROM clicks WHERE agent = 'BBDBuy' AND channel_id = '333'")[0].n === 1);
  checkPages('photos récupérées par l\'indexeur', sql("SELECT COUNT(*) AS n FROM items WHERE images IS NOT NULL AND images != '[]'")[0].n >= 55);
  const after = await lastEdit(mark);
  check('panneau mis à jour après envoi', after && /1\*\* item posté/.test(allText(after.body)) && validate('après envoi', after.body));

  const FORUM = '444';
  const fch = await interact({ type: 3, ...member(true), message: { id: 'm1' },
    data: { custom_id: `s:ch:${sid}:0`, component_type: 8, values: [FORUM], resolved: { channels: { [FORUM]: { id: FORUM, type: 15 } } } } });
  check('choix d\'un forum', /Forum <#444> : chaque item aura son propre post/.test(allText(fch.data.data)));
  const sel2 = findComp(fch.data.data, (c) => c.type === 3);
  await click(`s:sel:${sid}:0`, [sel2.options[0].value]);
  const thread = await waitCall((c) => c.method === 'POST' && c.path === `/channels/${FORUM}/threads`);
  check('forum : 1 item = 1 post (titre + prix, carte dedans)', thread && /€$/.test(thread.body.name) && thread.body.name.length <= 100
    && validate('post de forum', thread.body.message), thread && thread.body.name);
  check('forum : tag appliqué automatiquement', thread && Array.isArray(thread.body.applied_tags) && thread.body.applied_tags.length === 1, thread && JSON.stringify(thread.body.applied_tags));
  await click(`s:ch:${sid}:0`, [OTHER_CHANNEL]);

  const conf = await click(`s:all:${sid}:0`);
  check('tout poster → confirmation', /Tout poster \?/.test(allText(conf.data.data)) && validate('confirmation', conf.data.data));
  const posts = () => calls.filter((c) => c.path === `/channels/${OTHER_CHANNEL}/messages`);
  const before = posts().length;
  const ok = await click(`s:ok:${sid}:0`);
  check('file remplie', /en route vers/.test(allText(ok.data.data)), allText(ok.data.data).split('\n')[0]);
  await sleep(27000);
  const fast = posts().length - before;
  check('envoi immédiat après confirmation (~1/s)', fast >= 18 && fast <= 26, `${fast} postés en 27 s`);
  for (let i = 0; i < 3 && sql('SELECT COUNT(*) AS n FROM post_queue')[0].n; i++) {
    await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*');
    await sleep(45000);
  }
  const queueLeft = sql('SELECT COUNT(*) AS n FROM post_queue')[0].n;
  const titles = posts().slice(before).map((c) => findComp(c.body, (x) => x.type === 2 && x.style === 5).url);
  const queued = Number((allText(ok.data.data).match(/\*\*(\d+)\*\* items en route/) || [])[1]);
  check('toute la file envoyée, sans doublon', queueLeft === 0 && posts().length - before === queued && new Set(titles).size === titles.length,
    `${posts().length - before} postés, ${queueLeft} restants, ${new Set(titles).size} uniques`);

  const tr = sql("SELECT title_en FROM items WHERE title_en IS NOT NULL AND title_en LIKE '% %' LIMIT 1")[0] || { title_en: 'shoes' };
  const word = tr.title_en.split(' ').find((w) => w.length > 4) || tr.title_en.split(' ')[0];
  mark = calls.length;
  const srch = await submit('m:search:', { q: word, min: '', max: '200' });
  check('formulaire de recherche (différé)', srch.data.type === 6);
  const res = await lastEdit(mark);
  check(`recherche « ${word} »`, res && allText(res.body).includes(`« ${word} »`) && /résultat/.test(allText(res.body)), res && allText(res.body).split('\n')[1]);
  check('recherche : limites Discord', res && validate('recherche', res.body));

  const cats = await click('cat:list:0');
  check('liste des catalogues', /4号小店/.test(allText(cats.data.data)));
  const sv = await click('cat:shop:1784277725');
  check('fiche boutique', /items/.test(allText(sv.data.data)) && validate('fiche boutique', sv.data.data));
  const si = await click('cat:items:1784277725');
  check('items d\'une boutique', /🏪 4号小店/.test(allText(si.data.data)));
  const del = await click('cat:del:1784277725');
  check('confirmation de suppression', /Retirer 4号小店/.test(allText(del.data.data)));

  // ---- Découverte de boutiques
  mark = calls.length;
  const bulk = await submit('m:shop', { links: 'https://weidian.com/?userid=1617411897\nhttps://www.kakobuy.com/item/details?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7805904567&affcode=x\nhttps://item.taobao.com/item.htm?id=1' });
  check('ajout en masse (différé)', bulk.data.type === 6);
  const bulkRes = await lastEdit(mark);
  check('ajout en masse : boutiques trouvées', bulkRes && /\*\*1\*\* nouvelle boutique/.test(allText(bulkRes.body)) && /Taobao\/1688 ignoré/.test(allText(bulkRes.body)),
    bulkRes && allText(bulkRes.body).split('\n')[0]);
  const srcView = await click('src');
  check('écran Sources', /Sources automatiques/.test(allText(srcView.data.data)) && validate('sources', srcView.data.data));
  mark = calls.length;
  await click('src:add', ['555']);
  const srcRes = await lastEdit(mark);
  checkPages('source Discord : lit l\'historique et ajoute la boutique d\'un find', srcRes && /<#555> : 2 messages lus/.test(allText(srcRes.body))
    && sql("SELECT COUNT(*) AS n FROM shops WHERE id = '1840259863' AND source = 'discord:555'")[0].n === 1, srcRes && allText(srcRes.body).split('\n')[0]);
  mark = calls.length;
  await click('src:add', ['403']);
  const srcBad = await lastEdit(mark);
  check('source sans accès : message clair', srcBad && /n'y a pas accès/.test(allText(srcBad.body)));
  await fetch(WORKER + '/__scheduled?cron=*/5+*+*+*+*');
  await sleep(4000);
  check('cron de découverte : lit seulement les nouveaux messages', calls.some((c) => c.method === 'GET' && c.path.includes('/channels/555/messages?limit=100&after=1002')));

  // ---- Jadeship : items populaires (dont Taobao) et vendeurs classés
  const js = await fetch(WORKER + '/api/indexer/jadeship', {
    method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { platform: 'taobao', id: '919064369235', title: 'Minimalist Round Neck Shirt', price: 68, image: 'https://img.alicdn.com/x.jpg', sold: 185 },
        { platform: 'weidian', id: '7779545401', title: 'Margiel GATS German Training Shoes', price: 380, image: 'https://si.geilicdn.com/x.jpg', sold: 469 },
      ],
      shops: [{ id: '1624885820', name: 'A1 Top', tier: 'trusted' }],
      done: true,
    }),
  }).then((r) => r.json());
  check('Jadeship : items reçus', js.ok && js.items === 2);
  const trend = await click('search:trending');
  const tt = allText(trend.data.data);
  check('🔥 Tendances : les plus vendus d\'abord', /Tendances/.test(tt) && tt.indexOf('Margiel') > -1 && tt.indexOf('Margiel') < tt.indexOf('Minimalist') && /🔥 469/.test(tt), tt.split('\n')[1]);
  check('Tendances : limites Discord', validate('tendances', trend.data.data));
  check('item Weidian de Jadeship mis en file pour trouver sa boutique', sql("SELECT COUNT(*) AS n FROM link_queue WHERE item_id = '7779545401'")[0].n === 1);
  // ---- QC
  sql(`UPDATE items SET qc_count = 4278, qc_checked_at = ${Date.now()} WHERE id = 'weidian:7779545401'`);
  await click('set:qc', ['999']);
  await fetch(WORKER + '/__scheduled?cron=*/3+*+*+*+*');
  await sleep(4000);
  check('📸 salon QC : photo de membre + lien → QC communauté', sql("SELECT COUNT(*) AS n, SUM(images) AS img FROM qc_posts WHERE item_id = 'weidian:7779545401'")[0].img === 2
    && sql("SELECT COUNT(*) AS n FROM qc_posts")[0].n === 1);
  const qcCmd = await interact({ type: 2, member: { user: { id: '42' }, permissions: '0' }, data: { name: 'qc', options: [{ name: 'lien', value: 'https://www.kakobuy.com/item/details?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7779545401' }] } });
  check('/qc ouvert à tous (différé)', qcCmd.data.type === 5);
  const qcRes = await waitCall((c) => c.method === 'PATCH' && c.body && JSON.stringify(c.body).includes('photos QC'), 25000);
  const qcGals = qcRes ? JSON.stringify(qcRes.body).match(/"type":12/g) || [] : [];
  check('/qc : photos de la communauté + lots des agents, dans Discord', qcRes && /QC de la communauté/.test(allText(qcRes.body)) && qcGals.length >= 2
    && /img\.finderqc\.com/.test(JSON.stringify(qcRes.body)) && validate('/qc', qcRes.body), qcRes && `${qcGals.length} galeries · ${allText(qcRes.body).split('\n')[1]}`);
  check('/qc : aucun lien vers un site de QC', qcRes && !/"url":"https:\/\/(www\.)?(uufinds|finderqc)/.test(JSON.stringify(qcRes.body)));
  const tq = await click('search:trending');
  check('résultats : nombre de QC affiché', /📸 4 278 QC/.test(allText(tq.data.data)) && /🧑‍🤝‍🧑 2 QC/.test(allText(tq.data.data)));
  const sidQ = findComp(tq.data.data, (c) => c.type === 3).custom_id.split(':')[2];
  const onlyQc = await click(`s:qc:${sidQ}`);
  check('🎛️ filtre « seulement avec QC »', /avec QC/.test(allText(onlyQc.data.data)) && /1 résultat/.test(allText(onlyQc.data.data)), allText(onlyQc.data.data).split('\n')[1]);
  const qcOpt = findComp(onlyQc.data.data, (c) => c.type === 3 && /^s:sel:/.test(c.custom_id)).options[0].value;
  mark = calls.length;
  await click(`s:sel:${sidQ}:0`, [qcOpt]);
  const qcCard = await waitCall((c) => c.method === 'POST' && /\/channels\/\d+\/messages$/.test(c.path) && calls.indexOf(c) >= mark);
  const qcBtn = qcCard && findComp(qcCard.body, (c) => c.type === 2 && c.custom_id === 'pub:qc:weidian:7779545401');
  check('carte : bouton « 📸 Voir les QC (4 280) » à côté des boutons d\'achat', qcBtn && qcBtn.label === 'Voir les QC (4 280)' && validate('carte QC', qcCard.body),
    qcBtn && qcBtn.label);
  mark = calls.length;
  const qcClick = await interact({ type: 3, member: { user: { id: '42' }, permissions: '0' }, message: { id: 'm1' }, data: { custom_id: qcBtn.custom_id, component_type: 2 } });
  check('clic « Voir les QC » par un membre : fenêtre privée', qcClick.data.type === 5 && (qcClick.data.data.flags & 64) === 64);
  const qcWin = await lastEdit(mark);
  const qcGal = qcWin && findComp(qcWin.body, (c) => c.type === 12);
  check('fenêtre QC : photos de la communauté puis lots des agents', qcGal && qcGal.items.length === 2 && /localhost:\d+\/img\/qc1\.jpg/.test(JSON.stringify(qcGal))
    && /QC de la communauté/.test(allText(qcWin.body)) && /img\.finderqc\.com/.test(JSON.stringify(qcWin.body)) && validate('fenêtre QC', qcWin.body),
    qcWin && `${JSON.stringify(qcGal).slice(0, 160)} | ${allText(qcWin.body).slice(0, 160)}`);
  check('fenêtre QC : aucun lien vers un site de QC', qcWin && !/"url":"https:\/\/(www\.)?(uufinds|finderqc)/.test(JSON.stringify(qcWin.body)));
  const more = qcWin && findComp(qcWin.body, (c) => /^pub:qcp:/.test(c.custom_id || '') && !c.disabled && c.custom_id.endsWith(':1'));
  if (more) {
    mark = calls.length;
    const pageQc = await interact({ type: 3, member: { user: { id: '42' }, permissions: '0' }, message: { id: 'm2', flags: 64 }, data: { custom_id: more.custom_id, component_type: 2 } });
    const pageWin = await lastEdit(mark);
    check('fenêtre QC : « Plus de QC » montre les lots suivants', pageQc.data.type === 6 && pageWin && /lots 4–/.test(allText(pageWin.body)), pageWin && allText(pageWin.body).split('\n')[1]);
  }
  // Forum : QC postés automatiquement sous l'item
  await click(`s:posted:${sidQ}`);
  const fch2 = await interact({ type: 3, ...member(true), message: { id: 'm1' },
    data: { custom_id: `s:ch:${sidQ}:0`, component_type: 8, values: ['444'], resolved: { channels: { 444: { id: '444', type: 15 } } } } });
  const qcOpt2 = findComp(fch2.data.data, (c) => c.type === 3 && /^s:sel:/.test(c.custom_id)).options[0].value;
  mark = calls.length;
  await click(`s:sel:${sidQ}:0`, [qcOpt2]);
  const th = await waitCall((c) => c.method === 'POST' && c.path === '/channels/444/threads' && calls.indexOf(c) >= mark);
  const under = await waitCall((c) => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.path) && c.path !== '/channels/444/messages' && calls.indexOf(c) > calls.indexOf(th) && c.body && c.body.raw, 15000);
  check('forum : photos QC postées automatiquement sous l\'item', th && under && /qc1\.jpg/.test(under.body.raw) && /qc2\.png/.test(under.body.raw)
    && /attachment:\/\/qc1\.jpg/.test(under.body.raw) && /img\.finderqc\.com/.test(under.body.raw) && !/uufinds/.test(under.body.raw));
  const catsJ = await click('cat:list:0');
  check('vendeur Jadeship ajouté avec ⭐ Trusted', /A1 Top\*\*  ⭐ Trusted/.test(allText(catsJ.data.data)) || sql("SELECT tier FROM shops WHERE id = '1624885820'")[0].tier === 'trusted');

  // ---- Nouveautés du panneau
  await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*');
  await sleep(6000);
  check('catégories détectées automatiquement', sql("SELECT COUNT(*) AS n FROM items WHERE category IS NOT NULL")[0].n > 20);
  const st = await click('stats:7');
  check('📊 stats : clics et posts', /Statistiques/.test(allText(st.data.data)) && /\*\*1\*\* clic/.test(allText(st.data.data)) && validate('stats', st.data.data),
    allText(st.data.data).split('\n')[1]);
  const hist = await click('hist:0');
  check('🧾 historique des posts', /Historique des posts/.test(allText(hist.data.data)) && validate('historique', hist.data.data));
  const delBtn = findComp(hist.data.data, (c) => c.type === 2 && /^hist:del:/.test(c.custom_id || ''));
  const delPost = await click(delBtn.custom_id);
  check('🧾 supprimer un post de Discord', /supprimé de Discord/.test(allText(delPost.data.data)) && calls.some((c) => c.method === 'DELETE'));
  const setv = await click('set');
  check('⚙️ réglages : limites Discord', /Réglages/.test(allText(setv.data.data)) && validate('réglages', setv.data.data));
  const cur = await click('set:currency', ['USD']);
  check('⚙️ devise USD', /Dollar US/.test(allText(cur.data.data)));
  const latest2 = await click('search:latest');
  check('prix affichés en $', /~\$\d/.test(allText(latest2.data.data)), allText(latest2.data.data).match(/~\$[\d.]+/)?.[0]);
  await click('set:currency', ['EUR']);
  await click('set:lang', ['en']);
  const sid2 = findComp(latest2.data.data, (c) => c.type === 3).custom_id.split(':')[2];
  const flt = await click(`s:filt:${sid2}`);
  check('🎛️ filtres : limites Discord', /Filtres/.test(allText(flt.data.data)) && validate('filtres', flt.data.data));
  const cat = await click(`s:cat:${sid2}`, ['shoes']);
  check('🎛️ filtre catégorie', /Chaussures/.test(allText(cat.data.data)), allText(cat.data.data).split('\n')[1]);
  const sorted = await click(`s:sort:${sid2}`, ['price_asc']);
  check('🎛️ tri par prix croissant', /Prix croissant/.test(allText(sorted.data.data)));
  await click(`s:cat:${sid2}`, ['all']);
  await click(`s:posted:${sid2}`);
  const page0 = await click(`s:pg:${sid2}:0`);
  const opts = findComp(page0.data.data, (c) => c.type === 3 && /^s:sel:/.test(c.custom_id)).options;
  const before2 = Number((allText(page0.data.data).match(/(\d+) résultat/) || [])[1]);
  const hid = await click(`s:hide:${sid2}:0`, [opts[0].value]);
  const after2 = Number((allText(hid.data.data).match(/(\d+) résultat/) || [])[1]);
  check('🚫 masquer un item', /1 item masqué/.test(allText(hid.data.data)) && after2 === before2 - 1, `${before2} → ${after2}`);
  mark = calls.length;
  await click(`s:sel:${sid2}:0`, [opts[1].value]);
  const enPost = await waitCall((c, i) => c.method === 'POST' && /\/channels\/\d+\/messages$/.test(c.path) && calls.indexOf(c) >= mark);
  check('🌍 cartes en anglais', enPost && !!findComp(enPost.body, (c) => c.type === 2 && c.label === 'Buy on BBDBuy'));
  await click('set:lang', ['fr']);

  // Baisse de prix détectée à la réindexation
  const runId = (await fetch(WORKER + '/api/indexer/start', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: '1784277725' }) }).then((r) => r.json())).runId;
  const target = sql("SELECT item_id, price_cny FROM items WHERE shop_id = '1784277725' AND price_cny > 50 AND hidden = 0 LIMIT 1")[0];
  await fetch(WORKER + '/api/indexer/items', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopId: '1784277725', runId, items: [{ itemId: target.item_id, name: 'x', price: target.price_cny - 20 }] }) });
  const dropsView = await click('search:drops');
  check('📉 baisses de prix détectées', /Baisses de prix/.test(allText(dropsView.data.data)) && /1 résultat/.test(allText(dropsView.data.data)) && /~~/.test(allText(dropsView.data.data)));

  // Drops automatiques avec ping de rôle
  const pre = await click('sch:preset:latest');
  check('⏰ drop créé en un clic', /Drop créé/.test(allText(pre.data.data)) && validate('drop', pre.data.data));
  const schId = findComp(pre.data.data, (c) => /^sch:run:/.test(c.custom_id || '')).custom_id.split(':')[2];
  await click(`sch:role:${schId}`, ['888']);
  mark = calls.length;
  const run = await click(`sch:run:${schId}`);
  check('⏰ drop lancé', /en route vers/.test(allText(run.data.data)), allText(run.data.data).split('\n')[0]);
  const ping = await waitCall((c) => c.method === 'POST' && c.body && c.body.content && c.body.content.includes('<@&888>') && calls.indexOf(c) >= mark, 30000);
  check('🔔 ping du rôle avant le drop', !!ping);
  const schList = await click('sch:list');
  check('⏰ liste des drops', /Nouveautés/.test(allText(schList.data.data)) && validate('drops', schList.data.data));
  const run2 = await click(`sch:run:${schId}`);
  check('⏰ jamais deux fois le même item dans un salon', /en route|Aucun nouvel item/.test(allText(run2.data.data)));

  // Commandes publiques
  const pubUser = { member: { user: { id: '42' }, permissions: '0' } };
  mark = calls.length;
  const find = await interact({ type: 2, ...pubUser, data: { name: 'find', options: [{ name: 'recherche', value: 'shoes' }] } });
  check('/find ouvert à tous (réponse différée)', find.data.type === 5);
  const findRes = await lastEdit(mark);
  check('/find : résultats avec boutons d\'achat', findRes && /résultats/.test(allText(findRes.body)) && !!findComp(findRes.body, (c) => c.type === 2 && c.style === 5) && validate('/find', findRes.body),
    findRes && allText(findRes.body).split('\n')[1]);
  const pubNext = findComp(findRes.body, (c) => /^pub:pg:/.test(c.custom_id || '') && !c.disabled && c.custom_id.endsWith(':1'));
  if (pubNext) {
    const pg2 = await interact({ type: 3, ...pubUser, message: { id: 'm1' }, data: { custom_id: pubNext.custom_id, component_type: 2 } });
    check('/find : page suivante pour un membre', /page 2\//.test(allText(pg2.data.data)));
  }
  const conv = await interact({ type: 2, ...pubUser, data: { name: 'convert', options: [{ name: 'lien', value: 'https://www.lovegobuy.com/product?id=730344766230&shop_type=taobao&invite_code=X' }] } });
  const convBtn = conv.data.data && findComp(conv.data.data, (c) => c.type === 2 && c.label === 'Acheter sur BBDBuy');
  check('/convert : lien d\'agent → bouton BBDBuy avec ton code', convBtn && /\/go\/taobao%3A730344766230\/BBDBuy$/.test(convBtn.url) && validate('/convert', conv.data.data), convBtn && convBtn.url);
  const goTb = await fetch(WORKER + convBtn.url.replace('https://finds-bot.test', ''), { redirect: 'manual' });
  check('/convert : redirection Taobao vers BBDBuy', /bbdbuy\.com\/goods\/TAOBAO\/730344766230\?inviteCode=TEST/.test(goTb.headers.get('location') || ''));

  // Conversion automatique dans un salon
  await click('set:convert', ['777']);
  mark = calls.length;
  await fetch(WORKER + '/__scheduled?cron=*/2+*+*+*+*');
  const autoReply = await waitCall((c) => c.method === 'POST' && c.path === '/channels/777/messages' && calls.indexOf(c) >= mark, 15000);
  check('🔄 conversion auto : répond en quelques secondes au lien d\'un membre', autoReply && autoReply.body.message_reference.message_id === CHANNEL_777[1].id && validate('conversion', autoReply.body));
  await sleep(4000);
  check('🔄 conversion auto : ignore les anciens messages et les bots', calls.filter((c) => c.method === 'POST' && c.path === '/channels/777/messages').length === 1);

  // Bannir une boutique
  const ban = await click('cat:ban:1840259863');
  check('🚫 bannir une boutique', /est banni/.test(allText(ban.data.data)));
  mark = calls.length;
  await submit('m:shop', { links: 'https://weidian.com/?userid=1840259863' });
  const reBan = await lastEdit(mark);
  check('🚫 boutique bannie jamais réajoutée', reBan && sql("SELECT COUNT(*) AS n FROM shops WHERE id = '1840259863'")[0].n === 0, reBan && allText(reBan.body).split('\n')[0]);

  // Budgets d'écriture quotidiens (quota gratuit D1)
  const day = new Date().toISOString().slice(0, 10);
  const api = (path, body) => fetch(WORKER + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  sql(`UPDATE shops SET status = 'pending' WHERE id = '1617411897'`);
  const jobsBefore = await api('/api/indexer/jobs').then((r) => r.json());
  sqlFile(`INSERT OR REPLACE INTO settings (key, value) VALUES ('budget:items', '{"day":"${day}","used":5000}');
    INSERT OR REPLACE INTO settings (key, value) VALUES ('budget:pages', '{"day":"${day}","used":3000}');`);
  const jobsFull = await api('/api/indexer/jobs').then((r) => r.json());
  check('budget épuisé : l\'indexeur n\'a plus de travail aujourd\'hui', jobsBefore.shops.length > 0 && jobsFull.shops.length === 0 && jobsFull.missingImages === 0 && jobsFull.linkQueue === 0,
    `${jobsBefore.shops.length} boutique(s) → ${jobsFull.shops.length}`);
  const bRun = await api('/api/indexer/start', { shopId: '1617411897' }).then((r) => r.json());
  const refused = await api('/api/indexer/items', { shopId: '1617411897', runId: bRun.runId, items: [{ itemId: '7000000999', name: 'x', price: 10 }] });
  check('budget épuisé : écriture d\'items refusée (429)', refused.status === 429 && sql("SELECT COUNT(*) AS n FROM items WHERE item_id = '7000000999'")[0].n === 0);
  await api('/api/indexer/finish', { shopId: '1617411897', runId: bRun.runId, budget: true });
  check('budget épuisé : la boutique repasse en attente (reprise demain)', sql("SELECT status FROM shops WHERE id = '1617411897'")[0].status === 'pending');
  sqlFile(`INSERT OR REPLACE INTO settings (key, value) VALUES ('budget:items', '{"day":"2000-01-01","used":5000}');`);
  check('nouveau jour : le budget est de nouveau disponible', (await api('/api/indexer/jobs').then((r) => r.json())).shops.length > 0);

  // QC : secours Repfind quand FinderQC n'a rien
  // Repfind refuse parfois l'adresse IP de la machine de test (403) : non testable ici, il est vérifié en production.
  const repfindHere = await fetch('https://www.repfind.ai/client/product/detail?id=7802530042', { headers: { 'User-Agent': 'finds-bot/1.0' } })
    .then((r) => r.status).catch(() => 0);
  const rf = await api('/api/qc-window?item=weidian:7802530042').then((r) => r.json());
  if (repfindHere !== 200 && !rf.photos) console.log(`⚠️ QC : secours Repfind non testable depuis cette machine (Repfind répond ${repfindHere || 'rien'})`);
  else check('QC : secours Repfind quand FinderQC n\'a rien (dans Discord)', rf.ok && rf.photos > 0 && /cdn\.repfind\.ai/.test(rf.firstPhoto || '') && rf.externalLinks === 0, `${rf.qcCount} QC, ${rf.photos} photos`);

  const health = await click('health');
  check('🩺 santé : limites Discord', /Santé du bot/.test(allText(health.data.data)) && validate('santé', health.data.data));

  const acc = await click('acc');
  check('vue accès', /Membres ajoutés/.test(allText(acc.data.data)) && validate('accès', acc.data.data));
  const accAdd = await click('acc:add', ['555']);
  check('donner l\'accès', /Accès donné à <@555>/.test(allText(accAdd.data.data)));
  const viaAdded = await interact({ type: 2, member: { user: { id: '555' }, permissions: '0' }, data: { name: 'menu' } });
  check('membre ajouté peut ouvrir le menu', /# 🛍️ Finds/.test(allText(viaAdded.data.data)));
  const notAdmin = await interact({ type: 3, member: { user: { id: '555' }, permissions: '0' }, message: { id: 'm1' }, data: { custom_id: 'acc:add', component_type: 5, values: ['666'] } });
  check('membre ajouté ne peut pas donner l\'accès', /Seuls les administrateurs/.test(allText(notAdmin.data.data)));

  const itm = await submit('m:item', { link: 'https://item.taobao.com/item.htm?id=730344766230', title: 'Test bag', price: '199', image: '' });
  check('item Taobao manuel', /Item ajouté/.test(allText(itm.data.data)));

  const h2 = await click('home');
  check('accueil avec stats (+ items similaires découverts via les QC)', Number((allText(h2.data.data).match(/\*\*(\d+)\*\* items/) || [])[1]) >= 62, allText(h2.data.data).split('\n').find((l) => /items/.test(l)));
} catch (err) {
  failures++;
  console.error(err);
  console.log(devLog.slice(-3000));
} finally {
  // Journaux du Worker (console.log), gardés par wrangler dans son API locale.
  try {
    const q = await fetch(WORKER + '/cdn-cgi/local/explorer/api/local/observability/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM logs ORDER BY rowid LIMIT 2000' }),
    });
    devLog += '\n--- logs Worker ---\n' + await q.text();
  } catch {}
  writeFileSync(ROOT + '.wrangler/e2e-dev.log', devLog);
  const workerErrors = devLog.split('\n').filter((l) => /envoi échoué|traduction échouée|tâche|erreur|Error/.test(l));
  if (workerErrors.length) console.log('Logs Worker :\n' + workerErrors.slice(0, 15).join('\n'));
  dev.kill();
  mock.close();
  rmSync(ROOT + '.dev.vars', { force: true });
  console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK');
  process.exit(failures ? 1 : 0);
}
