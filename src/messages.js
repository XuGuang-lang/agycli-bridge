/**
 * Converts OpenAI-style `messages` into the single flattened prompt that
 * `agy --input-format stream-json` accepts, and post-processes the reply.
 *
 * agy only accepts `{"event":"user"}` input lines, and each line runs its own
 * turn, so the whole conversation is rendered as one transcript inside one
 * user message.
 */

/** Flatten string | content-block[] into plain text. */
export function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);

  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      // OpenAI: {type:'text', text}; Anthropic: {type:'text', text}
      if (typeof block.text === 'string') parts.push(block.text);
      // Images are unsupported by agy's stream input (text blocks only).
    }
  }
  return parts.join('\n');
}

/**
 * Build the prompt sent to agy.
 *
 * Leading system messages become a preamble block; system messages appearing
 * mid-conversation stay inline as labelled turns.
 *
 * @returns {{prompt: string, systemText: string, turns: number}}
 */
export function buildPrompt(messages, cfg) {
  const labels = cfg.roleLabels;
  const list = Array.isArray(messages) ? messages : [];

  const leadingSystem = [];
  let i = 0;
  for (; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== 'system') break;
    const text = normalizeContent(m.content).trim();
    if (text) leadingSystem.push(text);
  }

  const lines = [];
  for (; i < list.length; i++) {
    const m = list[i];
    if (!m) continue;
    const text = normalizeContent(m.content).trim();
    if (!text) continue;

    const label =
      m.role === 'assistant' ? labels.assistant
      : m.role === 'system' ? labels.system
      : labels.user;
    lines.push(`${label}: ${text}`);
  }

  const systemText = leadingSystem.join('\n\n');

  const sections = [];
  // The preamble goes first so it outranks the character card that follows.
  if (cfg.systemPreamble) sections.push(cfg.systemPreamble.trim());
  if (systemText) sections.push(systemText);
  if (cfg.transcriptHeader) sections.push(cfg.transcriptHeader.trim());
  if (lines.length) sections.push(lines.join('\n\n'));
  if (cfg.instruction) sections.push(cfg.instruction.trim());
  // Cue the model to continue as the assistant rather than echo the transcript.
  sections.push(`${labels.assistant}:`);

  return {
    prompt: sections.join('\n\n'),
    systemText,
    turns: lines.length,
  };
}

/**
 * Strips a leading role label ("Assistant:") that the model sometimes echoes.
 * Only inspects the head of the stream; becomes a pass-through once resolved.
 */
export class OutputSanitizer {
  constructor(cfg) {
    this.enabled = cfg.stripLeadingLabel !== false;
    this.labels = Object.values(cfg.roleLabels);
    this.done = !this.enabled;
    this.buffer = '';
  }

  /** @returns {string} text safe to emit now */
  push(chunk) {
    if (this.done) return chunk;

    this.buffer += chunk;
    // A label can only be as long as the longest label plus ": ".
    const maxLabel = Math.max(...this.labels.map((l) => l.length)) + 2;

    const trimmed = this.buffer.replace(/^[\s\n]*/, '');
    for (const label of this.labels) {
      const prefix = label + ':';
      if (trimmed.length < prefix.length) {
        // Could still grow into a label — keep holding.
        if (prefix.toLowerCase().startsWith(trimmed.toLowerCase())) return '';
        continue;
      }
      if (trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
        this.done = true;
        const out = trimmed.slice(prefix.length).replace(/^[ \t]*/, '');
        this.buffer = '';
        return out;
      }
    }

    // No label matched and we have enough text to be sure.
    if (trimmed.length >= maxLabel || /[\n]/.test(this.buffer)) {
      this.done = true;
      const out = this.buffer;
      this.buffer = '';
      return out;
    }
    return '';
  }

  /** Flush anything still held back. */
  flush() {
    const out = this.buffer;
    this.buffer = '';
    this.done = true;
    return out;
  }
}

/**
 * Detects stop sequences in a stream, holding back any tail that could still
 * grow into a match so partial stop text is never emitted to the client.
 */
export class StopWatcher {
  constructor(stops) {
    this.stops = (Array.isArray(stops) ? stops : stops ? [stops] : [])
      .filter((s) => typeof s === 'string' && s.length > 0);
    this.buffer = '';
    this.hit = false;
    this.maxLen = this.stops.reduce((m, s) => Math.max(m, s.length), 0);
  }

  get active() {
    return this.stops.length > 0;
  }

  /**
   * @returns {{text: string, stop: boolean}} text to emit, and whether a stop
   * sequence was reached (caller should end the response).
   */
  push(chunk) {
    if (!this.active || this.hit) {
      return { text: this.hit ? '' : chunk, stop: this.hit };
    }

    this.buffer += chunk;

    let cut = -1;
    for (const s of this.stops) {
      const idx = this.buffer.indexOf(s);
      if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
    }
    if (cut !== -1) {
      this.hit = true;
      const text = this.buffer.slice(0, cut);
      this.buffer = '';
      return { text, stop: true };
    }

    // Hold back the longest suffix that is a prefix of any stop sequence.
    let hold = 0;
    const tailStart = Math.max(0, this.buffer.length - (this.maxLen - 1));
    for (let i = tailStart; i < this.buffer.length; i++) {
      const tail = this.buffer.slice(i);
      if (this.stops.some((s) => s.startsWith(tail))) {
        hold = this.buffer.length - i;
        break;
      }
    }

    const emit = this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = this.buffer.slice(this.buffer.length - hold);
    return { text: emit, stop: false };
  }

  /** Emit whatever is still held back (no stop matched). */
  flush() {
    if (this.hit) return '';
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
}
