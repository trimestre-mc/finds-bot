// Petits constructeurs pour les composants Discord (Components V2).

export const COMPONENTS_V2 = 1 << 15;
export const ACCENT = 0x8b5cf6; // violet du panneau
export const GOLD = 0xf0b232; // cartes d'items postés

export const Style = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };

export const row = (...components) => ({ type: 1, components: components.filter(Boolean) });
export const text = (content) => ({ type: 10, content });
export const sep = (divider = true, spacing = 1) => ({ type: 14, divider, spacing });
export const thumb = (url) => ({ type: 11, media: { url } });
export const gallery = (urls) => ({ type: 12, items: urls.map((url) => ({ media: { url } })) });
export const container = (components, accent = ACCENT) => ({ type: 17, accent_color: accent, components: components.filter(Boolean) });

export function section(content, accessory) {
  return { type: 9, components: [text(content)], accessory };
}

export function btn(label, customId, style = Style.SECONDARY, extra = {}) {
  const b = { type: 2, style, custom_id: customId, ...extra };
  if (label) b.label = label;
  return b;
}

export function emojiBtn(emoji, label, customId, style = Style.SECONDARY, extra = {}) {
  return btn(label, customId, style, { emoji: { name: emoji }, ...extra });
}

export function link(label, url, emoji) {
  const b = { type: 2, style: Style.LINK, label, url };
  if (emoji) b.emoji = { name: emoji };
  return b;
}

// Modale avec des champs texte (composant Label).
export function modal(customId, title, fields) {
  return {
    custom_id: customId,
    title: title.slice(0, 45),
    components: fields.map((f) => ({
      type: 18,
      label: f.label,
      description: f.description,
      component: {
        type: 4,
        custom_id: f.id,
        style: f.long ? 2 : 1,
        required: !!f.required,
        placeholder: f.placeholder,
        value: f.value != null && f.value !== '' ? String(f.value) : undefined,
        max_length: f.max || 400,
      },
    })),
  };
}

// Récupère les valeurs d'une modale, quel que soit le format (Label ou ancienne ligne).
export function modalValues(data) {
  const out = {};
  const walk = (list) => {
    for (const c of list || []) {
      if (c.custom_id && 'value' in c) out[c.custom_id] = (c.value || '').trim();
      if (c.component) walk([c.component]);
      if (c.components) walk(c.components);
    }
  };
  walk(data.components);
  return out;
}

export const escape = (s) => String(s || '').replace(/([*_`~|>\\[\]])/g, '\\$1');
export const fmtInt = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');
export const ago = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'jamais');
