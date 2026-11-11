import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadOptions } from '../skills/bili-reach/scripts/cli.mjs';
import { registerBundledSkill } from '../dsh/index.mjs';

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
  assert.ok(meta.description.length > 0);
  assert.notEqual(meta['disable-model-invocation'], 'true');
});

test('skill reference links resolve inside the installed skill, not the repository', async () => {
  for (const file of await markdownBelow(skillDir)) {
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
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

test('DSH registers the skill description and resource base from the bundled file', async () => {
  const registrations = [];
  await registerBundledSkill({ skills: { register: skill => registrations.push(skill) } });
  assert.equal(registrations.length, 1);
  const skill = registrations[0];
  const content = await readFile(skillPath, 'utf8');
  assert.equal(skill.name, frontmatter(content).name);
  assert.equal(skill.description, frontmatter(content).description);
  assert.equal(skill.content, content);
  assert.equal(skill.path, skillPath);
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.equal(resolve(skill.resourceBase.path), skillDir);
});
