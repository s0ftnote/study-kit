#!/usr/bin/env node
// 从学科总览生成 Obsidian 白板（JSON Canvas）导图。零依赖，Node 18+。
//   node mindmap.mjs --overview <学科总览.md> --out <导图.canvas>
//   node mindmap.mjs --overview <学科总览.md> --progress <进度.md> --out <薄弱点.canvas>
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `用法：
  node mindmap.mjs --overview <学科总览.md> --out <输出.canvas> [--progress <进度.md>]

  --overview  学科总览。二级标题是章节，三级标题是专题，列表里的第一个 [[链接]] 是知识点
  --out       输出的 .canvas 文件
  --progress  可选。只画进度表里练过的知识点并上色：要重温为橙色，会了为绿色`;

// 库规则.md 里的小节名和状态词换了，这两处跟着改
const SKIP_SECTIONS = new Set(['来源']);
const SIZE = [
  { width: 200, height: 70 },  // 学科
  { width: 200, height: 56 },  // 章节
  { width: 220, height: 56 },  // 专题
  { width: 260, height: 56 },  // 知识点
];
const GAP_X = 90;
const GAP_Y = 18;
const COLOR = { 要重温: '2', 会了: '4' };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--overview', '--out', '--progress'].includes(key)) fail(`不认识的参数：${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${key} 后面缺少值`);
    args[key.slice(2)] = value;
    i += 1;
  }
  if (!args.overview || !args.out) fail('需要 --overview 和 --out');
  if (resolve(args.overview) === resolve(args.out)) fail('--out 不能和 --overview 是同一个文件');
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

// [[名字]]、[[名字|显示]]、[[名字#小节]]，表格里的 \| 也算
function firstLink(text) {
  const match = text.match(/\[\[([^\]\n]+?)\]\]/);
  if (!match) return null;
  return match[1].split(/\\?\|/)[0].split('#')[0].trim() || null;
}

export function parseOverview(markdown) {
  const root = { label: '总览', depth: 0, children: [] };
  let chapter = null;
  let topic = null;
  let skipping = false;
  let inFence = false;
  let inFrontmatter = false;
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index === 0 && line.trim() === '---') { inFrontmatter = true; return; }
    if (inFrontmatter) { if (line.trim() === '---') inFrontmatter = false; return; }
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1) {
        root.label = text.replace(/\s*总览$/, '') || text;
      } else if (level === 2) {
        skipping = SKIP_SECTIONS.has(text);
        topic = null;
        chapter = skipping ? null : { label: text, depth: 1, children: [] };
        if (chapter) root.children.push(chapter);
      } else if (!skipping && chapter) {
        topic = { label: text, depth: 2, children: [] };
        chapter.children.push(topic);
      }
      return;
    }
    if (skipping) return;
    const item = line.match(/^\s*[-*+]\s+(.*)$/);
    if (!item) return;
    const name = firstLink(item[1]);
    if (!name) return;
    (topic ?? chapter ?? root).children.push({ label: name, depth: 3, link: name, children: [] });
  });
  return root;
}

export function parseProgress(markdown) {
  const status = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const name = firstLink(line);
    if (!name) continue;
    const cells = line.split(/(?<!\\)\|/).map(cell => cell.trim());
    const found = Object.keys(COLOR).find(word => cells.includes(word));
    if (found) status.set(name, found);
  }
  return status;
}

function nodeId(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

// 叶子从上到下排开，父节点放在子节点的正中间
function layout(root) {
  const columnX = [];
  let x = 0;
  for (const size of SIZE) { columnX.push(x); x += size.width + GAP_X; }
  let cursor = 0;
  const place = (node, path) => {
    const size = SIZE[node.depth];
    node.id = nodeId(path);
    node.x = columnX[node.depth];
    node.width = size.width;
    node.height = size.height;
    if (node.children.length === 0) {
      node.y = cursor;
      cursor += size.height + GAP_Y;
      return;
    }
    const seen = new Map();
    for (const child of node.children) {
      const count = (seen.get(child.label) ?? 0) + 1;
      seen.set(child.label, count);
      place(child, `${path}/${child.label}${count > 1 ? `#${count}` : ''}`);
    }
    const first = node.children[0];
    const last = node.children[node.children.length - 1];
    node.y = Math.round((first.y + last.y + last.height) / 2 - size.height / 2);
    cursor = Math.max(cursor, node.y + size.height + GAP_Y);
  };
  place(root, root.label);
}

function nodeText(node) {
  if (node.depth === 0) return `## ${node.label}`;
  if (node.depth === 1) return `**${node.label}**`;
  if (node.link) return `[[${node.link}]]`;
  return node.label;
}

export function buildCanvas(root, status = new Map()) {
  layout(root);
  const nodes = [];
  const edges = [];
  const visit = node => {
    const entry = { id: node.id, type: 'text', text: nodeText(node), x: node.x, y: node.y, width: node.width, height: node.height };
    const color = node.link ? COLOR[status.get(node.link)] : undefined;
    if (color) entry.color = color;
    nodes.push(entry);
    for (const child of node.children) {
      edges.push({ id: nodeId(`${node.id}->${child.id}`), fromNode: node.id, fromSide: 'right', toNode: child.id, toSide: 'left' });
      visit(child);
    }
  };
  visit(root);
  return { nodes, edges };
}

// 薄弱点图只留练过的知识点，空掉的专题和章节一起去掉
export function keepPracticed(node, status) {
  node.children = node.children.filter(child => {
    if (child.link) return status.has(child.link);
    keepPracticed(child, status);
    return child.children.length > 0;
  });
}

function countPoints(node) {
  return (node.link ? 1 : 0) + node.children.reduce((sum, child) => sum + countPoints(child), 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${USAGE}\n`); return; }
  let overview;
  try {
    overview = await readFile(args.overview, 'utf8');
  } catch {
    process.stderr.write(`读不到总览：${args.overview}\n`);
    process.exit(1);
  }
  const root = parseOverview(overview);
  if (countPoints(root) === 0) {
    process.stderr.write('总览里没有找到知识点。知识点要写成列表项，并以 [[链接]] 开头。\n');
    process.exit(1);
  }
  let status = new Map();
  let unmatched = [];
  if (args.progress) {
    try {
      status = parseProgress(await readFile(args.progress, 'utf8'));
    } catch {
      process.stderr.write(`读不到进度：${args.progress}\n`);
      process.exit(1);
    }
    const known = new Set();
    const collect = node => { if (node.link) known.add(node.link); node.children.forEach(collect); };
    collect(root);
    unmatched = [...status.keys()].filter(name => !known.has(name));
    keepPracticed(root, status);
    if (countPoints(root) === 0) {
      process.stderr.write('进度表里还没有练过的知识点（状态要写成“要重温”或“会了”，名字要和总览里的一致）。\n');
      process.exit(1);
    }
  }
  const points = countPoints(root);
  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true });
  const canvas = buildCanvas(root, status);
  await writeFile(out, `${JSON.stringify(canvas, null, '\t')}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    out,
    subject: root.label,
    points,
    colored: canvas.nodes.filter(node => node.color).length,
    // 进度表里有、总览里找不到的名字：多半是改名后漏改了链接
    unmatched,
  })}\n`);
}

// 比较真实路径：skill 经符号链接安装时也能跑
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
