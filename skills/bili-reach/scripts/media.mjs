import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const OUTPUT_LIMIT = 64 * 1024;
const CDN_SUFFIXES = ['.bilivideo.com', '.bilivideo.cn', '.hdslb.com'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure('INVALID_ARGUMENT', `${label} must be a positive integer.`);
}

/** No shell, bounded output, and deliberately redacted errors. */
export function runProcess(bin, args, { timeoutMs = 300_000, cwd } = {}) {
  positive(timeoutMs, 'timeoutMs');
  if (typeof bin !== 'string' || !bin || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw failure('INVALID_ARGUMENT', 'Invalid process arguments.');
  }
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(failure(error.code === 'ENOENT' ? 'PROCESS_NOT_FOUND' : 'PROCESS_FAILED', 'Unable to start local tool.'));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let killTimer;
    const collect = (current, chunk) => current.length >= OUTPUT_LIMIT ? current : Buffer.concat([current, chunk]).subarray(0, OUTPUT_LIMIT);
    child.stdout.on('data', chunk => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    }, timeoutMs);
    const clear = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.on('error', error => {
      clear();
      reject(failure(error.code === 'ENOENT' ? 'PROCESS_NOT_FOUND' : 'PROCESS_FAILED', 'Local tool is unavailable.'));
    });
    child.on('close', (exitCode, signal) => {
      clear();
      if (timedOut) return reject(failure('PROCESS_TIMEOUT', 'Local tool timed out.'));
      if (exitCode !== 0) {
        const error = failure('PROCESS_FAILED', 'Local tool exited unsuccessfully.');
        error.exitCode = exitCode;
        error.signal = signal;
        return reject(error);
      }
      resolvePromise({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode });
    });
  });
}

async function modelAvailable(modelPath) {
  if (typeof modelPath !== 'string' || !modelPath) return false;
  try {
    if (!(await stat(modelPath)).isFile()) return false;
    await access(modelPath, constants.R_OK);
    return true;
  } catch { return false; }
}

// whisper.cpp supports --help, not --version. A help banner may contain no version.
async function probeTool(bin, kind, runner) {
  try {
    const output = await runner(bin, kind === 'ffmpeg' ? ['-version'] : ['--help'], { timeoutMs: 5000 });
    if (output?.exitCode !== undefined && output.exitCode !== 0) throw failure('PROCESS_FAILED', 'Local tool probe exited unsuccessfully.');
    const lines = `${output?.stdout || ''}\n${output?.stderr || ''}`.split(/\r?\n/).map(line => line.trim());
    const pattern = kind === 'ffmpeg' ? /^ffmpeg version \S+/i : /^whisper(?:\.cpp|-cli)?\s+(?:version\s+|v)\d[^\r\n]*$/i;
    const version = lines.find(line => pattern.test(line)) || null;
    return { available: true, version };
  } catch (error) {
    const missing = ['PROCESS_NOT_FOUND', 'ENOENT'].includes(error?.code);
    // A timeout or unsuccessful probe does not prove that the executable is absent.
    return { available: missing ? false : null, version: null, code: missing ? 'PROCESS_NOT_FOUND' : error?.code || 'PROCESS_FAILED' };
  }
}

async function requireTool(bin, kind, runner) {
  const result = await probeTool(bin, kind, runner);
  if (result.available === false) throw failure('NEED_SETUP', `A local ${kind} executable is required; no tool will be installed.`);
  if (result.available !== true) throw failure(result.code, 'Cannot verify the local tool; no media was downloaded.');
}

async function runTool(runner, bin, args, options) {
  try { return await runner(bin, args, options); } catch (error) {
    // The executable may disappear between preflight and actual processing.
    if (['PROCESS_NOT_FOUND', 'ENOENT'].includes(error?.code)) throw failure('NEED_SETUP', 'A required local tool is unavailable; no tool will be installed.');
    throw error;
  }
}

/** Only short local version/help probes; no credentials, downloads, or inference. */
export async function doctor({ ffmpegBin = 'ffmpeg', whisperBin = 'whisper-cli', modelPath, runner = runProcess } = {}) {
  const [ffmpeg, whisper, available] = await Promise.all([
    probeTool(ffmpegBin, 'ffmpeg', runner), probeTool(whisperBin, 'whisper', runner), modelAvailable(modelPath),
  ]);
  return { ffmpeg, whisper, model: { available, name: modelPath ? basename(modelPath) : null } };
}

