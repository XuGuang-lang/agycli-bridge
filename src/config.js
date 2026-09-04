import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  // --- server ---
  host: '127.0.0.1',
  port: 5599,
  apiKey: '',

  // --- agy CLI ---
  agyPath: 'agy',
  model: 'claude-sonnet-4-6',
  effort: '',
  agent: '',
  workdir: '',
  disableSlashCommands: true,
  extraArgs: [],

  // --- limits ---
  maxConcurrent: 2,
  timeout: 600,
  retries: 1,

  // --- prompt shaping ---
  // Framed as a task description, not an identity override. Telling the model
  // to "ignore your identity" reads as a jailbreak and makes Claude refuse and
  // announce itself as Antigravity; describing the task instead works cleanly.
  systemPreamble:
    'This session is a creative-writing and roleplay task rather than a coding task. ' +
    'No tools, files, or terminal are involved; the reply is prose only. ' +
    'Write in the voice and persona described below, and output only the in-character ' +
    'response — no preface, no meta-commentary, no notes about these instructions.',
  transcriptHeader: '',
  instruction: '',
  roleLabels: {
    user: 'Human',
    assistant: 'Assistant',
    system: 'System',
  },
  stripLeadingLabel: true,

  // --- logging ---
  debug: false,
  logPrompts: false,
};

const BOOL_RE = /^(1|true|yes|on)$/i;

function coerce(defaultValue, raw) {
  if (typeof defaultValue === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  }
  if (typeof defaultValue === 'boolean') return BOOL_RE.test(raw);
  if (Array.isArray(defaultValue)) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

/** Apply BRIDGE_* environment overrides on top of `cfg`, in place. */
function applyEnv(cfg) {
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'roleLabels') continue;
    const envKey = 'BRIDGE_' + key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
    const raw = process.env[envKey];
    if (raw === undefined || raw === '') continue;
    cfg[key] = coerce(DEFAULTS[key], raw);
  }
  return cfg;
}

/** Strip `//` line comments so config.json can be annotated. */
function stripComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

export function loadConfig(configPath = path.join(ROOT, 'config.json')) {
  let fileCfg = {};
  if (existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(stripComments(readFileSync(configPath, 'utf8')));
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${err.message}`);
    }
  }

  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    roleLabels: { ...DEFAULTS.roleLabels, ...(fileCfg.roleLabels || {}) },
  };
  applyEnv(cfg);

  if (cfg.effort && !['low', 'medium', 'high'].includes(cfg.effort)) {
    throw new Error(`config.effort must be low|medium|high, got "${cfg.effort}"`);
  }
  if (!(cfg.maxConcurrent >= 1)) cfg.maxConcurrent = 1;

  // agy inherits the cwd as its workspace; keep it off the user's real projects.
  cfg.workdir = cfg.workdir ? path.resolve(cfg.workdir) : path.join(ROOT, '.workdir');
  mkdirSync(cfg.workdir, { recursive: true });

  return cfg;
}
