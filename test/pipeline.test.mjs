import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir, symlink } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, validateSegments, parseTimestamps, toSrt } from '../skills/bili-reach/scripts/pipeline.mjs';
import { transcribeLocal } from '../skills/bili-reach/scripts/media.mjs';

const video = { bvid: 'BV1GJ411x7h7', aid: 170001, cid: 202, part: 2, partTitle: 'P2', title: 'fixture', author: 'fixture', duration: 100, totalParts: 2, pages: [], url: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2' };
const segments = [{ start: 0, end: 2.5, text: '原课说明' }, { start: 3, end: 5, text: '原例题' }];
const raw = { body: [{ from: 0, to: 2.5, content: '原课说明' }, { from: 3, to: 5, content: '原例题' }] };
const fail = (code) => Object.assign(new Error('fixture failure'), { code });
async function fixture(t, status = 'available') {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'bili-pipeline-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base); assert.ok(basename(root).startsWith('bili-pipeline-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const calls = { inspect: [], subtitles: 0, asr: [], frames: [] };
  const client = {
    async inspect(input, options) { calls.inspect.push({ input, options }); return video; },
    async getSubtitles() { calls.subtitles++; return { status, segments, raw, language: 'zh', track: { lan: 'zh' } }; },
  };
  const transcriber = async (options) => { calls.asr.push(options); return { segments, raw: { transcription: [] }, engine: 'fixture-local', language: 'zh', model: 'fixture.bin' }; };
  const frameCapturer = async (options) => {
    calls.frames.push(options);
    return Promise.all(options.timestamps.map(async (time) => {
      const path = join(options.workDir, `frame-${time}.png`); await writeFile(path, 'fixture png'); return { time, path };
    }));
  };
  return { root, calls, client, options: { client, output: root, transcriber, frameCapturer }, keyDir: join(root, `${video.bvid}-${video.cid}`) };
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('subtitles win without model or ASR, with complete exports and a small review', async (t) => {
  const f = await fixture(t);
  const result = await collect(video.bvid, { ...f.options, part: 2 });
  assert.equal(result.ok, true); assert.equal(result.manifest.kind, 'transcript');
  assert.equal(f.calls.asr.length, 0); assert.equal(f.calls.frames.length, 0);
  assert.deepEqual(f.calls.inspect[0].options, { part: 2 });
  assert.deepEqual((await readJson(join(result.runDir, 'transcript.json'))).segments, segments);
  assert.deepEqual(await readJson(join(result.runDir, 'raw/subtitle.json')), raw);
  assert.match(await readFile(join(result.runDir, 'transcript.srt'), 'utf8'), /00:00:00,000 --> 00:00:02,500/);
  assert.match(await readFile(join(result.runDir, 'transcript.txt'), 'utf8'), /原例题/);
  const review = await readFile(join(result.runDir, 'review.md'), 'utf8');
  assert.doesNotMatch(review, /查询现有笔记|关联已有知识点|AI 补充|##/);
  assert.ok(review.length < 400);
  assert.equal(result.manifest.retention.keepMedia, false);
});

test('only explicit none starts local ASR and records its actual source', async (t) => {
  const f = await fixture(t, 'none');
  const result = await collect(video.bvid, { ...f.options, model: 'fixture.bin', keepMedia: true });
  assert.equal(f.calls.asr.length, 1); assert.equal(f.calls.asr[0].keepMedia, true);
  assert.equal(result.manifest.source.type, 'local-asr');
  assert.ok(result.manifest.files.some((file) => file.path === 'raw/asr.json'));
});

for (const status of ['login-required', 'unknown']) {
  test(`${status} stops without ASR or screenshots`, async (t) => {
    const f = await fixture(t, status);
    await assert.rejects(collect(video.bvid, { ...f.options, frames: [10] }), { code: status === 'login-required' ? 'NEED_LOGIN' : 'API_ERROR' });
    assert.equal(f.calls.asr.length, 0); assert.equal(f.calls.frames.length, 0);
  });
}
for (const code of ['PLATFORM_BLOCKED', 'RATE_LIMITED', 'NETWORK_ERROR']) {
  test(`${code} never becomes missing subtitles`, async (t) => {
    const f = await fixture(t); f.client.getSubtitles = async () => { throw fail(code); };
    await assert.rejects(collect(video.bvid, f.options), { code });
    assert.equal(f.calls.asr.length, 0);
  });
}

test('subtitle-only none stops without trying ASR', async (t) => {
  const f = await fixture(t, 'none');
  await assert.rejects(collect(video.bvid, { ...f.options, asr: 'none' }), { code: 'NO_SUBTITLES' });
  assert.equal(f.calls.asr.length, 0);
});

test('invalid available subtitles fail rather than invoking ASR', async (t) => {
  const f = await fixture(t); f.client.getSubtitles = async () => ({ status: 'available', segments: [] });
  await assert.rejects(collect(video.bvid, f.options), { code: 'INVALID_TRANSCRIPT' });
  assert.equal(f.calls.asr.length, 0);
  await assert.rejects(readFile(join(f.keyDir, 'latest.json')), { code: 'ENOENT' });
});

test('frames-only never reads subtitles or invokes ASR and needs no model', async (t) => {
  const f = await fixture(t);
  f.client.getSubtitles = async () => { throw new Error('must not read subtitles'); };
  const result = await collect(video.bvid, { ...f.options, kind: 'frames', frames: [30, 90] });
  assert.equal(f.calls.asr.length, 0); assert.equal(f.calls.frames.length, 1);
  assert.equal(f.calls.frames[0].keepMedia, false);
  assert.equal(result.manifest.kind, 'frames'); assert.equal(result.manifest.coverage, null);
  assert.equal(result.manifest.source.type, 'video-frames');
  assert.equal(result.manifest.frames.length, 2);
  assert.match(result.manifest.frames[0].url, /\?p=2&t=30$/);
  await assert.rejects(readFile(join(result.runDir, 'transcript.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.keyDir, 'latest.json')), { code: 'ENOENT' });
  assert.equal((await readJson(join(f.keyDir, 'latest.frames.json'))).runId, result.manifest.runId);
});

test('frames and transcript success pointers remain independent', async (t) => {
  const f = await fixture(t);
  const text = await collect(video.bvid, f.options);
  const frames = await collect(video.bvid, { ...f.options, kind: 'frames', frames: [30] });
  assert.notEqual(text.runDir, frames.runDir);
  assert.equal((await readJson(join(f.keyDir, 'latest.json'))).runId, text.manifest.runId);
  assert.equal((await collect(video.bvid, f.options)).runDir, text.runDir);
  const again = await collect(video.bvid, { ...f.options, kind: 'frames', frames: [30] });
  assert.equal(again.cached, true); assert.equal(again.runDir, frames.runDir);
  assert.equal(f.calls.subtitles, 1); assert.equal(f.calls.frames.length, 1);
});

test('cache validates evidence but permits handwritten review edits', async (t) => {
  const f = await fixture(t); const first = await collect(video.bvid, f.options);
  await writeFile(join(first.runDir, 'review.md'), '人工内容，不要覆盖');
  assert.equal((await collect(video.bvid, f.options)).cached, true);
  assert.equal(await readFile(join(first.runDir, 'review.md'), 'utf8'), '人工内容，不要覆盖');
  await writeFile(join(first.runDir, 'transcript.txt'), 'corrupted');
  await assert.rejects(collect(video.bvid, f.options), { code: 'INVALID_CACHE' });
});

test('retained media is hashed, and a missing media file invalidates the cache', async (t) => {
  const f = await fixture(t, 'none'); let mediaPath;
  const transcriber = async (options) => {
    const mediaDir = join(options.workDir, 'bili-media-fixture'); await mkdir(mediaDir);
    mediaPath = join(mediaDir, 'audio.media'); await writeFile(mediaPath, 'retained media');
    return f.options.transcriber(options);
  };
  const first = await collect(video.bvid, { ...f.options, transcriber, keepMedia: true });
  assert.ok(first.manifest.files.some((file) => file.path.endsWith('audio.media')));
  assert.equal(resolve(mediaPath), join(first.runDir, 'raw/bili-media-fixture/audio.media'));
  await rm(mediaPath);
  await assert.rejects(collect(video.bvid, { ...f.options, keepMedia: true }), { code: 'INVALID_CACHE' });
});

test('refresh creates new evidence and leaves old handwritten review intact', async (t) => {
  const f = await fixture(t); const a = await collect(video.bvid, f.options);
  await writeFile(join(a.runDir, 'review.md'), '人工批注');
  const b = await collect(video.bvid, { ...f.options, refresh: true });
  assert.notEqual(a.runDir, b.runDir);
  assert.equal(await readFile(join(a.runDir, 'review.md'), 'utf8'), '人工批注');
  assert.equal((await readJson(join(f.keyDir, 'latest.json'))).runId, b.manifest.runId);
});

test('new screenshot times or newly requested media retention require refresh', async (t) => {
  const f = await fixture(t); await collect(video.bvid, { ...f.options, frames: [10] });
  await assert.rejects(collect(video.bvid, { ...f.options, frames: [20] }), { code: 'CACHE_OPTIONS_CHANGED' });
  await assert.rejects(collect(video.bvid, { ...f.options, keepMedia: true }), { code: 'CACHE_OPTIONS_CHANGED' });
});

test('failed refresh cannot move a successful pointer or alter review', async (t) => {
  const f = await fixture(t); const first = await collect(video.bvid, f.options);
  const pointer = await readFile(join(f.keyDir, 'latest.json'), 'utf8');
  await assert.rejects(collect(video.bvid, { ...f.options, refresh: true, frames: [10], frameCapturer: async () => { throw fail('PLATFORM_BLOCKED'); } }), { code: 'PLATFORM_BLOCKED' });
  assert.equal(await readFile(join(f.keyDir, 'latest.json'), 'utf8'), pointer);
  const runs = await readdir(join(f.keyDir, 'runs'));
  const failed = runs.find((id) => id !== first.manifest.runId);
  assert.equal((await readJson(join(f.keyDir, 'runs', failed, 'failure.json'))).code, 'PLATFORM_BLOCKED');
});

test('concurrent acquisition of one source is rejected rather than overwriting', async (t) => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { entered = r; });
  f.client.getSubtitles = async () => { entered(); await gate; return { status: 'available', segments, raw }; };
  const first = collect(video.bvid, f.options);
  await ready;
  try { await assert.rejects(collect(video.bvid, f.options), { code: 'BUSY' }); }
  finally { release(); }
  await first;
});

test('symlinked source directory is rejected', async (t) => {
  const f = await fixture(t); const outside = join(f.root, 'unrelated'); await mkdir(outside);
  await symlink(outside, f.keyDir, 'dir');
  await assert.rejects(collect(video.bvid, f.options), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await readdir(outside), []);
});

test('bad frame requests stop before platform access', async (t) => {
  const f = await fixture(t);
  for (const frames of [[], [-1], [Infinity], Array(13).fill(1)]) {
    await assert.rejects(collect(video.bvid, { ...f.options, kind: 'frames', frames }), { code: 'BAD_INPUT' });
  }
  assert.equal(f.calls.inspect.length, 0);
});

for (const keepMedia of [false, true]) {
  test(`actual media adapter preserves canonical raw JSON with keepMedia=${keepMedia}`, async (t) => {
    const f = await fixture(t, 'none');
    const model = join(f.root, 'fixture-model.bin'); await writeFile(model, 'fixture model');
    const original = { transcription: [{ offsets: { from: 0, to: 2000 }, text: '原始转写' }] };
    f.client.getMedia = async () => ({ url: 'https://a.bilivideo.com/fixture', kind: 'audio' });
    const runner = async (bin, args) => {
      if (args.includes('-version')) return { stdout: 'ffmpeg version fixture', stderr: '' };
      if (args.includes('--help')) return { stdout: 'usage: whisper-cli [options] file', stderr: '' };
      if (bin === 'whisper-cli') await writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify(original));
      else await writeFile(args.at(-1), 'fixture pcm');
      return { stdout: '', stderr: '' };
    };
    const transcriber = (options) => transcribeLocal({ ...options, runner, fetchImpl: async () => new Response('fixture audio') });
    const result = await collect(video.bvid, { ...f.options, model, transcriber, keepMedia });
    assert.deepEqual(await readJson(join(result.runDir, 'raw/asr.json')), original);
    assert.equal(result.manifest.files.some((file) => file.path.endsWith('audio.media')), keepMedia);
    assert.equal(result.manifest.files.some((file) => file.path.endsWith('audio.wav')), keepMedia);
    assert.equal((await collect(video.bvid, { ...f.options, keepMedia })).cached, true);
    assert.equal(await readFile(model, 'utf8'), 'fixture model');
  });
}

test('invalid segment times and timestamp parsing are strict', () => {
  for (const entry of [null, { start: null, end: 2, text: 'x' }, { start: '0', end: 2, text: 'x' }, { start: 0, end: 0, text: 'x' }]) {
    assert.throws(() => validateSegments([entry]), { code: 'INVALID_TRANSCRIPT' });
  }
  assert.deepEqual(parseTimestamps('90,30,30'), [30, 90]);
  assert.match(toSrt(segments), /00:00:03,000 --> 00:00:05,000/);
});
