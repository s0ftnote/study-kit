import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BiliClient } from '../skills/bili-reach/scripts/platform.mjs';
import { collect } from '../skills/bili-reach/scripts/pipeline.mjs';
import { readCookieFile, safeError } from '../skills/bili-reach/scripts/cli.mjs';
import { doctor } from '../skills/bili-reach/scripts/media.mjs';

export const name = 'study-kit';
export const bundledSkills = ['bili-reach', 'study-wiki', 'study-practice'];
export const inject = ['tools', 'skills'];

/** Host-only adapter; CLI/core never import the host SDK. Output root is admin config, not a model argument. */
export async function registerTools(ctx, config = {}, defineTool, services = {}) {
  const outputRoot = resolve(config.outputRoot ?? join(homedir(), '.bili-reach', 'materials'));
  const clientFactory = services.clientFactory ?? ((options) => new BiliClient(options));
  const collector = services.collector ?? collect;
  const doctorFn = services.doctorFn ?? doctor;
  ctx.tools.register(defineTool({
    name: 'bili_material',
    description: 'B站课程素材：inspect核对指定分P；collect优先平台字幕、明确无字幕才本地转写，可附截图；frames仅截图，完全不读字幕或转写。不会总结、读图或更新学习状态。',
    parameters: {
      action: { type: 'string', enum: ['doctor', 'inspect', 'collect', 'frames'], required: true, description: '操作' },
      url: { type: 'string', description: 'BV/av/完整B站链接；inspect/collect/frames必填' },
      part: { type: 'integer', description: '指定分P，须为正安全整数；不指定则取URL中的p或P1' },
      asr: { type: 'string', enum: ['none', 'local'], description: '仅collect：无字幕时是否本地转写，默认local' },
      frames: { type: 'array', items: { type: 'number' }, description: '最多12个有限非负秒数；frames操作必填且非空；collect默认不截图' },
      refresh: { type: 'boolean', description: '显式新建版本，不覆盖旧素材' },
      keepMedia: { type: 'boolean', description: '仅用户明确要求保留大媒体时设为true；否则省略，沿用管理员配置（默认false）' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: 2_000_000,
    async execute(args) {
      try {
        const bad = (message) => { throw Object.assign(new Error(message), { code: 'BAD_INPUT' }); };
        if (!args || typeof args !== 'object' || Array.isArray(args) || !['doctor', 'inspect', 'collect', 'frames'].includes(args.action)) bad('未知操作。');
        // The host DSL has no numeric bounds or array-size constraints. Validate before cookie access or client creation.
        if (args.part !== undefined && (!Number.isSafeInteger(args.part) || args.part <= 0)) bad('part 须为正安全整数。');
        if (args.frames !== undefined && (!Array.isArray(args.frames) || args.frames.length > 12 ||
          Array.from(args.frames).some((time) => typeof time !== 'number' || !Number.isFinite(time) || time < 0))) bad('frames 须为最多12个有限非负秒数。');
        if (args.action === 'frames' && !args.frames?.length) bad('frames 操作须提供至少一个截图秒数。');
        if (args.keepMedia !== undefined && typeof args.keepMedia !== 'boolean') bad('keepMedia 须为boolean。');
        if (args.refresh !== undefined && typeof args.refresh !== 'boolean') bad('refresh 须为boolean。');
        if (args.asr !== undefined && !['none', 'local'].includes(args.asr)) bad('asr 仅支持 none 或 local。');
        if (args.action === 'doctor') return { ok: true, report: await doctorFn({ modelPath: config.model, ffmpegBin: config.ffmpegBin, whisperBin: config.whisperBin }) };
        if (typeof args.url !== 'string' || !args.url.trim()) bad('请提供视频链接。');
        if (config.keepMedia !== undefined && typeof config.keepMedia !== 'boolean') bad('管理员配置 keepMedia 须为boolean。');
        const client = clientFactory({ cookie: await readCookieFile(config.cookieFile) });
        if (args.action === 'inspect') return { ok: true, video: await client.inspect(args.url, { part: args.part }) };
        const kind = args.action === 'frames' ? 'frames' : 'transcript';
        // Only these fields cross into the core. Arbitrary output paths, clients or process/network overrides from args are ignored.
        const result = await collector(args.url, { client, output: outputRoot, part: args.part, kind,
          ...(kind === 'transcript' ? { asr: args.asr ?? config.asr ?? 'local', model: config.model,
            language: config.language ?? 'zh', glossary: config.glossary ?? [], whisperBin: config.whisperBin } : {}),
          frames: args.frames, refresh: args.refresh === true, keepMedia: args.keepMedia ?? config.keepMedia ?? false,
          ffmpegBin: config.ffmpegBin });
        // Keep full transcripts on disk, not in every model context.
        return { ok: true, kind, status: result.status, cached: result.cached, runDir: result.runDir, manifestPath: result.manifestPath,
          video: result.manifest.video, source: result.manifest.source, frames: result.manifest.frames };
      } catch (error) { return safeError(error); }
    },
  }));
}

export async function registerBundledSkill(ctx) {
  for (const skill of bundledSkills) {
    const skillDir = fileURLToPath(new URL(`../skills/${skill}/`, import.meta.url));
    const path = join(skillDir, 'SKILL.md');
    const content = await readFile(path, 'utf8');
    // Bundled skills use plain, single-line frontmatter; keep each trigger in one place.
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    const description = /^description:[ \t]*(.+)$/m.exec(header ?? '')?.[1]?.trim();
    if (!description) throw new Error(`Bundled skill ${skill} requires a single-line description.`);
    ctx.skills.register({ name: skill, description, content, source: 'bundled', path,
      resourceBase: { kind: 'directory', path: skillDir } });
  }
}

export async function apply(ctx, config = {}) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  await registerTools(ctx, config, defineTool);
  await registerBundledSkill(ctx);
}
export default { name, inject, apply };