function cdnURL(input, base) {
  let url;
  try { url = new URL(input, base); } catch { throw failure('UNSAFE_MEDIA_URL', 'Invalid media URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !CDN_SUFFIXES.some(suffix => host.endsWith(suffix) && host.length > suffix.length)) {
    throw failure('UNSAFE_MEDIA_URL', 'Media URL is not an allowed HTTPS Bilibili CDN.');
  }
  return url;
}

// The real parent and mkdtemp identity let cleanup reject replaced/symlinked paths.
async function operationDir(workDir) {
  if (typeof workDir !== 'string' || !workDir) throw failure('INVALID_ARGUMENT', 'workDir is required.');
  try {
    const root = resolve(workDir);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'bili-media-'));
    return { directory, realDirectory: await realpath(directory), identity: await lstat(directory), files: new Map() };
  } catch { throw failure('MEDIA_IO_FAILED', 'Cannot create media working directory.'); }
}

function ownedPath(operation, name) {
  const path = resolve(operation.directory, name);
  if (basename(path) !== name || dirname(path) !== operation.directory) throw failure('MEDIA_IO_FAILED', 'Invalid local media path.');
  return path;
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

// Never walk/remove directories, follow symlinks, or remove unregistered caller files.
async function cleanupOwned(operation, paths) {
  for (const path of paths) {
    const identity = operation.files.get(path);
    if (!identity || !identity.isFile() || identity.nlink !== 1) continue;
    try {
      const absolute = resolve(path);
      if (absolute !== path || dirname(absolute) !== operation.directory || await realpath(operation.directory) !== operation.realDirectory) continue;
      const directory = await lstat(operation.directory);
      if (!directory.isDirectory() || !sameFile(directory, operation.identity)) continue;
      const current = await lstat(absolute);
      const ownedLinks = [...operation.files.values()].filter(file => sameFile(file, identity)).length;
      if (!current.isFile() || current.nlink !== ownedLinks || !sameFile(current, identity)) continue;
      // Absolute path, fresh-directory identity and this invocation's file identity checked immediately before unlink.
      await unlink(absolute);
      operation.files.delete(path);
    } catch { /* Best effort; cleanup must not hide the original result/error. */ }
  }
}

async function removeEmptyOperation(operation) {
  try {
    const absolute = resolve(operation.directory);
    if (absolute !== operation.directory || await realpath(absolute) !== operation.realDirectory) return;
    const current = await lstat(absolute);
    if (!current.isDirectory() || !sameFile(current, operation.identity)) return;
    // Only the exact fresh directory; rmdir refuses PNGs, caller files and unknown contents.
    await rmdir(absolute);
  } catch { /* Nonempty/replaced/unavailable directories must remain untouched. */ }
}

// Only claim an expected tool output when it was absent before this invocation.
async function toolOutput(operation, name, create) {
  const path = ownedPath(operation, name);
  try {
    await lstat(path);
    throw failure('MEDIA_IO_FAILED', 'Refusing to replace an existing local file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { return await create(path); } finally {
    try {
      const identity = await lstat(path);
      if (identity.isFile() && identity.nlink === 1) operation.files.set(path, identity);
    } catch { /* A failed tool need not have created its output. */ }
  }
}

async function download(urlInput, operation, name, { fetchImpl, timeoutMs, maxBytes }) {
  let url = cdnURL(urlInput);
  positive(maxBytes, 'maxBytes');
  positive(timeoutMs, 'timeoutMs');
  const target = ownedPath(operation, name);
  const temporary = ownedPath(operation, `${name}.part`);
  let handle;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    for (let hop = 0; ; hop++) {
      response = await fetchImpl(url.href, {
        redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'bili-reach/1.0' },
      });
      if (!REDIRECTS.has(response.status)) break;
      await response.body?.cancel();
      if (hop >= 5) throw failure('MEDIA_REDIRECT_LIMIT', 'Too many media redirects.');
      const location = response.headers.get('location');
      if (!location) throw failure('MEDIA_DOWNLOAD_FAILED', 'Media redirect has no destination.');
      url = cdnURL(location, url);
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw failure('LOGIN_REQUIRED', 'Media download requires login.');
      if ([403, 412].includes(response.status)) throw failure('PLATFORM_BLOCKED', 'Media download requires platform verification.');
      if (response.status === 429) throw failure('RATE_LIMITED', 'Media download rate limit reached.');
      throw failure('MEDIA_DOWNLOAD_FAILED', 'Media download failed.');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body.cancel();
      throw failure('MEDIA_TOO_LARGE', 'Media exceeds the configured size limit.');
    }
    handle = await open(temporary, 'wx', 0o600);
    operation.files.set(temporary, await handle.stat());
    let bytes = 0;
    for await (const chunk of response.body) {
      if (controller.signal.aborted) throw failure('MEDIA_TIMEOUT', 'Media download timed out.');
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw failure('MEDIA_TOO_LARGE', 'Media exceeds the configured size limit.');
      await handle.writeFile(chunk);
    }
    if (!bytes) throw failure('MEDIA_DOWNLOAD_FAILED', 'Media download was empty.');
    if (controller.signal.aborted) throw failure('MEDIA_TIMEOUT', 'Media download timed out.');
    await handle.close();
    handle = undefined;
    // Hard-link publication is no-clobber (unlike rename); finally removes our .part link.
    await link(temporary, target);
    operation.files.set(target, operation.files.get(temporary));
    return target;
  } catch (error) {
    if (error.code && ['LOGIN_REQUIRED', 'PLATFORM_BLOCKED', 'RATE_LIMITED', 'UNSAFE_MEDIA_URL', 'MEDIA_REDIRECT_LIMIT', 'MEDIA_DOWNLOAD_FAILED', 'MEDIA_TOO_LARGE', 'MEDIA_TIMEOUT'].includes(error.code)) throw error;
    throw failure(controller.signal.aborted ? 'MEDIA_TIMEOUT' : 'MEDIA_DOWNLOAD_FAILED', controller.signal.aborted ? 'Media download timed out.' : 'Media download failed.');
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => {});
    // Even keepMedia does not retain an incomplete download.
    await cleanupOwned(operation, [temporary]);
  }
}

