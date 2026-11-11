import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BiliClient, BiliError } from './platform.mjs';
import { collect, parseTimestamps, VERSION } from './pipeline.mjs';
import { doctor } from './media.mjs';

export const HELP = `bili-reach — B 站学习素材工具 v${VERSION}

  doctor [--model 模型路径]
  inspect <BV/av/URL> [--part N]
  collect <BV/av/URL> --output 素材目录 [选项]
  frames <BV/av/URL> --frames 30,90 --output 素材目录

选项：
  --part N                 指定分 P（未指定时使用 URL 中的 p 或第 1 P）
  --asr local|none          无字幕时本地转写，或只取平台字幕；默认 local
  --model 路径              whisper.cpp 模型文件；仅真正转写时需要
  --language zh             转写语种；默认 zh
  --glossary 术语1,术语2    本地 ASR 提示词，不改写平台字幕
  --frames 30,90            按秒截图，最多 12 张；默认不截图
  --refresh                 新建素材版本，旧文件保持原样
  --keep-media              保留本次中间音视频/WAV；默认清理，只留原稿和截图
  --cookie-file 路径        私有 Cookie 文件（纯请求头或 Netscape 格式）
  --config 路径             私有 JSON 配置，命令行选项优先
  --ffmpeg-bin 路径         默认 ffmpeg
  --whisper-bin 路径        默认 whisper-cli
  --help / --version

所有结果输出 JSON；默认不联网下载模型，不使用云转写，不读取浏览器凭据。
`;
const optionNames = { output: 'output', part: 'part', asr: 'asr', model: 'model', language: 'language', glossary: 'glossary', frames: 'frames', 'cookie-file': 'cookieFile', config: 'config', 'ffmpeg-bin': 'ffmpegBin', 'whisper-bin': 'whisperBin' };
const configKeys = new Set(['output', 'asr', 'model', 'language', 'glossary', 'cookieFile', 'ffmpegBin', 'whisperBin', 'keepMedia']);
const bad = (message) => { throw new BiliError('BAD_INPUT', message); };

export function parseArgs(argv) {
  const args = [...argv], positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version') return { version: true };
    if (arg === '--refresh') { options.refresh = true; continue; }
    if (arg === '--keep-media' || arg === '--no-keep-media') { options.keepMedia = arg === '--keep-media'; continue; }
    if (arg.startsWith('--')) {
      const key = optionNames[arg.slice(2)];
      if (!key) bad(`未知选项：${arg}`);
      if (!args[i + 1] || args[i + 1].startsWith('--')) bad(`${arg} 缺少值。`);
      options[key] = args[++i];
    } else positional.push(arg);
  }
  const [action, input, ...extra] = positional;
  if (!['doctor', 'inspect', 'collect', 'frames'].includes(action)) bad('请选择 doctor、inspect、collect 或 frames。');
  if (extra.length || (action === 'doctor' && input)) bad('参数数量不正确；请查看 --help。');
  if (action !== 'doctor' && !input) bad('请提供 BV 号或视频链接。');
  return { action, input, options };
}

