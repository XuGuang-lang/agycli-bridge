import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTransient, buildArgs } from '../src/agy.js';

const cfg = {
  agent: '',
  disableSlashCommands: true,
  timeout: 600,
  extraArgs: [],
};

// ------------------------------------------------------------------ buildArgs

test('buildArgs always uses stream-json in both directions', () => {
  const args = buildArgs({ model: 'm', effort: '', cfg });
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('--input-format'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
});

test('buildArgs passes model and effort', () => {
  const args = buildArgs({ model: 'gemini-3.1-pro-high', effort: 'high', cfg });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro-high');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('buildArgs omits effort and agent when unset', () => {
  const args = buildArgs({ model: 'm', effort: '', cfg });
  assert.ok(!args.includes('--effort'));
  assert.ok(!args.includes('--agent'));
});

test('buildArgs includes agent when configured', () => {
  const args = buildArgs({ model: 'm', effort: '', cfg: { ...cfg, agent: 'roleplay' } });
  assert.equal(args[args.indexOf('--agent') + 1], 'roleplay');
});

test('buildArgs forwards the timeout to --print-timeout', () => {
  const args = buildArgs({ model: 'm', effort: '', cfg: { ...cfg, timeout: 90 } });
  assert.equal(args[args.indexOf('--print-timeout') + 1], '90s');
});

test('buildArgs appends extraArgs', () => {
  const args = buildArgs({ model: 'm', effort: '', cfg: { ...cfg, extraArgs: ['--sandbox'] } });
  assert.ok(args.includes('--sandbox'));
});

// ---------------------------------------------------------------- isTransient

test('isTransient matches agy eligibility-check flakes', () => {
  assert.ok(isTransient(
    'Eligibility check failed: failed to get profile picture: ' +
    'Get "https://lh3.googleusercontent.com/a/x": EOF'
  ));
  assert.ok(isTransient('Eligibility check failed: Get "https://www.googleapis.com": EOF'));
});

test('isTransient matches the spurious mid-stream interruption', () => {
  assert.ok(isTransient('The stream was interrupted. Please continue the task you were working on.'));
});

test('isTransient matches network errors', () => {
  assert.ok(isTransient('dial tcp 1.2.3.4:443: connect: connection reset'));
  assert.ok(isTransient('i/o timeout'));
  assert.ok(isTransient('no such host'));
  assert.ok(isTransient('503 Service Unavailable'));
});

test('isTransient rejects real errors that must not be retried', () => {
  assert.ok(!isTransient('stream input content block type "image" is not supported'));
  assert.ok(!isTransient('model "nope" is not available'));
  assert.ok(!isTransient('invalid JSON Schema structure'));
  assert.ok(!isTransient(''));
  assert.ok(!isTransient(undefined));
});
