import test from 'node:test';
import assert from 'node:assert/strict';

test('MP de pub : titre, texte, bouton de lien, « Se désinscrire » activable', async () => {
  const { adMessage } = await import('../src/pub.js');
  const on = JSON.stringify(adMessage({}, { title: 'Promo', text: 'Salut', btnLabel: 'Voir', btnUrl: 'https://x.y' }));
  assert.match(on, /Promo/);
  assert.match(on, /pub:adoff/);
  assert.match(on, /https:\/\/x\.y/);
  const off = JSON.stringify(adMessage({}, { title: 'Promo', text: 'Salut', unsub: false }));
  assert.doesNotMatch(off, /pub:adoff/);
});

test('modèle Kij Find : mise en forme Discord gardée, bouton vers le serveur', async () => {
  const { adMessage, PRESETS } = await import('../src/pub.js');
  const s = JSON.stringify(adMessage({}, PRESETS.kijfind));
  assert.match(s, /kijfind\.png/); // bannière
  assert.match(s, /Kij Find/);
  assert.match(s, /✅ Débutant/); // {fb_verified} → emoji (Unicode de secours sans la liste des emojis)
  assert.match(s, /"type":14/); // séparateurs
  assert.match(s, /https:\/\/discord\.gg\/9XpCj6p6Rg/);
});
