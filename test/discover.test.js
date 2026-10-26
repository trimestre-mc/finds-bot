import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWeidian, messageText } from '../src/discover.js';

test('extraction des liens Weidian, y compris dans les liens d\'agents', () => {
  const text = [
    'W2C https://weidian.com/item.html?itemID=7863670229&spider_token=abc',
    'https://www.kakobuy.com/item/details?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7805904567&affcode=x',
    'https://www.bbdbuy.com/goods/WEIDIAN/7874663131?inviteCode=X',
    'https://cnfans.com/product?id=7111111111&platform=WEIDIAN&ref=1',
    'https://www.lovegobuy.com/product?id=7222222222&shop_type=weidian&invite_code=X',
    'https://www.oopbuy.com/product/weidian/7303204804',
    'shop: https://weidian.com/?userid=1784277725 et https://shop1840259863.v.weidian.com/?userid=1840259863',
    'https://item.taobao.com/item.htm?id=730344766230',
  ].join('\n');
  const f = extractWeidian(text);
  assert.deepEqual([...f.items].sort(), ['7111111111', '7222222222', '7303204804', '7805904567', '7863670229', '7874663131']);
  assert.deepEqual([...f.shops].sort(), ['1784277725', '1840259863']);
  assert.equal(f.others, 1);
});

test('texte d\'un message : contenu, embeds et boutons', () => {
  const m = {
    content: 'regardez ça',
    embeds: [{ url: 'https://weidian.com/item.html?itemID=7000000001' }],
    components: [{ type: 17, components: [{ type: 1, components: [{ type: 2, style: 5, url: 'https://www.bbdbuy.com/goods/WEIDIAN/7000000002' }] }] }],
  };
  assert.deepEqual([...extractWeidian(messageText(m)).items].sort(), ['7000000001', '7000000002']);
});
