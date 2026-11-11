import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, writeFile, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { captureFrames, doctor, runProcess, transcribeLocal } from '../skills/bili-reach/scripts/media.mjs';

const CDN = 'https://upos-sz-mirror.bilivideo.com/audio?token=secret';
const video = { bvid: 'BVtest', cid: 1, part: 1, title: 'test', duration: 10 };
const transcript = { transcription: [
  { offsets: { from: 0, to: 1000 }, text: ' 你好 ' },
  { offsets: { from: 1000, to: 2500 }, text: '世界' },
] };

async function fixture(t, raw = transcript) {
  const root = await mkdtemp(join(tmpdir(), 'bili-media-test-'));
  t.after(async () => {
    // Check the absolute owned target before recursive test-fixture cleanup.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('bili-media-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const modelPath = join(root, 'ggml-model.bin');
  await writeFile(modelPath, 'fake model');
  const calls = [];
  const probes = [];
  const requests = [];
  const kinds = [];
  const client = { async getMedia(_video, { kind }) { kinds.push(kind); return { url: CDN, kind, mimeType: 'application/octet-stream' }; } };
  const runner = async (bin, args, options) => {
    if (args.length === 1 && ['-version', '--help'].includes(args[0])) {
      probes.push({ bin, args, options });
      return { stdout: bin === 'ffmpeg' ? 'ffmpeg version 7.0\n' : '', stderr: bin === 'whisper-cli' ? 'usage: whisper-cli [options] file0 file1 ...\n' : '', exitCode: 0 };
    }
    calls.push({ bin, args, options });
    if (bin === 'whisper-cli') {
      const prefix = args[args.indexOf('-of') + 1];
      await writeFile(`${prefix}.json`, typeof raw === 'string' ? raw : JSON.stringify(raw));
    } else {
      await writeFile(args.at(-1), Buffer.from([137, 80, 78, 71]));
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return new Response('media data'); };
  return { root, calls, probes, requests, kinds, options: { client, video, workDir: root, modelPath, runner, fetchImpl } };
}

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files;
}

test('transcribe uses local audio, mono 16k PCM and whisper full JSON', async t => {
  const f = await fixture(t);
  const result = await transcribeLocal({ ...f.options, glossary: ['哔哩哔哩', '术语'], keepMedia: true });
  assert.deepEqual(result, {
    segments: [{ start: 0, end: 1, text: '你好' }, { start: 1, end: 2.5, text: '世界' }],
    raw: transcript, engine: 'whisper.cpp', model: 'ggml-model.bin', language: 'zh',
  });
  assert.deepEqual(f.kinds, ['audio']);
  const ffmpeg = f.calls[0];
  assert.equal(ffmpeg.bin, 'ffmpeg');
  for (const flag of ['-nostdin', '-vn', '-n']) assert.ok(ffmpeg.args.includes(flag));
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ar') + 1], '16000');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ac') + 1], '1');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-protocol_whitelist') + 1], 'file');
  assert.equal(await readFile(ffmpeg.args[ffmpeg.args.indexOf('-i') + 1], 'utf8'), 'media data');
  assert.ok(!ffmpeg.args.some(arg => arg.includes('https://')));
  const whisper = f.calls[1];
  assert.ok(whisper.args.includes('-ojf'));
  assert.equal(whisper.args[whisper.args.indexOf('--prompt') + 1], '哔哩哔哩, 术语');
  assert.equal(f.requests[0].options.redirect, 'manual');
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(Object.keys(f.requests[0].options.headers).some(key => key.toLowerCase() === 'cookie'), false);
  assert.ok((await filesBelow(f.root)).some(path => path.endsWith('.wav')));
});

test('default transcription returns raw JSON but cleans all owned intermediate files', async t => {
  const f = await fixture(t);
  const result = await transcribeLocal(f.options);
  assert.deepEqual(result.raw, transcript);
  assert.deepEqual(await readdir(f.root), ['ggml-model.bin']);
  assert.deepEqual((await filesBelow(f.root)).map(path => basename(path)), ['ggml-model.bin']);
  assert.deepEqual(f.probes.map(probe => [probe.bin, probe.args]), [['ffmpeg', ['-version']], ['whisper-cli', ['--help']]]);
});

