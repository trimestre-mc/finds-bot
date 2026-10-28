#!/usr/bin/env python3
# Emojis du bot (emojis d'application Discord) : dessins originaux en SVG, rendus en PNG 128×128 (rsvg-convert),
# plus deux GIF animés (« live » et chargement). Lancer : python3 emojis/make.py
import os, subprocess, math
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = os.path.join(HERE, 'src'), os.path.join(HERE, 'png')
FONT = "font-family=\"'SF Pro Display','Helvetica Neue',Arial,sans-serif\""
CJK = "font-family=\"'PingFang SC','Hiragino Sans GB','Heiti SC',sans-serif\""

def badge(c1, c2, glyph, extra_defs=''):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient>
<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>{extra_defs}</defs>
<rect x="4" y="4" width="120" height="120" rx="32" fill="url(#g)"/>
<rect x="4" y="4" width="120" height="120" rx="32" fill="url(#hl)"/>
<rect x="5.5" y="5.5" width="117" height="117" rx="30.5" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3"/>
{glyph}</svg>'''

def label(t, size=56, y=82, font=FONT, ls=0):
    return f'<text x="64" y="{y}" text-anchor="middle" {font} font-size="{size}" font-weight="900" letter-spacing="{ls}" fill="#fff">{t}</text>'

W = 'fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"'
CHECK = f'<path d="M86 96l8 8 16-17" {W} stroke-width="7"/>'

E = {
  # QC
  'fb_qc': badge('#8b5cf6', '#6d28d9', '<rect x="20" y="42" width="78" height="54" rx="12" fill="#fff"/><rect x="42" y="31" width="32" height="16" rx="6" fill="#fff"/>'
           '<circle cx="59" cy="69" r="17" fill="#6d28d9"/><circle cx="59" cy="69" r="9" fill="#fff"/>'
           '<circle cx="98" cy="96" r="20" fill="#22c55e" stroke="#fff" stroke-width="5"/>' + CHECK),
  'fb_gl': badge('#22c55e', '#15803d', label('GL', 58, 84)),
  'fb_rl': badge('#ef4444', '#b91c1c', label('RL', 58, 84)),
  'fb_photos': badge('#38bdf8', '#2563eb', '<rect x="22" y="30" width="84" height="68" rx="12" fill="#fff"/><path d="M30 88l22-26 16 18 12-12 18 20z" fill="#2563eb"/><circle cx="84" cy="48" r="8" fill="#f59e0b"/>'),
  'fb_verified': badge('#22c55e', '#0f766e', '<path d="M64 18l11 9 14-2 5 13 13 6-2 14 9 11-9 11 2 14-13 6-5 13-14-2-11 9-11-9-14 2-5-13-13-6 2-14-9-11 9-11-2-14 13-6 5-13 14 2z" fill="#fff"/>'
           f'<path d="M46 66l12 12 25-27" {W.replace("#fff", "#15803d")} stroke-width="11"/>'),
  # Achat / agents / plateformes
  'fb_cart': badge('#fb923c', '#ea580c', f'<path d="M20 32h14l11 46h48l11-32H40" {W} stroke-width="9"/><circle cx="52" cy="94" r="8" fill="#fff"/><circle cx="88" cy="94" r="8" fill="#fff"/>'),
  'fb_bbdbuy': badge('#f97316', '#dc2626', label('BBD', 44, 70, ls=-1) + label('BUY', 21, 98, ls=4)),
  'fb_kakobuy': badge('#0ea5e9', '#4f46e5', label('KAKO', 34, 70, ls=-1) + label('BUY', 21, 98, ls=4)),
  'fb_weidian': badge('#f43f5e', '#be123c', label('微店', 46, 80, CJK)),
  'fb_taobao': badge('#fb923c', '#f97316', label('淘', 66, 88, CJK)),
  'fb_1688': badge('#f59e0b', '#ea580c', label('1688', 40, 78, ls=-1)),
  'fb_link': badge('#64748b', '#334155', f'<path d="M56 72l16-16" {W} stroke-width="9"/><path d="M52 58l-10 10a14 14 0 0 0 20 20l10-10" {W} stroke-width="9"/><path d="M76 70l10-10a14 14 0 0 0-20-20l-10 10" {W} stroke-width="9"/>'),
  'fb_shop': badge('#a855f7', '#7c3aed', '<path d="M24 50l8-22h64l8 22z" fill="#fff"/><path d="M24 50a10 10 0 0 0 20 0a10 10 0 0 0 20 0a10 10 0 0 0 20 0a10 10 0 0 0 20 0" fill="#fff"/>'
           '<rect x="30" y="62" width="68" height="40" rx="6" fill="#fff"/><rect x="54" y="74" width="20" height="28" rx="3" fill="#7c3aed"/>'),
  'fb_price': badge('#10b981', '#047857', '<path d="M26 26h40l40 40-40 40-40-40z" fill="#fff"/><circle cx="42" cy="42" r="7" fill="#047857"/>'
           '<text x="68" y="84" text-anchor="middle" ' + FONT + ' font-size="40" font-weight="900" fill="#047857">¥</text>'),
  'fb_drop': badge('#10b981', '#0f766e', f'<polyline points="22,36 50,62 68,50 98,82" {W} stroke-width="10"/><path d="M78 86h26V60" {W} stroke-width="10"/>'),
  'fb_fire': badge('#f97316', '#e11d48', '<path d="M64 16c6 18 30 28 30 56a30 30 0 0 1-60 0c0-14 7-23 14-29 0 11 6 17 12 17-5-15 0-30 4-44z" fill="#fff"/>'
           '<path d="M64 62c3 9 14 13 14 26a14 14 0 0 1-28 0c0-8 5-13 9-16 0 5 3 8 5 8-2-7 0-13 0-18z" fill="#f97316"/>'),
  'fb_crown': badge('#fbbf24', '#d97706', '<path d="M22 46l22 18 20-30 20 30 22-18-8 50H30z" fill="#fff"/><rect x="30" y="98" width="68" height="10" rx="4" fill="#fff"/>'),
  'fb_star': badge('#facc15', '#f59e0b', '<path d="M64 18l13 28 30 3-23 20 7 30-27-16-27 16 7-30-23-20 30-3z" fill="#fff"/>'),
  'fb_new': badge('#ec4899', '#8b5cf6', label('NEW', 38, 77, ls=-1)),
  # Outils du bot
  'fb_search': badge('#3b82f6', '#1d4ed8', f'<circle cx="56" cy="56" r="24" {W} stroke-width="11"/><path d="M74 74l24 24" {W} stroke-width="13"/>'),
  'fb_compare': badge('#14b8a6', '#0e7490', f'<path d="M64 24v76M40 100h48M28 40h72" {W} stroke-width="8"/><path d="M28 40l-14 30h28z" fill="#fff"/><path d="M100 40l-14 30h28z" fill="#fff"/>'
           '<path d="M14 70a14 10 0 0 0 28 0z M86 70a14 10 0 0 0 28 0z" fill="#fff"/><circle cx="64" cy="24" r="7" fill="#fff"/>'),
  'fb_coupon': badge('#f472b6', '#db2777', '<path d="M18 38h92v16a10 10 0 0 0 0 20v16H18V74a10 10 0 0 0 0-20z" fill="#fff"/>'
           '<text x="64" y="80" text-anchor="middle" ' + FONT + ' font-size="34" font-weight="900" fill="#db2777">%</text>'),
  'fb_gift': badge('#f43f5e', '#c026d3', '<rect x="22" y="52" width="84" height="20" rx="5" fill="#fff"/><rect x="28" y="72" width="72" height="34" rx="5" fill="#fff"/>'
           '<rect x="58" y="52" width="12" height="54" fill="#c026d3"/><path d="M64 52c-10-22-34-18-26-4 4 6 18 4 26 4zm0 0c10-22 34-18 26-4-4 6-18 4-26 4z" fill="#fff"/>'),
  'fb_signup': badge('#f59e0b', '#ea580c', '<circle cx="54" cy="46" r="18" fill="#fff"/><path d="M20 102c0-22 16-34 34-34s34 12 34 34z" fill="#fff"/>'
           '<circle cx="96" cy="88" r="20" fill="#22c55e" stroke="#fff" stroke-width="5"/><path d="M96 78v20M86 88h20" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'),
  'fb_stats': badge('#6366f1', '#4338ca', '<rect x="24" y="66" width="18" height="36" rx="5" fill="#fff"/><rect x="55" y="44" width="18" height="58" rx="5" fill="#fff"/><rect x="86" y="26" width="18" height="76" rx="5" fill="#fff"/>'),
  'fb_bell': badge('#fbbf24', '#f97316', '<path d="M64 20c-18 0-30 14-30 32v20l-10 14h80l-10-14V52c0-18-12-32-30-32z" fill="#fff"/><circle cx="64" cy="98" r="10" fill="#fff"/>'),
  'fb_box': badge('#d97706', '#92400e', '<path d="M64 18l40 20v52L64 110 24 90V38z" fill="#fff"/><path d="M24 38l40 20 40-20M64 58v52" fill="none" stroke="#92400e" stroke-width="6" stroke-linejoin="round"/>'),
  'fb_trend': badge('#22c55e', '#16a34a', f'<polyline points="22,90 50,62 68,74 100,40" {W} stroke-width="10"/><path d="M78 40h22v22" {W} stroke-width="10"/>'),
  'fb_bot': badge('#8b5cf6', '#ec4899', '<path d="M64 16l38 24v48L64 112 26 88V40z" fill="#fff" fill-opacity=".95"/>' + label('F', 54, 84).replace('#fff', '#8b5cf6')),
  'fb_warn': badge('#f59e0b', '#d97706', '<path d="M64 20l46 82H18z" fill="#fff"/><rect x="59" y="48" width="10" height="30" rx="4" fill="#d97706"/><circle cx="64" cy="90" r="6" fill="#d97706"/>'),
  # Analyse IA : verdicts des points, étapes, détails contrôlés.
  'fb_ok': badge('#22c55e', '#15803d', f'<path d="M36 66l18 18 38-40" {W} stroke-width="14"/>'),
  'fb_mid': badge('#fbbf24', '#d97706', '<rect x="56" y="26" width="16" height="50" rx="8" fill="#fff"/><circle cx="64" cy="96" r="9" fill="#fff"/>'),
  'fb_bad': badge('#f43f5e', '#be123c', f'<path d="M42 42l44 44M86 42l-44 44" {W} stroke-width="14"/>'),
  'fb_tag': badge('#38bdf8', '#2563eb', '<path d="M24 30h44l38 38-36 36-46-46z" fill="#fff"/><circle cx="44" cy="50" r="8" fill="#2563eb"/>'
         '<rect x="58" y="70" width="26" height="6" rx="3" fill="#2563eb" transform="rotate(45 71 73)"/>'),
  'fb_ruler': badge('#14b8a6', '#0f766e', '<rect x="14" y="46" width="100" height="36" rx="7" fill="#fff"/>'
         + ''.join(f'<rect x="{24 + i * 12}" y="46" width="4" height="{18 if i % 2 == 0 else 11}" rx="2" fill="#0f766e"/>' for i in range(8))),
  'fb_thread': badge('#f472b6', '#be185d', f'<path d="M30 98L94 34" {W} stroke-width="9"/><ellipse cx="96" cy="32" rx="9" ry="5" fill="none" stroke="#fff" stroke-width="4" transform="rotate(-45 96 32)"/>'
         f'<path d="M100 30c18 14-8 34-26 26s-30 10-40 34" fill="none" stroke="#fde68a" stroke-width="5" stroke-linecap="round"/>'),
  'fb_zoom': badge('#6366f1', '#4338ca', f'<circle cx="56" cy="56" r="28" {W} stroke-width="11"/><path d="M78 78l24 24" {W} stroke-width="14"/>'
         f'<path d="M56 42v28M42 56h28" {W} stroke-width="8"/>'),
  'fb_brain': badge('#a855f7', '#db2777', '<path d="M54 18l9 27 27 9-27 9-9 27-9-27-27-9 27-9z" fill="#fff"/>'
         '<path d="M94 64l5 14 14 5-14 5-5 14-5-14-14-5 14-5z" fill="#fde68a"/><circle cx="92" cy="30" r="6" fill="#fff" fill-opacity=".85"/>'),
  'fb_redo': badge('#22d3ee', '#0891b2', f'<path d="M96 56a34 34 0 0 0-62-12" {W} stroke-width="11"/><path d="M28 28v20h20" {W} stroke-width="11"/>'
         f'<path d="M32 72a34 34 0 0 0 62 12" {W} stroke-width="11"/><path d="M100 100V80H80" {W} stroke-width="11"/>'),
  'fb_clock': badge('#64748b', '#334155', f'<circle cx="64" cy="66" r="38" fill="#fff"/><path d="M64 42v26l16 10" fill="none" stroke="#334155" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>'),
  'fb_tip': badge('#fde047', '#f59e0b', '<path d="M64 18a30 30 0 0 0-18 54c4 4 6 8 6 14h24c0-6 2-10 6-14a30 30 0 0 0-18-54z" fill="#fff"/>'
         '<rect x="52" y="92" width="24" height="8" rx="3" fill="#fff"/><rect x="55" y="103" width="18" height="7" rx="3" fill="#fff"/>'),
  'fb_ask': badge('#fb923c', '#ea580c', '<rect x="16" y="40" width="74" height="56" rx="12" fill="#fff"/><rect x="34" y="30" width="30" height="14" rx="5" fill="#fff"/>'
         '<circle cx="53" cy="68" r="15" fill="#ea580c"/><circle cx="53" cy="68" r="8" fill="#fff"/>'
         '<circle cx="98" cy="94" r="20" fill="#22c55e" stroke="#fff" stroke-width="5"/><path d="M98 84v20M88 94h20" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'),
}

# Sans badge : étoiles de la note et puces d'étapes.
STAR = 'M64 10l15.5 33 36 4.5-26.5 25 7 35.5L64 90 32 108l7-35.5-26.5-25 36-4.5z'
PLAIN = {
  'fb_s1': '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
           '<stop offset="0" stop-color="#fde68a"/><stop offset=".5" stop-color="#fbbf24"/><stop offset="1" stop-color="#d97706"/></linearGradient></defs>'
           f'<path d="{STAR}" fill="url(#g)" stroke="#fff" stroke-opacity=".5" stroke-width="3" stroke-linejoin="round"/>'
           '<path d="M64 22l10 22 22 3" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="5" stroke-linecap="round"/></svg>',
  'fb_s0': '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
           f'<path d="{STAR}" fill="#94a3b8" fill-opacity=".22" stroke="#94a3b8" stroke-opacity=".75" stroke-width="7" stroke-linejoin="round"/></svg>',
  'fb_done': '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
           '<stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/></linearGradient></defs>'
           f'<circle cx="64" cy="64" r="52" fill="url(#g)"/><path d="M40 66l16 16 32-34" {W} stroke-width="13"/></svg>',
  'fb_todo': '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
           '<circle cx="64" cy="64" r="46" fill="none" stroke="#94a3b8" stroke-opacity=".7" stroke-width="10" stroke-dasharray="14 12"/></svg>',
}
E.update(PLAIN)

def render(name, svg, size=128):
    p = os.path.join(SRC, f'{name}.svg'); open(p, 'w').write(svg)
    out = os.path.join(OUT, f'{name}.png')
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), p, '-o', out], check=True)
    return out

for n, s in E.items():
    render(n, s)

# Animés : « live » (point qui pulse) et chargement (arc qui tourne).
def frames(make, n):
    imgs = []
    for i in range(n):
        p = render(f'_f{i}', make(i / n))
        imgs.append(Image.open(p).convert('RGBA'))
        os.remove(p); os.remove(os.path.join(SRC, f'_f{i}.svg'))
    return imgs

def save_gif(name, imgs, ms):
    pal = [im.convert('RGBA') for im in imgs]
    bg = Image.new('RGBA', pal[0].size, (0, 0, 0, 0))
    out = []
    for im in pal:
        # Transparence GIF : un index de palette réservé aux pixels transparents.
        alpha = im.getchannel('A')
        p = im.convert('RGB').convert('P', palette=Image.Palette.ADAPTIVE, colors=255)
        mask = Image.eval(alpha, lambda a: 255 if a <= 128 else 0)
        p.paste(255, mask)
        out.append(p)
    out[0].save(os.path.join(OUT, f'{name}.gif'), save_all=True, append_images=out[1:], duration=ms, loop=0, transparency=255, disposal=2)

live = lambda t: badge('#16a34a', '#065f46',
    f'<circle cx="64" cy="64" r="{20 + 30 * t:.1f}" fill="#4ade80" fill-opacity="{0.55 * (1 - t):.2f}"/>'
    '<circle cx="64" cy="64" r="20" fill="#fff"/><circle cx="64" cy="64" r="11" fill="#22c55e"/>')
save_gif('fb_live', frames(live, 16), 70)

def spin(t):
    a = t * 360
    return badge('#8b5cf6', '#4f46e5', f'<circle cx="64" cy="64" r="32" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="12"/>'
                 f'<path d="M64 32a32 32 0 0 1 32 32" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" transform="rotate({a:.1f} 64 64)"/>')
save_gif('fb_loading', frames(spin, 12), 60)

# Analyse IA des QC : une photo balayée par un faisceau de scan, avec une étincelle qui pulse.
def aiscan(t):
    y = 34 + 58 * (0.5 - 0.5 * math.cos(2 * math.pi * t))  # va-et-vient doux
    glow = 0.5 + 0.5 * math.sin(2 * math.pi * t * 2)
    return badge('#8b5cf6', '#4f46e5',
        '<defs><linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#67e8f9" stop-opacity="0"/>'
        '<stop offset="1" stop-color="#67e8f9" stop-opacity=".75"/></linearGradient><clipPath id="ph"><rect x="22" y="30" width="72" height="66" rx="10"/></clipPath></defs>'
        '<rect x="22" y="30" width="72" height="66" rx="10" fill="#fff"/>'
        '<path d="M28 90l20-24 14 16 10-10 16 18z" fill="#c4b5fd"/><circle cx="76" cy="46" r="7" fill="#a78bfa"/>'
        f'<g clip-path="url(#ph)"><rect x="22" y="{y - 22:.1f}" width="72" height="22" fill="url(#beam)"/>'
        f'<rect x="22" y="{y - 2:.1f}" width="72" height="4" fill="#22d3ee"/></g>'
        f'<path d="M104 18l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#fde047" fill-opacity="{0.45 + 0.55 * glow:.2f}" '
        f'transform="translate({104 * (1 - (0.8 + 0.2 * glow)):.1f} {32 * (1 - (0.8 + 0.2 * glow)):.1f}) scale({0.8 + 0.2 * glow:.2f})"/>')
save_gif('fb_aiscan', frames(aiscan, 20), 60)

# Barre de progression en emojis : début, milieu, fin ; pleine (violet, avec un reflet qui glisse) ou
# vide (rail gris). Dégradé vertical : les morceaux se raccordent sans couture. Les morceaux se mettent bout à bout dans le texte.
def bar(part, full, t=0.0):
    y, h = 42, 44
    r = h / 2
    if part == 'l': shape = f'<path d="M{8 + r} {y}H128V{y + h}H{8 + r}a{r} {r} 0 0 1 0-{h}z"/>'
    elif part == 'r': shape = f'<path d="M0 {y}H{120 - r}a{r} {r} 0 0 1 0 {h}H0z"/>'
    else: shape = f'<rect x="0" y="{y}" width="128" height="{h}"/>'
    if not full:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
                f'<g fill="#94a3b8" fill-opacity=".28">{shape}</g></svg>')
    x = -80 + 300 * t
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs>'
            '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset=".55" stop-color="#7c3aed"/><stop offset="1" stop-color="#5b21b6"/></linearGradient>'
            '<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'
            f'<clipPath id="c">{shape}</clipPath></defs>'
            f'<g clip-path="url(#c)"><rect width="128" height="128" fill="url(#g)"/><rect width="128" height="128" fill="url(#v)"/>'
            f'<path d="M{x:.1f} 30h26l-20 70h-26z" fill="#fff" fill-opacity=".45"/></g></svg>')

for part in 'lmr':
    save_gif(f'fb_bar{part}1', frames(lambda t, p=part: bar(p, True, t), 14), 70)
    render(f'fb_bar{part}0', bar(part, False))

# Planche de contrôle.
names = sorted(f for f in os.listdir(OUT) if f.endswith(('.png', '.gif')))
cols = 8
sheet = Image.new('RGBA', (cols * 140, math.ceil(len(names) / cols) * 140), (49, 51, 56, 255))
for i, f in enumerate(names):
    im = Image.open(os.path.join(OUT, f)).convert('RGBA')
    sheet.alpha_composite(im, (i % cols * 140 + 6, i // cols * 140 + 6))
sheet.save(os.path.join(HERE, 'planche.png'))
print(len(names), 'emojis')
