import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient, BiliError } from '../skills/bili-reach/scripts/platform.mjs';

const BVID = 'BV1GJ411x7h7';
const video = { bvid: BVID, cid: 202 };
const info = {
  bvid: BVID, aid: 170001, title: '测试课程', owner: { name: '测试作者' }, duration: 300,
  pages: [{ page: 1, cid: 101, part: '第一课', duration: 100 }, { page: 2, cid: 202, part: '第二课', duration: 200 }],
};
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (data) => json({ code: 0, data });
const track = (lan = 'zh-CN', extras = {}) => ({ lan, subtitle_url: `https://aisubtitle.hdslb.com/${lan}.json`, ...extras });
const subtitleBody = { body: [{ from: 0, to: 2.5, content: '  你好  ' }, { from: 3, to: 5, content: '世界' }] };
function mock(handler, options = {}) {
  const calls = [];
  const client = new BiliClient({ ...options, fetchImpl: async (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    return handler(call, calls.length);
  } });
  return { client, calls };
}
const code = (expected) => (error) => error instanceof BiliError && error.code === expected;

test('inspect accepts BV/av IDs, full URLs, share text, and preserves selected P', async (t) => {
  for (const [input, part, aid] of [
    [BVID, 1, false], ['av170001', 1, true], [`${BVID}?p=2`, 2, false],
    [`https://www.bilibili.com/video/${BVID}/?p=2&spm_id_from=333`, 2, false],
    [`https://m.bilibili.com/video/${BVID}?p=2`, 2, false],
    [`推荐课程！ https://www.bilibili.com/video/${BVID}/?p=2 。`, 2, false],
    [`来看看 ${BVID} 这门课`, 1, false],
    [`www.bilibili.com/video/${BVID}?p=2`, 2, false],
  ]) await t.test(input, async () => {
    const { client, calls } = mock(() => ok(info));
    const result = await client.inspect(input);
    assert.equal(result.part, part);
    assert.equal(result.cid, part === 1 ? 101 : 202);
    assert.equal(result.duration, part === 1 ? 100 : 200);
    assert.equal(result.partTitle, part === 1 ? '第一课' : '第二课');
    assert.equal(result.title, '测试课程');
    assert.equal(result.author, '测试作者');
    assert.equal(result.totalParts, 2);
    assert.deepEqual(result.pages[1], { part: 2, cid: 202, title: '第二课', duration: 200 });
    assert.equal(result.url, `https://www.bilibili.com/video/${BVID}/?p=${part}`);
    assert.equal(calls[0].url.pathname, '/x/web-interface/view');
    assert.equal(calls[0].url.searchParams.get(aid ? 'aid' : 'bvid'), aid ? '170001' : BVID);
  });
});

test('explicit part overrides URL query, including invalid URL part', async () => {
  const { client } = mock(() => ok(info));
  assert.equal((await client.inspect(`${BVID}?p=2`, { part: 1 })).cid, 101);
  assert.equal((await client.inspect(`${BVID}?p=invalid`, { part: '2' })).cid, 202);
});

test('invalid and out-of-range parts never silently become P1', async (t) => {
  for (const part of [0, -1, 3, 1.5, NaN, null, '', 'abc', '02', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(part), async () => {
      const { client } = mock(() => ok(info));
      await assert.rejects(client.inspect(BVID, { part }), code('BAD_PART'));
    });
  }
  const { client } = mock(() => ok(info));
  for (const query of ['p=0', 'p=-1', 'p=3', 'p=', 'p=NaN']) await assert.rejects(client.inspect(`${BVID}?${query}`), code('BAD_PART'));
});

