import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff } from '../server/services/diffEngine.js';

test('DiffEngine: identical files have no differences', () => {
  const text = 'config interface "lan"\n\toption ipaddr "192.168.1.1"\n';
  const result = computeDiff(text, text);
  assert.equal(result.hasDifferences, false);
  assert.equal(result.hunks.length, 0);
});

test('DiffEngine: detects additions, deletions, and context hunks', () => {
  const textA = `
config interface 'lan'
\toption ipaddr '192.168.1.1'
\toption netmask '255.255.255.0'
`.trim();

  const textB = `
config interface 'lan'
\toption ipaddr '192.168.1.254'
\toption ip6assign '60'
\toption netmask '255.255.255.0'
`.trim();

  const result = computeDiff(textA, textB);
  assert.equal(result.hasDifferences, true);
  assert.ok(result.hunks.length > 0);

  const hunk = result.hunks[0];
  assert.ok(hunk.lines.some((l) => l.type === 'delete' && l.text.includes('192.168.1.1')));
  assert.ok(hunk.lines.some((l) => l.type === 'add' && l.text.includes('192.168.1.254')));
  assert.ok(hunk.lines.some((l) => l.type === 'add' && l.text.includes("ip6assign '60'")));
  assert.ok(hunk.lines.some((l) => l.type === 'context' && l.text.includes("config interface 'lan'")));
});