export async function readCookieFile(path) {
  if (!path) return '';
  const st = await lstat(resolve(path));
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) bad('Cookie 文件须为小于 1MB 的普通文件。');
  const text = (await readFile(resolve(path), 'utf8')).trim();
  if (text.startsWith('{') || text.startsWith('[')) bad('Cookie 文件只接受纯 Cookie 请求头或 Netscape 格式，不接受浏览器数据库。');
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.split('\t').length >= 7)) {
    return lines.filter((line) => (!line.startsWith('#') || line.startsWith('#HttpOnly_')) && line.includes('\t'))
      .map((line) => line.replace(/^#HttpOnly_/, '').split('\t'))
      .filter((c) => /^(\.)?bilibili\.com$/i.test(c[0]) && /^\w+$/.test(c[5]) && !/[\r\n;]/.test(c[6]) && (!Number(c[4]) || Number(c[4]) > Date.now() / 1000))
      .map((c) => `${c[5]}=${c[6]}`).join('; ');
  }
  if (/[\r\n]/.test(text) || !/^[A-Za-z0-9_]+=[^\r\n]+$/.test(text)) bad('Cookie 文件内容不是有效请求头。');
  return text;
}

export async function loadOptions(parsed) {
  let config = {};
  if (parsed.options.config) {
    const st = await lstat(resolve(parsed.options.config));
    if (!st.isFile() || st.size > 1024 * 1024) bad('配置文件须为小于 1MB 的 JSON 文件。');
    try { config = JSON.parse(await readFile(resolve(parsed.options.config), 'utf8')); }
    catch { bad('配置文件不是有效 JSON。'); }
    if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some((key) => !configKeys.has(key))) bad('配置文件包含未知字段；请参照示例。');
  }
  const options = { ...config, ...parsed.options };
  delete options.config;
  if (options.part !== undefined) {
    options.part = Number(options.part);
    if (!Number.isSafeInteger(options.part) || options.part < 1) bad('--part 必须是正整数。');
  }
  options.asr ??= 'local'; options.language ??= 'zh';
  if (!['local', 'none'].includes(options.asr)) bad('--asr 仅支持 local 或 none。');
  if (!/^[A-Za-z-]{2,20}$/.test(options.language)) bad('转写语种无效。');
  if (typeof options.glossary === 'string') options.glossary = options.glossary.split(',').map((s) => s.trim()).filter(Boolean);
  options.glossary ??= [];
  if (!Array.isArray(options.glossary) || options.glossary.some((s) => typeof s !== 'string')) bad('glossary 须为字符串数组。');
  options.frames = parseTimestamps(options.frames);
  if (parsed.action === 'frames' && !options.frames.length) bad('独立截图请通过 --frames 指定时间点。');
  options.keepMedia ??= false;
  if (typeof options.keepMedia !== 'boolean') bad('keepMedia 须为布尔值。');
  for (const key of ['output', 'model', 'cookieFile', 'ffmpegBin', 'whisperBin']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key].trim())) bad(`${key} 须为非空路径。`);
  }
  return options;
}

export function safeError(error) {
  const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'ERROR';
  const hints = {
    NEED_SETUP: '先运行 doctor；自行准备本地转写模型，不会自动安装。',
    NEED_LOGIN: '请本人准备私有 B 站 Cookie 文件，通过 --cookie-file 指定；不要把凭据贴进聊天。',
    LOGIN_REQUIRED: '请本人准备私有登录态后再试。',
    PLATFORM_BLOCKED: '请到 B 站官方页面处理验证；本次停止，不更换后端绕过。',
    RATE_LIMITED: '等待平台允许后再试；本次停止，不自动重试或改用其他后端。',
    CACHE_OPTIONS_CHANGED: '使用 --refresh 生成新版本，旧素材保持不变。',
  };
  const message = String(error.message ?? '处理失败').replace(/https?:\/\/\S+/g, '[URL]').replace(/(?:SESSDATA|bili_jct|Cookie)\s*[=:]\s*[^\s;]+/gi, '[凭据已隐藏]').slice(0, 500);
  return { ok: false, error: { code, message, ...(hints[code] ? { hint: hints[code] } : {}) } };
}

export async function runCli(argv, { stdout = (s) => process.stdout.write(s), clientFactory = (options) => new BiliClient(options), collector = collect, doctorFn = doctor } = {}) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) { stdout(HELP); return 0; }
    if (parsed.version) { stdout(VERSION + '\n'); return 0; }
    const options = await loadOptions(parsed);
    let result;
    if (parsed.action === 'doctor') result = { ok: true, report: await doctorFn({ ...options, modelPath: options.model }) };
    else {
      const cookie = await readCookieFile(options.cookieFile);
      const client = clientFactory({ cookie });
      if (parsed.action === 'inspect') result = { ok: true, video: await client.inspect(parsed.input, { part: options.part }) };
      else result = await collector(parsed.input, { ...options, client, kind: parsed.action === 'frames' ? 'frames' : 'transcript' });
    }
    stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch (error) { stdout(JSON.stringify(safeError(error), null, 2) + '\n'); return 1; }
}
