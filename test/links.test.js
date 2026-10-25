import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeidianShop, parseItemLink, buildAgentLink, isValidTemplate } from '../src/links.js';

test('liens de boutique Weidian', () => {
  assert.equal(parseWeidianShop('https://weidian.com/?userid=1784277725'), '1784277725');
  assert.equal(parseWeidianShop('https://shop1784277725.v.weidian.com/?userid=1784277725'), '1784277725');
  assert.equal(parseWeidianShop('https://weidian.com/s/1840259863'), '1840259863');
  assert.equal(parseWeidianShop('1840259863'), '1840259863');
  assert.equal(parseWeidianShop('https://weidian.com/item.html?itemID=7874663131'), null);
});

test('liens d\'items', () => {
  assert.deepEqual(parseItemLink('https://weidian.com/item.html?itemID=7874663131&spider_token=x'),
    { platform: 'weidian', itemId: '7874663131', url: 'https://weidian.com/item.html?itemID=7874663131' });
  assert.equal(parseItemLink('https://item.taobao.com/item.htm?spm=a.b&id=730344766230').itemId, '730344766230');
  assert.equal(parseItemLink('https://detail.1688.com/offer/736283429364.html').platform, '1688');
  assert.equal(parseItemLink('https://www.kakobuy.com/item/details?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7805904567').itemId, '7805904567');
  assert.equal(parseItemLink('https://example.com'), null);
});

test('modèles d\'agents', () => {
  const item = { url: 'https://weidian.com/item.html?itemID=1', item_id: '1', platform: 'weidian' };
  assert.equal(buildAgentLink('https://a.com/p?url={url}&code=X', item),
    'https://a.com/p?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D1&code=X');
  assert.equal(buildAgentLink('https://a.com/{platform}/{id}?c=X', item), 'https://a.com/weidian/1?c=X');
  assert.ok(isValidTemplate('https://a.com/p?url={url}'));
  assert.ok(!isValidTemplate('http://a.com/p?url={url}'));
  assert.ok(!isValidTemplate('https://a.com/p'));
});
