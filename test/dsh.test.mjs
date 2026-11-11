import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTools } from '../dsh/index.mjs';

const input = 'BV1GJ411x7h7';
const video = { bvid: input, cid: 7, part: 2, title: '离线示例', duration: 120, url: `https://www.bilibili.com/video/${input}?p=2` };
const source = { type: 'platform-subtitle', provider: 'bilibili', language: 'zh' };
const result = {
  ok: true, status: 'complete', cached: false, runDir: '/fixture/materials/run', manifestPath: '/fixture/materials/run/manifest.json',
  manifest: { video, source, frames: [{ time: 0, path: 'frames/0.png' }], segments: [{ start: 0, end: 1, text: '正文不可进入工具结果' }], raw: '不可进入工具结果' },
  transcript: '全文不可进入工具结果',
};

// Deliberately validate the author payload, rather than using an identity mock
// that would accept unsupported SDK keywords. Actual SDK compilation is tested below when configured.
function assertPayload(payload) {
  assert.equal(payload.name, 'bili_material');
  assert.equal(typeof payload.execute, 'function');
  assert.equal(typeof payload.output.render, 'function');
  assert.deepEqual(payload.output.schema, { type: 'json' });
  assert.equal(payload.timeoutMs, 2_000_000);
  assert.deepEqual(Object.keys(payload.parameters).sort(), ['action', 'asr', 'frames', 'keepMedia', 'part', 'refresh', 'url']);
  assert.deepEqual(payload.parameters.action.enum, ['doctor', 'inspect', 'collect', 'frames']);
  assert.equal(payload.parameters.action.required, true);
  assert.equal(payload.parameters.part.type, 'integer');
  assert.equal(payload.parameters.frames.type, 'array');
  assert.deepEqual(payload.parameters.frames.items, { type: 'number' });
  assert.equal(payload.parameters.keepMedia.type, 'boolean');
  assert.ok(!Object.hasOwn(payload.parameters.keepMedia, 'default'), 'retention must not be silently enabled');
  assert.match(payload.parameters.keepMedia.description, /用户明确/);
  for (const schema of Object.values(payload.parameters)) {
    const allowed = schema.type === 'array'
      ? ['type', 'items', 'description', 'required']
      : ['type', 'enum', 'description', 'required'];
    for (const key of Object.keys(schema)) assert.ok(allowed.includes(key), `unsupported DSL keyword: ${key}`);
  }
}

async function fixture(config = {}, overrides = {}) {
  const calls = { clients: [], inspect: [], collect: [], doctor: [] };
  const client = { async inspect(...args) { calls.inspect.push(args); return video; } };
  const registrations = [];
  let payload;
  const services = {
    clientFactory(options) { calls.clients.push(options); return client; },
    async collector(...args) { calls.collect.push(args); return result; },
    async doctorFn(options) { calls.doctor.push(options); return { ready: true }; },
    ...overrides,
  };
  await registerTools({ tools: { register(tool) { registrations.push(tool); } } }, config, options => {
    assertPayload(options);
    payload = options;
    return { ...options, compiledByMock: true };
  }, services);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].compiledByMock, true, 'register the defineTool result, not its raw author payload');
  return { tool: registrations[0], payload, calls, client };
}

test('offline registration validates author payload; real host permissions/cancellation are not exercised', async () => {
  const { tool } = await fixture();
  assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{\n  "ok": true\n}' }]);
});

test('package root self-import exposes apply and independent ./core exposes collect without loading a host SDK', async () => {
  const root = await import('@s0ftnote/bili-reach');
  const alias = await import('@s0ftnote/bili-reach/dsh');
  const core = await import('@s0ftnote/bili-reach/core');
  assert.equal(typeof root.apply, 'function');
  assert.equal(root.default.apply, root.apply);
  assert.equal(root.apply, alias.apply);
  assert.equal(typeof core.collect, 'function');
  assert.equal(core.apply, undefined);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.main, './dsh/index.mjs');
  assert.equal(pkg.exports['.'], pkg.main);
  assert.equal(pkg.exports['./core'], './skills/bili-reach/scripts/pipeline.mjs');
  assert.equal(pkg.bin['bili-reach'], './skills/bili-reach/scripts/bili-reach.mjs');
  assert.ok(pkg.files.includes('skills/'));
  assert.ok(!pkg.files.some(path => ['src/', 'bin/'].includes(path)));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.equal(pkg.peerDependencies['@deepseek-ai/schemastery'], undefined);
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true);
});

