import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';

/**
 * Resolve the agy binary. Returns the command to spawn plus whether it needs a
 * shell (Windows .cmd/.bat wrappers cannot be spawned directly on modern Node).
 *
 * @returns {{command: string, shell: boolean}}
 */
export function resolveAgy(agyPath) {
  if (agyPath.includes('/') || agyPath.includes('\\')) {
    if (!existsSync(agyPath)) throw new Error(`agy not found at "${agyPath}"`);
    return { command: agyPath, shell: needsShell(agyPath) };
  }

  let found = '';
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [agyPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Prefer a real executable over a .cmd/.bat shim.
    found = candidates.find((c) => path.extname(c).toLowerCase() === '.exe')
      || candidates.find((c) => !needsShell(c))
      || candidates[0]
      || '';
  } catch {
    /* fall through to the not-found error below */
  }

  if (!found) {
    throw new Error(
      `agy not found on PATH (looked for "${agyPath}"). ` +
      `Install the Antigravity CLI or set "agyPath" in config.json.`
    );
  }
  return { command: found, shell: needsShell(found) };
}

function needsShell(file) {
  if (!IS_WIN) return false;
  const ext = path.extname(file).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

export function getVersion(bin) {
  try {
    return execFileSync(bin.command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: bin.shell,
      timeout: 10_000,
    }).trim().split(/\r?\n/)[0];
  } catch {
    return 'unknown';
  }
}

/**
 * Query `agy models`. Returns [{id, name}]; empty array if the call fails.
 */
export function listModels(bin) {
  try {
    const out = execFileSync(bin.command, ['models'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: bin.shell,
      timeout: 30_000,
    });
    const models = [];
    for (const line of out.split(/\r?\n/)) {
      const [id, name] = line.split('\t');
      if (id && id.trim() && !id.includes(' ')) {
        models.push({ id: id.trim(), name: (name || id).trim() });
      }
    }
    return models;
  } catch {
    return [];
  }
}

export function buildArgs({ model, effort, cfg }) {
  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (cfg.agent) args.push('--agent', cfg.agent);
  if (cfg.disableSlashCommands) args.push('--disable-slash-commands');
  args.push('--print-timeout', `${cfg.timeout}s`);
  if (Array.isArray(cfg.extraArgs) && cfg.extraArgs.length) args.push(...cfg.extraArgs);
  return args;
}

const STDERR_CAP = 8000;

// agy runs a network eligibility check on every invocation, which flakes often
// enough under concurrency to matter. These failures happen before any output,
// so retrying is safe and invisible to the client.
const TRANSIENT_RE =
  /eligibility check failed|failed to get profile|stream was interrupted|\bEOF\b|connection reset|i\/o timeout|dial tcp|no such host|temporarily unavailable|too many requests|\b(?:429|500|502|503|504)\b/i;

export function isTransient(message) {
  return TRANSIENT_RE.test(message || '');
}

/**
 * `runOnce` plus bounded retries for transient CLI startup failures.
 * Retries only while nothing has been streamed to the client yet.
 */
