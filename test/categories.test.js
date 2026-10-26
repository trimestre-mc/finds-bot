import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCategory, forumTagFor } from '../src/categories.js';

test('catégories détectées depuis de vrais titres', () => {
  const cases = {
    'Margiel GATS German Training Shoes': 'shoes',
    'Jordan 4 Retro Black Cat': 'shoes',
    'Aspen Sweatshirt': 'hoodies',
    'Jiang Zhi Exclusive-Mi*u26FW Grey Half-Zip Turtleneck Sweater': 'hoodies',
    'Cotton Tee': 'tees',
    'Balenciaga Plaid Long Sleeve Polo': 'tees',
    'Chanel Sunglasses': 'accessories',
    'Saturn Bracelet': 'jewelry',
    'Confetti Ring': 'jewelry',
    'Bal Short Shorts': 'pants',
    'AM Jeans AM002-AM029': 'pants',
    'Canada Goose Down Jacket': 'jackets',
    'Goyard Tote Bag': 'bags',
    '新款时尚百搭潮鞋-040': 'shoes',
    'Jellycat Barcelona Bear': 'other',
  };
  for (const [title, cat] of Object.entries(cases)) assert.equal(detectCategory(title), cat, title);
});

test('tag de forum correspondant', () => {
  const tags = [{ id: '1', name: '👟 Sneakers' }, { id: '2', name: 'Shoes' }, { id: '3', name: 'Hoodies' }, { id: '4', name: 'Bijoux' }];
  assert.equal(forumTagFor(tags, 'shoes'), '2');
  assert.equal(forumTagFor(tags, 'hoodies'), '3');
  assert.equal(forumTagFor(tags, 'jewelry'), '4');
  assert.equal(forumTagFor(tags, 'bags'), null);
});