test('doctor uses only allowed admin tool settings and never reads a cookie or creates a client', async () => {
  const { tool, calls } = await fixture({ cookieFile: '/fixture/does-not-exist.cookie', model: '/fixture/model', ffmpegBin: '/fixture/ffmpeg', whisperBin: '/fixture/whisper' });
  assert.deepEqual(await tool.execute({ action: 'doctor', cookieFile: '/ignored', model: '/ignored' }), { ok: true, report: { ready: true } });
  assert.deepEqual(calls.doctor, [{ modelPath: '/fixture/model', ffmpegBin: '/fixture/ffmpeg', whisperBin: '/fixture/whisper' }]);
  assert.deepEqual(calls.clients, []);
  assert.deepEqual(calls.collect, []);
});

test('inspect passes only video input and part, without collecting', async () => {
  const { tool, calls } = await fixture();
  assert.deepEqual(await tool.execute({ action: 'inspect', url: input, part: 2, output: '/ignored' }), { ok: true, video });
  assert.deepEqual(calls.clients, [{ cookie: '' }]);
  assert.deepEqual(calls.inspect, [[input, { part: 2 }]]);
  assert.deepEqual(calls.collect, []);
});

test('collect defaults to transcript kind and returns metadata/paths, never full content', async () => {
  const { tool, calls, client } = await fixture();
  const response = await tool.execute({ action: 'collect', url: input });
  assert.deepEqual(calls.collect, [[input, {
    client, output: resolve(join(homedir(), '.bili-reach', 'materials')), part: undefined, kind: 'transcript',
    asr: 'local', model: undefined, language: 'zh', glossary: [], whisperBin: undefined,
    frames: undefined, refresh: false, keepMedia: false, ffmpegBin: undefined,
  }]]);
  assert.deepEqual(response, { ok: true, kind: 'transcript', status: 'complete', cached: false,
    runDir: result.runDir, manifestPath: result.manifestPath, video, source, frames: result.manifest.frames });
  assert.doesNotMatch(JSON.stringify(response), /正文|全文|不可进入/);
  assert.equal(Object.hasOwn(response, 'manifest'), false);
});

test('collect permits requested frames and only whitelisted args; paths and execution settings remain admin-controlled', async () => {
  const config = { outputRoot: './admin-materials', asr: 'local', model: '/admin/model', language: 'zh-CN', glossary: ['术语'], ffmpegBin: '/admin/ffmpeg', whisperBin: '/admin/whisper' };
  const { tool, calls, client } = await fixture(config);
  await tool.execute({ action: 'collect', url: input, part: 2, asr: 'none', frames: [0, 2.5], refresh: true, keepMedia: true,
    output: '/untrusted', outputRoot: '/untrusted', model: '/untrusted', cookie: 'untrusted', cookieFile: '/untrusted',
    language: 'en', glossary: ['untrusted'], ffmpegBin: '/untrusted', whisperBin: '/untrusted',
    client: {}, transcriber: 'untrusted', fetchImpl: 'untrusted', runner: 'untrusted', signal: 'untrusted', kind: 'frames' });
  assert.deepEqual(calls.collect, [[input, {
    client, output: resolve('./admin-materials'), part: 2, kind: 'transcript', asr: 'none', model: config.model,
    language: config.language, glossary: config.glossary, whisperBin: config.whisperBin,
    frames: [0, 2.5], refresh: true, keepMedia: true, ffmpegBin: config.ffmpegBin,
  }]]);
});

test('frames action selects screenshot-only collection without forwarding any transcript/ASR options', async () => {
  const { tool, calls, client } = await fixture({ outputRoot: './admin-materials', asr: 'local', model: '/unused', glossary: ['unused'], whisperBin: '/unused' });
  const response = await tool.execute({ action: 'frames', url: input, frames: [0, 0.5], part: 1, asr: 'local' });
  assert.equal(response.kind, 'frames');
  assert.deepEqual(calls.collect, [[input, {
    client, output: resolve('./admin-materials'), part: 1, kind: 'frames', frames: [0, 0.5], refresh: false, keepMedia: false, ffmpegBin: undefined,
  }]]);
  assert.deepEqual(calls.inspect, []);
  assert.deepEqual(calls.doctor, []);
});

test('keepMedia is false by default, allows admin default and explicit boolean overrides only', async () => {
  for (const [config, args, expected] of [
    [{}, {}, false], [{ keepMedia: true }, {}, true], [{ keepMedia: true }, { keepMedia: false }, false],
    [{ keepMedia: false }, { keepMedia: true }, true],
  ]) {
    const { tool, calls } = await fixture(config);
    assert.equal((await tool.execute({ action: 'collect', url: input, ...args })).ok, true);
    assert.equal(calls.collect[0][1].keepMedia, expected);
  }
});