for (const stage of ['ffmpeg', 'whisper-cli']) {
  for (const code of ['PROCESS_FAILED', 'PROCESS_TIMEOUT']) {
    test(`default transcription cleans even partial outputs after ${stage} ${code}`, async t => {
      const f = await fixture(t);
      const runner = async (bin, args, options) => {
        const result = await f.options.runner(bin, args, options);
        if (bin === stage && args.length > 1) throw Object.assign(new Error('mock local failure'), { code });
        return result;
      };
      await assert.rejects(transcribeLocal({ ...f.options, runner }), { code });
      assert.deepEqual(await readdir(f.root), ['ggml-model.bin']);
      assert.deepEqual((await filesBelow(f.root)).map(path => basename(path)), ['ggml-model.bin']);
    });
  }
}

test('keepMedia retains transcription intermediates even after a tool failure', async t => {
  const f = await fixture(t);
  const runner = async (bin, args, options) => {
    const result = await f.options.runner(bin, args, options);
    if (bin === 'whisper-cli' && args.length > 1) throw Object.assign(new Error('mock local failure'), { code: 'PROCESS_FAILED' });
    return result;
  };
  await assert.rejects(transcribeLocal({ ...f.options, runner, keepMedia: true }), { code: 'PROCESS_FAILED' });
  assert.deepEqual((await filesBelow(f.root)).map(path => basename(path)).sort(), ['audio.media', 'audio.wav', 'ggml-model.bin', 'transcript.json']);
});

test('transcription cleanup leaves caller files, old work directories and unknown tool outputs alone', async t => {
  const f = await fixture(t);
  const old = join(f.root, 'bili-media-old');
  await mkdir(old);
  const sentinels = [];
  for (const directory of [f.root, old]) {
    for (const name of ['audio.media', 'audio.wav', 'transcript.json', 'video.media']) {
      const path = join(directory, name);
      await writeFile(path, 'caller content');
      sentinels.push(path);
    }
  }
  let unknown;
  const runner = async (bin, args, options) => {
    if (args.includes('-ojf')) {
      unknown = join(options.cwd, 'unknown.bin');
      await writeFile(unknown, 'not ours to clean');
    }
    return f.options.runner(bin, args, options);
  };
  await transcribeLocal({ ...f.options, runner });
  for (const path of sentinels) assert.equal(await readFile(path, 'utf8'), 'caller content');
  assert.equal(await readFile(unknown, 'utf8'), 'not ours to clean');
});

test('an existing caller output in the new directory is not claimed or removed', async t => {
  const f = await fixture(t);
  let sentinel;
  const fetchImpl = async (...args) => {
    const [directory] = (await readdir(f.root)).filter(name => name.startsWith('bili-media-'));
    sentinel = join(f.root, directory, 'audio.wav');
    await writeFile(sentinel, 'caller wav');
    return f.options.fetchImpl(...args);
  };
  await assert.rejects(transcribeLocal({ ...f.options, fetchImpl }), { code: 'MEDIA_IO_FAILED' });
  assert.equal(await readFile(sentinel, 'utf8'), 'caller wav');
  assert.equal((await filesBelow(f.root)).some(path => basename(path) === 'audio.media'), false);
  assert.equal(f.calls.length, 0);
});

test('download publication never replaces a caller file created during fetch', async t => {
  const f = await fixture(t);
  let sentinel;
  const fetchImpl = async (...args) => {
    const [directory] = (await readdir(f.root)).filter(name => name.startsWith('bili-media-'));
    sentinel = join(f.root, directory, 'video.media');
    await writeFile(sentinel, 'caller video');
    return f.options.fetchImpl(...args);
  };
  await assert.rejects(captureFrames({ ...f.options, fetchImpl, timestamps: [1] }), { code: 'MEDIA_DOWNLOAD_FAILED' });
  assert.equal(await readFile(sentinel, 'utf8'), 'caller video');
  assert.equal((await filesBelow(f.root)).some(path => path.endsWith('.part')), false);
});

