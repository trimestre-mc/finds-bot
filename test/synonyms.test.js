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

test('fautes de frappe, singulier, numéros collés, recherche élargie', async () => {
  const { expandQuery, relevance, relaxQuery } = await import('../src/synonyms.js');
  const first = (q) => expandQuery(q).map((g) => g.alt[0]);
  assert.deepEqual(first('suprem tee'), ['supreme', 'tee']);
  assert.deepEqual(first('jordna 4'), ['jordan', '4']);
  assert.deepEqual(first('stone isand'), ['stone island']);
  assert.deepEqual(first('chaussette nike'), ['socks', 'nike']);
  assert.deepEqual(first('survêtement'), ['tracksuit']);
  assert.deepEqual(first('nb550'), ['new balance', '550']);
  const aj4 = expandQuery('jordan 4');
  assert.ok(relevance(aj4, { title_en: 'AJ4 White Oreo' }) > 0);
  assert.ok(relevance(aj4, { title_en: 'Air Jordan 4 Retro' }) > 0);
  assert.equal(relevance(aj4, { title_en: 'Air Jordan 1 Low' }), 0);
  assert.ok(relevance(expandQuery('new balance 550'), { title_en: 'NB550 white green' }) > 0);
  assert.equal(relevance(expandQuery('lv bag'), { title_zh: '2025蔻家新款老花腋下包' }), 0);
  assert.deepEqual(relaxQuery(expandQuery('nike hoodie rouge')).map((g) => g.alt[0]), ['nike', 'hoodie']);
});

test('autocomplétion de /find : modèles connus, marque + type, surnoms', async () => {
  const { suggestQueries } = await import('../src/synonyms.js');
  assert.ok(suggestQueries('nik').includes('nike tech fleece'));
  assert.ok(suggestQueries('nike h').includes('nike hoodie'));
  assert.ok(suggestQueries('lv').includes('louis vuitton bag') || suggestQueries('lv').includes('louis vuitton'));
  assert.ok(suggestQueries('').length > 0 && suggestQueries('x'.repeat(5)).includes('xxxxx'));
  assert.ok(suggestQueries('a').length <= 25);
});