test('rejects unsupported URLs before any request', async () => {
  const { client, calls } = mock(() => assert.fail('must not fetch'));
  for (const input of [
    `https://evil.test/video/${BVID}`, `https://bilibili.com.evil.test/video/${BVID}`,
    `https://evil.test/?url=https://www.bilibili.com/video/${BVID}`,
    `https://www.bilibili.com@127.0.0.1/video/${BVID}`,
    `http://www.bilibili.com/video/${BVID}`, `https://www.bilibili.com:8443/video/${BVID}`,
    `https://user:password@www.bilibili.com/video/${BVID}`,
    `https://127.0.0.1/video/${BVID}`, `https://[::1]/video/${BVID}`,
    `https://api.bilibili.com/video/${BVID}`, `https://www.bilibili.com/read/${BVID}`,
    `ftp://www.bilibili.com/video/${BVID}`, `evil.test/video/${BVID}`, `//127.0.0.1/video/${BVID}`,
    '', 'not-a-video', `https://www.bilibili.com/video/${BVID}EXTRA`,
  ]) await assert.rejects(client.inspect(input), code('BAD_INPUT'));
  assert.equal(calls.length, 0);
});

test('b23 manual redirects preserve P, never leak API cookies', async () => {
  const { client, calls } = mock(({ url }) => {
    if (url.hostname === 'b23.tv') return new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${BVID}/?p=2` } });
    if (url.hostname === 'www.bilibili.com') return new Response('landing');
    return ok(info);
  }, { cookie: 'SESSDATA=secret' });
  const result = await client.inspect('分享：https://b23.tv/abc');
  assert.equal(result.cid, 202);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.equal(calls[1].init.headers.Cookie, undefined);
  assert.equal(calls[2].init.headers.Cookie, 'SESSDATA=secret');
  assert.ok(calls.every((call) => call.init.redirect === 'manual'));
});

test('short link query P is retained if landing URL lacks P; explicit P wins', async () => {
  const { client } = mock(({ url }) => url.hostname === 'b23.tv'
    ? new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${BVID}` } })
    : url.hostname === 'www.bilibili.com' ? new Response('ok') : ok(info));
  assert.equal((await client.inspect('https://b23.tv/abc?p=2')).part, 2);
  assert.equal((await client.inspect('https://b23.tv/abc?p=2', { part: 1 })).part, 1);
});

test('short links reject private, unknown, HTTP, credential and endless redirects', async () => {
  for (const location of ['https://127.0.0.1/', 'https://evil.test/', 'http://www.bilibili.com/', 'https://u:p@www.bilibili.com/']) {
    const { client, calls } = mock(() => new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(client.inspect('https://b23.tv/abc'), code('BAD_INPUT'));
    assert.equal(calls.length, 1);
  }
  const { client, calls } = mock(() => new Response(null, { status: 302, headers: { location: '/again' } }));
  await assert.rejects(client.inspect('https://b23.tv/abc'), code('API_ERROR'));
  assert.equal(calls.length, 6);
});

test('metadata rejects malformed pages and does not use top-level cid as P fallback', async () => {
  for (const data of [{ ...info, pages: [] }, { ...info, pages: [{ ...info.pages[0], cid: 0 }] }, { ...info, pages: [{ ...info.pages[0], duration: null }] }, { ...info, pages: [{ ...info.pages[0], page: 2 }] }]) {
    const { client } = mock(() => ok(data));
    await assert.rejects(client.inspect(BVID), code('API_ERROR'));
  }
});

test('subtitle chooses manual Chinese over AI Chinese and English', async () => {
  const tracks = [track('en'), track('ai-zh'), track('zh-CN', { isAI: 1 }), track('zh-Hans')];
  const { client, calls } = mock(({ url }) => url.hostname === 'api.bilibili.com' ? ok({ subtitle: { subtitles: tracks } }) : json(subtitleBody), { cookie: 'SESSDATA=secret' });
  const result = await client.getSubtitles(video);
  assert.equal(result.status, 'available');
  assert.equal(result.language, 'zh-Hans');
  assert.deepEqual(result.track, tracks[3]);
  assert.deepEqual(result.segments, [{ start: 0, end: 2.5, text: '你好' }, { start: 3, end: 5, text: '世界' }]);
  assert.deepEqual(result.raw, subtitleBody);
  assert.equal(calls[0].url.searchParams.get('cid'), '202');
  assert.equal(calls[0].init.headers.Cookie, 'SESSDATA=secret');
  assert.equal(calls[1].init.headers.Cookie, undefined);
  assert.equal(calls[1].url.pathname, '/zh-Hans.json');
});

test('AI Chinese outranks manual non-Chinese; no Chinese falls back to human foreign language', async () => {
  for (const [tracks, expected] of [[ [track('en'), track('ai-zh')], 'ai-zh' ], [ [track('ai-en'), track('ja')], 'ja' ]]) {
    const { client } = mock(({ url }) => url.hostname === 'api.bilibili.com' ? ok({ subtitle: { subtitles: tracks } }) : json(subtitleBody));
    assert.equal((await client.getSubtitles(video)).language, expected);
  }
});

test('subtitle CDN relative-protocol URLs and safe redirects work without cookies', async () => {
  const { client, calls } = mock(({ url }) => {
    if (url.hostname === 'api.bilibili.com') return ok({ subtitle: { subtitles: [track('zh', { subtitle_url: '//aisubtitle.hdslb.com/start' })] } });
    if (url.pathname === '/start') return new Response(null, { status: 302, headers: { location: 'https://subtitle.bilibili.com/end' } });
    return json(subtitleBody);
  }, { cookie: 'secret' });
  assert.equal((await client.getSubtitles(video)).status, 'available');
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every((call) => !call.init.headers.Cookie && !call.init.headers.Authorization));
});

