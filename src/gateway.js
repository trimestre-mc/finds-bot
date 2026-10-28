// Connexion permanente à Discord (Gateway), dans un Durable Object (gratuit) : les messages des salons de
// conversion et de recherche par image arrivent à l'instant où ils sont postés, au lieu d'être relus chaque minute.
// Le traitement se fait dans une exécution à part du bot (POST /api/watch/message), avec son propre quota.
// Une alarme toutes les 30 s vérifie la connexion et la relance (reprise de session si possible). Tant que la
// connexion vit, elle le note dans les réglages (« gateway:alive ») et la relecture par cron se met en veille.

import { DurableObject } from 'cloudflare:workers';
import { withDb } from './turso.js';
import { kvSet } from './kvstore.js';

const GATEWAY = 'https://gateway.discord.gg/?v=10&encoding=json';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
const WATCHDOG_MS = 30000;
const CHANNELS_TTL_MS = 60000;

export class Gateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ws = null;
    this.seq = null;
    this.session = null;
    this.resumeUrl = null;
    this.beat = null;
    this.acked = true;
    this.lastEvent = 0;
    this.connecting = null;
    this.channels = new Map();
    this.channelsAt = 0;
    this.handled = 0;
    this.seen = 0;
  }

  // Appelé chaque minute par le cron (et à la main) : vérifie la connexion, la relance si besoin.
  // /refresh : liste des salons modifiée dans les réglages, relue tout de suite.
  async fetch(request) {
    // /status : simple lecture de l'état (dashboard), sans vérification.
    if (new URL(request.url).pathname === '/status') return Response.json(this.status());
    if (new URL(request.url).pathname === '/refresh') await this.loadChannels();
    await this.ensure();
    return Response.json(this.status());
  }

  async alarm() {
    await this.ensure();
  }

  status() {
    return { connected: this.alive(), session: !!this.session, lastEvent: this.lastEvent, seen: this.seen, handled: this.handled, channels: this.channels.size, aliveSaved: this.aliveSaved ?? null, upstash: !!this.env.UPSTASH_URL };
  }

  alive() {
    return !!this.ws && this.ws.readyState === 1 && Date.now() - this.lastEvent < 3 * 45000;
  }

  async ensure() {
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    if (!this.alive()) await this.connect();
    if (this.alive()) {
      const env = withDb(this.env);
      this.aliveSaved = await kvSet(env, 'gateway:alive', Date.now(), 300);
      if (!this.aliveSaved) {
        await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gateway:alive', ?)").bind(String(Date.now())).run().catch(() => {});
      }
    }
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.close();
      if (!this.session) {
        const saved = await this.ctx.storage.get(['session', 'seq', 'resumeUrl']);
        this.session = saved.get('session') || null;
        this.seq = saved.get('seq') ?? null;
        this.resumeUrl = saved.get('resumeUrl') || null;
      }
      const base = this.session && this.resumeUrl ? `${this.resumeUrl.replace(/^wss:/, 'https:')}/?v=10&encoding=json` : GATEWAY;
      const res = await fetch(base, { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`Gateway : pas de WebSocket (${res.status})`);
      ws.accept();
      this.ws = ws;
      this.lastEvent = Date.now();
      ws.addEventListener('message', (e) => this.onMessage(e.data).catch((err) => console.log('gateway', String(err).slice(0, 200))));
      ws.addEventListener('close', (e) => {
        console.log('gateway fermée', e.code, String(e.reason || '').slice(0, 80));
        // Codes sans reprise possible : session oubliée, nouvelle identification au prochain essai.
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(e.code)) console.log('gateway : refus définitif', e.code);
        if ([4007, 4009].includes(e.code)) this.forget();
        if (this.ws === ws) this.ws = null;
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  close() {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    if (this.ws) { try { this.ws.close(1000, 'reconnexion'); } catch {} }
    this.ws = null;
  }

  forget() {
    this.session = null;
    this.seq = null;
    this.ctx.storage.delete(['session', 'seq', 'resumeUrl']).catch(() => {});
  }

  send(payload) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload));
  }

  async onMessage(data) {
    const p = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    this.lastEvent = Date.now();
    if (p.s != null) this.seq = p.s;
    switch (p.op) {
      case 10: { // Hello : battements de cœur, puis reprise de session ou identification
        const every = p.d.heartbeat_interval;
        this.acked = true;
        this.beat = setInterval(() => {
          if (!this.acked) { this.close(); return; } // pas de réponse au dernier battement : connexion morte
          this.acked = false;
          this.send({ op: 1, d: this.seq });
        }, every);
        if (this.session) this.send({ op: 6, d: { token: this.env.DISCORD_BOT_TOKEN, session_id: this.session, seq: this.seq } });
        else {
          this.send({ op: 2, d: { token: this.env.DISCORD_BOT_TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'finds-bot', device: 'finds-bot' } } });
        }
        return;
      }
      case 11: this.acked = true; return;
      case 1: this.send({ op: 1, d: this.seq }); return;
      case 7: this.close(); await this.connect(); return; // Discord demande de se reconnecter (reprise)
      case 9: // session invalide
        if (!p.d) this.forget();
        this.close();
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));
        await this.connect();
        return;
      case 0: return this.dispatch(p.t, p.d);
      default:
    }
  }

  async dispatch(type, d) {
    if (type === 'READY') {
      this.session = d.session_id;
      this.resumeUrl = d.resume_gateway_url;
      await this.ctx.storage.put({ session: this.session, resumeUrl: this.resumeUrl, seq: this.seq });
      return;
    }
    if (type === 'MESSAGE_CREATE') this.seen++;
    if (type !== 'MESSAGE_CREATE' || !d || (d.author && d.author.bot)) return;
    if (this.seq != null && this.seq % 20 === 0) this.ctx.storage.put('seq', this.seq).catch(() => {});
    const kind = await this.channelKind(d.channel_id);
    if (!kind) return;
    this.handled++;
    // Traitement dans une exécution à part du bot (son propre quota de requêtes).
    const res = await this.env.SELF.fetch('https://finds-bot/api/watch/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.INDEXER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: d.channel_id, message: d }),
    });
    if (!res.ok) console.log('gateway : traitement', res.status);
  }

  // Salons surveillés (conversion, recherche par image, analyse IA), relus au plus une fois par minute ; un salon
  // inconnu fait relire la liste (au plus toutes les 15 s), pour un salon ajouté à l'instant.
  async channelKind(channelId) {
    const stale = Date.now() - this.channelsAt > CHANNELS_TTL_MS || (!this.channels.has(channelId) && Date.now() - this.channelsAt > 15000);
    if (stale) await this.loadChannels();
    return this.channels.get(channelId) || null;
  }

  // Relit la liste des salons ; s'il y en a de nouveaux, rattrape les messages déjà postés depuis leur ajout.
  async loadChannels() {
    const before = new Set(this.channels.keys());
    const env = withDb(this.env);
    const [conv, img, ai] = await Promise.all([
      env.DB.prepare('SELECT channel_id FROM convert_channels').all(),
      env.DB.prepare('SELECT channel_id FROM image_channels').all(),
      env.DB.prepare('SELECT channel_id FROM aiqc_channels').all().catch(() => ({ results: [] })),
    ]);
    this.channels = new Map([...conv.results.map((c) => [c.channel_id, 'convert']), ...img.results.map((c) => [c.channel_id, 'image']),
      ...ai.results.map((c) => [c.channel_id, 'aiqc'])]);
    this.channelsAt = Date.now();
    if (this.channelsAt && [...this.channels.keys()].some((id) => !before.has(id)) && before.size) {
      await this.env.SELF.fetch('https://finds-bot/api/watch/catchup', {
        method: 'POST', headers: { Authorization: `Bearer ${this.env.INDEXER_SECRET}` },
      }).catch((err) => console.log('gateway : rattrapage', String(err).slice(0, 120)));
    }
  }
}