async function mediaURL(client, video, kind) {
  if (!client || typeof client.getMedia !== 'function') throw failure('INVALID_ARGUMENT', 'A media client is required.');
  let media;
  try { media = await client.getMedia(video, { kind }); } catch (error) {
    const platformCodes = ['NEED_LOGIN', 'LOGIN_REQUIRED', 'BAD_PART', 'PLATFORM_BLOCKED', 'RATE_LIMITED'];
    throw failure(platformCodes.includes(error?.code) ? error.code : 'MEDIA_LOOKUP_FAILED', 'Cannot resolve media for this video.');
  }
  if (!media || media.kind !== kind || typeof media.url !== 'string') throw failure('MEDIA_LOOKUP_FAILED', 'Media client returned an invalid result.');
  return cdnURL(media.url).href;
}

function durationOf(video) {
  if (!Number.isFinite(video?.duration) || video.duration <= 0) throw failure('INVALID_ARGUMENT', 'Video duration must be positive and finite.');
  return video.duration;
}

function timestampSeconds(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
}

function parseTranscript(raw, duration) {
  const invalid = () => failure('INVALID_TRANSCRIPT', 'Local transcription has an empty or invalid timeline.');
  if (!raw || !Array.isArray(raw.transcription) || !raw.transcription.length) throw invalid();
  let previousEnd = 0;
  return raw.transcription.map(item => {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) throw invalid();
    const hasOffsets = item.offsets !== undefined;
    const start = hasOffsets ? item.offsets?.from / 1000 : timestampSeconds(item.timestamps?.from);
    const end = hasOffsets ? item.offsets?.to / 1000 : timestampSeconds(item.timestamps?.to);
    if (hasOffsets && (!Number.isSafeInteger(item.offsets?.from) || !Number.isSafeInteger(item.offsets?.to))) throw invalid();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previousEnd || end > duration) throw invalid();
    previousEnd = end;
    return { start, end, text: item.text.trim() };
  });
}

