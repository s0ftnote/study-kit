import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, loadOptions, readCookieFile, runCli, safeError } from '../skills/bili-reach/scripts/cli.mjs';

async function fixture(t) {
  const base = await realpath(tmpdir()); const root = await mkdtemp(join(base, 'bili-cli-test-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), base); assert.ok(basename(root).startsWith('bili-cli-test-')); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('frames CLI requires times and defaults to lean media retention', async () => {
  const parsed = parseArgs(['frames', 'BV1GJ411x7h7', '--frames', '90,30', '--part', '2']);
  assert.equal(parsed.action, 'frames');
  const options = await loadOptions(parsed);
  assert.deepEqual(options.frames, [30, 90]); assert.equal(options.keepMedia, false); assert.equal(options.part, 2);
  await assert.rejects(loadOptions(parseArgs(['frames', 'BV1GJ411x7h7'])), { code: 'BAD_INPUT' });
});

test('retention flags explicitly override private configuration', async (t) => {
  const root = await fixture(t); const path = join(root, 'fixture.local.json');
  await writeFile(path, JSON.stringify({ keepMedia: true, language: 'zh' }));
  assert.equal((await loadOptions(parseArgs(['collect', 'BV1GJ411x7h7', '--config', path]))).keepMedia, true);
  assert.equal((await loadOptions(parseArgs(['collect', 'BV1GJ411x7h7', '--config', path, '--no-keep-media']))).keepMedia, false);
  assert.equal((await loadOptions(parseArgs(['collect', 'BV1GJ411x7h7', '--keep-media']))).keepMedia, true);
  await writeFile(path, JSON.stringify({ keepMedia: 'false' }));
  await assert.rejects(loadOptions(parseArgs(['collect', 'BV1GJ411x7h7', '--config', path])), { code: 'BAD_INPUT' });
});

test('unknown commands/options and invalid config fields are rejected', async (t) => {
  for (const args of [[], ['unknown'], ['collect'], ['collect', 'BV1GJ411x7h7', '--upload'], ['doctor', 'extra']]) assert.throws(() => parseArgs(args), { code: 'BAD_INPUT' });
  const root = await fixture(t); const path = join(root, 'fixture.local.json');
  await writeFile(path, JSON.stringify({ cookie: 'not allowed' }));
  await assert.rejects(loadOptions(parseArgs(['collect', 'BV1GJ411x7h7', '--config', path])), { code: 'BAD_INPUT' });
});

test('doctor does not read cookie configuration or create a platform client', async () => {
  let output = '';
  const code = await runCli(['doctor', '--cookie-file', '/nonexistent/private.cookie'], {
    stdout: (s) => { output += s; }, clientFactory: () => assert.fail('must not create client'),
    doctorFn: async () => ({ whisper: { available: null, version: null, code: 'PROCESS_TIMEOUT' } }),
  });
  assert.equal(code, 0); assert.equal(JSON.parse(output).report.whisper.available, null);
});

test('frames routes directly to frames core and preserves an explicit retention choice', async () => {
  let options, output = '';
  const code = await runCli(['frames', 'BV1GJ411x7h7', '--frames', '30', '--keep-media'], {
    stdout: (s) => { output += s; }, clientFactory: () => ({}),
    collector: async (_input, value) => { options = value; return { ok: true, status: 'complete' }; },
  });
  assert.equal(code, 0); assert.equal(options.kind, 'frames'); assert.deepEqual(options.frames, [30]);
  assert.equal(options.keepMedia, true); assert.equal(JSON.parse(output).ok, true);
});

test('collect routes to transcript core without adding screenshots or retention', async () => {
  let options;
  assert.equal(await runCli(['collect', 'BV1GJ411x7h7'], { stdout: () => {}, clientFactory: () => ({}), collector: async (_input, value) => { options = value; return { ok: true }; } }), 0);
  assert.equal(options.kind, 'transcript'); assert.deepEqual(options.frames, []); assert.equal(options.keepMedia, false);
});

test('only the selected Bilibili cookies are read from a private fixture file', async (t) => {
  const root = await fixture(t); const path = join(root, 'fixture.cookie');
  await writeFile(path, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfixture-value\n.example.com\tTRUE\t/\tTRUE\t0\tOTHER\tignored\n');
  assert.equal(await readCookieFile(path), 'SESSDATA=fixture-value');
  await writeFile(path, 'SESSDATA=fixture\r\nInjected: header');
  await assert.rejects(readCookieFile(path), { code: 'BAD_INPUT' });
});

test('error codes and stop hints survive while URLs and credential values are redacted', () => {
  const result = safeError(Object.assign(new Error('https://example.invalid/?token=fixture SESSDATA=fixture-value'), { code: 'PLATFORM_BLOCKED' }));
  assert.equal(result.error.code, 'PLATFORM_BLOCKED'); assert.match(result.error.hint, /官方/);
  assert.doesNotMatch(result.error.message, /token=|fixture-value/);
});

test('bad frames and backend failures exit nonzero as JSON', async () => {
  for (const args of [['frames', 'BV1GJ411x7h7'], ['collect', 'BV1GJ411x7h7', '--part', '0']]) {
    let output = '';
    assert.equal(await runCli(args, { stdout: (s) => { output += s; }, clientFactory: () => assert.fail('must not call platform') }), 1);
    assert.equal(JSON.parse(output).error.code, 'BAD_INPUT');
  }
  let output = '';
  assert.equal(await runCli(['collect', 'BV1GJ411x7h7'], { stdout: (s) => { output += s; }, clientFactory: () => ({}), collector: async () => { throw Object.assign(new Error('rate limit'), { code: 'RATE_LIMITED' }); } }), 1);
  assert.equal(JSON.parse(output).error.code, 'RATE_LIMITED');
});

test('help and version have no platform side effects', async () => {
  for (const arg of ['--help', '--version']) {
    let output = '';
    assert.equal(await runCli([arg], { stdout: (s) => { output += s; }, clientFactory: () => assert.fail('must not call platform') }), 0);
    assert.ok(output.length > 0);
  }
});
