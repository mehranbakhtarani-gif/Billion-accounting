import test from 'node:test';
import assert from 'node:assert/strict';
import { code39Svg, normalizeCode39 } from '../src/lib/barcode.ts';

test('Code 39 normalizes supported SKU characters and creates a scannable SVG structure', () => {
  assert.equal(normalizeCode39(' yrn-dty-300 '), 'YRN-DTY-300');
  const svg = code39Svg('YRN-DTY-300');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /aria-label="Code 39 YRN-DTY-300"/);
  assert.match(svg, /<rect /);
  assert.match(svg, /viewBox="0 0 \d+ 56"/);
});

test('Code 39 rejects unsupported, empty and oversized values', () => {
  assert.throws(() => normalizeCode39(''), /بارکد باید/);
  assert.throws(() => normalizeCode39('SKU/فارسی'), /بارکد باید/);
  assert.throws(() => normalizeCode39('A'.repeat(65)), /بارکد باید/);
  assert.throws(() => normalizeCode39('*ABC*'), /بارکد باید/);
});
