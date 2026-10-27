#!/usr/bin/env python3
# Envoie les emojis de emojis/png/ sur l'application Discord, via le Worker (le jeton du bot reste sur Cloudflare).
# Lancer : python3 emojis/upload.py [--replace]
import base64, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SECRET = open(os.path.join(HERE, '..', '.secrets')).read().strip()
URL = 'https://finds-bot.wheatenmoon5861.workers.dev/api/emojis'
files = sorted(f for f in os.listdir(os.path.join(HERE, 'png')) if f.startswith('fb_'))
emojis = []
for f in files:
    data = open(os.path.join(HERE, 'png', f), 'rb').read()
    kind = 'gif' if f.endswith('.gif') else 'png'
    emojis.append({'name': f.rsplit('.', 1)[0], 'image': f'data:image/{kind};base64,' + base64.b64encode(data).decode()})
for i in range(0, len(emojis), 10):
    req = urllib.request.Request(URL, data=json.dumps({'emojis': emojis[i:i + 10], 'replace': '--replace' in sys.argv}).encode(),
                                 headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json', 'User-Agent': 'curl/8.4.0'})
    res = json.load(urllib.request.urlopen(req, timeout=120))
    print('envoyés :', ', '.join(res['uploaded']) or '(déjà là)')
print(len(res['map']), 'emojis sur l\'application')
