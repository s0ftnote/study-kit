import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadOptions, runCli } from '../skills/bili-reach/scripts/cli.mjs';
import { registerBundledSkill, bundledSkills } from '../dsh/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillDir = resolve(root, 'skills/bili-reach');
const skillPath = resolve(skillDir, 'SKILL.md');

async function markdownBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownBelow(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function frontmatter(content) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  assert.ok(header, 'skill must start with frontmatter');
  return Object.fromEntries(header.split(/\r?\n/).map(line => {
    const match = /^([a-z-]+):[ \t]*(.+)$/.exec(line);
    assert.ok(match, 'bundled frontmatter uses plain single-line fields');
    return [match[1], match[2].trim()];
  }));
}

test('Bilibili skill is discoverable from its canonical description', async () => {
  const meta = frontmatter(await readFile(skillPath, 'utf8'));
  assert.equal(meta.name, 'bili-reach');
  assert.match(meta.description, /分析/);
  assert.match(meta.description, /讲解/);
  assert.match(meta.description, /讲稿/);
  assert.match(meta.description, /截图/);
  assert.notEqual(meta['disable-model-invocation'], 'true');
});

test('every bundled skill has a canonical name and description', async () => {
  for (const name of bundledSkills) {
    const meta = frontmatter(await readFile(resolve(root, 'skills', name, 'SKILL.md'), 'utf8'));
    assert.equal(meta.name, name);
    assert.ok(meta.description.length > 0);
  }
});

test('skill reference links resolve inside the installed skill, not the repository', async () => {
  for (const name of bundledSkills) {
  const skillDir = resolve(root, 'skills', name);
  for (const file of await markdownBelow(skillDir)) {
    const content = await readFile(file, 'utf8');
    for (const match of content.replace(/`[^`\n]*`/g, "").matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
      const link = match[1] ?? match[2];
      if (/^https?:\/\//.test(link) || link.startsWith('#')) continue;
      const localPath = decodeURIComponent(link.split('#')[0]);
      assert.ok(!isAbsolute(localPath), 'reference must be relative to the installed skill');
      const target = resolve(dirname(file), localPath);
      for (const path of [target, await realpath(target)]) {
        const rel = relative(skillDir, path);
        assert.ok(rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel), 'reference must stay inside the installed skill');
      }
      assert.ok((await stat(target)).isFile(), `missing reference from ${relative(skillDir, file)}`);
    }
  }
  }
});

test('documented skill CLI commands parse without network, models or credentials', async () => {
  let checked = 0;
  for (const file of await markdownBelow(skillDir)) {
    const content = await readFile(file, 'utf8');
    for (const block of content.matchAll(/```sh\r?\n([\s\S]*?)```/g)) {
      for (const line of block[1].split(/\r?\n/)) {
        const tokens = [...line.trim().matchAll(/'([^']*)'|"([^"]*)"|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
        if (tokens[0] !== 'node') continue;
        assert.equal(tokens[1], '<skill目录>/scripts/bili-reach.mjs', 'examples must run the installed skill entry');
        // Keep the executable path intact; substitute placeholders only in CLI arguments.
        const args = tokens.slice(2).map(arg => arg.replace(/<P>/g, '2')
          .replace(/<BV或URL>/g, 'BV1GJ411x7h7')
          .replace(/<[^>]+>/g, '/private/fixture'));
        const parsed = parseArgs(args);
        if (!parsed.help && !parsed.version) await loadOptions(parsed);
        checked++;
      }
    }
  }
  assert.ok(checked >= 6, 'main flow and acquisition branches must have checked examples');
});

test('documented supplemental frames command selects frames-only collection with refresh', async () => {
  const content = await readFile(resolve(skillDir, 'references/acquisition.md'), 'utf8');
  const line = content.split(/\r?\n/).find(line => line.startsWith('node ') && line.includes(' frames ') && line.includes('--refresh'));
  assert.ok(line, 'supplemental frames must have an executable example');
  const tokens = [...line.matchAll(/'([^']*)'|"([^"]*)"|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
  const args = tokens.slice(2).map(arg => arg.replace(/<P>/g, '2')
    .replace(/<BV或URL>/g, 'BV1GJ411x7h7').replace(/<[^>]+>/g, '/private/fixture'));
  let calls = 0, output = '';
  const code = await runCli(args, {
    stdout: value => { output += value; },
    clientFactory: () => ({ inspect: () => assert.fail('CLI must not add a separate inspect before collection') }),
    doctorFn: () => assert.fail('supplemental frames must not invoke ASR environment checks'),
    collector: async (input, options) => {
      calls++;
      assert.equal(input, 'BV1GJ411x7h7');
      assert.equal(options.kind, 'frames');
      assert.equal(options.part, 2);
      assert.equal(options.refresh, true);
      assert.deepEqual(options.frames, [32, 92]);
      assert.equal(options.model, undefined);
      return { ok: true, status: 'complete' };
    },
  });
  assert.equal(code, 0, output);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(output).status, 'complete');
});

test('DSH registers the skill description and resource base from the bundled file', async () => {
  const registrations = [];
  await registerBundledSkill({ skills: { register: skill => registrations.push(skill) } });
  assert.deepEqual(registrations.map(skill => skill.name), bundledSkills);
  const skill = registrations[0];
  const content = await readFile(skillPath, 'utf8');
  assert.equal(skill.name, frontmatter(content).name);
  assert.equal(skill.description, frontmatter(content).description);
  assert.equal(skill.content, content);
  assert.equal(skill.path, skillPath);
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.equal(resolve(skill.resourceBase.path), skillDir);
});
