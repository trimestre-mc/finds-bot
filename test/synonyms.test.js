import test from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery, relevance } from '../src/synonyms.js';

const item = (title_en, title_zh = '', category = null) => ({ title_en, title_zh, category });

test('« supreme tee » : Supreme/SUP + tee/T恤/短袖, en mots entiers', () => {
  const g = expandQuery('supreme tee');
  assert.equal(g.length, 2);
  assert.ok(relevance(g, item(null, 'SUP 25ss 字母短袖')) > 0);
  assert.ok(relevance(g, item('Supreme Box Logo Tee')) > 0);
  assert.ok(relevance(g, item('Supreme Hoodie', '', 'tees')) > 0, 'item classé t-shirt');
  assert.equal(relevance(g, item('Super Steel Tee')), 0, '« super » n\'est pas « sup »');
  assert.equal(relevance(g, item('Supreme Steel Bottle')), 0, '« steel » n\'est pas « tee »');
  assert.ok(relevance(g, item('Supreme Box Logo Tee')) > relevance(g, item(null, 'SUP 短袖')), 'titre anglais d\'abord');
});

test('« nike tech » et expressions de deux mots', () => {
  const g = expandQuery('nike tech');
  assert.ok(relevance(g, item('Nike Tech Fleece Hoodie')) > 0);
  assert.ok(relevance(g, item(null, '耐克科技羊毛卫衣')) > 0);
  assert.equal(relevance(g, item('Nike Dunk Low')), 0);
  assert.equal(expandQuery('chrome hearts hoodie').length, 2);
  assert.ok(relevance(expandQuery('chrome hearts jeans'), item(null, '克罗心十字架牛仔裤')) > 0);
  assert.ok(relevance(expandQuery('pull noir'), item(null, '黑色毛衣')) > 0, 'mots français');
});