test('subtitle none is only a successful, explicitly empty track list', async () => {
  const { client } = mock(() => ok({ subtitle: { subtitles: [] } }));
  assert.deepEqual(await client.getSubtitles(video), { status: 'none', language: null, track: null, segments: [], raw: { subtitle: { subtitles: [] } } });
  for (const data of [{}, { subtitle: {} }, { subtitle: { subtitles: null } }]) {
    const invalid = mock(() => ok(data));
    await assert.rejects(invalid.client.getSubtitles(video), code('API_ERROR'));
  }
});

test('subtitle login-required is explicit and not none', async () => {
  for (const data of [{ need_login_subtitle: true }, { need_login_subtitle: 1, subtitle: { subtitles: [] } }, { subtitle: { need_login_subtitle: true, subtitles: [] } }]) {
    const { client, calls } = mock(() => ok(data));
    assert.equal((await client.getSubtitles(video)).status, 'login-required');
    assert.equal(calls.length, 1);
  }
  const { client } = mock(() => json({ code: -101, message: '账号未登录' }));
  assert.equal((await client.getSubtitles(video)).status, 'login-required');
});

test('HTTP/API risk and rate limits stop immediately; failed requests never become none', async () => {
  const cases = [
    [() => json({}, 412), 'PLATFORM_BLOCKED'], [() => json({}, 403), 'PLATFORM_BLOCKED'],
    [() => json({}, 429), 'RATE_LIMITED'], [() => json({}, 500), 'API_ERROR'],
    [() => json({ code: -352 }), 'PLATFORM_BLOCKED'], [() => json({ code: -412 }), 'PLATFORM_BLOCKED'],
    [() => json({ code: -403 }), 'PLATFORM_BLOCKED'], [() => json({ code: -509 }), 'RATE_LIMITED'],
    [() => json({ code: -1 }), 'API_ERROR'], [() => json({ code: -400 }), 'API_ERROR'], [() => json({ code: 0 }), 'API_ERROR'],
    [() => new Response('<html>captcha</html>'), 'PLATFORM_BLOCKED'],
    [() => new Response('not json'), 'API_ERROR'],
    [() => { throw new Error('secret credentials must not escape'); }, 'NETWORK_ERROR'],
  ];
  for (const [handler, expected] of cases) {
    const { client, calls } = mock(handler);
    await assert.rejects(client.getSubtitles(video), (error) => code(expected)(error) && !error.message.includes('secret'));
    assert.equal(calls.length, 1);
  }
});

