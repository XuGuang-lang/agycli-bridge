import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeContent, buildPrompt, OutputSanitizer, StopWatcher } from '../src/messages.js';

const cfg = {
  systemPreamble: 'PREAMBLE',
  transcriptHeader: '',
  instruction: '',
  stripLeadingLabel: true,
  roleLabels: { user: 'Human', assistant: 'Assistant', system: 'System' },
};

// ------------------------------------------------------------ normalizeContent

test('normalizeContent passes strings through', () => {
  assert.equal(normalizeContent('hello'), 'hello');
});

test('normalizeContent joins text blocks', () => {
  assert.equal(
    normalizeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\nb'
  );
});

test('normalizeContent drops non-text blocks', () => {
  const blocks = [
    { type: 'text', text: 'keep' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
  ];
  assert.equal(normalizeContent(blocks), 'keep');
});

test('normalizeContent handles null and undefined', () => {
  assert.equal(normalizeContent(null), '');
  assert.equal(normalizeContent(undefined), '');
});

// ----------------------------------------------------------------- buildPrompt

test('buildPrompt puts the preamble ahead of the client system prompt', () => {
  const { prompt } = buildPrompt([
    { role: 'system', content: 'You are Alice.' },
    { role: 'user', content: 'hi' },
  ], cfg);

  assert.ok(prompt.indexOf('PREAMBLE') < prompt.indexOf('You are Alice.'));
});

test('buildPrompt preserves the full system prompt', () => {
  const card = 'Alice is a botanist who speaks in short sentences.';
  const { prompt, systemText } = buildPrompt([
    { role: 'system', content: card },
    { role: 'user', content: 'hi' },
  ], cfg);

  assert.equal(systemText, card);
  assert.ok(prompt.includes(card));
});

test('buildPrompt merges consecutive leading system messages', () => {
  const { systemText } = buildPrompt([
    { role: 'system', content: 'first' },
    { role: 'system', content: 'second' },
    { role: 'user', content: 'hi' },
  ], cfg);

  assert.equal(systemText, 'first\n\nsecond');
});

test('buildPrompt labels turns and keeps mid-conversation system messages inline', () => {
  const { prompt, turns } = buildPrompt([
    { role: 'system', content: 'card' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'system', content: '[OOC: be brief]' },
    { role: 'user', content: 'and now?' },
  ], cfg);

  assert.equal(turns, 4);
  assert.ok(prompt.includes('Human: hello'));
  assert.ok(prompt.includes('Assistant: hi there'));
  assert.ok(prompt.includes('System: [OOC: be brief]'));
});

test('buildPrompt ends with the assistant cue', () => {
  const { prompt } = buildPrompt([{ role: 'user', content: 'hi' }], cfg);
  assert.ok(prompt.endsWith('Assistant:'));
});

test('buildPrompt skips empty messages', () => {
  const { turns } = buildPrompt([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '   ' },
  ], cfg);
  assert.equal(turns, 1);
});

// ------------------------------------------------------------ OutputSanitizer

test('OutputSanitizer strips a leading Assistant label', () => {
  const s = new OutputSanitizer(cfg);
  const out = s.push('Assistant: hello there') + s.flush();
  assert.equal(out, 'hello there');
});

test('OutputSanitizer strips a label split across chunks', () => {
  const s = new OutputSanitizer(cfg);
  let out = '';
  for (const chunk of ['Assis', 'tant', ': ', 'hi']) out += s.push(chunk);
  out += s.flush();
  assert.equal(out, 'hi');
});

test('OutputSanitizer leaves unlabelled text intact', () => {
  const s = new OutputSanitizer(cfg);
  const out = s.push('Once upon a time') + s.flush();
  assert.equal(out, 'Once upon a time');
});

test('OutputSanitizer does not strip a label in the middle of the reply', () => {
  const s = new OutputSanitizer(cfg);
  const out = s.push('She said Assistant: no') + s.flush();
  assert.equal(out, 'She said Assistant: no');
});

test('OutputSanitizer becomes a pass-through once resolved', () => {
  const s = new OutputSanitizer(cfg);
  s.push('Assistant: a');
  assert.equal(s.push('Assistant: b'), 'Assistant: b');
});

test('OutputSanitizer can be disabled', () => {
  const s = new OutputSanitizer({ ...cfg, stripLeadingLabel: false });
  assert.equal(s.push('Assistant: hi'), 'Assistant: hi');
});

// ---------------------------------------------------------------- StopWatcher

test('StopWatcher is inert with no stop sequences', () => {
  const w = new StopWatcher([]);
  assert.equal(w.active, false);
  assert.deepEqual(w.push('anything'), { text: 'anything', stop: false });
});

test('StopWatcher truncates at a stop sequence', () => {
  const w = new StopWatcher(['\nHuman:']);
  const r = w.push('a reply\nHuman: next turn');
  assert.equal(r.text, 'a reply');
  assert.equal(r.stop, true);
});

test('StopWatcher holds back a partial match until resolved', () => {
  const w = new StopWatcher(['\nHuman:']);
  const first = w.push('hello\nHum');
  assert.equal(first.text, 'hello');   // "\nHum" held back
  assert.equal(first.stop, false);

  const second = w.push('an: more');
  assert.equal(second.stop, true);
  assert.equal(second.text, '');
});

test('StopWatcher releases a held partial that turns out not to match', () => {
  const w = new StopWatcher(['\nHuman:']);
  w.push('hello\nHum');
  const out = w.push('ble bee');
  assert.equal(out.stop, false);
  assert.equal(out.text + w.flush(), '\nHumble bee');
});

test('StopWatcher honours the earliest of several stop sequences', () => {
  const w = new StopWatcher(['END', 'STOP']);
  const r = w.push('text STOP then END');
  assert.equal(r.text, 'text ');
  assert.equal(r.stop, true);
});

test('StopWatcher emits nothing after a stop was hit', () => {
  const w = new StopWatcher(['END']);
  w.push('a END b');
  assert.deepEqual(w.push('more'), { text: '', stop: true });
  assert.equal(w.flush(), '');
});

test('StopWatcher accepts a bare string stop sequence', () => {
  const w = new StopWatcher('END');
  assert.equal(w.active, true);
  assert.equal(w.push('a END b').text, 'a ');
});
