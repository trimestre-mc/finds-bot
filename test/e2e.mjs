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
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: String(Date.now()) }));
  });
}).listen(MOCK_PORT);

// ---- Clés de signature de test
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
writeFileSync(ROOT + '.dev.vars', [
  `DISCORD_PUBLIC_KEY=${pubHex}`, 'DISCORD_APP_ID=999', 'DISCORD_BOT_TOKEN=fake',
  `INDEXER_SECRET=${SECRET}`, `DISCORD_API=http://localhost:${MOCK_PORT}`, 'AGENTS_OWNER_ID=1',
].join('\n'));

const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString();
rmSync(ROOT + '.wrangler/state', { recursive: true, force: true });
sh('npx wrangler d1 execute finds-bot --local --file schema.sql');
const sql = (q) => JSON.parse(sh(`npx wrangler d1 execute finds-bot --local --json --command "${q}"`))[0].results;

const dev = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--test-scheduled'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => (devLog += d));
dev.stderr.on('data', (d) => (devLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const shop = await submit('m:shop', { link: 'https://weidian.com/?userid=1784277725' });
  check('boutique ajoutée', /Boutique .*ajoutée/.test(allText(shop.data.data)));
  check('vue catalogues : limites Discord', validate('catalogues', shop.data.data));
  const tb = await submit('m:shop', { link: 'https://shop123.taobao.com' });
  check('boutique Taobao refusée proprement', /demandent une connexion/.test(allText(tb.data.data)));

  console.log('… indexation réelle (60 items max)');
  execSync('node indexer/index.mjs', {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, WORKER_URL: WORKER, INDEXER_SECRET: SECRET, MAX_ITEMS: '60' },
  });
  console.log('… traduction (3 passages du cron)');
  for (let i = 0; i < 3; i++) { await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*'); await sleep(8000); }
  check('titres traduits', sql('SELECT COUNT(*) AS n FROM items WHERE title_en IS NOT NULL')[0].n > 0);

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

  let mark = calls.length;
  const post = await click(`s:sel:${sid}:0`, [sel.options[0].value]);
  check('poster la sélection (réponse différée)', post.data.type === 6);
  const posted = await waitCall((c) => c.method === 'POST' && c.path === `/channels/${OTHER_CHANNEL}/messages`);
  check('carte postée : limites Discord', posted && validate('carte postée', posted.body));
  const buy = posted && findComp(posted.body, (c) => c.type === 2 && c.style === 5);
  check('carte postée : image + bouton BBDBuy avec code', posted && !!findComp(posted.body, (c) => c.type === 12) && /^https:\/\/www\.bbdbuy\.com\/goods\/WEIDIAN\/\d+\?inviteCode=TEST$/.test(buy.url),
    posted && `${buy.label} | ${allText(posted.body).split('\n')[0]}`);
  const after = await lastEdit(mark);
  check('panneau mis à jour après envoi', after && /1\*\* item posté/.test(allText(after.body)) && validate('après envoi', after.body));

  const conf = await click(`s:all:${sid}:0`);
  check('tout poster → confirmation', /Tout poster \?/.test(allText(conf.data.data)) && validate('confirmation', conf.data.data));
  const posts = () => calls.filter((c) => c.path === `/channels/${OTHER_CHANNEL}/messages`);
  const before = posts().length;
  const ok = await click(`s:ok:${sid}:0`);
  check('file remplie', /en route vers/.test(allText(ok.data.data)), allText(ok.data.data).split('\n')[0]);
  await sleep(27000);
  const fast = posts().length - before;
  check('envoi immédiat après confirmation (~1/s)', fast >= 18 && fast <= 26, `${fast} postés en 27 s`);
  await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*');
  await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*');
  await sleep(45000);
  const queueLeft = sql('SELECT COUNT(*) AS n FROM post_queue')[0].n;
  const titles = posts().slice(before).map((c) => allText(c.body).split('\n').pop());
  check('toute la file envoyée, sans doublon', queueLeft === 0 && posts().length - before === 59 && new Set(titles).size === titles.length,
    `${posts().length - before} postés, ${queueLeft} restants, ${new Set(titles).size} uniques`);

  const tr = sql("SELECT title_en FROM items WHERE title_en IS NOT NULL AND title_en LIKE '% %' LIMIT 1")[0];
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
  check('accueil avec stats', /61\*\* items/.test(allText(h2.data.data)), allText(h2.data.data).split('\n').find((l) => /items/.test(l)));
} catch (err) {
  failures++;
  console.error(err);
  console.log(devLog.slice(-3000));
} finally {
  const workerErrors = devLog.split('\n').filter((l) => /envoi échoué|traduction échouée|tâche|erreur|Error/.test(l));
  if (workerErrors.length) console.log('Logs Worker :\n' + workerErrors.slice(0, 15).join('\n'));
  dev.kill();
  mock.close();
  rmSync(ROOT + '.dev.vars', { force: true });
  console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK');
  process.exit(failures ? 1 : 0);
}
