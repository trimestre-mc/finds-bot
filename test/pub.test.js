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
