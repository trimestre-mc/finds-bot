// Test de bout en bout en local : Worker (wrangler dev) + faux Discord + vrai indexeur Weidian.
// Usage : npm run test:e2e

import { spawn, execSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const WORKER = 'http://localhost:8787';
const MOCK_PORT = 8790;
const SECRET = 'test-secret';
const GUILD = '111', CHANNEL = '222', ADMIN_PERMS = String(1n << 3n);

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
  `INDEXER_SECRET=${SECRET}`, `DISCORD_API=http://localhost:${MOCK_PORT}`,
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
const cmd = (name, sub, options, admin = true) => interact({
  type: 2, ...member(admin),
  data: { name, options: sub ? [{ type: 1, name: sub, options }] : options },
});
const comp = (custom_id, values, admin = true) => interact({
  type: 3, ...member(admin), message: { id: 'm1' }, data: { custom_id, component_type: values ? 3 : 2, values },
});
const waitCall = async (pred, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const c = calls.find(pred); if (c) return c; await sleep(300); }
  return null;
};

try {
  for (let i = 0; i < 60; i++) { try { await fetch(WORKER); break; } catch { await sleep(1000); } }

  const ping = await interact({ type: 1 });
  check('PING -> PONG', ping.data.type === 1);

  const bad = await fetch(WORKER + '/interactions', { method: 'POST', body: '{"type":1}' });
  check('signature invalide refusée', bad.status === 401);

  const denied = await cmd('statut', null, [], false);
  check('non-admin refusé', /Réservé/.test(denied.data.data.content));

  const ag = await cmd('agent', 'ajouter', [
    { name: 'nom', value: 'BBDBuy' }, { name: 'modele', value: 'https://bbdbuy.com/product?url={url}&inviteCode=TEST' },
  ]);
  check('agent ajouté', /enregistré/.test(ag.data.data.content), ag.data.data.content.split('\n')[1]);

  const cat = await cmd('catalogue', 'ajouter', [{ name: 'lien', value: 'https://weidian.com/?userid=1784277725' }]);
  check('catalogue ajouté', /ajoutée/.test(cat.data.data.content));

  const tb = await cmd('catalogue', 'ajouter', [{ name: 'lien', value: 'https://shop123.taobao.com' }]);
  check('boutique Taobao refusée proprement', /connexion/.test(tb.data.data.content));

  console.log('… indexation réelle (60 items max)');
  execSync('node indexer/index.mjs', {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, WORKER_URL: WORKER, INDEXER_SECRET: SECRET, MAX_ITEMS: '60' },
  });
  const shop = sql("SELECT status, item_count, name FROM shops")[0];
  check('indexation terminée', shop.status === 'ok' && shop.item_count >= 60, `${shop.item_count} items, ${shop.name}`);

  console.log('… traduction (3 passages du cron)');
  for (let i = 0; i < 3; i++) { await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*'); await sleep(8000); }
  const tr = sql("SELECT title_zh, title_en FROM items WHERE title_en IS NOT NULL LIMIT 3");
  check('titres traduits', tr.length > 0, tr.map((t) => `${t.title_zh} → ${t.title_en}`).join(' | '));

  const rate = sql("SELECT value FROM settings WHERE key = 'cny_eur'");
  check('taux ¥→€ récupéré', rate.length === 1, rate[0] && rate[0].value);

  const search = await cmd('recherche', null, [{ name: 'mots', value: 'veste' }]);
  check('recherche différée', search.data.type === 5);
  const edit = await waitCall((c) => c.method === 'PATCH' && c.path.includes('/messages/@original'));
  check('résultats de recherche envoyés', edit && edit.body.content.startsWith('🔎'), edit && edit.body.content);
  const sel = edit?.body.components?.[0]?.components[0];

  const all = await cmd('recherche', null, []);
  const edit2 = await waitCall((c) => c.method === 'PATCH' && c.path.includes('/messages/@original') && c !== edit);
  const sid = edit2.body.components[0].components[0].custom_id.split(':')[1];
  check('recherche vide = tout', /60 résultats|[6-9]\d résultats/.test(edit2.body.content), edit2.body.content);

  const pg = await comp(`pg:${sid}:1`);
  check('page suivante', pg.data.type === 7 && /page 2\//.test(pg.data.data.content));

  const firstId = edit2.body.components[0].components[0].options[0].value;
  await comp(`sel:${sid}:0`, [firstId]);
  const posted = await waitCall((c) => c.method === 'POST' && c.path === `/channels/${CHANNEL}/messages`);
  const btn = posted && posted.body.components[0].components;
  check('item posté avec image et boutons', posted && posted.body.embeds[0].image && btn[0].url.includes('bbdbuy.com') && btn[0].url.includes('inviteCode=TEST'),
    posted && `${posted.body.embeds[0].title} | ${btn.map((b) => b.label).join(', ')}`);
  const done = await waitCall((c) => c.method === 'POST' && c.path === '/webhooks/999/tok');
  check('confirmation à l\'admin', done && /1 item posté/.test(done.body.content));

  const confirm = await comp(`all:${sid}`);
  check('tout poster demande confirmation', /Poster \*\*\d+\*\* items/.test(confirm.data.data.content), confirm.data.data.content);
  const ok = await comp(`ok:${sid}`);
  check('file remplie', /ajoutés à la file/.test(ok.data.data.content));
  const before = calls.filter((c) => c.path === `/channels/${CHANNEL}/messages`).length;
  await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*');
  await sleep(15000);
  const after = calls.filter((c) => c.path === `/channels/${CHANNEL}/messages`).length;
  check('le cron poste la file petit à petit', after - before === 8, `${after - before} postés en 1 passage`);

  const manual = await cmd('item', 'ajouter', [
    { name: 'lien', value: 'https://item.taobao.com/item.htm?id=730344766230' }, { name: 'titre', value: 'Test bag' }, { name: 'prix', value: 199 },
  ]);
  check('item Taobao manuel', /Item ajouté/.test(manual.data.data.content));

  const st = await cmd('statut', null, []);
  check('statut', /items dans/.test(st.data.data.content), st.data.data.content.replace(/\n/g, ' | '));

  void sel;
} catch (err) {
  failures++;
  console.error(err);
  console.log(devLog.slice(-3000));
} finally {
  dev.kill();
  mock.close();
  rmSync(ROOT + '.dev.vars', { force: true });
  console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK');
  process.exit(failures ? 1 : 0);
}
