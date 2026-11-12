/**
 * Minimal Bilibili public-API client (Node >=22, no runtime dependencies).
 * API flow references: CZX2244/dsh-bilibili lib/extractor.js and
 * Panniantong/Agent-Reach agent_reach/channels/bilibili.py (MIT).
 * Pinned sources and notices: ../THIRD_PARTY_NOTICES.md.
 * Independently implemented: no retries on risk control, no ASR/browser/login/download.
 */
const API = 'https://api.bilibili.com';
const BV = /^BV[0-9A-Za-z]{10}$/;
const WEB_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv', 'www.b23.tv']);
const CDN_DOMAINS = ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'biliapi.net'];
const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; study-kit/1.0)';

export class BiliError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new BiliError(code, message, details); };
const positive = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const nonnegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function safeUrl(input, purpose) {
  let url;
  try { url = new URL(input); } catch { fail('BAD_INPUT', 'Invalid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    fail('BAD_INPUT', 'Only credential-free HTTPS URLs on known Bilibili hosts are allowed');
  }
  const host = url.hostname.toLowerCase();
  const allowed = purpose === 'api' ? host === 'api.bilibili.com'
    : purpose === 'web' ? WEB_HOSTS.has(host)
    : CDN_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!allowed) fail('BAD_INPUT', 'URL host is not allowed', { purpose });
  return url;
}
function partNumber(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value))) {
    fail('BAD_PART', 'Part must be a positive integer');
  }
  const part = Number(value);
  if (!positive(part)) fail('BAD_PART', 'Part must be a safe positive integer');
  return part;
}
function parseInput(input) {
  if (typeof input !== 'string' || !input.trim()) fail('BAD_INPUT', 'A BV/av ID or Bilibili URL is required');
  const text = input.trim();
  const bare = /^(BV[0-9A-Za-z]{10}|av[1-9]\d*)(?:\?([^\s]*))?$/i.exec(text);
  if (bare) {
    const id = bare[1];
    if (/^bv/i.test(id) && !BV.test(id)) fail('BAD_INPUT', 'BV IDs are case-sensitive');
    return { id, query: new URLSearchParams(bare[2] ?? '') };
  }
  // Parse the URL before considering IDs: an evil host containing a BV is never an ID.
  const match = /https?:\/\/[^\s<>"「」]+/i.exec(text);
  const candidate = match?.[0].replace(/[)）\]】,，。！!；;]+$/, '')
    ?? (/^(?:(?:www|m)\.)?(?:bilibili\.com|b23\.tv)\//i.test(text) ? `https://${text}` : null);
  if (candidate) return { url: safeUrl(candidate, 'web') };
  if (/[/:@]/.test(text)) fail('BAD_INPUT', 'Unsupported URL or share text');
  const shared = /(?:^|[^A-Za-z0-9])(BV[0-9A-Za-z]{10}|av[1-9]\d*)(?=$|[^A-Za-z0-9])/g.exec(text);
  if (shared) return { id: shared[1], query: new URLSearchParams() };
  fail('BAD_INPUT', 'No supported Bilibili video ID or URL found');
}
function parseVideoUrl(url) {
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) fail('BAD_INPUT', 'URL must identify a Bilibili video');
  return { id: match[1], query: url.searchParams };
}
function apiError(payload, endpoint) {
  const code = payload?.code;
  const message = typeof payload?.message === 'string' ? payload.message : '';
  const details = { endpoint, upstreamCode: code };
  if ([-352, -412, -403].includes(code) || /风控|验证|captcha|risk control/i.test(message)) {
    fail('PLATFORM_BLOCKED', 'Bilibili requires verification; no retry was attempted', details);
  }
  if (code === -509 || code === 429 || /频繁|限流|too many|rate limit/i.test(message)) {
    fail('RATE_LIMITED', 'Bilibili rate limit reached', details);
  }
  if ([-101, -102, -104, 10015002, 6002105].includes(code) || /未登录|请先登录|需要登录|会员|大会员|login required|not logged in/i.test(message)) {
    fail('LOGIN_REQUIRED', 'Bilibili requires a valid login or entitlement', details);
  }
  fail('API_ERROR', 'Bilibili API did not return a successful response', details);
}
function validateVideo(video) {
  if (!video || !BV.test(video.bvid) || !positive(video.cid)) fail('BAD_INPUT', 'An inspected video with bvid and cid is required');
}
function emptySubtitles(status, raw) {
  return { status, language: null, track: null, segments: [], raw };
}

export class BiliClient {
  constructor({ fetchImpl = globalThis.fetch, cookie = '', timeoutMs = 30000 } = {}) {
    if (typeof fetchImpl !== 'function' || typeof cookie !== 'string' || /[\r\n\0]/.test(cookie)
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      fail('BAD_INPUT', 'Invalid fetch, cookie or timeout configuration');
    }
    this.fetchImpl = fetchImpl;
    this.cookie = cookie;
    this.timeoutMs = timeoutMs;
  }