test('cleanup does not follow or remove a tool output symlink to caller JSON', async t => {
  const f = await fixture(t);
  const sentinel = join(f.root, 'caller.json');
  await writeFile(sentinel, JSON.stringify(transcript));
  let output;
  const runner = async (bin, args, options) => {
    if (args.includes('-ojf')) {
      output = `${args[args.indexOf('-of') + 1]}.json`;
      await symlink(sentinel, output);
      return {};
    }
    return f.options.runner(bin, args, options);
  };
  await transcribeLocal({ ...f.options, runner });
  assert.equal((await lstat(output)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(sentinel, 'utf8')), transcript);
  assert.equal((await filesBelow(f.root)).some(path => ['audio.media', 'audio.wav'].includes(basename(path))), false);
});

test('cleanup refuses a replacement directory even when filenames match owned outputs', async t => {
  const f = await fixture(t);
  let replacement;
  const runner = async (bin, args, options) => {
    if (args.includes('-ojf')) {
      const original = options.cwd;
      const moved = `${original}-moved`;
      // Verify this fixture's exact absolute directory before moving it.
      assert.equal(dirname(resolve(original)), resolve(f.root));
      assert.ok(basename(original).startsWith('bili-media-'));
      assert.equal(dirname(resolve(moved)), resolve(f.root));
      await rename(original, moved);
      await mkdir(original);
      replacement = original;
      for (const name of ['audio.media', 'audio.wav', 'transcript.json']) await writeFile(join(original, name), 'caller replacement');
      throw Object.assign(new Error('mock failure after directory replacement'), { code: 'PROCESS_FAILED' });
    }
    return f.options.runner(bin, args, options);
  };
  await assert.rejects(transcribeLocal({ ...f.options, runner }), { code: 'PROCESS_FAILED' });
  for (const name of ['audio.media', 'audio.wav', 'transcript.json']) {
    assert.equal(await readFile(join(replacement, name), 'utf8'), 'caller replacement');
  }
});

test('timestamp string fallback supports comma and dot milliseconds', async t => {
  const f = await fixture(t, { transcription: [{ timestamps: { from: '00:00:00,100', to: '00:00:01.500' }, text: '词' }] });
  assert.deepEqual((await transcribeLocal(f.options)).segments, [{ start: 0.1, end: 1.5, text: '词' }]);
});

