import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skillSource = fileURLToPath(new URL('../skills/bili-reach/', import.meta.url));

async function installedSkill(t) {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'bili-skill-install-'));
  await chmod(root, 0o700);
  const identity = await lstat(root);
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base);
    assert.ok(basename(root).startsWith('bili-skill-install-'));
    assert.equal(await realpath(root), root);
    const current = await lstat(root);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(root, { recursive: true, force: true });
  });
  const skillDir = join(root, 'installed skill');
  // Only the skill subtree is installed: no repository package.json, DSH wrapper or node_modules.
  await cp(skillSource, skillDir, { recursive: true, dereference: false, errorOnExist: true, force: false });
  const cwd = join(root, 'unrelated working directory');
  await mkdir(cwd);
  assert.deepEqual((await readdir(root)).sort(), ['installed skill', 'unrelated working directory']);
  return { root, skillDir, cwd };
}

async function inventory(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'installed resources must not depend on symlinks');
    assert.ok(!['package.json', 'node_modules'].includes(entry.name), 'skill must run without repository package metadata or dependencies');
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else {
      assert.ok(entry.isFile());
      files.push([relative(root, path), createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

function runNode(args, cwd) {
  const guard = 'globalThis.fetch = () => { throw new Error("Unexpected network access in distribution test"); };';
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`, ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('standalone skill runtime works after copying only its directory, from an unrelated cwd', async t => {
  const { skillDir, cwd } = await installedSkill(t);
  const before = await inventory(skillDir);
  const entry = join(skillDir, 'scripts/bili-reach.mjs');
  for (const [name] of before.filter(([name]) => name.endsWith('.mjs'))) {
    const file = join(skillDir, name);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), 'runtime may only import builtins or installed scripts');
      const target = await realpath(resolve(dirname(file), specifier));
      const rel = relative(skillDir, target);
      assert.ok(rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel), 'runtime import must stay inside the installed skill');
    }
  }
  assert.match(runNode([entry, '--help'], cwd), /bili-reach[\s\S]*--help/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(runNode([entry, '--version'], cwd).trim(), pkg.version);

  const probe = `
    import assert from 'node:assert/strict';
    const [cliURL, coreURL] = process.argv.slice(1);
    const cli = await import(cliURL);
    const core = await import(coreURL);
    assert.equal(typeof cli.runCli, 'function');
    assert.equal(typeof core.collect, 'function');
    assert.deepEqual(core.parseTimestamps('90,30'), [30, 90]);
    assert.equal((await cli.loadOptions(cli.parseArgs(['inspect', 'BV1GJ411x7h7']))).asr, 'local');
    let output = '', doctorCalls = 0;
    const code = await cli.runCli(['doctor', '--cookie-file', 'must-not-be-read.cookie'], {
      stdout: text => { output += text; },
      clientFactory: () => assert.fail('doctor must not create a network client'),
      collector: () => assert.fail('doctor must not create materials'),
      doctorFn: async () => { doctorCalls++; return { mocked: true }; },
    });
    assert.equal(code, 0);
    assert.equal(doctorCalls, 1);
    assert.deepEqual(JSON.parse(output), { ok: true, report: { mocked: true } });
    console.log(JSON.stringify({ version: core.VERSION, imported: true }));
  `;
  const output = runNode(['--input-type=module', '-e', probe,
    pathToFileURL(join(skillDir, 'scripts/cli.mjs')).href,
    pathToFileURL(join(skillDir, 'scripts/pipeline.mjs')).href], cwd);
  assert.deepEqual(JSON.parse(output), { version: pkg.version, imported: true });
  assert.deepEqual(await readdir(cwd), [], 'help, version, imports and mocked doctor must not create materials');
  assert.deepEqual(await inventory(skillDir), before, 'installed resources must remain unchanged');
});

test('copied skill Markdown links need no files outside the installation', async t => {
  const { skillDir } = await installedSkill(t);
  const files = await inventory(skillDir);
  let checked = 0;
  for (const [name] of files.filter(([name]) => name.endsWith('.md'))) {
    const file = join(skillDir, name);
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
      const link = match[1] ?? match[2];
      if (/^https?:\/\//.test(link) || link.startsWith('#')) continue;
      const localPath = decodeURIComponent(link.split('#')[0]);
      assert.ok(!isAbsolute(localPath), 'installed links must be relative');
      const target = resolve(dirname(file), localPath);
      const inside = path => {
        const rel = relative(skillDir, path);
        assert.ok(rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel), `link escapes installed skill: ${name}: ${link}`);
      };
      inside(target);
      inside(await realpath(target));
      assert.ok((await stat(target)).isFile(), `missing installed reference: ${name}: ${link}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'installed documentation must include checked local references');
});