  async _request(input, { purpose = 'api', json = true, maxBytes = MAX_API_BYTES } = {}) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BiliError('NETWORK_ERROR', 'Bilibili request timed out', { timeoutMs: this.timeoutMs }));
      }, this.timeoutMs);
    });
    const work = async () => {
      let url = safeUrl(input, purpose);
      for (let hops = 0; hops <= 5; hops++) {
        const headers = { Accept: json ? 'application/json' : '*/*', 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
        // Purpose check also prevents a subtitle URL on api.bilibili.com from receiving cookies.
        if (purpose === 'api' && url.hostname === 'api.bilibili.com' && this.cookie) headers.Cookie = this.cookie;
        const response = await this.fetchImpl(url.href, { headers, redirect: 'manual', signal: controller.signal });
        if (controller.signal.aborted) { await response.body?.cancel(); fail('NETWORK_ERROR', 'Bilibili request timed out'); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || hops === 5) fail('API_ERROR', 'Invalid or excessive upstream redirects');
          url = safeUrl(new URL(location, url).href, purpose);
          continue;
        }
        const details = { status: response.status };
        if (!response.ok) await response.body?.cancel();
        if (response.status === 429) fail('RATE_LIMITED', 'Bilibili rate limit reached', details);
        if ([403, 412].includes(response.status)) fail('PLATFORM_BLOCKED', 'Bilibili requires verification', details);
        if (response.status === 401) fail('LOGIN_REQUIRED', 'Bilibili requires login', details);
        if (!response.ok) fail('API_ERROR', 'Bilibili HTTP request failed', details);
        if (!json) { await response.body?.cancel(); return url; }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); fail('API_ERROR', 'Upstream response exceeds size limit'); }
        const chunks = [];
        let size = 0;
        if (!response.body) fail('API_ERROR', 'Empty upstream response');
        const reader = response.body.getReader();
        const abortReader = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', abortReader, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) fail('NETWORK_ERROR', 'Bilibili request timed out');
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { await reader.cancel(); fail('API_ERROR', 'Upstream response exceeds size limit'); }
            chunks.push(Buffer.from(value));
          }
        } finally {
          controller.signal.removeEventListener('abort', abortReader);
          reader.releaseLock();
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try { return JSON.parse(text); } catch {
          if (/captcha|验证|风控|<html|<!doctype/i.test(text)) fail('PLATFORM_BLOCKED', 'Bilibili returned a verification page');
          fail('API_ERROR', 'Invalid upstream JSON');
        }
      }
    };
    try { return await Promise.race([work(), timeout]); }
    catch (error) {
      if (error instanceof BiliError) throw error;
      // Never forward fetch error messages: they may contain URLs or credentials.
      fail('NETWORK_ERROR', 'Bilibili network request failed');
    } finally { clearTimeout(timer); }
  }

  async _api(endpoint, params) {
    const url = new URL(API + endpoint);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
    const payload = await this._request(url.href);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.code !== 0) apiError(payload, endpoint);
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) fail('API_ERROR', 'Missing API data', { endpoint });
    return payload.data;
  }

  async inspect(input, { part } = {}) {
    let parsed = parseInput(input);
    if (parsed.url) {
      const shortPart = parsed.url.searchParams.get('p');
      const resolved = /^(?:www\.)?b23\.tv$/.test(parsed.url.hostname)
        ? await this._request(parsed.url.href, { purpose: 'web', json: false }) : parsed.url;
      parsed = parseVideoUrl(resolved);
      if (!parsed.query.has('p') && shortPart !== null) parsed.query.set('p', shortPart);
    }
    const selected = part !== undefined ? partNumber(part) : parsed.query.has('p') ? partNumber(parsed.query.get('p')) : 1;
    const params = BV.test(parsed.id) ? { bvid: parsed.id } : { aid: parsed.id.slice(2) };
    const data = await this._api('/x/web-interface/view', params);
    if (!BV.test(data.bvid) || !positive(data.aid) || !Array.isArray(data.pages) || !data.pages.length) fail('API_ERROR', 'Malformed video metadata');
    const pages = data.pages.map((page, index) => {
      if (page.page !== index + 1 || !positive(page.cid) || typeof page.part !== 'string' || !nonnegative(page.duration)) fail('API_ERROR', 'Malformed video part metadata');
      return { part: page.page, cid: page.cid, title: page.part, duration: page.duration };
    });
    const page = pages[selected - 1];
    if (!page) fail('BAD_PART', 'Selected part is out of range', { part: selected, totalParts: pages.length });
    if (typeof data.title !== 'string' || typeof data.owner?.name !== 'string') fail('API_ERROR', 'Malformed video title or author');
    return {
      bvid: data.bvid, aid: data.aid, cid: page.cid, part: selected, partTitle: page.title,
      title: data.title, author: data.owner.name, duration: page.duration, totalParts: pages.length, pages,
      url: `https://www.bilibili.com/video/${data.bvid}/?p=${selected}`,
    };
  }

  async getSubtitles(video) {
    validateVideo(video);
    let data;
    // Public player/v2 is deliberately the sole route. No fallback after a block or failure.
    try { data = await this._api('/x/player/v2', { bvid: video.bvid, cid: video.cid }); }
    catch (error) {
      if (error.code === 'LOGIN_REQUIRED') return emptySubtitles('login-required', { upstreamCode: error.details.upstreamCode, status: error.details.status });
      throw error;
    }
    const subtitle = data.subtitle;
    if (data.need_login_subtitle === true || data.need_login_subtitle === 1 || subtitle?.need_login_subtitle === true) return emptySubtitles('login-required', data);
    if (!subtitle || !Array.isArray(subtitle.subtitles)) fail('API_ERROR', 'Malformed subtitle list');
    const tracks = subtitle.subtitles;
    if (!tracks.length) return emptySubtitles('none', data);
    const ranked = tracks.map((track, index) => {
      if (!track || typeof track !== 'object' || typeof track.lan !== 'string' || typeof track.subtitle_url !== 'string' || !track.subtitle_url) fail('API_ERROR', 'Malformed subtitle track');
      const chinese = /(?:^|[-_])zh(?:$|[-_])|chinese/i.test(track.lan) || /中文|汉语/.test(track.lan_doc ?? track.lan_name ?? '');
      const ai = track.isAI === true || track.isAI === 1 || track.isAI === '1' || /(?:^|[-_])ai(?:$|[-_])/i.test(track.lan);
      return { track, index, rank: chinese ? (ai ? 1 : 0) : (ai ? 3 : 2) };
    }).sort((a, b) => a.rank - b.rank || a.index - b.index);
    const track = ranked[0].track;
    const url = track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
    const raw = await this._request(url, { purpose: 'cdn', maxBytes: MAX_SUBTITLE_BYTES });
    if (!raw || !Array.isArray(raw.body) || !raw.body.length) fail('API_ERROR', 'Empty or malformed subtitle body');
    const segments = raw.body.map((item) => {
      if (!item || !nonnegative(item.from) || !nonnegative(item.to) || item.to <= item.from || typeof item.content !== 'string' || !item.content.trim()) fail('API_ERROR', 'Invalid subtitle segment');
      return { start: item.from, end: item.to, text: item.content.trim() };
    });
    return { status: 'available', language: track.lan, track, segments, raw };
  }

  async getMedia(video, { kind = 'audio' } = {}) {
    validateVideo(video);
    if (!['audio', 'video'].includes(kind)) fail('BAD_INPUT', 'Media kind must be audio or video');
    const data = await this._api('/x/player/playurl', { bvid: video.bvid, cid: video.cid, qn: 64, fnval: 16, fnver: 0, fourk: 0 });
    if (data.need_login === true || data.is_preview === true || data.is_preview === 1 || data.has_paid === false) fail('LOGIN_REQUIRED', 'Full media requires a valid login or entitlement');
    let streams = data.dash?.[kind];
    let stream;
    if (Array.isArray(streams) && streams.length) {
      streams = streams.filter((item) => item && typeof (item.baseUrl ?? item.base_url) === 'string');
      const bandwidth = (item) => nonnegative(item.bandwidth) ? item.bandwidth : Infinity;
      if (kind === 'video') {
        // Prefer the smallest representation at/above 720p; otherwise the best available.
        const height = (item) => nonnegative(item.height) && nonnegative(item.width) ? Math.min(item.height, item.width) : ({ 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080 })[item.id] ?? 0;
        streams.sort((a, b) => {
          const ah = height(a), bh = height(b);
          if (ah >= 720 && bh < 720) return -1;
          if (ah < 720 && bh >= 720) return 1;
          return (ah >= 720 ? ah - bh : bh - ah) || bandwidth(a) - bandwidth(b);
        });
      } else streams.sort((a, b) => bandwidth(a) - bandwidth(b));
      stream = streams[0];
    } else if (kind === 'video' && Array.isArray(data.durl) && data.durl.length === 1) {
      stream = { baseUrl: data.durl[0].url, backupUrl: data.durl[0].backup_url, mimeType: 'video/mp4' };
    }
    if (!stream) fail('API_ERROR', `No usable ${kind} stream returned`);
    const url = safeUrl(stream.baseUrl ?? stream.base_url, 'cdn').href;
    const backup = stream.backupUrl ?? stream.backup_url ?? [];
    if (!Array.isArray(backup)) fail('API_ERROR', 'Malformed media backup URLs');
    const backupUrls = backup.map((entry) => safeUrl(entry, 'cdn').href);
    const mimeType = stream.mimeType ?? stream.mime_type;
    return { url, ...(backupUrls.length ? { backupUrls } : {}), kind, ...(typeof mimeType === 'string' ? { mimeType } : {}) };
  }
}