export async function run(opts) {
  const attempts = Math.max(1, (opts.cfg.retries ?? 1) + 1);
  let lastErr;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let delivered = false;
    const onDelta = (delta) => {
      delivered = true;
      return opts.onDelta?.(delta);
    };

    try {
      return await runOnce({ ...opts, onDelta });
    } catch (err) {
      lastErr = err;
      const fatal =
        err.code === 'EABORTED' ||
        err.code === 'ETIMEDOUT' ||
        delivered ||
        !isTransient(err.message) ||
        attempt === attempts - 1;
      if (fatal) throw err;

      if (opts.cfg.debug) {
        console.error(`[agy] transient failure (attempt ${attempt + 1}), retrying: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Run one agy turn.
 *
 * The prompt is delivered over stdin as a single `{"event":"user"}` NDJSON line
 * — this sidesteps the ~32K Windows command-line limit and keeps the run to a
 * single turn (agy starts a new turn per input line).
 *
 * @param {object}   opts
 * @param {string}   opts.prompt
 * @param {function} opts.onDelta   called with each text chunk of the reply
 * @param {function} [opts.onEvent] called with every parsed NDJSON event
 * @returns {Promise<{text: string, usage: object, conversationId: string}>}
 */
export function runOnce({ bin, prompt, model, effort, cfg, onDelta, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const args = buildArgs({ model, effort, cfg });

    if (cfg.debug) {
      console.error(`[agy] ${bin.command} ${args.join(' ')}`);
      if (cfg.logPrompts) console.error(`[agy] prompt (${prompt.length} chars):\n${prompt}`);
    }

    const child = spawn(bin.command, args, {
      cwd: cfg.workdir,
      shell: bin.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });

    let text = '';
    let usage = null;
    let conversationId = '';
    let resultError = '';
    let stderr = '';
    let stdoutTail = '';
    let settled = false;
    let killedForStop = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Detached process groups are not used, so a direct kill is enough; on
      // Windows SIGTERM maps to TerminateProcess.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
      }, 2000).unref?.();
    };

    const timer = setTimeout(() => {
      kill();
      finish(reject, Object.assign(
        new Error(`agy timed out after ${cfg.timeout}s`),
        { code: 'ETIMEDOUT' }
      ));
    }, cfg.timeout * 1000);

    const onAbort = () => {
      kill();
      finish(reject, Object.assign(new Error('client disconnected'), { code: 'EABORTED' }));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    /** Caller signals "stop sequence reached" by returning true from onDelta. */
    const handleEvent = (evt) => {
      onEvent?.(evt);

      if (evt.event === 'init') {
        conversationId = evt.conversation_id || conversationId;
        return;
      }

      if (evt.event === 'step_update') {
        const step = evt.step_update || {};
        conversationId = step.conversation_id || conversationId;
        if (step.usage) usage = step.usage;
        // Only the model's prose is part of the API response; tool_use,
        // system_message and friends are internal to the CLI.
        if (step.step_type !== 'agent_response') return;
        const delta = step.text_delta;
        if (!delta) return;
        text += delta;
        if (onDelta?.(delta) === true) {
          killedForStop = true;
          kill();
        }
        return;
      }

      if (evt.event === 'result') {
        const r = evt.result || {};
        conversationId = r.conversation_id || conversationId;
        if (r.usage) usage = r.usage;
        if (r.status && r.status !== 'SUCCESS') {
          resultError = r.error || `agy returned status ${r.status}`;
        }
        // Some models emit the full reply only in `result` (no ACTIVE deltas).
        if (!text && typeof r.response === 'string' && r.response) {
          text = r.response;
          onDelta?.(r.response);
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutTail += chunk;
      let nl;
      while ((nl = stdoutTail.indexOf('\n')) !== -1) {
        const line = stdoutTail.slice(0, nl).trim();
        stdoutTail = stdoutTail.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          if (cfg.debug) console.error('[agy] unparsable line:', line.slice(0, 200));
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += chunk;
      if (cfg.debug) process.stderr.write(`[agy:stderr] ${chunk}`);
    });

    child.on('error', (err) => {
      finish(reject, new Error(`failed to launch agy: ${err.message}`));
    });

    child.on('close', (code) => {
      if (stdoutTail.trim()) {
        try { handleEvent(JSON.parse(stdoutTail.trim())); } catch { /* partial line */ }
      }

      if (killedForStop) {
        return finish(resolve, { text, usage, conversationId, stoppedEarly: true });
      }
      if (resultError) {
        // agy occasionally reports a spurious interruption *after* streaming a
        // complete reply. Keep the text: for a chat client, a good answer beats
        // an error, and injecting the error into the prose would corrupt it.
        if (text) {
          if (cfg.debug) {
            console.error(`[agy] late error ignored (${text.length} chars already sent): ${resultError}`);
          }
          return finish(resolve, { text, usage, conversationId, stoppedEarly: false, lateError: resultError });
        }
        return finish(reject, new Error(resultError));
      }
      if (code !== 0 && !text) {
        const detail = stderr.trim() || `agy exited with code ${code}`;
        return finish(reject, new Error(detail));
      }
      finish(resolve, { text, usage, conversationId, stoppedEarly: false });
    });

    const line = JSON.stringify({
      event: 'user',
      message: { role: 'user', content: prompt },
    });
    child.stdin.on('error', () => { /* closed early; `close` reports the real cause */ });
    child.stdin.write(line + '\n', 'utf8');
    child.stdin.end();
  });
}