test('missing or unreadable model fails before any download', async t => {
  const f = await fixture(t);
  await assert.rejects(transcribeLocal({ ...f.options, modelPath: undefined }), { code: 'NEED_SETUP' });
  await assert.rejects(transcribeLocal({ ...f.options, modelPath: join(f.root, 'missing') }), { code: 'NEED_SETUP' });
  await assert.rejects(transcribeLocal({ ...f.options, modelPath: f.root }), { code: 'NEED_SETUP' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.length, 0);
});

for (const missing of ['ffmpeg', 'whisper-cli']) {
  test(`missing ${missing} is NEED_SETUP before any media lookup or fetch`, async t => {
    const f = await fixture(t);
    const runner = async (bin, args, options) => {
      if (bin === missing) throw Object.assign(new Error('/private/tool'), { code: 'PROCESS_NOT_FOUND' });
      return f.options.runner(bin, args, options);
    };
    await assert.rejects(transcribeLocal({ ...f.options, runner }), error => error.code === 'NEED_SETUP' && !error.message.includes('/private'));
    if (missing === 'ffmpeg') await assert.rejects(captureFrames({ ...f.options, runner, timestamps: [1] }), { code: 'NEED_SETUP' });
    assert.equal(f.requests.length, 0);
    assert.equal(f.kinds.length, 0);
    assert.equal(f.calls.length, 0);
  });
}

for (const code of ['PROCESS_FAILED', 'PROCESS_TIMEOUT']) {
  test(`a failing local probe preserves ${code} and does not download`, async t => {
    const f = await fixture(t);
    const runner = async () => { throw Object.assign(new Error('private process output'), { code }); };
    await assert.rejects(transcribeLocal({ ...f.options, runner }), error => error.code === code && !error.message.includes('private'));
    await assert.rejects(captureFrames({ ...f.options, runner, timestamps: [1] }), { code });
    assert.equal(f.requests.length, 0);
    assert.equal(f.kinds.length, 0);
  });
}

test('a tool disappearing after preflight remains NEED_SETUP and cleans downloaded media', async t => {
  const f = await fixture(t);
  const runner = async (bin, args, options) => {
    if (args.length > 1) throw Object.assign(new Error('/private/missing-tool'), { code: 'PROCESS_NOT_FOUND' });
    return f.options.runner(bin, args, options);
  };
  await assert.rejects(transcribeLocal({ ...f.options, runner }), { code: 'NEED_SETUP' });
  await assert.rejects(captureFrames({ ...f.options, runner, timestamps: [1] }), { code: 'NEED_SETUP' });
  assert.deepEqual(await readdir(f.root), ['ggml-model.bin']);
});

test('capture only preflights ffmpeg, without requiring a model or whisper', async t => {
  const f = await fixture(t);
  await captureFrames({ ...f.options, modelPath: undefined, whisperBin: '/missing/whisper', timestamps: [1] });
  assert.deepEqual(f.probes.map(probe => [probe.bin, probe.args]), [['ffmpeg', ['-version']]]);
});

for (const [name, raw] of [
  ['empty transcript', { transcription: [] }],
  ['missing transcript', {}],
  ['invalid JSON', '{bad'],
  ['zero length', { transcription: [{ offsets: { from: 0, to: 0 }, text: 'a' }] }],
  ['negative time', { transcription: [{ offsets: { from: -1, to: 20 }, text: 'a' }] }],
  ['non-numeric time', { transcription: [{ offsets: { from: '0', to: 1000 }, text: 'a' }] }],
  ['invalid timestamp', { transcription: [{ timestamps: { from: '00:60:00.000', to: '00:60:01.000' }, text: 'a' }] }],
  ['past duration', { transcription: [{ offsets: { from: 0, to: 10001 }, text: 'a' }] }],
  ['empty text', { transcription: [{ offsets: { from: 0, to: 1000 }, text: ' ' }] }],
  ['overlapping timeline', { transcription: [{ offsets: { from: 0, to: 1000 }, text: 'a' }, { offsets: { from: 900, to: 2000 }, text: 'b' }] }],
  ['backward timeline', { transcription: [{ offsets: { from: 2000, to: 3000 }, text: 'a' }, { offsets: { from: 0, to: 1000 }, text: 'b' }] }],
]) {
  test(`rejects ${name}`, async t => {
    const f = await fixture(t, raw);
    await assert.rejects(transcribeLocal(f.options), { code: 'INVALID_TRANSCRIPT' });
    assert.deepEqual((await filesBelow(f.root)).map(path => basename(path)), ['ggml-model.bin']);
  });
}

test('capture downloads silent video once and preserves requested times', async t => {
  const f = await fixture(t);
  const result = await captureFrames({ ...f.options, timestamps: [0, 9.5, 1], width: 1200 });
  assert.deepEqual(f.kinds, ['video']);
  assert.deepEqual(result.map(frame => frame.time), [0, 9.5, 1]);
  assert.equal(f.requests.length, 1);
  for (const [index, frame] of result.entries()) {
    assert.ok(frame.path.endsWith('.png'));
    assert.ok((await readFile(frame.path)).length > 0);
    assert.equal(f.calls[index].args[f.calls[index].args.indexOf('-vf') + 1], 'scale=1200:-1');
    assert.ok(f.calls[index].args.includes('-nostdin'));
  }
});

test('default frame capture cleans downloaded video, but retains PNG evidence', async t => {
  const f = await fixture(t);
  const result = await captureFrames({ ...f.options, timestamps: [1, 2] });
  assert.equal((await filesBelow(f.root)).some(path => basename(path) === 'video.media'), false);
  for (const frame of result) assert.ok((await readFile(frame.path)).length > 0);
});

test('keepMedia explicitly retains downloaded frame video', async t => {
  const f = await fixture(t);
  const [frame] = await captureFrames({ ...f.options, timestamps: [1], keepMedia: true });
  assert.equal(await readFile(join(dirname(frame.path), 'video.media'), 'utf8'), 'media data');
  assert.ok((await readFile(frame.path)).length > 0);
});

for (const code of ['PROCESS_FAILED', 'PROCESS_TIMEOUT']) {
  test(`frame ${code} cleans video while keeping already produced PNGs`, async t => {
    const f = await fixture(t);
    let attempts = 0;
    const runner = async (bin, args, options) => {
      const result = await f.options.runner(bin, args, options);
      if (args.length > 1 && ++attempts === 2) throw Object.assign(new Error('mock frame failure'), { code });
      return result;
    };
    await assert.rejects(captureFrames({ ...f.options, timestamps: [1, 2, 3], runner }), { code });
    const names = (await filesBelow(f.root)).map(path => basename(path));
    assert.equal(names.includes('video.media'), false);
    assert.equal(names.filter(name => name.endsWith('.png')).length, 2);
  });
}

test('frame validation occurs before network or execution', async t => {
  const f = await fixture(t);
  for (const timestamps of [[-1], [10], [Infinity], [NaN], ['1'], Array(13).fill(1), undefined]) {
    await assert.rejects(captureFrames({ ...f.options, timestamps }), { code: 'INVALID_ARGUMENT' });
  }
  for (const width of [0, 1.5, 99999]) {
    await assert.rejects(captureFrames({ ...f.options, timestamps: [1], width }), { code: 'INVALID_ARGUMENT' });
  }
  assert.deepEqual(await captureFrames({ ...f.options, timestamps: [] }), []);
  assert.equal(f.requests.length, 0);
});

test('capture rejects missing output rather than returning imaginary paths', async t => {
  const f = await fixture(t);
  await assert.rejects(captureFrames({ ...f.options, timestamps: [1], runner: async () => ({}) }), { code: 'FRAME_CAPTURE_FAILED' });
});

test('each operation uses unique files and never overwrites caller content', async t => {
  const f = await fixture(t);
  const sentinel = join(f.root, 'video.media');
  await writeFile(sentinel, 'do not replace');
  const a = await captureFrames({ ...f.options, timestamps: [1] });
  const b = await captureFrames({ ...f.options, timestamps: [1] });
  assert.notEqual(a[0].path, b[0].path);
  assert.equal(await readFile(sentinel, 'utf8'), 'do not replace');
});

for (const url of [
  'http://a.bilivideo.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a',
  'https://evil.example/a', 'https://bilivideo.com.evil.example/a', 'https://a.bilivideo.com:444/a',
  'https://user:secret@a.bilivideo.com/a', 'file:///etc/passwd', 'not a url',
]) {
  test(`rejects unsafe media URL ${url.replace(/user:secret@/, '[redacted]@')}`, async t => {
    const f = await fixture(t);
    const client = { async getMedia() { return { url, kind: 'video' }; } };
    await assert.rejects(captureFrames({ ...f.options, client, timestamps: [1] }), { code: 'UNSAFE_MEDIA_URL' });
    assert.equal(f.requests.length, 0);
  });
}

test('validates every redirect and never follows a private destination', async t => {
  const f = await fixture(t);
  let count = 0;
  const fetchImpl = async (_url, options) => {
    count++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private?secret=abc' } });
  };
  await assert.rejects(captureFrames({ ...f.options, fetchImpl, timestamps: [1] }), error => error.code === 'UNSAFE_MEDIA_URL' && !error.message.includes('secret'));
  assert.equal(count, 1);
});

test('allows necessary CDN suffixes and relative redirects', async t => {
  const f = await fixture(t);
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://a.bilivideo.cn/a' } });
    if (seen.length === 2) return new Response(null, { status: 307, headers: { location: 'https://a.hdslb.com/b' } });
    if (seen.length === 3) return new Response(null, { status: 301, headers: { location: '/final' } });
    return new Response('media');
  };
  await captureFrames({ ...f.options, timestamps: [1], fetchImpl });
  assert.equal(seen.at(-1), 'https://a.hdslb.com/final');
});

