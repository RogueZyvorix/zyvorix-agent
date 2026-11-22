import express, { Request, Response, NextFunction } from 'express';
import { Client, GatewayIntentBits, Partials, Message, ChannelType, Events } from 'discord.js';
import OpenAI from 'openai';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// ============================================================
// 1. KONSTANTA & TIPE
// ============================================================
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MASK = '••••••••';
const MAX_TOOL_ITER = 5;
const MAX_HISTORY = 30;

const DEFAULT_PROMPT =
  'Kamu adalah Zyvorix, asisten AI ringkas di server. Jawab singkat dan jelas dalam Bahasa Indonesia kecuali diminta lain. ' +
  'Gunakan tool hanya jika benar-benar dibutuhkan. Untuk run_shell pakai perintah aman dan non-interaktif. ' +
  'Jika ada gambar, deskripsikan isinya dengan singkat.';

interface Config {
  discordToken: string;
  allowedUserIds: string[];
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  toolsEnabled: boolean;
  dashboardPassword: string;
}

const DEFAULTS: Config = {
  discordToken: '',
  allowedUserIds: [],
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '',
  model: 'zyvorix-combo',
  systemPrompt: DEFAULT_PROMPT,
  toolsEnabled: true,
  dashboardPassword: 'admin',
};

// ============================================================
// 2. LOGGER (ring buffer + SSE broadcast)
// ============================================================
interface LogEntry { time: string; type: string; msg: string; }
const logBuffer: LogEntry[] = [];
const sseClients = new Set<Response>();

function log(type: string, msg: string) {
  const entry: LogEntry = { time: new Date().toLocaleTimeString('id-ID'), type, msg };
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) res.write(line);
  console.log(`[${entry.time}] [${type}] ${msg}`);
}

const clip = (s: string, n = 1500) =>
  s.length > n ? s.slice(0, n) + `\n...[terpotong ${s.length - n} karakter]` : s;
const ramMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

// ============================================================
// 3. KONFIG (data/config.json)
// ============================================================
function saveConfig(c: Config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

function loadConfig(): Config {
  try {
    if (!fs.existsSync(CONFIG_FILE)) saveConfig({ ...DEFAULTS });
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (e) {
    log('error', `Gagal membaca config: ${(e as Error).message}. Memakai default.`);
    return { ...DEFAULTS };
  }
}

let cfg: Config = loadConfig();

// ============================================================
// 4. OPENAI CLIENT (9Router / OpenAI-compatible)
// ============================================================
function makeClient(): OpenAI {
  return new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey || 'not-needed' });
}
let openai: OpenAI = makeClient();

// ============================================================
// 5. TOOLS
// ============================================================
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Jalankan perintah shell di OS server. Timeout 15 detik.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Perintah yang dijalankan' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Baca isi file teks.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path file' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Tulis atau timpa file teks.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file' },
          content: { type: 'string', description: 'Isi file' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

function runShell(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err && (err as any).killed) return resolve(clip(`Timeout (15 detik). ${out}`));
      resolve(clip(out || (err ? `Exit error: ${err.message}` : '(tanpa output)')));
    });
  });
}