test('subtitle CDN failure or unsafe URL is not a successful empty subtitle', async () => {
  for (const url of ['https://evil.test/sub', 'https://127.0.0.1/sub', 'http://aisubtitle.hdslb.com/sub', 'https://aisubtitle.hdslb.com.evil.test/sub']) {
    const { client, calls } = mock(() => ok({ subtitle: { subtitles: [track('zh', { subtitle_url: url })] } }));
    await assert.rejects(client.getSubtitles(video), code('BAD_INPUT'));
    assert.equal(calls.length, 1);
  }
  const { client, calls } = mock(({ url }) => url.hostname === 'api.bilibili.com' ? ok({ subtitle: { subtitles: [track()] } }) : new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }));
  await assert.rejects(client.getSubtitles(video), code('BAD_INPUT'));
  assert.equal(calls.length, 2);
  for (const status of [429, 412, 500]) {
    const blocked = mock(({ url }) => url.hostname === 'api.bilibili.com' ? ok({ subtitle: { subtitles: [track()] } }) : json({}, status));
    await assert.rejects(blocked.client.getSubtitles(video), code(status === 429 ? 'RATE_LIMITED' : status === 412 ? 'PLATFORM_BLOCKED' : 'API_ERROR'));
  }
});

test('malformed subtitle bodies/segments cannot be available or none', async () => {
  for (const raw of [{}, { body: [] }, { body: [{}] }, ...[
    { from: -1, to: 2, content: 'x' }, { from: 0, to: -1, content: 'x' },
    { from: 2, to: 1, content: 'x' }, { from: 1, to: 1, content: 'x' },
    { from: 'NaN', to: 2, content: 'x' }, { from: null, to: 2, content: 'x' },
    { from: 0, to: 2, content: '' }, { from: 0, to: 2, content: '   ' },
    { from: 0, to: 2, content: 42 },
  ].map((item) => ({ body: [item] }))]) {
    const { client } = mock(({ url }) => url.hostname === 'api.bilibili.com' ? ok({ subtitle: { subtitles: [track()] } }) : json(raw));
    await assert.rejects(client.getSubtitles(video), code('API_ERROR'));
  }
});

test('getMedia chooses lowest bandwidth DASH audio with normalized backups and MIME', async () => {
  const { client, calls } = mock(() => ok({ dash: { audio: [
    { bandwidth: 190000, baseUrl: 'https://a.bilivideo.com/high.m4s' },
    { bandwidth: 64000, base_url: 'https://a.bilivideo.com/low.m4s', backup_url: ['https://b.bilivideo.cn/low.m4s'], mime_type: 'audio/mp4' },
    { bandwidth: 128000, baseUrl: 'https://a.bilivideo.com/mid.m4s' },
  ] } }));
  assert.deepEqual(await client.getMedia(video), { url: 'https://a.bilivideo.com/low.m4s', backupUrls: ['https://b.bilivideo.cn/low.m4s'], mimeType: 'audio/mp4', kind: 'audio' });
  assert.equal(calls[0].url.pathname, '/x/player/playurl');
  assert.equal(calls[0].url.searchParams.get('cid'), '202');
  assert.equal(calls[0].url.searchParams.get('fnval'), '16');
});

test('getMedia video prefers reasonable 720p and lowest bandwidth within same quality', async () => {
  const make = (height, bandwidth, name = height) => ({ width: height * 16 / 9, height, bandwidth, baseUrl: `https://a.bilivideo.com/${name}.m4s`, mimeType: 'video/mp4' });
  for (const [streams, expected] of [
    [[make(360, 1), make(1080, 10), make(720, 9), make(720, 8, '720-low')], '720-low'],
    [[make(360, 1), make(480, 10)], 480],
    [[make(1080, 10), make(2160, 20)], 1080],
  ]) {
    const { client } = mock(() => ok({ dash: { video: streams } }));
    const result = await client.getMedia(video, { kind: 'video' });
    assert.equal(result.url, `https://a.bilivideo.com/${expected}.m4s`);
    assert.equal(result.kind, 'video');
  }
});