test('redirect loops have a finite bound', async t => {
  const f = await fixture(t);
  let count = 0;
  const fetchImpl = async () => { count++; return new Response(null, { status: 302, headers: { location: '/again' } }); };
  await assert.rejects(captureFrames({ ...f.options, timestamps: [1], fetchImpl }), { code: 'MEDIA_REDIRECT_LIMIT' });
  assert.equal(count, 6);
});

test('checks Content-Length and streaming byte limits; removes only owned partial files', async t => {
  const f = await fixture(t);
  const sentinel = join(f.root, 'keep.part');
  await writeFile(sentinel, 'keep');
  const opts = { ...f.options, timestamps: [1], maxBytes: 5 };
  await assert.rejects(captureFrames({ ...opts, fetchImpl: async () => new Response('huge', { headers: { 'content-length': '10' } }) }), { code: 'MEDIA_TOO_LARGE' });
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(4)); controller.close(); },
  }));
  await assert.rejects(captureFrames({ ...opts, fetchImpl }), { code: 'MEDIA_TOO_LARGE' });
  assert.deepEqual((await filesBelow(f.root)).filter(path => path.endsWith('.part')), [sentinel]);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.equal(f.calls.length, 0);
});

test('download timeout aborts and redacts upstream errors', async t => {
  const f = await fixture(t);
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('sensitive URL and path')), { once: true });
  });
  await assert.rejects(captureFrames({ ...f.options, timestamps: [1], timeoutMs: 20, fetchImpl }), error => error.code === 'MEDIA_TIMEOUT' && !error.message.includes('sensitive'));
  await assert.rejects(captureFrames({ ...f.options, timestamps: [1], fetchImpl: async () => { throw new Error(CDN); } }), error => error.code === 'MEDIA_DOWNLOAD_FAILED' && !error.message.includes('secret'));
});