test('valid frame bounds accept zero, fractional seconds and 12 requests without coercion', async () => {
  const { tool, calls } = await fixture();
  const frames = Array.from({ length: 12 }, (_, i) => i / 2);
  assert.equal((await tool.execute({ action: 'frames', url: input, part: Number.MAX_SAFE_INTEGER, frames })).ok, true);
  assert.deepEqual(calls.collect[0][1].frames, frames);
});

test('invalid args fail before cookie access, clientFactory or collector (including with an identity SDK mock)', async t => {
  const cases = [
    ['null args', null], ['array args', []], ['unknown action', { action: 'unknown' }],
    ...[undefined, '', 7].map(url => ['missing/invalid URL', { action: 'collect', url }]),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '2', null, true].map(part => ['bad part', { action: 'inspect', url: input, part }]),
    ...[null, '1,2', {}, [NaN], [Infinity], [-1], ['0'], [null], [false], Array(1), Array(13).fill(0)].map(frames => ['bad frames', { action: 'collect', url: input, frames }]),
    ['frames omitted', { action: 'frames', url: input }], ['empty frames', { action: 'frames', url: input, frames: [] }],
    ...['true', 'false', 0, 1, null, {}].map(keepMedia => ['bad keepMedia', { action: 'collect', url: input, keepMedia }]),
    ['bad refresh', { action: 'collect', url: input, refresh: 'true' }],
    ['bad ASR', { action: 'collect', url: input, asr: 'cloud' }],
  ];
  for (const [label, args] of cases) await t.test(label, async () => {
    const { tool, calls } = await fixture({ cookieFile: '/fixture/does-not-exist.cookie' });
    const response = await tool.execute(args);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'BAD_INPUT');
    assert.deepEqual(calls.clients, []);
    assert.deepEqual(calls.collect, []);
  });
  for (const keepMedia of ['true', null, 1]) {
    const { tool, calls } = await fixture({ keepMedia });
    assert.equal((await tool.execute({ action: 'collect', url: input })).error.code, 'BAD_INPUT');
    assert.deepEqual(calls.clients, []);
  }
});

test('network, login, risk, rate-limit, cache and cancellation states survive safeError without leaking secrets', async () => {
  for (const code of ['NETWORK_ERROR', 'NEED_LOGIN', 'LOGIN_REQUIRED', 'PLATFORM_BLOCKED', 'RATE_LIMITED', 'CACHE_OPTIONS_CHANGED', 'NEED_SETUP', 'ABORTED']) {
    const { tool } = await fixture({}, { collector: async () => { throw Object.assign(new Error('https://private.example/media?token=secret Cookie=private-cookie SESSDATA=secret-session'), { code }); } });
    const response = await tool.execute({ action: 'collect', url: input });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, code);
    assert.doesNotMatch(JSON.stringify(response), /private\.example|private-cookie|secret-session|token=secret/);
  }
  const { tool } = await fixture({}, { clientFactory() { throw Object.assign(new Error('stopped'), { code: 'RATE_LIMITED' }); } });
  assert.equal((await tool.execute({ action: 'inspect', url: input })).error.code, 'RATE_LIMITED');
});

// Opt in with an importable SDK module file/URL, including a normal source module.
// No machine-specific SDK paths, dependencies, profile registration or collection are required.
const sdkModule = process.env.DSH_TOOLS_MODULE;
test('real DSH SDK compiles and registers the tool offline (registration only)', {
  skip: sdkModule ? false : 'DSH_TOOLS_MODULE is unset; point it to an importable SDK module file or file: URL to run real SDK compilation.',
}, async () => {
  const sdk = await import(sdkModule.startsWith('file:') ? sdkModule : pathToFileURL(resolve(sdkModule)).href);
  assert.equal(typeof sdk.defineTool, 'function');
  const registrations = [];
  const neverRun = () => { assert.fail('registration must not execute collection, network, doctor or clientFactory'); };
  await registerTools({ tools: { register(tool) { registrations.push(tool); } } }, {}, sdk.defineTool, {
    clientFactory: neverRun, collector: neverRun, doctorFn: neverRun,
  });
  assert.equal(registrations.length, 1);
  const tool = registrations[0];
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.deepEqual(tool.parameters.properties.action.enum, ['doctor', 'inspect', 'collect', 'frames']);
  assert.equal(tool.parameters.properties.part.type, 'integer');
  assert.deepEqual(tool.parameters.properties.frames.items, { type: 'number' });
  assert.equal(tool.parameters.properties.keepMedia.type, 'boolean');
  assert.deepEqual(tool.output.schema, {});
  assert.equal(typeof tool.execute, 'function');
});