test('single progressive video is supported but split video is not misrepresented as full media', async () => {
  const { client } = mock(() => ok({ durl: [{ url: 'https://a.bilivideo.com/video.mp4' }] }));
  assert.equal((await client.getMedia(video, { kind: 'video' })).mimeType, 'video/mp4');
  const split = mock(() => ok({ durl: [{ url: 'https://a.bilivideo.com/one.mp4' }, { url: 'https://a.bilivideo.com/two.mp4' }] }));
  await assert.rejects(split.client.getMedia(video, { kind: 'video' }), code('API_ERROR'));
  await assert.rejects(client.getMedia(video), code('API_ERROR'));
});

test('media login, previews, missing streams and unsafe URLs fail honestly', async () => {
  for (const data of [{ need_login: true }, { is_preview: 1 }, { is_preview: true }, { has_paid: false }]) {
    const { client } = mock(() => ok(data));
    await assert.rejects(client.getMedia(video), code('LOGIN_REQUIRED'));
  }
  const login = mock(() => json({ code: -101 }));
  await assert.rejects(login.client.getMedia(video), code('LOGIN_REQUIRED'));
  const missing = mock(() => ok({ dash: { audio: [] } }));
  await assert.rejects(missing.client.getMedia(video), code('API_ERROR'));
  for (const url of ['http://a.bilivideo.com/a', 'https://evil.test/a', 'https://127.0.0.1/a', 'https://u:p@a.bilivideo.com/a']) {
    const { client } = mock(() => ok({ dash: { audio: [{ baseUrl: url, bandwidth: 1 }] } }));
    await assert.rejects(client.getMedia(video), code('BAD_INPUT'));
  }
  const backups = mock(() => ok({ dash: { audio: [{ baseUrl: 'https://a.bilivideo.com/a', backupUrl: ['https://evil.test/a'] }] } }));
  await assert.rejects(backups.client.getMedia(video), code('BAD_INPUT'));
});

test('API redirects cannot move credentials to another host', async () => {
  const { client, calls } = mock(() => new Response(null, { status: 302, headers: { location: 'https://www.bilibili.com/' } }), { cookie: 'SESSDATA=secret' });
  await assert.rejects(client.inspect(BVID), code('BAD_INPUT'));
  assert.equal(calls.length, 1);
});

test('timeouts abort fetch and remain NETWORK_ERROR, never none', async () => {
  let signal;
  const { client, calls } = mock((call) => {
    signal = call.init.signal;
    return new Promise(() => {});
  }, { timeoutMs: 15 });
  await assert.rejects(client.getSubtitles(video), code('NETWORK_ERROR'));
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 1);
});

test('request timeout also cancels stalled body reads', async () => {
  let signal;
  let cancelled = false;
  const { client } = mock((call) => {
    signal = call.init.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }));
  }, { timeoutMs: 15 });
  await assert.rejects(client.getSubtitles(video), code('NETWORK_ERROR'));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('limits response bodies using both declared length and streamed bytes', async () => {
  for (const response of [
    () => json({}, 200, { 'content-length': String(5 * 1024 * 1024) }),
    () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
  ]) {
    const { client } = mock(response);
    await assert.rejects(client.inspect(BVID), code('API_ERROR'));
  }
});

test('constructor and methods validate configuration and video shape', async () => {
  for (const options of [{ fetchImpl: 1 }, { cookie: 'x\r\nInjected: y' }, { timeoutMs: 0 }, { timeoutMs: NaN }]) assert.throws(() => new BiliClient(options), code('BAD_INPUT'));
  const { client, calls } = mock(() => assert.fail('must not fetch'));
  for (const invalid of [undefined, {}, { bvid: BVID, cid: -1 }, { bvid: 'bad', cid: 1 }]) {
    await assert.rejects(client.getSubtitles(invalid), code('BAD_INPUT'));
    await assert.rejects(client.getMedia(invalid), code('BAD_INPUT'));
  }
  await assert.rejects(client.getMedia(video, { kind: 'other' }), code('BAD_INPUT'));
  assert.equal(calls.length, 0);
});