test('stream failure cleans partial download and keeps unrelated files', async t => {
  const f = await fixture(t);
  const fetchImpl = async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('private stream URL')); },
  }));
  await assert.rejects(captureFrames({ ...f.options, timestamps: [1], fetchImpl }), { code: 'MEDIA_DOWNLOAD_FAILED' });
  assert.equal((await filesBelow(f.root)).some(path => path.endsWith('.part')), false);
});

for (const [status, code] of [[401, 'LOGIN_REQUIRED'], [403, 'PLATFORM_BLOCKED'], [412, 'PLATFORM_BLOCKED'], [429, 'RATE_LIMITED']]) {
  test(`CDN HTTP ${status} preserves ${code} with no signed URL or cookie`, async t => {
    const f = await fixture(t);
    const fetchImpl = async () => new Response('private URL cookie and token=secret', { status });
    for (const task of [() => captureFrames({ ...f.options, fetchImpl, timestamps: [1] }), () => transcribeLocal({ ...f.options, fetchImpl })]) {
      await assert.rejects(task(), error => {
        assert.equal(error.code, code);
        for (const secret of ['https://', 'cookie', 'token', 'secret', CDN]) assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await filesBelow(f.root)).some(path => /\.(?:media|part)$/.test(path)), false);
  });
}

test('CDN stop classification is not hidden by a failing response-body cancellation', async t => {
  const f = await fixture(t);
  const fetchImpl = async () => ({ status: 429, body: { cancel: async () => { throw new Error(CDN); } } });
  await assert.rejects(captureFrames({ ...f.options, fetchImpl, timestamps: [1] }), error => error.code === 'RATE_LIMITED' && !error.message.includes('secret'));
});

test('preserves platform stop codes while redacting upstream messages', async t => {
  const f = await fixture(t);
  for (const code of ['NEED_LOGIN', 'LOGIN_REQUIRED', 'BAD_PART', 'PLATFORM_BLOCKED', 'RATE_LIMITED']) {
    const client = { async getMedia() { throw Object.assign(new Error('private credentials and URL'), { code }); } };
    await assert.rejects(captureFrames({ ...f.options, client, timestamps: [1] }), error => error.code === code && !error.message.includes('private'));
  }
  assert.equal(f.requests.length, 0);
});

test('runProcess has no shell and bounds stdout/stderr', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000));process.stderr.write("y".repeat(100000));']);
  assert.equal(Buffer.byteLength(result.stdout), 65536);
  assert.equal(Buffer.byteLength(result.stderr), 65536);
  const literal = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'hello; echo injected']);
  assert.equal(literal.stdout, 'hello; echo injected');
});

test('runProcess rejects nonzero exits without leaking output or arguments', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("https://private.example/secret /private/path");process.exit(7)']), error => {
    assert.equal(error.code, 'PROCESS_FAILED');
    assert.equal(error.exitCode, 7);
    assert.ok(!error.message.includes('secret'));
    assert.ok(!error.message.includes('/private/path'));
    return true;
  });
});

