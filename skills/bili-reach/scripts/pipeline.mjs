import { mkdir, readFile, writeFile, rename, open, realpath, lstat, readdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, relative, basename, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BiliClient, BiliError } from './platform.mjs';
import { transcribeLocal, captureFrames } from './media.mjs';

export const VERSION = '0.1.0';
const fail = (code, message) => { throw new BiliError(code, message); };

export function validateSegments(segments, duration = Infinity) {
  if (!Array.isArray(segments) || !segments.length) fail('INVALID_TRANSCRIPT', '没有有效转写，未生成成功记录。');
  let previous = -1;
  return Array.from(segments, (s) => {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') fail('INVALID_TRANSCRIPT', '转写时间必须是秒数。');
    const { start, end } = s;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previous || end > duration + 5 || typeof s.text !== 'string' || !s.text.trim()) {
      fail('INVALID_TRANSCRIPT', '转写时间轴或文字无效，请检查原始结果。');
    }
    previous = start;
    return { start, end, text: s.text.trim() };
  });
}

export function parseTimestamps(value) {
  const values = value == null || value === '' ? [] : Array.isArray(value) ? Array.from(value) : String(value).split(',');
  if (values.length > 12 || values.some((x) => (typeof x !== 'number' && (typeof x !== 'string' || !x.trim())) || !Number.isFinite(Number(x)) || Number(x) < 0)) {
    fail('BAD_INPUT', '截图时间须为最多 12 个非负秒数。');
  }
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function toSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join('\n');
}
const json = (value) => JSON.stringify(value, null, 2) + '\n';
async function save(path, text) { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
async function assertRegular(path) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink()) fail('UNSAFE_PATH', '素材缓存路径不是普通文件。');
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function inside(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) fail('UNSAFE_PATH', '拒绝越界路径。');
  return rel;
}
const textLabel = (s) => String(s ?? '').replace(/[\r\n<>`\[\]]/g, ' ').slice(0, 300);
const pointerName = (kind) => kind === 'frames' ? 'latest.frames.json' : 'latest.json';

// Index every retained immutable file, including explicitly retained large media.
async function evidenceFiles(root, dir = root) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (dir === root && ['manifest.json', 'review.md', 'failure.json'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) fail('UNSAFE_PATH', '证据不能是符号链接。');
    if (entry.isDirectory()) files.push(...await evidenceFiles(root, path));
    else {
      await assertRegular(path);
      inside(root, await realpath(path));
      files.push({ path: inside(root, path), sha256: await digest(path) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function cachedResult(keyDir, video, timestamps, { kind, asr, keepMedia }) {
  let pointer;
  try { await assertRegular(join(keyDir, pointerName(kind))); pointer = JSON.parse(await readFile(join(keyDir, pointerName(kind)), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) fail('INVALID_CACHE', '缓存索引不是有效 JSON。'); throw error; }
  if (!/^[0-9a-f-]{36}$/.test(pointer?.runId ?? '')) fail('INVALID_CACHE', '缓存索引无效。');
  const actual = await realpath(join(keyDir, 'runs', pointer.runId)).catch(() => fail('INVALID_CACHE', '缓存版本缺失。'));
  inside(await realpath(keyDir), actual);
  await assertRegular(join(actual, 'manifest.json'));
  let manifest;
  try { manifest = JSON.parse(await readFile(join(actual, 'manifest.json'), 'utf8')); }
  catch { fail('INVALID_CACHE', '缓存清单无效。'); }
  if (manifest?.status !== 'complete' || manifest.video?.bvid !== video.bvid || manifest.video?.cid !== video.cid || (manifest.kind ?? 'transcript') !== kind || !manifest.source || !Array.isArray(manifest.frames) || !Array.isArray(manifest.files) || !manifest.files.length) fail('INVALID_CACHE', '缓存来源或清单不一致。');
  if (kind === 'transcript' && asr === 'none' && manifest.source.type === 'local-asr') fail('CACHE_OPTIONS_CHANGED', '缓存来自本地转写；仅字幕模式请用 --refresh 新建版本。');
  if (keepMedia && manifest.retention?.keepMedia !== true) fail('CACHE_OPTIONS_CHANGED', '缓存未按新策略保留媒体；请用 --refresh 新建版本。');
  if (timestamps.some((time) => !manifest.frames.some((f) => f.time === time))) fail('CACHE_OPTIONS_CHANGED', '需要新增截图，请用 --refresh 创建新版本。');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) fail('INVALID_CACHE', '缓存文件索引无效。');
    seen.add(file.path);
    const path = resolve(actual, file.path);
    inside(actual, path);
    try { await assertRegular(path); inside(actual, await realpath(path)); }
    catch (error) { if (error.code === 'ENOENT') fail('INVALID_CACHE', '缓存证据缺失，请用 --refresh 新建版本。'); throw error; }
    if (await digest(path) !== file.sha256) fail('INVALID_CACHE', '素材已被修改，请用 --refresh 新建版本，不覆盖旧文件。');
  }
  if (kind === 'transcript' && !['transcript.json', 'transcript.srt', 'transcript.txt'].every((path) => seen.has(path))) fail('INVALID_CACHE', '缓存缺少转写证据索引。');
  if (manifest.frames.some((f) => !f || typeof f.path !== 'string' || !seen.has(f.path))) fail('INVALID_CACHE', '缓存缺少截图证据索引。');
  return { ok: true, cached: true, status: 'complete', runDir: actual, manifestPath: join(actual, 'manifest.json'), manifest };
}

/** Shared acquisition core; frames-only deliberately never touches subtitles or ASR. */
export async function collect(input, options = {}) {
  const { client = new BiliClient(), output = './materials', part, kind = 'transcript', asr = 'local', model, language = 'zh', glossary = [], refresh = false, keepMedia = false,
    transcriber = transcribeLocal, frameCapturer = captureFrames, ffmpegBin = 'ffmpeg', whisperBin = 'whisper-cli' } = options;
  if (!['transcript', 'frames'].includes(kind) || !['none', 'local'].includes(asr) || typeof keepMedia !== 'boolean' || typeof refresh !== 'boolean') fail('BAD_INPUT', '采集策略无效。');
  if (!Array.isArray(glossary) || glossary.some((x) => typeof x !== 'string' || x.length > 200) || glossary.length > 100) fail('BAD_INPUT', '术语表无效。');
  const timestamps = parseTimestamps(options.frames);
  if (kind === 'frames' && !timestamps.length) fail('BAD_INPUT', '独立截图至少需要一个时间点。');
  const video = await client.inspect(input, { part });
  if (!/^BV[A-Za-z0-9]{10}$/.test(video.bvid) || !Number.isSafeInteger(video.cid) || video.cid <= 0 || !Number.isFinite(video.duration) || video.duration <= 0) fail('INVALID_METADATA', '视频标识或时长无效。');
  if (timestamps.some((t) => t >= video.duration)) fail('BAD_INPUT', '截图时间超出所选分 P 的时长。');
  await mkdir(resolve(output), { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(output));
  const keyDir = join(root, `${video.bvid}-${video.cid}`);
  await mkdir(keyDir, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  if ((await lstat(keyDir)).isSymbolicLink()) fail('UNSAFE_PATH', '来源目录不能是符号链接。');
  const lockPath = join(keyDir, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail('BUSY', '这个来源正在处理；确认没有任务运行后，才可手动处理异常遗留的 .lock。'); throw e; }
  let runDir;
  try {
    await lock.writeFile(json({ pid: process.pid, startedAt: new Date().toISOString() }));
    if (!refresh) { const cached = await cachedResult(keyDir, video, timestamps, { kind, asr, keepMedia }); if (cached) return cached; }
    let subtitle;
    if (kind === 'transcript') {
      subtitle = await client.getSubtitles(video);
      if (subtitle.status === 'login-required') fail('NEED_LOGIN', '需要用户提供 B 站登录态；未启动 ASR。');
      if (!['available', 'none'].includes(subtitle.status)) fail('API_ERROR', '字幕状态不明确，未启动 ASR。');
      if (subtitle.status === 'none' && asr === 'none') fail('NO_SUBTITLES', '该来源无可用字幕，且本次禁用了 ASR。');
    }
    const runId = randomUUID();
    const runsDir = join(keyDir, 'runs');
    await mkdir(runsDir, { recursive: true, mode: 0o700 });
    if ((await lstat(runsDir)).isSymbolicLink()) fail('UNSAFE_PATH', '版本目录不能是符号链接。');
    runDir = join(runsDir, runId);
    await mkdir(runDir, { mode: 0o700 });
    let source = { type: 'video-frames', provider: 'bilibili' }, segments;
    if (kind === 'transcript') {
      await mkdir(join(runDir, 'raw'), { mode: 0o700 });
      let raw, rawPath;
      if (subtitle.status === 'available') {
        segments = validateSegments(subtitle.segments, video.duration);
        raw = subtitle.raw; rawPath = 'raw/subtitle.json';
        source = { type: 'platform-subtitle', provider: 'bilibili', language: subtitle.language ?? '', track: subtitle.track ?? null };
      } else {
        const result = await transcriber({ client, video, workDir: join(runDir, 'raw'), modelPath: model, language, glossary, ffmpegBin, whisperBin, keepMedia });
        segments = validateSegments(result.segments, video.duration);
        raw = result.raw; rawPath = 'raw/asr.json';
        source = { type: 'local-asr', provider: result.engine, language: result.language ?? language, model: result.model ?? basename(model ?? '') };
      }
      await save(join(runDir, rawPath), json(raw ?? null));
      await save(join(runDir, 'transcript.json'), json({ schemaVersion: 1, video, source, segments }));
      await save(join(runDir, 'transcript.srt'), toSrt(segments));
      await save(join(runDir, 'transcript.txt'), segments.map((s) => `[${stamp(s.start)} --> ${stamp(s.end)}] ${s.text}`).join('\n') + '\n');
    }
    let frames = [];
    if (timestamps.length) {
      const frameDir = join(runDir, 'frames'); await mkdir(frameDir, { mode: 0o700 });
      const captured = await frameCapturer({ client, video, workDir: frameDir, timestamps, ffmpegBin, keepMedia });
      frames = captured.map((f) => ({ time: f.time, path: inside(runDir, resolve(f.path)), url: `${video.url}&t=${Math.floor(f.time)}` }));
      if (frames.length !== timestamps.length || timestamps.some((time) => !frames.some((f) => f.time === time))) fail('INCOMPLETE_FRAMES', '请求截图未完整生成，未提交成功记录。');
      for (const frame of frames) { await assertRegular(join(runDir, frame.path)); inside(runDir, await realpath(join(runDir, frame.path))); }
    }
    // A small evidence entry, not a second workflow or a page of empty headings.
    await save(join(runDir, 'review.md'), `# 待审：${textLabel(video.title)} · P${video.part}\n\n- 来源：${video.url}\n- 材料：${source.type}${kind === 'transcript' ? ' · [转写](transcript.json)' : ''}\n- 状态：尚未人工核对。\n${frames.length ? '\n' + frames.map((f) => `- [${f.time} 秒](${f.url}) · [截图](${f.path})`).join('\n') + '\n' : ''}`);
    const files = await evidenceFiles(runDir);
    const manifest = { schemaVersion: 1, kind, tool: { name: 'bili-reach', version: VERSION }, status: 'complete', runId, createdAt: new Date().toISOString(), video, source, frames, files,
      coverage: segments ? { firstStart: segments[0].start, lastEnd: segments.at(-1).end, duration: video.duration, note: '有效时间轴不代表每句话都正确或完整。' } : null,
      retention: { keepMedia }, review: { state: 'pending', path: 'review.md' } };
    await save(join(runDir, 'manifest.json'), json(manifest));
    const tmpPointer = join(keyDir, `.latest-${runId}.json`);
    await save(tmpPointer, json({ runId }));
    await rename(tmpPointer, join(keyDir, pointerName(kind)));
    return { ok: true, cached: false, status: 'complete', runDir, manifestPath: join(runDir, 'manifest.json'), manifest };
  } catch (error) {
    if (runDir) await save(join(runDir, 'failure.json'), json({ status: 'failed', code: error.code ?? 'ERROR', message: '任务未完成；旧成功版本保持不变。' })).catch(() => {});
    throw error;
  } finally {
    await lock.close();
    // Only this invocation's exclusive lock in the verified source directory is removed.
    if (resolve(lockPath) !== join(root, `${video.bvid}-${video.cid}`, '.lock')) throw new Error('Unsafe lock path');
    await unlink(lockPath);
  }
}