export async function transcribeLocal({ client, video, workDir, modelPath, ffmpegBin = 'ffmpeg', whisperBin = 'whisper-cli', language = 'zh', glossary = [], timeoutMs = 1_800_000, maxBytes = 500 * 1024 * 1024, fetchImpl = globalThis.fetch, runner = runProcess, keepMedia = false } = {}) {
  if (!await modelAvailable(modelPath)) throw failure('NEED_SETUP', 'A readable local whisper.cpp model is required; no model will be downloaded.');
  const duration = durationOf(video);
  positive(timeoutMs, 'timeoutMs');
  positive(maxBytes, 'maxBytes');
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language) || !Array.isArray(glossary) || glossary.some(term => typeof term !== 'string') || glossary.join(', ').length > 16_384) {
    throw failure('INVALID_ARGUMENT', 'Invalid language or glossary.');
  }
  if (typeof keepMedia !== 'boolean') throw failure('INVALID_ARGUMENT', 'keepMedia must be a boolean.');
  await requireTool(ffmpegBin, 'ffmpeg', runner);
  await requireTool(whisperBin, 'whisper', runner);
  const url = await mediaURL(client, video, 'audio');
  const operation = await operationDir(workDir);
  const { directory } = operation;
  try {
    const input = await download(url, operation, 'audio.media', { fetchImpl, timeoutMs, maxBytes });
    const wav = ownedPath(operation, 'audio.wav');
    const prefix = ownedPath(operation, 'transcript');
    await toolOutput(operation, 'audio.wav', path => runTool(runner, ffmpegBin, ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,mp3,aac,flac,wav,ogg', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path], { timeoutMs, cwd: directory }));
    const args = ['-m', resolve(modelPath), '-f', wav, '-l', language, '-ojf', '-of', prefix];
    if (glossary.length) args.push('--prompt', glossary.join(', '));
    await toolOutput(operation, 'transcript.json', () => runTool(runner, whisperBin, args, { timeoutMs, cwd: directory }));
    let raw;
    try {
      const jsonPath = `${prefix}.json`;
      if ((await stat(jsonPath)).size > 32 * 1024 * 1024) throw new Error();
      raw = JSON.parse(await readFile(jsonPath, 'utf8'));
    } catch { throw failure('INVALID_TRANSCRIPT', 'Local transcription did not produce valid JSON.'); }
    // The pipeline saves raw as raw/asr.json; the whisper working copy is disposable.
    return { segments: parseTranscript(raw, duration), raw, engine: 'whisper.cpp', model: basename(modelPath), language };
  } finally {
    if (!keepMedia) {
      await cleanupOwned(operation, ['audio.media', 'audio.wav', 'transcript.json'].map(name => ownedPath(operation, name)));
      await removeEmptyOperation(operation);
    }
  }
}

export async function captureFrames({ client, video, workDir, timestamps, width = 1600, ffmpegBin = 'ffmpeg', timeoutMs = 300_000, maxBytes = 800 * 1024 * 1024, fetchImpl = globalThis.fetch, runner = runProcess, keepMedia = false } = {}) {
  const duration = durationOf(video);
  if (!Array.isArray(timestamps) || timestamps.length > 12 || timestamps.some(time => !Number.isFinite(time) || time < 0 || time >= duration)) {
    throw failure('INVALID_ARGUMENT', 'Use at most 12 finite timestamps within the video duration.');
  }
  if (!Number.isSafeInteger(width) || width < 1 || width > 7680) throw failure('INVALID_ARGUMENT', 'Frame width must be an integer between 1 and 7680.');
  positive(timeoutMs, 'timeoutMs');
  positive(maxBytes, 'maxBytes');
  if (typeof keepMedia !== 'boolean') throw failure('INVALID_ARGUMENT', 'keepMedia must be a boolean.');
  if (!timestamps.length) return [];
  await requireTool(ffmpegBin, 'ffmpeg', runner);
  const url = await mediaURL(client, video, 'video');
  const operation = await operationDir(workDir);
  const { directory } = operation;
  try {
    const input = await download(url, operation, 'video.media', { fetchImpl, timeoutMs, maxBytes });
    const frames = [];
    for (const [index, time] of timestamps.entries()) {
      const path = ownedPath(operation, `frame-${String(index + 1).padStart(2, '0')}.png`);
      await runTool(runner, ffmpegBin, ['-nostdin', '-v', 'error', '-n', '-ss', String(time), '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,mp3,aac,flac,wav,ogg', '-i', input, '-an', '-frames:v', '1', '-vf', `scale=${width}:-1`, '-f', 'image2', path], { timeoutMs, cwd: directory });
      try { if (!(await stat(path)).isFile() || (await stat(path)).size === 0) throw new Error(); } catch {
        throw failure('FRAME_CAPTURE_FAILED', 'Local tool did not produce a frame.');
      }
      frames.push({ time, path });
    }
    return frames;
  } finally {
    // PNG evidence (including frames produced before a failure) is never cleaned here.
    if (!keepMedia) {
      await cleanupOwned(operation, [ownedPath(operation, 'video.media')]);
      await removeEmptyOperation(operation);
    }
  }
}