test('runProcess timeout kills an unresponsive process', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 100 }), { code: 'PROCESS_TIMEOUT' });
});

test('runProcess reports missing executables without paths', async () => {
  await assert.rejects(runProcess('/nonexistent/private/secret-tool', []), error => error.code === 'PROCESS_NOT_FOUND' && !error.message.includes('/nonexistent'));
});

test('doctor uses official whisper help; availability does not imply a version', async t => {
  const f = await fixture(t);
  const result = await doctor({ modelPath: f.options.modelPath, runner: f.options.runner });
  assert.deepEqual(result.ffmpeg, { available: true, version: 'ffmpeg version 7.0' });
  assert.deepEqual(result.whisper, { available: true, version: null });
  assert.deepEqual(f.probes.map(probe => probe.args), [['-version'], ['--help']]);
  assert.ok(f.probes.every(probe => probe.options.timeoutMs === 5000));
  assert.deepEqual(result.model, { available: true, name: 'ggml-model.bin' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.length, 0);
  const missing = await doctor({ ffmpegBin: '/missing/ffmpeg', whisperBin: '/missing/whisper' });
  assert.deepEqual(missing.ffmpeg, { available: false, version: null, code: 'PROCESS_NOT_FOUND' });
  assert.deepEqual(missing.whisper, { available: false, version: null, code: 'PROCESS_NOT_FOUND' });
  assert.deepEqual(missing.model, { available: false, name: null });
});

test('doctor default runner invokes a local help-only whisper mock successfully', async t => {
  const f = await fixture(t);
  const whisperBin = join(f.root, 'whisper-help-only');
  const ffmpegBin = join(f.root, 'ffmpeg-version-only');
  await writeFile(whisperBin, `#!${process.execPath}\nif (process.argv.length !== 3 || process.argv[2] !== '--help') { console.error('unknown argument'); process.exit(1); }\nconsole.error('usage: whisper-cli [options] file0 file1 ...');\n`);
  await writeFile(ffmpegBin, `#!${process.execPath}\nif (process.argv[2] !== '-version') process.exit(1);\nconsole.log('ffmpeg version 7.0');\n`);
  await chmod(whisperBin, 0o700);
  await chmod(ffmpegBin, 0o700);
  const result = await doctor({ whisperBin, ffmpegBin });
  assert.deepEqual(result.whisper, { available: true, version: null });
  assert.deepEqual(result.ffmpeg, { available: true, version: 'ffmpeg version 7.0' });
});

test('doctor only extracts recognized version banners, never an error first line', async () => {
  for (const text of ['unknown argument: --version', 'error: failed to read model', 'usage: whisper-cli [options]']) {
    const result = await doctor({ runner: async () => ({ stdout: text, stderr: '' }) });
    assert.equal(result.ffmpeg.version, null);
    assert.equal(result.whisper.version, null);
  }
  const result = await doctor({ runner: async bin => ({ stderr: bin === 'whisper-cli' ? 'whisper.cpp version 1.8\nusage: ...' : 'ffmpeg version 7.0\n' }) });
  assert.equal(result.whisper.version, 'whisper.cpp version 1.8');
});

test('doctor does not label a nonzero injected probe response as available or as a version', async () => {
  const result = await doctor({ runner: async () => ({ stdout: 'unknown argument: --version', exitCode: 1 }) });
  assert.deepEqual(result.whisper, { available: null, version: null, code: 'PROCESS_FAILED' });
  assert.deepEqual(result.ffmpeg, { available: null, version: null, code: 'PROCESS_FAILED' });
});

for (const code of ['PROCESS_TIMEOUT', 'PROCESS_FAILED']) {
  test(`doctor reports an inconclusive ${code}, not a missing executable`, async () => {
    const result = await doctor({ runner: async () => { throw Object.assign(new Error('private process data'), { code }); } });
    for (const tool of [result.ffmpeg, result.whisper]) {
      assert.deepEqual(tool, { available: null, version: null, code });
    }
    assert.equal(JSON.stringify(result).includes('private'), false);
  });
}