async function execTool(name: string, argsRaw: string): Promise<string> {
  let args: any;
  try {
    args = JSON.parse(argsRaw || '{}');
  } catch {
    return 'Error: argumen tool bukan JSON valid.';
  }
  try {
    switch (name) {
      case 'run_shell': {
        const command = String(args.command ?? '');
        log('tool', `run_shell: ${command}`);
        const result = await runShell(command);
        log('tool', `hasil: ${clip(result, 200)}`);
        return result;
      }
      case 'read_file': {
        const p = String(args.path ?? '');
        log('tool', `read_file: ${p}`);
        return clip(fs.readFileSync(p, 'utf8'));
      }
      case 'write_file': {
        const p = String(args.path ?? '');
        const content = String(args.content ?? '');
        log('tool', `write_file: ${p} (${content.length} char)`);
        fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
        fs.writeFileSync(p, content);
        return `OK, ${content.length} karakter ditulis ke ${p}`;
      }
      default:
        return `Error: tool "${name}" tidak dikenal.`;
    }
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// ============================================================
// 6. AGENT LOOP (history per key, max 5 iterasi tool)
// ============================================================
const histories = new Map<string, OpenAI.ChatCompletionMessageParam[]>();

function trimHistory(h: OpenAI.ChatCompletionMessageParam[]) {
  while (h.length > MAX_HISTORY) h.shift();
  while (h.length && h[0].role !== 'user') h.shift(); // jaga urutan tool_call agar valid
}

async function runAgent(key: string, text: string, images: string[] = []): Promise<string> {
  const h = histories.get(key) ?? [];
  histories.set(key, h);

  const userContent: any = images.length
    ? [
        { type: 'text', text: text || 'Deskripsikan gambar ini.' },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : text;
  h.push({ role: 'user', content: userContent });

  // Saat ada gambar, kirim tanpa parameter tools (kompatibilitas model kecil)
  const useTools = cfg.toolsEnabled && images.length === 0;

  for (let i = 0; i < MAX_TOOL_ITER; i++) {
    const res = await openai.chat.completions.create({
      model: cfg.model,
      max_tokens: 1024,
      messages: [{ role: 'system', content: cfg.systemPrompt || DEFAULT_PROMPT }, ...h],
      ...(useTools ? { tools, tool_choice: 'auto' as const } : {}),
    });

    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('Respons kosong dari model');
    h.push(msg as OpenAI.ChatCompletionMessageParam);

    if (!msg.tool_calls?.length) {
      trimHistory(h);
      return msg.content?.trim() || '(kosong)';
    }

    for (const tc of msg.tool_calls) {
      const result =
        tc.type === 'function'
          ? await execTool(tc.function.name, tc.function.arguments)
          : 'Error: tipe tool tidak didukung.';
      h.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  trimHistory(h);
  return `⚠️ Batas ${MAX_TOOL_ITER} iterasi tool tercapai. Coba ulangi dengan permintaan yang lebih sederhana.`;
}

// ============================================================
// 7. DISCORD BOT
// ============================================================
let discord: Client | null = null;
let botOnline = false;
let botTag = '';

function splitText(s: string, size = 1900): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

async function onMessage(msg: Message) {
  try {
    if (msg.author.bot || !discord?.user) return;

    const isDM = msg.channel.type === ChannelType.DM;
    const isMention = msg.mentions.has(discord.user.id);
    if (!isDM && !isMention) return;

    if (!cfg.allowedUserIds.includes(msg.author.id)) {
      log('bot', `Ditolak: ${msg.author.tag} (${msg.author.id})`);
      return;
    }

    const text = msg.content.replace(new RegExp(`<@!?${discord.user.id}>`, 'g'), '').trim();
    const key = `dc:${msg.channel.id}`;

    if (text === '!clear') {
      histories.delete(key);
      log('discord', `History ${key} dihapus`);
      await msg.reply('🧹 History percakapan dihapus.');
      return;
    }
    if (text === '!status') {
      await msg.reply(
        `✅ Online\nModel: \`${cfg.model}\`\nTools: ${cfg.toolsEnabled ? 'ON' : 'OFF'}\nRAM: ${ramMB()} MB`
      );
      return;
    }

    const images = msg.attachments
      .filter((a) => a.contentType?.startsWith('image/'))
      .map((a) => a.url);
    if (!text && images.length === 0) return;

    log('discord', `${msg.author.tag}: ${clip(text || '[gambar]', 200)}`);
    if ('sendTyping' in msg.channel) await msg.channel.sendTyping();

    const reply = await runAgent(key, text, images);
    log('bot', `→ ${clip(reply, 200)}`);
    for (const part of splitText(reply)) await msg.reply(part);
  } catch (e) {
    const m = (e as Error).message;
    log('error', `Discord: ${m}`);
    await msg.reply(`⚠️ Error: ${clip(m, 300)}`).catch(() => {});
  }
}

async function stopBot() {
  if (!discord) return;
  const c = discord;
  discord = null;
  botOnline = false;
  botTag = '';
  c.destroy();
  log('bot', 'Bot dihentikan');
}

async function startBot() {
  await stopBot();
  if (!cfg.discordToken) throw new Error('Discord token belum diisi di konfigurasi');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    botOnline = true;
    botTag = c.user.tag;
    log('bot', `Online sebagai ${botTag}`);
  });
  client.on(Events.MessageCreate, onMessage);
  client.on(Events.Error, (e) => log('error', `Discord client: ${e.message}`));

  discord = client;
  try {
    await client.login(cfg.discordToken);
  } catch (e) {
    discord = null;
    botOnline = false;
    throw e;
  }
}

// ============================================================
// 8. EXPRESS + AUTH
// ============================================================
const sessions = new Set<string>();

function auth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const token = bearer || String(req.query.token ?? '');
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.post('/api/login', (req, res) => {
  if (String(req.body?.password ?? '') !== cfg.dashboardPassword) {
    log('auth', 'Login gagal');
    return res.status(401).json({ error: 'Password salah' });
  }
  const token = randomUUID();
  sessions.add(token);
  log('auth', 'Login berhasil');
  res.json({ token });
});

app.get('/api/status', auth, (_req, res) => {
  res.json({
    botOnline,
    botTag,
    ramMB: ramMB(),
    uptime: Math.floor(process.uptime()),
    model: cfg.model,
  });
});

app.post('/api/bot/:action', auth, async (req, res) => {
  const action = req.params.action;
  try {
    if (action === 'start') await startBot();
    else if (action === 'stop') await stopBot();
    else if (action === 'restart') {
      await stopBot();
      await startBot();
    } else {
      return res.status(400).json({ error: 'Aksi tidak valid' });
    }
    res.json({ ok: true, botOnline });
  } catch (e) {
    botOnline = false;
    log('error', `Bot ${action} gagal: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/config', auth, (_req, res) => {
  res.json({
    ...cfg,
    discordToken: cfg.discordToken ? MASK : '',
    apiKey: cfg.apiKey ? MASK : '',
    dashboardPassword: MASK,
  });
});

app.put('/api/config', auth, (req, res) => {
  const b: any = req.body ?? {};
  const next: Config = { ...cfg };

  const strKeys = ['discordToken', 'baseUrl', 'apiKey', 'model', 'systemPrompt', 'dashboardPassword'] as const;
  for (const k of strKeys) {
    if (typeof b[k] === 'string' && b[k] !== MASK) (next as any)[k] = b[k].trim();
  }
  if (b.allowedUserIds !== undefined) {
    const ids = Array.isArray(b.allowedUserIds) ? b.allowedUserIds : String(b.allowedUserIds).split(',');
    next.allowedUserIds = ids.map((s: unknown) => String(s).trim()).filter(Boolean);
  }
  if (typeof b.toolsEnabled === 'boolean') next.toolsEnabled = b.toolsEnabled;
  if (!next.baseUrl) next.baseUrl = DEFAULTS.baseUrl;
  if (!next.model) next.model = DEFAULTS.model;
  if (!next.systemPrompt) next.systemPrompt = DEFAULT_PROMPT;
  if (!next.dashboardPassword) next.dashboardPassword = DEFAULTS.dashboardPassword;

  const tokenChanged = next.discordToken !== cfg.discordToken;
  saveConfig(next);
  cfg = next;
  openai = makeClient();
  log('config', 'Konfigurasi disimpan & diterapkan');

  if (tokenChanged && discord) {
    startBot().catch((e) => log('error', `Restart bot gagal: ${(e as Error).message}`));
  }
  res.json({ ok: true });
});

app.get('/api/logs/stream', auth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  for (const e of logBuffer) res.write(`data: ${JSON.stringify(e)}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.post('/api/chat', auth, async (req, res) => {
  const text = String(req.body?.message ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Pesan kosong' });
  try {
    log('web', `Dashboard: ${clip(text, 200)}`);
    const reply = await runAgent('web', text);
    log('web', `→ ${clip(reply, 200)}`);
    res.json({ reply });
  } catch (e) {
    log('error', `Web chat: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post('/api/chat/clear', auth, (_req, res) => {
  histories.delete('web');
  log('web', 'History chat web dihapus');
  res.json({ ok: true });
});

// ============================================================
// 9. BOOT
// ============================================================
process.on('unhandledRejection', (e) => log('error', `Unhandled: ${(e as Error)?.message ?? e}`));

process.on('SIGINT', async () => {
  log('system', 'Mematikan agent...');
  await stopBot();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  log('system', `Dashboard aktif di http://0.0.0.0:${PORT}`);
  if (cfg.discordToken) {
    startBot().catch((e) => log('error', `Bot gagal start: ${(e as Error).message}`));
  } else {
    log('system', 'Discord token belum diisi. Isi lewat dashboard.');
  }
});
