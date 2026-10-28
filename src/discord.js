// Outils Discord : vérification de signature, appels REST, constantes.

export const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4 };
export const Reply = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE: 8,
};
export const EPHEMERAL = 64;
export const ADMINISTRATOR = 1n << 3n;

const DEFAULT_API = 'https://discord.com/api/v10';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Vérifie que la requête vient bien de Discord (Ed25519).
export async function verifyRequest(request, publicKey) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (!signature || !timestamp) return { ok: false, body };
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
    return { ok, body };
  } catch {
    return { ok: false, body };
  }
}

export async function discordApi(env, method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch((env.DISCORD_API || DEFAULT_API) + path, {
      method,
      // Content-Type seulement avec un corps : Discord refuse une requête sans corps annoncée en JSON (ex. DELETE).
      headers: body ? { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } : { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((data.retry_after || 1) * 1000)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`Discord ${method} ${path} -> rate limit`);
}

// Message avec fichiers joints (ex. photos QC). files = [{ name, blob }].
export async function discordUpload(env, path, payload, files) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })),
    }));
    files.forEach((f, i) => form.append(`files[${i}]`, f.blob, f.name));
    const res = await fetch((env.DISCORD_API || DEFAULT_API) + path, {
      method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, body: form,
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((data.retry_after || 1) * 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`Discord POST ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`Discord POST ${path} -> rate limit`);
}

// Message de suivi après une réponse différée.
export function followup(env, token, data) {
  return discordApi(env, 'POST', `/webhooks/${env.DISCORD_APP_ID}/${token}`, data);
}

export function editOriginal(env, token, data) {
  return discordApi(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, data);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function reply(content, extra = {}) {
  return json({ type: Reply.MESSAGE, data: { content, flags: EPHEMERAL, ...extra } });
}
