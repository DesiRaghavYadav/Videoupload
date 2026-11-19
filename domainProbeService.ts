import type { Express, Request, Response } from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { chromium } from 'playwright-core';

export type DomainScopeMode = 'exact_host' | 'root_domain';

export interface DomainProbeVerifiedEntry {
  host: string;
  rootDomain: string;
  status: 'confirmed' | 'no_video';
  hasVideo: boolean;
  sourcePageUrl: string;
  originInputUrl: string;
  discoveryDepth: 0 | 1;
  videoUrl: string;
  thumbnailUrl: string;
  title: string;
  videoType?: string;
  contentType?: string;
  sizeBytes?: number | null;
  verifiedLive?: boolean;
  usedPlaywright?: boolean;
  usedHomeDomainFallback?: boolean;
  attemptsUsed: number;
  checkedAt: string;
}

export interface CloudflareBlockedEntry {
  host: string;
  rootDomain: string;
  url: string;
  originInputUrl: string;
  httpStatus?: number;
  reason: string;
  playwrightAttempted: boolean;
  attemptsUsed: number;
  checkedAt: string;
}

export type ProbeTaskStatus =
  | 'pending'
  | 'checking_direct'
  | 'checking_inner_links'
  | 'found_yes'
  | 'no_video'
  | 'cloudflare_blocked'
  | 'skipped_in_json'
  | 'skipped_cloudflare_json'
  | 'skipped_domain_limit'
  | 'error';

export interface DomainProbeTask {
  id: string;
  index: number;
  url: string;
  host: string;
  rootDomain: string;
  scopeKey: string;
  status: ProbeTaskStatus;
  workerId?: number;
  message?: string;
  discoveryDepth?: 0 | 1;
  matchedPageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  innerLinksChecked?: number;
  verifiedLive?: boolean;
  usedPlaywright?: boolean;
  usedHomeDomainFallback?: boolean;
  blockedByCloudflare?: boolean;
  error?: string;
  checkedAt?: string;
}

export interface DomainProbeJobState {
  jobId: string;
  isRunning: boolean;
  cancelled: boolean;
  concurrency: number;
  maxPerDomain: number;
  maxInnerLinksPerPage: number;
  domainScope: DomainScopeMode;
  verifyVideoHeaders: boolean;
  includeEmbedIframes: boolean;
  saveNoVideoDomains: boolean;
  usePlaywrightFallback: boolean;
  autoPassCloudflare: boolean;
  excludePatterns: string[];
  excludedCount: number;
  startedAt: string;
  endedAt?: string;
  total: number;
  pending: number;
  checking: number;
  foundYes: number;
  noVideo: number;
  cloudflareBlocked: number;
  skippedInJson: number;
  skippedCloudflareJson: number;
  skippedDomainLimit: number;
  errors: number;
  activeWorkers: number;
  tasks: DomainProbeTask[];
}

export interface DomainProbeServiceDeps {
  localRegistryDir: string;
  cfWorkerBaseUrl: string;
  isPreviewVideoUrl: (u?: string | null) => boolean;
  axiosGetWithRetry: (url: string, config?: any, maxRetries?: number, extraServers?: string[]) => Promise<any>;
  resolveChromiumExecutable?: () => string | null;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

const MULTI_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'co.in',
  'net.in',
  'org.in',
  'com.au',
  'net.au',
  'com.br',
  'co.jp',
  'co.kr',
  'com.mx',
  'com.tr',
  'co.za',
]);

function normalizeHost(hostname: string): string {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

function getRootDomain(hostname: string): string {
  const clean = normalizeHost(hostname);
  if (!clean) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean) || clean === 'localhost') {
    return clean;
  }
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function getScopeKeyFromUrl(
  rawUrl: string,
  scopeMode: DomainScopeMode
): { valid: boolean; normalizedUrl: string; host: string; rootDomain: string; scopeKey: string } {
  try {
    let target = String(rawUrl || '').trim();
    if (!target) return { valid: false, normalizedUrl: '', host: '', rootDomain: '', scopeKey: '' };
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    const parsed = new URL(target);
    const host = normalizeHost(parsed.hostname);
    const rootDomain = getRootDomain(host);
    const scopeKey = scopeMode === 'root_domain' ? rootDomain : host;
    return {
      valid: Boolean(host && /^https?:$/i.test(parsed.protocol)),
      normalizedUrl: parsed.href,
      host,
      rootDomain,
      scopeKey,
    };
  } catch {
    return { valid: false, normalizedUrl: '', host: '', rootDomain: '', scopeKey: '' };
  }
}

function cleanText(s?: string | null): string {
  return s ? s.replace(/\s+/g, ' ').trim() : '';
}

function matchesExcludePatterns(urlStr: string, excludePatterns: string[]): boolean {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  const lower = urlStr.toLowerCase();
  return excludePatterns.some((pat) => {
    const clean = pat.trim().toLowerCase();
    return clean.length > 0 && lower.includes(clean);
  });
}

function isNonContentPath(urlStr: string): boolean {
  const lower = urlStr.toLowerCase();
  if (/\.(jpg|jpeg|png|webp|avif|gif|svg|ico|css|js|json|xml|pdf|zip|rar|woff2?|ttf|eot)(\?.*)?$/i.test(lower)) {
    return true;
  }
  if (
    /\/(login|signin|sign-in|signup|register|logout|auth|contact|about|privacy|terms|tos|dmca|cookie|faq|help|support|feed|rss|sitemap|wp-json|wp-login|wp-admin)(\/|\?|$)/i.test(
      lower
    )
  ) {
    return true;
  }
  return false;
}

function isCloudflareChallengeResponse(status: number, headers: Record<string, any> | undefined, bodyText: string): boolean {
  const mitigated = String(headers?.['cf-mitigated'] || '').toLowerCase();
  if (mitigated.includes('challenge')) return true;
  const body = (bodyText || '').slice(0, 80000);
  const hasCfChallengeMarker =
    /cf_chl_opt|\/cdn-cgi\/challenge-platform\/|cf-browser-verification|cf-turnstile|challenges\.cloudflare\.com/i.test(body) ||
    /<title[^>]*>\s*(?:Just a moment|Attention Required!?\s*\|\s*Cloudflare|Cloudflare)/i.test(body) ||
    (/Checking your browser before accessing/i.test(body) && /cloudflare/i.test(body)) ||
    (/Enable JavaScript and cookies to continue/i.test(body) && (/cf_chl|cloudflare|ray id/i.test(body)));
  if (hasCfChallengeMarker) return true;
  const serverHdr = String(headers?.server || '').toLowerCase();
  if ((status === 403 || status === 503) && serverHdr.includes('cloudflare') && (/ray id|cloudflare|verify you are human|blocked/i.test(body) || body.trim() === '')) {
    return true;
  }
  return false;
}

async function readResponseTextUpToBytes(data: any, maxBytes: number): Promise<string> {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, maxBytes);
  if (Buffer.isBuffer(data)) return data.subarray(0, maxBytes).toString('utf8');
  if (typeof data.on === 'function') {
    return await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      };
      data.on('data', (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        total += buf.length;
        if (total >= maxBytes) {
          try {
            data.destroy();
          } catch {}
          done();
        }
      });
      data.on('end', done);
      data.on('close', done);
      data.on('error', done);
    });
  }
  if (typeof data === 'object') return JSON.stringify(data).slice(0, maxBytes);
  return '';
}

async function fetchLightweightHtmlOrDetectDirectVideo(
  targetUrl: string,
  refererUrl: string | undefined,
  axiosGetWithRetry: DomainProbeServiceDeps['axiosGetWithRetry']
): Promise<{
  kind: 'direct_video' | 'html' | 'cloudflare_blocked' | 'other' | 'error';
  finalUrl: string;
  contentType: string;
  httpStatus?: number;
  sizeBytes: number | null;
  html?: string;
  error?: string;
}> {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  try {
    const parsed = new URL(targetUrl);
    const response = await axiosGetWithRetry(
      targetUrl,
      {
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,video/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: refererUrl || `${parsed.origin}/`,
        },
        timeout: 15000,
        maxRedirects: 5,
        responseType: 'stream',
        validateStatus: () => true,
      },
      2
    );

    const status = Number(response.status || 0);
    const finalUrl = (response.request as any)?.res?.responseUrl || response.config?.url || targetUrl;
    const contentType = String(response.headers?.['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const rawLen = Number(response.headers?.['content-length'] || 0);
    const sizeBytes = !Number.isNaN(rawLen) && rawLen > 0 ? rawLen : null;

    if (status >= 400) {
      let snippet = '';
      if (status === 403 || status === 503 || status === 429 || String(response.headers?.['cf-mitigated'] || '').toLowerCase().includes('challenge')) {
        snippet = await readResponseTextUpToBytes(response.data, 64 * 1024);
      } else if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }

      if (isCloudflareChallengeResponse(status, response.headers, snippet)) {
        return {
          kind: 'cloudflare_blocked',
          finalUrl,
          contentType,
          httpStatus: status,
          sizeBytes,
          error: `Cloudflare Verification (HTTP ${status})`,
        };
      }

      return {
        kind: 'error',
        finalUrl,
        contentType,
        httpStatus: status,
        sizeBytes,
        error: `HTTP ${status}`,
      };
    }

    const isDirectVideoHeader =
      contentType.startsWith('video/') ||
      contentType.includes('mpegurl') ||
      contentType.includes('dash+xml') ||
      (contentType === 'application/octet-stream' && /\.(mp4|m3u8|webm|mov|mkv|ts)(\?|$)/i.test(finalUrl));

    if (isDirectVideoHeader) {
      if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
      return {
        kind: 'direct_video',
        finalUrl,
        contentType: contentType || 'video/mp4',
        httpStatus: status,
        sizeBytes,
      };
    }

    const looksText =
      contentType.includes('html') ||
      contentType.includes('text/') ||
      contentType.includes('xml') ||
      contentType === '';

    if (!looksText) {
      if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
      return {
        kind: 'other',
        finalUrl,
        contentType,
        httpStatus: status,
        sizeBytes,
      };
    }

    // Read up to 2.5 MB of HTML stream and stop immediately (never download huge files)
    const html = await readResponseTextUpToBytes(response.data, 2.5 * 1024 * 1024);

    if (isCloudflareChallengeResponse(status, response.headers, html)) {
      return {
        kind: 'cloudflare_blocked',
        finalUrl,
        contentType: contentType || 'text/html',
        httpStatus: status,
        sizeBytes,
        error: `Cloudflare JS Verification (HTTP ${status})`,
      };
    }

    return {
      kind: 'html',
      finalUrl,
      contentType: contentType || 'text/html',
      httpStatus: status,
      sizeBytes,
      html,
    };
  } catch (err: any) {
    return {
      kind: 'error',
      finalUrl: targetUrl,
      contentType: '',
      sizeBytes: null,
      error: cleanText(err?.message || 'Fetch error'),
    };
  }
}

async function verifyVideoUrlWithoutDownload(
  videoUrl: string,
  refererUrl: string
): Promise<{ reachable: boolean; contentType?: string; sizeBytes?: number | null }> {
  const ua = USER_AGENTS[0];
  const commonHeaders = {
    'User-Agent': ua,
    Accept: 'video/mp4,video/*,*/*;q=0.9',
    Referer: refererUrl,
    Connection: 'close',
  };

  // 1. Try fast HEAD request first (0 body bytes transferred)
  try {
    const headRes = await axios.head(videoUrl, {
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
      headers: commonHeaders,
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const ct = String(headRes.headers?.['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const len = Number(headRes.headers?.['content-length'] || 0);
    if (headRes.status >= 200 && headRes.status < 300 && !ct.includes('text/html') && !ct.includes('application/json')) {
      return {
        reachable: true,
        contentType: ct || undefined,
        sizeBytes: !Number.isNaN(len) && len > 0 ? len : null,
      };
    }
    if (headRes.status === 404 || headRes.status === 410) {
      return { reachable: false };
    }
  } catch {}

  // 2. Fallback: HTTP GET with Range: bytes=0-1023 & immediate stream.destroy() right after headers
  try {
    const res = await axios.get(videoUrl, {
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
      headers: {
        ...commonHeaders,
        Range: 'bytes=0-1023',
      },
      responseType: 'stream',
      timeout: 9000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (res.data && typeof res.data.destroy === 'function') {
      res.data.destroy();
    }
    const ct = String(res.headers?.['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const contentRange = String(res.headers?.['content-range'] || '');
    const crMatch = contentRange.match(/bytes\s+\d+-\d+\/(\d+)/i);
    const rawLen = Number(crMatch ? crMatch[1] : res.headers?.['content-length'] || 0);

    if (res.status >= 200 && res.status < 300 && !ct.includes('text/html') && !ct.includes('application/json')) {
      return {
        reachable: true,
        contentType: ct || undefined,
        sizeBytes: !Number.isNaN(rawLen) && rawLen > 0 ? rawLen : null,
      };
    }
  } catch {}

  return { reachable: false };
}

function extractVideoThumbAndSameSiteLinksFromHtml(
  html: string,
  finalUrl: string,
  scopeMode: DomainScopeMode,
  isPreviewVideoUrl: (u?: string | null) => boolean,
  includeEmbedIframes: boolean,
  excludePatterns: string[] = []
): {
  title: string;
  thumbnailUrl: string;
  videoCandidates: Array<{ url: string; type: string; thumb?: string }>;
  sameSiteLinks: Array<{ url: string; score: number; anchorThumb?: string; anchorTitle?: string }>;
} {
  const $ = cheerio.load(html || '');
  const baseHost = (() => {
    try {
      return normalizeHost(new URL(finalUrl).hostname);
    } catch {
      return '';
    }
  })();
  const baseRoot = getRootDomain(baseHost);

  const resolveUrl = (raw?: string): string => {
    if (!raw) return '';
    try {
      return new URL(raw.trim(), finalUrl).href;
    } catch {
      return '';
    }
  };

  const title =
    cleanText(
      $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        $('h1').first().text() ||
        $('title').text()
    ) || baseHost;

  // Candidate thumbnails
  let primaryThumb =
    resolveUrl($('video').first().attr('poster') || $('video').first().attr('data-poster') || $('video').first().attr('data-thumb')) ||
    resolveUrl($('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content')) ||
    resolveUrl($('meta[name="twitter:image"]').attr('content')) ||
    resolveUrl($('meta[name="thumbnail"], meta[itemprop="thumbnailUrl"], link[rel="image_src"]').first().attr('content') || $('link[rel="image_src"]').attr('href'));

  // Parse JSON-LD
  const jsonLdEntries: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        jsonLdEntries.push(item);
        if (!primaryThumb) {
          const jt = item?.thumbnailUrl || item?.thumbnail || (typeof item?.image === 'string' ? item.image : item?.image?.url);
          if (typeof jt === 'string') {
            const rt = resolveUrl(jt);
            if (rt) primaryThumb = rt;
          }
        }
      }
    } catch {}
  });

  if (!primaryThumb) {
    $('img[src]').each((_, el) => {
      if (primaryThumb) return;
      const src = $(el).attr('src');
      const cls = `${$(el).attr('class') || ''} ${$(el).attr('id') || ''}`;
      if (src && !src.startsWith('data:') && /(poster|thumb|cover|preview|featured|hero|player)/i.test(cls)) {
        primaryThumb = resolveUrl(src);
      }
    });
  }

  // Video candidates
  const videoMap = new Map<string, { url: string; type: string; thumb?: string }>();
  const addVideoCandidate = (raw?: string, typeHint?: string, explicitThumb?: string) => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;
    const cleaned = raw
      .replace(/&amp;/gi, '&')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002f/gi, '/')
      .replace(/\\u003d/gi, '=')
      .replace(/\\\//g, '/')
      .replace(/\\+$/, '')
      .trim();
    const abs = resolveUrl(cleaned);
    if (!abs || !/^https?:\/\//i.test(abs)) return;
    if (isPreviewVideoUrl(abs)) return;
    if (!videoMap.has(abs)) {
      const inferredType =
        typeHint ||
        (/\.m3u8(\?|$)/i.test(abs)
          ? 'HLS (m3u8)'
          : /\.webm(\?|$)/i.test(abs)
          ? 'WebM Video'
          : /\.mp4(\?|$)/i.test(abs)
          ? 'MP4 Video'
          : 'Video Stream');
      videoMap.set(abs, { url: abs, type: inferredType, thumb: explicitThumb || primaryThumb || undefined });
    }
  };

  addVideoCandidate(
    $('meta[name="twitter:player:stream"]').attr('content') ||
      $('meta[property="twitter:player:stream"]').attr('content') ||
      $('meta[itemprop="contentUrl"]').attr('content')
  );

  const ogVid =
    $('meta[property="og:video"]').attr('content') ||
    $('meta[property="og:video:url"]').attr('content') ||
    $('meta[property="og:video:secure_url"]').attr('content');
  if (ogVid && !/\.(html?|php)(\?|$)/i.test(ogVid)) {
    addVideoCandidate(ogVid);
  }

  for (const item of jsonLdEntries) {
    const cUrl = item?.contentUrl || item?.video?.contentUrl || item?.associatedMedia?.contentUrl;
    if (typeof cUrl === 'string') addVideoCandidate(cUrl);
  }

  $('video').each((_, el) => {
    const vPoster = resolveUrl($(el).attr('poster') || $(el).attr('data-poster') || $(el).attr('data-thumb'));
    const vSrc =
      $(el).attr('src') ||
      $(el).attr('data-src') ||
      $(el).attr('data-video') ||
      $(el).attr('data-video-url') ||
      $(el).attr('data-url');
    if (vSrc) addVideoCandidate(vSrc, undefined, vPoster);
    $(el)
      .find('source')
      .each((__, sEl) => {
        const sSrc = $(sEl).attr('src') || $(sEl).attr('data-src') || $(sEl).attr('data-url');
        if (sSrc) addVideoCandidate(sSrc, $(sEl).attr('type'), vPoster);
      });
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && /\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(href)) {
      addVideoCandidate(href);
    }
  });

  const normalizedScripts = html
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003d/gi, '=')
    .replace(/&amp;/gi, '&');
  const scriptMatches =
    normalizedScripts.match(/https?:\/\/[^\s"'<>\\`]+\.(?:mp4|webm|mov|mkv|m3u8)(?:\?[^\s"'<>\\`]*)?/gi) || [];
  for (const m of scriptMatches) {
    addVideoCandidate(m);
  }

  if (includeEmbedIframes) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const abs = resolveUrl(src);
      if (/(youtube|youtu\.be|vimeo|dailymotion|player|embed|stream|video)/i.test(abs)) {
        if (!videoMap.has(abs)) {
          videoMap.set(abs, { url: abs, type: 'Embedded Player (iframe)', thumb: primaryThumb || undefined });
        }
      }
    });
  }

  // Sort direct MP4 / high-quality video candidates first
  const videoCandidates = Array.from(videoMap.values()).sort((a, b) => {
    const scoreOf = (v: { url: string; type: string }) => {
      let s = 0;
      if (v.type === 'Embedded Player (iframe)') return -10;
      if (/\.mp4(\?|$)/i.test(v.url)) s += 20;
      if (/1080|720|hd/i.test(v.url)) s += 10;
      if (/\.m3u8(\?|$)/i.test(v.url)) s += 8;
      if (/480|360/i.test(v.url)) s += 4;
      return s;
    };
    return scoreOf(b) - scoreOf(a);
  });

  // Extract same-website child links (in case landing page has no direct video)
  const sameSiteMap = new Map<string, { url: string; score: number; anchorThumb?: string; anchorTitle?: string }>();
  const finalNorm = finalUrl.replace(/\/+$/, '');

  const considerInnerLink = (rawHref?: string, textHint?: string, thumbHint?: string) => {
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
      return;
    }
    const abs = resolveUrl(rawHref);
    if (!abs || !/^https?:\/\//i.test(abs)) return;
    if (abs.replace(/\/+$/, '') === finalNorm) return;
    if (isNonContentPath(abs)) return;
    if (matchesExcludePatterns(abs, excludePatterns)) return;

    let linkHost = '';
    try {
      linkHost = normalizeHost(new URL(abs).hostname);
    } catch {
      return;
    }
    const linkRoot = getRootDomain(linkHost);
    const sameSite = scopeMode === 'root_domain' ? linkRoot === baseRoot : linkHost === baseHost;
    if (!sameSite) return;

    // Score likelihood of leading to a video page
    let score = 0;
    const lowerUrl = abs.toLowerCase();
    const lowerText = (textHint || '').toLowerCase();
    if (/\/(watch|video|videos|v|play|player|movie|movies|episode|film|clip|clips|stream|embed|reel|reels|media)\b/i.test(lowerUrl)) {
      score += 40;
    }
    if (thumbHint) score += 25;
    if (/\d{3,}/.test(lowerUrl)) score += 15;
    if (/(watch|video|play|movie|episode|hd|min|sec|\d+:\d+)/i.test(lowerText)) score += 12;
    const depth = new URL(abs).pathname.split('/').filter(Boolean).length;
    if (depth >= 1 && depth <= 4) score += 8;
    if (/\/(tag|tags|category|categories|page|author|user|search|archive)\b/i.test(lowerUrl)) score -= 20;

    const prev = sameSiteMap.get(abs);
    if (!prev || score > prev.score) {
      sameSiteMap.set(abs, {
        url: abs,
        score,
        anchorThumb: thumbHint || prev?.anchorThumb,
        anchorTitle: cleanText(textHint) || prev?.anchorTitle,
      });
    }
  };

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const txt = cleanText($(el).text()) || cleanText($(el).attr('title'));
    const childImg = $(el).find('img').first();
    const imgSrc = childImg.attr('data-src') || childImg.attr('data-lazy-src') || childImg.attr('src');
    const thumbHint = imgSrc && !imgSrc.startsWith('data:') ? resolveUrl(imgSrc) : undefined;
    considerInnerLink(href, txt, thumbHint);
  });

  for (const attr of ['data-href', 'data-url', 'data-link', 'data-video-url']) {
    $(`[${attr}]`).each((_, el) => {
      considerInnerLink($(el).attr(attr), cleanText($(el).text()) || cleanText($(el).attr('title')));
    });
  }

  const sameSiteLinks = Array.from(sameSiteMap.values()).sort((a, b) => b.score - a.score);

  return {
    title,
    thumbnailUrl: primaryThumb,
    videoCandidates,
    sameSiteLinks,
  };
}

let activePlaywrightProbes = 0;
const playwrightWaitQueue: Array<() => void> = [];
async function withPlaywrightSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activePlaywrightProbes >= 2) {
    await new Promise<void>((resolve) => playwrightWaitQueue.push(resolve));
  }
  activePlaywrightProbes++;
  try {
    return await fn();
  } finally {
    activePlaywrightProbes = Math.max(0, activePlaywrightProbes - 1);
    const next = playwrightWaitQueue.shift();
    if (next) next();
  }
}

async function probePageWithPlaywrightNoDownload(params: {
  url: string;
  executablePath: string;
  scopeMode: DomainScopeMode;
  isPreviewVideoUrl: (u?: string | null) => boolean;
  includeEmbedIframes: boolean;
  excludePatterns: string[];
  waitForCloudflareMs?: number;
  followTopInnerIfCleared?: boolean;
}): Promise<{
  finalUrl: string;
  title: string;
  thumbnailUrl: string;
  videoCandidates: Array<{ url: string; type: string; thumb?: string }>;
  sameSiteLinks: Array<{ url: string; score: number; anchorThumb?: string; anchorTitle?: string }>;
  stillBlockedByCloudflare: boolean;
  httpStatus?: number;
  innerPageMatch?: {
    finalUrl: string;
    title: string;
    thumbnailUrl: string;
    videoCandidates: Array<{ url: string; type: string; thumb?: string }>;
  };
} | null> {
  return withPlaywrightSlot(async () => {
    let browser: any = null;
    try {
      browser = await chromium.launch({
        executablePath: params.executablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      const context = await browser.newContext({
        userAgent: USER_AGENTS[0],
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        } catch {}
      });
      const interceptedVideos: Array<{ url: string; type: string }> = [];

      // Block heavy media/font downloads so ZERO full video binaries are fetched!
      await page.route('**/*', async (route: any) => {
        const req = route.request();
        const rUrl = req.url();
        const rType = req.resourceType();
        if (/\.(mp4|m3u8|webm|mov|mkv)(\?|$)/i.test(rUrl) && !params.isPreviewVideoUrl(rUrl)) {
          if (!interceptedVideos.some((v) => v.url === rUrl)) {
            interceptedVideos.push({
              url: rUrl,
              type: /\.m3u8(\?|$)/i.test(rUrl) ? 'HLS (m3u8)' : 'JS Network Video',
            });
          }
          await route.abort().catch(() => {});
          return;
        }
        if (rType === 'media' || rType === 'font') {
          await route.abort().catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      });

      const navRes = await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 16000 }).catch(() => null);
      let httpStatus = navRes ? Number(navRes.status() || 0) : undefined;
      await page.waitForTimeout(1400);

      let html = await page.content().catch(() => '');
      let stillBlocked = isCloudflareChallengeResponse(httpStatus || 200, {}, html);

      // If Cloudflare JS challenge detected, poll briefly (up to waitForCloudflareMs) to let automatic clearance settle
      if (stillBlocked && (params.waitForCloudflareMs || 0) > 0) {
        const deadline = Date.now() + Math.min(10000, params.waitForCloudflareMs || 6500);
        while (stillBlocked && Date.now() < deadline) {
          await page.waitForTimeout(800);
          html = await page.content().catch(() => '');
          stillBlocked = isCloudflareChallengeResponse(200, {}, html);
        }
      }

      const finalUrl = page.url() || params.url;
      const parsed = extractVideoThumbAndSameSiteLinksFromHtml(
        html,
        finalUrl,
        params.scopeMode,
        params.isPreviewVideoUrl,
        params.includeEmbedIframes,
        params.excludePatterns
      );

      // Merge any JS-intercepted media URLs ahead of static candidates if not preview clips
      const mergedMap = new Map<string, { url: string; type: string; thumb?: string }>();
      for (const iv of interceptedVideos) {
        mergedMap.set(iv.url, { url: iv.url, type: iv.type, thumb: parsed.thumbnailUrl || undefined });
      }
      for (const vc of parsed.videoCandidates) {
        if (!mergedMap.has(vc.url)) mergedMap.set(vc.url, vc);
      }

      const videoCandidates = Array.from(mergedMap.values());
      let innerPageMatch:
        | {
            finalUrl: string;
            title: string;
            thumbnailUrl: string;
            videoCandidates: Array<{ url: string; type: string; thumb?: string }>;
          }
        | undefined;

      // Reuse the same cleared browser session/cookies for top same-site link if needed
      if (!stillBlocked && videoCandidates.length === 0 && params.followTopInnerIfCleared && parsed.sameSiteLinks.length > 0) {
        const innerTarget = parsed.sameSiteLinks[0];
        interceptedVideos.length = 0;
        await page.goto(innerTarget.url, { waitUntil: 'domcontentloaded', timeout: 14000 }).catch(() => null);
        await page.waitForTimeout(1400);
        const innerUrl = page.url() || innerTarget.url;
        const innerHtml = await page.content().catch(() => '');
        if (!isCloudflareChallengeResponse(200, {}, innerHtml)) {
          const innerParsed = extractVideoThumbAndSameSiteLinksFromHtml(
            innerHtml,
            innerUrl,
            params.scopeMode,
            params.isPreviewVideoUrl,
            params.includeEmbedIframes,
            params.excludePatterns
          );
          const innerMap = new Map<string, { url: string; type: string; thumb?: string }>();
          for (const iv of interceptedVideos) {
            innerMap.set(iv.url, { url: iv.url, type: iv.type, thumb: innerParsed.thumbnailUrl || innerTarget.anchorThumb || parsed.thumbnailUrl || undefined });
          }
          for (const vc of innerParsed.videoCandidates) {
            if (!innerMap.has(vc.url)) innerMap.set(vc.url, vc);
          }
          const innerVideos = Array.from(innerMap.values());
          if (innerVideos.length > 0) {
            innerPageMatch = {
              finalUrl: innerUrl,
              title: innerParsed.title || innerTarget.anchorTitle || parsed.title,
              thumbnailUrl: innerParsed.thumbnailUrl || innerTarget.anchorThumb || parsed.thumbnailUrl,
              videoCandidates: innerVideos,
            };
          }
        }
      }

      return {
        finalUrl,
        title: parsed.title,
        thumbnailUrl: parsed.thumbnailUrl,
        videoCandidates,
        sameSiteLinks: parsed.sameSiteLinks,
        stillBlockedByCloudflare: stillBlocked,
        httpStatus,
        innerPageMatch,
      };
    } catch {
      return null;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  });
}

export function registerDomainProbeRoutes(app: Express, deps: DomainProbeServiceDeps): void {
  const probeJsonPath = path.join(deps.localRegistryDir, 'domain_video_probe.json');
  const D1_PROBE_DOC_ID = 'domain_video_probe_registry_v1';
  const cfBlockedJsonPath = path.join(deps.localRegistryDir, 'domain_cloudflare_blocked.json');
  const D1_CF_BLOCKED_DOC_ID = 'domain_cloudflare_blocked_registry_v1';

  let domainProbeRegistry: Record<string, DomainProbeVerifiedEntry> = {};
  let cloudflareBlockedRegistry: Record<string, CloudflareBlockedEntry> = {};
  let registryHydratedFromD1 = false;
  let lastD1SyncAt = 0;
  let lastCfD1SyncAt = 0;

  // Load initial saved JSON registries from local disk
  try {
    if (fs.existsSync(probeJsonPath)) {
      const raw = fs.readFileSync(probeJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        domainProbeRegistry = parsed.domains && typeof parsed.domains === 'object' ? parsed.domains : parsed;
      }
    }
  } catch (err) {
    console.warn('Could not load domain_video_probe.json:', err);
  }
  try {
    if (fs.existsSync(cfBlockedJsonPath)) {
      const raw = fs.readFileSync(cfBlockedJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        cloudflareBlockedRegistry = parsed.domains && typeof parsed.domains === 'object' ? parsed.domains : parsed;
      }
    }
  } catch (err) {
    console.warn('Could not load domain_cloudflare_blocked.json:', err);
  }

  const persistCloudflareBlockedRegistry = async (forceD1 = false): Promise<void> => {
    const payload = {
      updatedAt: new Date().toISOString(),
      totalBlockedDomains: Object.keys(cloudflareBlockedRegistry).length,
      domains: cloudflareBlockedRegistry,
    };
    try {
      if (!fs.existsSync(deps.localRegistryDir)) {
        fs.mkdirSync(deps.localRegistryDir, { recursive: true });
      }
      fs.writeFileSync(cfBlockedJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Failed writing domain_cloudflare_blocked.json:', err);
    }

    const now = Date.now();
    if (!forceD1 && now - lastCfD1SyncAt < 2500) return;
    lastCfD1SyncAt = now;

    try {
      await axios.post(
        `${deps.cfWorkerBaseUrl}/api/ad_config`,
        {
          id: D1_CF_BLOCKED_DOC_ID,
          ...payload,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
    } catch {}
  };

  const persistDomainProbeRegistry = async (forceD1 = false): Promise<void> => {
    const payload = {
      updatedAt: new Date().toISOString(),
      totalSaved: Object.keys(domainProbeRegistry).length,
      confirmedVideoDomains: Object.values(domainProbeRegistry).filter((e) => e.hasVideo).length,
      domains: domainProbeRegistry,
    };

    try {
      if (!fs.existsSync(deps.localRegistryDir)) {
        fs.mkdirSync(deps.localRegistryDir, { recursive: true });
      }
      fs.writeFileSync(probeJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Failed writing domain_video_probe.json:', err);
    }

    const now = Date.now();
    if (!forceD1 && now - lastD1SyncAt < 2500) return;
    lastD1SyncAt = now;

    try {
      await axios.post(
        `${deps.cfWorkerBaseUrl}/api/ad_config`,
        {
          id: D1_PROBE_DOC_ID,
          ...payload,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
    } catch {}
  };

  const hydrateDomainProbeFromD1IfNeeded = async (force = false): Promise<void> => {
    if (registryHydratedFromD1 && !force) return;
    registryHydratedFromD1 = true;
    try {
      const res = await axios.get(`${deps.cfWorkerBaseUrl}/api/ad_config/${encodeURIComponent(D1_PROBE_DOC_ID)}`, {
        timeout: 8000,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300 && res.data && typeof res.data === 'object') {
        const remote = res.data?.data || res.data;
        const remoteDomains = remote?.domains;
        if (remoteDomains && typeof remoteDomains === 'object') {
          let changed = false;
          for (const [k, v] of Object.entries(remoteDomains as Record<string, DomainProbeVerifiedEntry>)) {
            if (v && v.host && !domainProbeRegistry[k]) {
              domainProbeRegistry[k] = v;
              changed = true;
            }
          }
          if (changed) {
            try {
              fs.writeFileSync(
                probeJsonPath,
                JSON.stringify(
                  {
                    updatedAt: new Date().toISOString(),
                    totalSaved: Object.keys(domainProbeRegistry).length,
                    domains: domainProbeRegistry,
                  },
                  null,
                  2
                ),
                'utf-8'
              );
            } catch {}
          }
        }
      }
    } catch {}

    try {
      const cfRes = await axios.get(`${deps.cfWorkerBaseUrl}/api/ad_config/${encodeURIComponent(D1_CF_BLOCKED_DOC_ID)}`, {
        timeout: 8000,
        validateStatus: () => true,
      });
      if (cfRes.status >= 200 && cfRes.status < 300 && cfRes.data && typeof cfRes.data === 'object') {
        const remote = cfRes.data?.data || cfRes.data;
        const remoteDomains = remote?.domains;
        if (remoteDomains && typeof remoteDomains === 'object') {
          let changed = false;
          for (const [k, v] of Object.entries(remoteDomains as Record<string, CloudflareBlockedEntry>)) {
            if (v && v.host && !cloudflareBlockedRegistry[k]) {
              cloudflareBlockedRegistry[k] = v;
              changed = true;
            }
          }
          if (changed) {
            try {
              fs.writeFileSync(
                cfBlockedJsonPath,
                JSON.stringify(
                  {
                    updatedAt: new Date().toISOString(),
                    totalBlockedDomains: Object.keys(cloudflareBlockedRegistry).length,
                    domains: cloudflareBlockedRegistry,
                  },
                  null,
                  2
                ),
                'utf-8'
              );
            } catch {}
          }
        }
      }
    } catch {}
  };

  // Single-URL two-stage probe (Direct page -> Same-site inner child links -> Cloudflare/Playwright JS attempt -> Home domain fallback; NO video binary download!)
  const probeUrlAndSameSiteLinks = async (params: {
    inputUrl: string;
    scopeMode: DomainScopeMode;
    maxInnerLinksPerPage: number;
    verifyVideoHeaders: boolean;
    includeEmbedIframes: boolean;
    usePlaywrightFallback: boolean;
    autoPassCloudflare: boolean;
    excludePatterns: string[];
    triedHomeOrigins?: Set<string>;
    onStage?: (status: ProbeTaskStatus, msg: string) => void;
  }): Promise<{
    hasVideo: boolean;
    sourcePageUrl: string;
    discoveryDepth: 0 | 1;
    videoUrl: string;
    thumbnailUrl: string;
    title: string;
    videoType?: string;
    contentType?: string;
    sizeBytes?: number | null;
    verifiedLive?: boolean;
    usedPlaywright?: boolean;
    usedHomeDomainFallback?: boolean;
    blockedByCloudflare?: boolean;
    cloudflareHttpStatus?: number;
    playwrightAttempted?: boolean;
    innerLinksChecked: number;
    error?: string;
  }> => {
    const {
      inputUrl,
      scopeMode,
      maxInnerLinksPerPage,
      verifyVideoHeaders,
      includeEmbedIframes,
      usePlaywrightFallback,
      autoPassCloudflare,
      excludePatterns,
      triedHomeOrigins,
      onStage,
    } = params;

    const validateCandidates = async (
      candidates: Array<{ url: string; type: string; thumb?: string }>,
      referer: string,
      fallbackThumb: string
    ) => {
      for (const cand of candidates.slice(0, 3)) {
        if (!verifyVideoHeaders || cand.type === 'Embedded Player (iframe)') {
          return {
            matched: cand,
            thumb: cand.thumb || fallbackThumb,
            verifiedLive: cand.type === 'Embedded Player (iframe)',
            contentType: undefined,
            sizeBytes: null as number | null,
          };
        }
        const check = await verifyVideoUrlWithoutDownload(cand.url, referer);
        if (check.reachable) {
          return {
            matched: cand,
            thumb: cand.thumb || fallbackThumb,
            verifiedLive: true,
            contentType: check.contentType,
            sizeBytes: check.sizeBytes ?? null,
          };
        }
      }
      return null;
    };

    const probeSinglePageAndInnerLinks = async (targetUrl: string, stagePrefix: string, allowPlaywrightCf: boolean): Promise<{
      hasVideo: boolean;
      sourcePageUrl: string;
      discoveryDepth: 0 | 1;
      videoUrl: string;
      thumbnailUrl: string;
      title: string;
      videoType?: string;
      contentType?: string;
      sizeBytes?: number | null;
      verifiedLive?: boolean;
      usedPlaywright?: boolean;
      blockedByCloudflare?: boolean;
      cloudflareHttpStatus?: number;
      playwrightAttempted?: boolean;
      innerLinksChecked: number;
      error?: string;
    }> => {
      onStage?.('checking_direct', `${stagePrefix}Checking page headers & video tags (no download)...`);
      const level0 = await fetchLightweightHtmlOrDetectDirectVideo(targetUrl, undefined, deps.axiosGetWithRetry);

      if (level0.kind === 'cloudflare_blocked') {
        const execPath = allowPlaywrightCf && deps.resolveChromiumExecutable ? deps.resolveChromiumExecutable() : null;
        if (execPath) {
          onStage?.('checking_direct', `${stagePrefix}Cloudflare detected (HTTP ${level0.httpStatus || 403}) — attempting Playwright challenge pass...`);
          const pwCf = await probePageWithPlaywrightNoDownload({
            url: targetUrl,
            executablePath: execPath,
            scopeMode,
            isPreviewVideoUrl: deps.isPreviewVideoUrl,
            includeEmbedIframes,
            excludePatterns,
            waitForCloudflareMs: 4000,
            followTopInnerIfCleared: true,
          });
          if (pwCf && !pwCf.stillBlockedByCloudflare) {
            if (pwCf.videoCandidates.length > 0) {
              const hitCf0 = await validateCandidates(pwCf.videoCandidates, pwCf.finalUrl, pwCf.thumbnailUrl);
              if (hitCf0) {
                return {
                  hasVideo: true,
                  sourcePageUrl: pwCf.finalUrl,
                  discoveryDepth: 0,
                  videoUrl: hitCf0.matched.url,
                  thumbnailUrl: hitCf0.thumb || '',
                  title: pwCf.title,
                  videoType: hitCf0.matched.type,
                  contentType: hitCf0.contentType,
                  sizeBytes: hitCf0.sizeBytes,
                  verifiedLive: hitCf0.verifiedLive,
                  usedPlaywright: true,
                  playwrightAttempted: true,
                  innerLinksChecked: 0,
                };
              }
            }
            if (pwCf.innerPageMatch && pwCf.innerPageMatch.videoCandidates.length > 0) {
              const hitCf1 = await validateCandidates(
                pwCf.innerPageMatch.videoCandidates,
                pwCf.innerPageMatch.finalUrl,
                pwCf.innerPageMatch.thumbnailUrl || pwCf.thumbnailUrl
              );
              if (hitCf1) {
                return {
                  hasVideo: true,
                  sourcePageUrl: pwCf.innerPageMatch.finalUrl,
                  discoveryDepth: 1,
                  videoUrl: hitCf1.matched.url,
                  thumbnailUrl: hitCf1.thumb || '',
                  title: pwCf.innerPageMatch.title || pwCf.title,
                  videoType: hitCf1.matched.type,
                  contentType: hitCf1.contentType,
                  sizeBytes: hitCf1.sizeBytes,
                  verifiedLive: hitCf1.verifiedLive,
                  usedPlaywright: true,
                  playwrightAttempted: true,
                  innerLinksChecked: 1,
                };
              }
            }
            return {
              hasVideo: false,
              sourcePageUrl: pwCf.finalUrl,
              discoveryDepth: pwCf.innerPageMatch ? 1 : 0,
              videoUrl: '',
              thumbnailUrl: '',
              title: pwCf.title || '',
              usedPlaywright: true,
              playwrightAttempted: true,
              innerLinksChecked: pwCf.innerPageMatch ? 1 : 0,
            };
          }
          return {
            hasVideo: false,
            sourcePageUrl: pwCf?.finalUrl || targetUrl,
            discoveryDepth: 0,
            videoUrl: '',
            thumbnailUrl: '',
            title: '',
            blockedByCloudflare: true,
            cloudflareHttpStatus: pwCf?.httpStatus || level0.httpStatus,
            playwrightAttempted: true,
            innerLinksChecked: 0,
            error: level0.error || `Cloudflare Verification Failed (HTTP ${pwCf?.httpStatus || level0.httpStatus || 403})`,
          };
        }

        return {
          hasVideo: false,
          sourcePageUrl: level0.finalUrl || targetUrl,
          discoveryDepth: 0,
          videoUrl: '',
          thumbnailUrl: '',
          title: '',
          blockedByCloudflare: true,
          cloudflareHttpStatus: level0.httpStatus,
          playwrightAttempted: false,
          innerLinksChecked: 0,
          error: level0.error || `Cloudflare Verification (HTTP ${level0.httpStatus || 403})`,
        };
      }

      if (level0.kind === 'direct_video') {
        return {
          hasVideo: true,
          sourcePageUrl: level0.finalUrl,
          discoveryDepth: 0 as 0 | 1,
          videoUrl: level0.finalUrl,
          thumbnailUrl: '',
          title: path.basename(new URL(level0.finalUrl).pathname) || 'Direct Video Stream',
          videoType: 'Direct Video Stream',
          contentType: level0.contentType,
          sizeBytes: level0.sizeBytes,
          verifiedLive: true,
          innerLinksChecked: 0,
        };
      }

      const parsedL0 =
        level0.kind === 'html' && level0.html
          ? extractVideoThumbAndSameSiteLinksFromHtml(
              level0.html,
              level0.finalUrl,
              scopeMode,
              deps.isPreviewVideoUrl,
              includeEmbedIframes,
              excludePatterns
            )
          : null;

      if (parsedL0 && parsedL0.videoCandidates.length > 0) {
        const hit0 = await validateCandidates(parsedL0.videoCandidates, level0.finalUrl, parsedL0.thumbnailUrl);
        if (hit0) {
          return {
            hasVideo: true,
            sourcePageUrl: level0.finalUrl,
            discoveryDepth: 0 as 0 | 1,
            videoUrl: hit0.matched.url,
            thumbnailUrl: hit0.thumb || '',
            title: parsedL0.title,
            videoType: hit0.matched.type,
            contentType: hit0.contentType,
            sizeBytes: hit0.sizeBytes,
            verifiedLive: hit0.verifiedLive,
            innerLinksChecked: 0,
          };
        }
      }

      // Level 1 fallback: probe up to maxInnerLinksPerPage same-website links
      const innerCandidates = parsedL0 ? parsedL0.sameSiteLinks.slice(0, maxInnerLinksPerPage) : [];
      let innerChecked = 0;

      for (const inner of innerCandidates) {
        innerChecked++;
        onStage?.(
          'checking_inner_links',
          `${stagePrefix}No direct video — checking same-website link ${innerChecked}/${innerCandidates.length}...`
        );
        const level1 = await fetchLightweightHtmlOrDetectDirectVideo(inner.url, level0.finalUrl, deps.axiosGetWithRetry);
        if (level1.kind === 'direct_video') {
          return {
            hasVideo: true,
            sourcePageUrl: level1.finalUrl,
            discoveryDepth: 1 as 0 | 1,
            videoUrl: level1.finalUrl,
            thumbnailUrl: inner.anchorThumb || parsedL0?.thumbnailUrl || '',
            title: inner.anchorTitle || parsedL0?.title || '',
            videoType: 'Direct Video Stream',
            contentType: level1.contentType,
            sizeBytes: level1.sizeBytes,
            verifiedLive: true,
            innerLinksChecked: innerChecked,
          };
        }
        if (level1.kind === 'html' && level1.html) {
          const parsedL1 = extractVideoThumbAndSameSiteLinksFromHtml(
            level1.html,
            level1.finalUrl,
            scopeMode,
            deps.isPreviewVideoUrl,
            includeEmbedIframes,
            excludePatterns
          );
          if (parsedL1.videoCandidates.length > 0) {
            const hit1 = await validateCandidates(
              parsedL1.videoCandidates,
              level1.finalUrl,
              parsedL1.thumbnailUrl || inner.anchorThumb || parsedL0?.thumbnailUrl || ''
            );
            if (hit1) {
              return {
                hasVideo: true,
                sourcePageUrl: level1.finalUrl,
                discoveryDepth: 1 as 0 | 1,
                videoUrl: hit1.matched.url,
                thumbnailUrl: hit1.thumb || inner.anchorThumb || parsedL0?.thumbnailUrl || '',
                title: parsedL1.title || inner.anchorTitle || parsedL0?.title || '',
                videoType: hit1.matched.type,
                contentType: hit1.contentType,
                sizeBytes: hit1.sizeBytes,
                verifiedLive: hit1.verifiedLive,
                innerLinksChecked: innerChecked,
              };
            }
          }
        }
      }

      // Optional JS-Rendered SPA Fallback via Playwright (bounded 2 concurrent tabs, 0 video binary downloads)
      if (usePlaywrightFallback && deps.resolveChromiumExecutable) {
        const execPath = deps.resolveChromiumExecutable();
        if (execPath) {
          onStage?.('checking_direct', `${stagePrefix}Static HTML had no video — rendering JS via Playwright fallback...`);
          const pwL0 = await probePageWithPlaywrightNoDownload({
            url: targetUrl,
            executablePath: execPath,
            scopeMode,
            isPreviewVideoUrl: deps.isPreviewVideoUrl,
            includeEmbedIframes,
            excludePatterns,
          });
          if (pwL0 && pwL0.videoCandidates.length > 0) {
            const pwHit0 = await validateCandidates(pwL0.videoCandidates, pwL0.finalUrl, pwL0.thumbnailUrl);
            if (pwHit0) {
              return {
                hasVideo: true,
                sourcePageUrl: pwL0.finalUrl,
                discoveryDepth: 0 as 0 | 1,
                videoUrl: pwHit0.matched.url,
                thumbnailUrl: pwHit0.thumb || '',
                title: pwL0.title,
                videoType: pwHit0.matched.type,
                contentType: pwHit0.contentType,
                sizeBytes: pwHit0.sizeBytes,
                verifiedLive: pwHit0.verifiedLive,
                usedPlaywright: true,
                innerLinksChecked: innerChecked,
              };
            }
          }
          if (pwL0 && pwL0.sameSiteLinks.length > 0) {
            const topInner = pwL0.sameSiteLinks[0];
            innerChecked++;
            onStage?.('checking_inner_links', `${stagePrefix}Playwright checking top JS same-website link...`);
            const pwL1 = await probePageWithPlaywrightNoDownload({
              url: topInner.url,
              executablePath: execPath,
              scopeMode,
              isPreviewVideoUrl: deps.isPreviewVideoUrl,
              includeEmbedIframes,
              excludePatterns,
            });
            if (pwL1 && pwL1.videoCandidates.length > 0) {
              const pwHit1 = await validateCandidates(
                pwL1.videoCandidates,
                pwL1.finalUrl,
                pwL1.thumbnailUrl || topInner.anchorThumb || pwL0.thumbnailUrl
              );
              if (pwHit1) {
                return {
                  hasVideo: true,
                  sourcePageUrl: pwL1.finalUrl,
                  discoveryDepth: 1 as 0 | 1,
                  videoUrl: pwHit1.matched.url,
                  thumbnailUrl: pwHit1.thumb || topInner.anchorThumb || pwL0.thumbnailUrl || '',
                  title: pwL1.title || topInner.anchorTitle || pwL0.title,
                  videoType: pwHit1.matched.type,
                  contentType: pwHit1.contentType,
                  sizeBytes: pwHit1.sizeBytes,
                  verifiedLive: pwHit1.verifiedLive,
                  usedPlaywright: true,
                  innerLinksChecked: innerChecked,
                };
              }
            }
          }
        }
      }

      if (level0.kind === 'error') {
        return {
          hasVideo: false,
          sourcePageUrl: targetUrl,
          discoveryDepth: 0 as 0 | 1,
          videoUrl: '',
          thumbnailUrl: '',
          title: '',
          innerLinksChecked: innerChecked,
          error: level0.error || 'Failed to reach URL',
        };
      }

      if (level0.kind !== 'html') {
        return {
          hasVideo: false,
          sourcePageUrl: level0.finalUrl,
          discoveryDepth: 0 as 0 | 1,
          videoUrl: '',
          thumbnailUrl: '',
          title: '',
          innerLinksChecked: innerChecked,
          error: `Non-HTML resource (${level0.contentType || 'unknown'})`,
        };
      }

      return {
        hasVideo: false,
        sourcePageUrl: level0.finalUrl,
        discoveryDepth: (innerChecked > 0 ? 1 : 0) as 0 | 1,
        videoUrl: '',
        thumbnailUrl: '',
        title: parsedL0?.title || '',
        innerLinksChecked: innerChecked,
      };
    };

    const primaryRes = await probeSinglePageAndInnerLinks(inputUrl, '', autoPassCloudflare);
    if (primaryRes.hasVideo) {
      return primaryRes;
    }

    // If the submitted page was not found (e.g. HTTP 404/error) OR found no video on a deep path,
    // fall back once to that link's home domain (origin + '/') and probe it + its same-site links!
    try {
      const parsedIn = new URL(inputUrl);
      const isAlreadyHome = parsedIn.pathname === '/' && !parsedIn.search;
      const homeUrl = `${parsedIn.origin}/`;
      if (!isAlreadyHome && !triedHomeOrigins?.has(parsedIn.origin)) {
        triedHomeOrigins?.add(parsedIn.origin);
        onStage?.(
          'checking_inner_links',
          `${primaryRes.error ? `Page failed (${primaryRes.error})` : 'No video on page'} — trying home domain ${homeUrl}...`
        );
        const homeRes = await probeSinglePageAndInnerLinks(homeUrl, `[Home ${parsedIn.hostname}] `, autoPassCloudflare && !primaryRes.playwrightAttempted);
        if (homeRes.hasVideo) {
          return {
            ...homeRes,
            usedHomeDomainFallback: true,
            innerLinksChecked: primaryRes.innerLinksChecked + homeRes.innerLinksChecked,
          };
        }
        return {
          ...homeRes,
          usedHomeDomainFallback: true,
          blockedByCloudflare: Boolean(homeRes.blockedByCloudflare || primaryRes.blockedByCloudflare),
          cloudflareHttpStatus: homeRes.cloudflareHttpStatus ?? primaryRes.cloudflareHttpStatus,
          playwrightAttempted: Boolean(homeRes.playwrightAttempted || primaryRes.playwrightAttempted),
          innerLinksChecked: primaryRes.innerLinksChecked + homeRes.innerLinksChecked,
          error: homeRes.error && primaryRes.error ? `${primaryRes.error}; Home: ${homeRes.error}` : (homeRes.error || primaryRes.error),
        };
      }
    } catch {}

    return primaryRes;
  };

  let activeProbeJob: DomainProbeJobState | null = null;
  let probeCancelFlag = false;

  const recomputeJobCounters = (job: DomainProbeJobState) => {
    let pending = 0;
    let checking = 0;
    let foundYes = 0;
    let noVideo = 0;
    let cloudflareBlocked = 0;
    let skippedInJson = 0;
    let skippedCloudflareJson = 0;
    let skippedDomainLimit = 0;
    let errors = 0;
    for (const t of job.tasks) {
      if (t.status === 'pending') pending++;
      else if (t.status === 'checking_direct' || t.status === 'checking_inner_links') checking++;
      else if (t.status === 'found_yes') foundYes++;
      else if (t.status === 'no_video') noVideo++;
      else if (t.status === 'cloudflare_blocked') cloudflareBlocked++;
      else if (t.status === 'skipped_in_json') skippedInJson++;
      else if (t.status === 'skipped_cloudflare_json') skippedCloudflareJson++;
      else if (t.status === 'skipped_domain_limit') skippedDomainLimit++;
      else if (t.status === 'error') errors++;
    }
    job.total = job.tasks.length;
    job.pending = pending;
    job.checking = checking;
    job.foundYes = foundYes;
    job.noVideo = noVideo;
    job.cloudflareBlocked = cloudflareBlocked;
    job.skippedInJson = skippedInJson;
    job.skippedCloudflareJson = skippedCloudflareJson;
    job.skippedDomainLimit = skippedDomainLimit;
    job.errors = errors;
  };

  const runProbeWorkerLoop = (job: DomainProbeJobState) => {
    // Per-domain atomic tracker ensuring we NEVER exceed maxPerDomain (default 5) even at 50 concurrent workers!
    const triedHomeOrigins = new Set<string>();
    const domainStats = new Map<
      string,
      { attemptsUsed: number; inFlight: number; confirmed: boolean; cfBlocked: boolean }
    >();
    const getDomainStat = (scopeKey: string) => {
      let s = domainStats.get(scopeKey);
      if (!s) {
        s = {
          attemptsUsed: 0,
          inFlight: 0,
          confirmed: Boolean(domainProbeRegistry[scopeKey]),
          cfBlocked: Boolean(cloudflareBlockedRegistry[scopeKey]),
        };
        domainStats.set(scopeKey, s);
      }
      return s;
    };

    const sweepRemainingForDomain = (
      scopeKey: string,
      status: 'skipped_in_json' | 'skipped_cloudflare_json' | 'skipped_domain_limit',
      reason: string
    ) => {
      for (const t of job.tasks) {
        if (t.status === 'pending' && t.scopeKey === scopeKey) {
          t.status = status;
          t.message = reason;
          t.checkedAt = new Date().toISOString();
        }
      }
    };

    const claimNextTask = (): DomainProbeTask | null => {
      if (probeCancelFlag || !job.isRunning) return null;

      // Pass 1: sweep any tasks whose domain was confirmed, CF-blocked, or hit maxPerDomain
      for (const t of job.tasks) {
        if (t.status !== 'pending') continue;
        const saved = domainProbeRegistry[t.scopeKey];
        const cfSaved = cloudflareBlockedRegistry[t.scopeKey];
        const st = getDomainStat(t.scopeKey);
        if (saved || st.confirmed) {
          t.status = 'skipped_in_json';
          t.message = `Already saved in JSON (${saved?.hasVideo ? 'YES · Video Verified' : 'No-Video Logged'}) — skipped`;
          t.videoUrl = saved?.videoUrl || undefined;
          t.thumbnailUrl = saved?.thumbnailUrl || undefined;
          t.matchedPageUrl = saved?.sourcePageUrl || undefined;
          t.checkedAt = new Date().toISOString();
          continue;
        }
        if (cfSaved || st.cfBlocked) {
          t.status = 'skipped_cloudflare_json';
          t.blockedByCloudflare = true;
          t.message = `Already in Cloudflare Blocked JSON (${cfSaved?.reason || 'Cloudflare Verification'}) — skipped`;
          t.checkedAt = new Date().toISOString();
          continue;
        }
        if (st.attemptsUsed >= job.maxPerDomain && st.inFlight === 0) {
          t.status = 'skipped_domain_limit';
          t.message = `Skipped — already checked max ${job.maxPerDomain} links for ${t.scopeKey}`;
          t.checkedAt = new Date().toISOString();
        }
      }

      // Pass 2: Enforce max 1 in-flight worker per domain/subdomain at a time.
      for (const t of job.tasks) {
        if (t.status !== 'pending') continue;
        const st = getDomainStat(t.scopeKey);
        if (st.confirmed || st.cfBlocked || domainProbeRegistry[t.scopeKey] || cloudflareBlockedRegistry[t.scopeKey]) continue;
        if (st.attemptsUsed >= job.maxPerDomain) continue;
        if (st.inFlight === 0) {
          st.inFlight += 1;
          return t;
        }
      }

      return null;
    };

    let runningWorkers = 0;

    const spawnWorker = async (workerId: number) => {
      runningWorkers++;
      job.activeWorkers = runningWorkers;
      try {
        while (!probeCancelFlag && job.isRunning) {
          const task = claimNextTask();
          if (!task) {
            const anyPendingLeft = job.tasks.some((t) => {
              if (t.status !== 'pending') return false;
              const st = getDomainStat(t.scopeKey);
              return !st.confirmed && !st.cfBlocked && st.attemptsUsed < job.maxPerDomain;
            });
            const anyOtherInFlight = Array.from(domainStats.values()).some((s) => s.inFlight > 0);
            if (!anyPendingLeft && !anyOtherInFlight) {
              break;
            }
            if (anyOtherInFlight && anyPendingLeft) {
              await new Promise((r) => setTimeout(r, 100));
              continue;
            }
            break;
          }

          const st = getDomainStat(task.scopeKey);
          task.workerId = workerId;
          task.status = 'checking_direct';
          task.message = `[W${workerId}] Checking ${task.host}...`;

          try {
            if (st.confirmed || domainProbeRegistry[task.scopeKey]) {
              const saved = domainProbeRegistry[task.scopeKey];
              task.status = 'skipped_in_json';
              task.message = `Already saved in JSON — skipped`;
              task.videoUrl = saved?.videoUrl;
              task.thumbnailUrl = saved?.thumbnailUrl;
              task.checkedAt = new Date().toISOString();
            } else if (st.cfBlocked || cloudflareBlockedRegistry[task.scopeKey]) {
              task.status = 'skipped_cloudflare_json';
              task.blockedByCloudflare = true;
              task.message = `Already in Cloudflare Blocked JSON — skipped`;
              task.checkedAt = new Date().toISOString();
            } else {
              const res = await probeUrlAndSameSiteLinks({
                inputUrl: task.url,
                scopeMode: job.domainScope,
                maxInnerLinksPerPage: job.maxInnerLinksPerPage,
                verifyVideoHeaders: job.verifyVideoHeaders,
                includeEmbedIframes: job.includeEmbedIframes,
                usePlaywrightFallback: job.usePlaywrightFallback,
                autoPassCloudflare: job.autoPassCloudflare,
                excludePatterns: job.excludePatterns,
                triedHomeOrigins,
                onStage: (stage, msg) => {
                  task.status = stage;
                  task.message = `[W${workerId}] ${msg}`;
                },
              });

              st.attemptsUsed += 1;
              task.innerLinksChecked = res.innerLinksChecked;
              task.usedPlaywright = res.usedPlaywright;
              task.usedHomeDomainFallback = res.usedHomeDomainFallback;
              task.checkedAt = new Date().toISOString();

              if (res.hasVideo && res.videoUrl) {
                st.confirmed = true;
                task.status = 'found_yes';
                task.discoveryDepth = res.discoveryDepth;
                task.matchedPageUrl = res.sourcePageUrl;
                task.videoUrl = res.videoUrl;
                task.thumbnailUrl = res.thumbnailUrl;
                task.title = res.title;
                task.verifiedLive = res.verifiedLive;
                const originNote = res.usedHomeDomainFallback ? ' via Home Domain' : '';
                task.message =
                  res.discoveryDepth === 1
                    ? `[W${workerId}] YES${originNote} via same-website link (${res.innerLinksChecked} checked${res.usedPlaywright ? ', JS Playwright' : ''}) — Saved to JSON!`
                    : `[W${workerId}] YES${originNote} direct video found${res.usedPlaywright ? ' (JS Playwright)' : ''} — Saved to JSON!`;

                domainProbeRegistry[task.scopeKey] = {
                  host: task.scopeKey,
                  rootDomain: task.rootDomain,
                  status: 'confirmed',
                  hasVideo: true,
                  sourcePageUrl: res.sourcePageUrl,
                  originInputUrl: task.url,
                  discoveryDepth: res.discoveryDepth,
                  videoUrl: res.videoUrl,
                  thumbnailUrl: res.thumbnailUrl,
                  title: res.title,
                  videoType: res.videoType,
                  contentType: res.contentType,
                  sizeBytes: res.sizeBytes ?? null,
                  verifiedLive: Boolean(res.verifiedLive),
                  usedPlaywright: Boolean(res.usedPlaywright),
                  usedHomeDomainFallback: Boolean(res.usedHomeDomainFallback),
                  attemptsUsed: st.attemptsUsed,
                  checkedAt: new Date().toISOString(),
                };
                persistDomainProbeRegistry(false).catch(() => {});

                // Immediately skip ALL remaining pending links of this same domain!
                sweepRemainingForDomain(
                  task.scopeKey,
                  'skipped_in_json',
                  `Skipped — ${task.scopeKey} confirmed YES & saved in JSON`
                );
              } else if (res.blockedByCloudflare) {
                st.cfBlocked = true;
                task.status = 'cloudflare_blocked';
                task.blockedByCloudflare = true;
                task.error = res.error || 'Cloudflare verification blocked';
                task.message = `[W${workerId}] Cloudflare verification not passed — saved to domain_cloudflare_blocked.json`;

                cloudflareBlockedRegistry[task.scopeKey] = {
                  host: task.scopeKey,
                  rootDomain: task.rootDomain,
                  url: res.sourcePageUrl || task.url,
                  originInputUrl: task.url,
                  httpStatus: res.cloudflareHttpStatus,
                  reason: res.error || 'Cloudflare Verification Failed',
                  playwrightAttempted: Boolean(res.playwrightAttempted),
                  attemptsUsed: st.attemptsUsed,
                  checkedAt: new Date().toISOString(),
                };
                persistCloudflareBlockedRegistry(false).catch(() => {});

                sweepRemainingForDomain(
                  task.scopeKey,
                  'skipped_cloudflare_json',
                  `Skipped — ${task.scopeKey} saved in Cloudflare Blocked JSON`
                );
              } else if (res.error) {
                task.status = 'error';
                task.error = res.error;
                task.message = `[W${workerId}] ${res.error} (Attempt ${st.attemptsUsed}/${job.maxPerDomain} for ${task.scopeKey})`;
              } else {
                task.status = 'no_video';
                task.message = `[W${workerId}] No video (direct + ${res.innerLinksChecked} same-site links) · ${st.attemptsUsed}/${job.maxPerDomain}`;
              }

              // If domain reached maxPerDomain without any YES or CF block, optionally persist no_video & skip remaining pending links
              if (!st.confirmed && !st.cfBlocked && st.attemptsUsed >= job.maxPerDomain) {
                if (job.saveNoVideoDomains && st.inFlight <= 1 && !domainProbeRegistry[task.scopeKey]) {
                  domainProbeRegistry[task.scopeKey] = {
                    host: task.scopeKey,
                    rootDomain: task.rootDomain,
                    status: 'no_video',
                    hasVideo: false,
                    sourcePageUrl: task.url,
                    originInputUrl: task.url,
                    discoveryDepth: 0,
                    videoUrl: '',
                    thumbnailUrl: '',
                    title: res.title || task.host,
                    attemptsUsed: st.attemptsUsed,
                    checkedAt: new Date().toISOString(),
                  };
                  persistDomainProbeRegistry(false).catch(() => {});
                }
                sweepRemainingForDomain(
                  task.scopeKey,
                  'skipped_domain_limit',
                  `Skipped — max ${job.maxPerDomain} links checked for ${task.scopeKey}`
                );
              }
            }
          } catch (workerErr: any) {
            st.attemptsUsed += 1;
            task.status = 'error';
            task.error = cleanText(workerErr?.message || 'Probe error');
            task.message = `[W${workerId}] ${task.error}`;
          } finally {
            st.inFlight = Math.max(0, st.inFlight - 1);
            recomputeJobCounters(job);
          }
        }
      } finally {
        runningWorkers = Math.max(0, runningWorkers - 1);
        job.activeWorkers = runningWorkers;
        recomputeJobCounters(job);
        if (runningWorkers === 0) {
          job.isRunning = false;
          job.endedAt = new Date().toISOString();
          await Promise.all([
            persistDomainProbeRegistry(true).catch(() => {}),
            persistCloudflareBlockedRegistry(true).catch(() => {}),
          ]);
        }
      }
    };

    const workerCount = Math.min(job.concurrency, Math.max(1, job.tasks.length));
    for (let w = 1; w <= workerCount; w++) {
      void spawnWorker(w);
    }
  };

  // GET status + saved JSON registry + Cloudflare blocked registry
  app.get('/api/domain-probe/status', async (_req: Request, res: Response) => {
    await hydrateDomainProbeFromD1IfNeeded();
    if (activeProbeJob) recomputeJobCounters(activeProbeJob);
    const entries = Object.values(domainProbeRegistry).sort((a, b) =>
      String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
    );
    const cloudflareBlockedEntries = Object.values(cloudflareBlockedRegistry).sort((a, b) =>
      String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
    );
    res.json({
      success: true,
      registryCount: entries.length,
      confirmedCount: entries.filter((e) => e.hasVideo).length,
      noVideoCount: entries.filter((e) => !e.hasVideo).length,
      cloudflareBlockedCount: cloudflareBlockedEntries.length,
      cloudflareBlockedEntries,
      entries,
      job: activeProbeJob,
    });
  });

  // GET downloadable JSON file (confirmed domains)
  app.get('/api/domain-probe/export.json', async (_req: Request, res: Response) => {
    await hydrateDomainProbeFromD1IfNeeded();
    const payload = {
      exportedAt: new Date().toISOString(),
      totalDomains: Object.keys(domainProbeRegistry).length,
      confirmedVideoDomains: Object.values(domainProbeRegistry).filter((e) => e.hasVideo).length,
      domains: domainProbeRegistry,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="domain_video_probe.json"');
    res.send(JSON.stringify(payload, null, 2));
  });

  // GET downloadable Cloudflare-blocked JSON file
  app.get('/api/domain-probe/cloudflare-blocked.json', async (_req: Request, res: Response) => {
    await hydrateDomainProbeFromD1IfNeeded();
    const payload = {
      exportedAt: new Date().toISOString(),
      totalBlockedDomains: Object.keys(cloudflareBlockedRegistry).length,
      domains: cloudflareBlockedRegistry,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="domain_cloudflare_blocked.json"');
    res.send(JSON.stringify(payload, null, 2));
  });

  // POST start batch probe job (1..50 workers, max 5 links per domain/subdomain)
  app.post('/api/domain-probe/start', async (req: Request, res: Response) => {
    await hydrateDomainProbeFromD1IfNeeded();
    const {
      urls,
      concurrency = 15,
      maxPerDomain = 5,
      maxInnerLinksPerPage = 5,
      domainScope = 'exact_host',
      verifyVideoHeaders = true,
      includeEmbedIframes = false,
      saveNoVideoDomains = false,
      usePlaywrightFallback = false,
      autoPassCloudflare = true,
      excludePatterns = [],
    } = req.body || {};

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ success: false, error: 'urls array is required' });
    }

    if (activeProbeJob?.isRunning) {
      return res.status(409).json({
        success: false,
        error: 'A domain probe job is already running. Stop it first before starting a new batch.',
      });
    }

    const safeConcurrency = Math.max(1, Math.min(50, Number(concurrency) || 15));
    const safeMaxPerDomain = Math.max(1, Math.min(20, Number(maxPerDomain) || 5));
    const safeMaxInner = Math.max(1, Math.min(15, Number(maxInnerLinksPerPage) || 5));
    const safeScope: DomainScopeMode = domainScope === 'root_domain' ? 'root_domain' : 'exact_host';
    const cleanExcludePatterns: string[] = Array.isArray(excludePatterns)
      ? excludePatterns.map((p: any) => String(p || '').trim()).filter(Boolean)
      : typeof excludePatterns === 'string'
      ? excludePatterns
          .split(/[,|\n]+/)
          .map((p) => p.trim())
          .filter(Boolean)
      : [];

    const uniqueCleanUrls = Array.from(
      new Set(urls.map((u: any) => String(u || '').trim()).filter(Boolean))
    );

    let excludedCount = 0;
    const tasks: DomainProbeTask[] = [];
    uniqueCleanUrls.forEach((rawUrl, idx) => {
      const info = getScopeKeyFromUrl(rawUrl, safeScope);
      if (!info.valid) return;
      if (matchesExcludePatterns(info.normalizedUrl, cleanExcludePatterns)) {
        excludedCount++;
        return;
      }
      const existing = domainProbeRegistry[info.scopeKey];
      const existingCf = !existing ? cloudflareBlockedRegistry[info.scopeKey] : undefined;
      tasks.push({
        id: `dp_${Date.now()}_${idx + 1}`,
        index: tasks.length + 1,
        url: info.normalizedUrl,
        host: info.host,
        rootDomain: info.rootDomain,
        scopeKey: info.scopeKey,
        status: existing ? 'skipped_in_json' : existingCf ? 'skipped_cloudflare_json' : 'pending',
        message: existing
          ? `Already in JSON (${existing.hasVideo ? 'YES · Video Verified' : 'No-Video Logged'}) — skipped`
          : existingCf
          ? `Already in Cloudflare Blocked JSON (${existingCf.reason || 'Cloudflare'}) — skipped`
          : 'Queued for probe',
        blockedByCloudflare: Boolean(existingCf),
        matchedPageUrl: existing?.sourcePageUrl || undefined,
        videoUrl: existing?.videoUrl || undefined,
        thumbnailUrl: existing?.thumbnailUrl || undefined,
        title: existing?.title || undefined,
      });
    });

    if (tasks.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          excludedCount > 0
            ? `All ${excludedCount} provided URL(s) matched your exclude patterns.`
            : 'No valid HTTP/HTTPS URLs provided',
      });
    }

    probeCancelFlag = false;
    activeProbeJob = {
      jobId: `probe_${Date.now()}`,
      isRunning: true,
      cancelled: false,
      concurrency: safeConcurrency,
      maxPerDomain: safeMaxPerDomain,
      maxInnerLinksPerPage: safeMaxInner,
      domainScope: safeScope,
      verifyVideoHeaders: Boolean(verifyVideoHeaders),
      includeEmbedIframes: Boolean(includeEmbedIframes),
      saveNoVideoDomains: Boolean(saveNoVideoDomains),
      usePlaywrightFallback: Boolean(usePlaywrightFallback),
      autoPassCloudflare: Boolean(autoPassCloudflare),
      excludePatterns: cleanExcludePatterns,
      excludedCount,
      startedAt: new Date().toISOString(),
      total: tasks.length,
      pending: 0,
      checking: 0,
      foundYes: 0,
      noVideo: 0,
      cloudflareBlocked: 0,
      skippedInJson: 0,
      skippedCloudflareJson: 0,
      skippedDomainLimit: 0,
      errors: 0,
      activeWorkers: 0,
      tasks,
    };
    recomputeJobCounters(activeProbeJob);

    if (activeProbeJob.pending === 0) {
      activeProbeJob.isRunning = false;
      activeProbeJob.endedAt = new Date().toISOString();
    } else {
      runProbeWorkerLoop(activeProbeJob);
    }

    res.json({ success: true, job: activeProbeJob });
  });

  // POST stop running probe job cleanly
  app.post('/api/domain-probe/stop', (_req: Request, res: Response) => {
    probeCancelFlag = true;
    if (activeProbeJob) {
      activeProbeJob.cancelled = true;
      activeProbeJob.isRunning = false;
      activeProbeJob.endedAt = new Date().toISOString();
      for (const t of activeProbeJob.tasks) {
        if (t.status === 'checking_direct' || t.status === 'checking_inner_links') {
          t.status = 'pending';
          t.message = 'Stopped by user';
        }
      }
      recomputeJobCounters(activeProbeJob);
    }
    res.json({ success: true, job: activeProbeJob });
  });

  // POST clear current probe queue view (keeps saved JSON registry intact)
  app.post('/api/domain-probe/clear-job', (_req: Request, res: Response) => {
    probeCancelFlag = true;
    activeProbeJob = null;
    res.json({ success: true });
  });

  // DELETE one host from saved JSON registry (so user can re-probe it)
  app.delete('/api/domain-probe/registry/:host', async (req: Request, res: Response) => {
    const key = decodeURIComponent(String(req.params.host || '')).toLowerCase();
    if (domainProbeRegistry[key]) {
      delete domainProbeRegistry[key];
      await persistDomainProbeRegistry(true);
    }
    res.json({
      success: true,
      entries: Object.values(domainProbeRegistry).sort((a, b) =>
        String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
      ),
    });
  });

  // POST import & merge domain_video_probe.json entries
  app.post('/api/domain-probe/registry/import', async (req: Request, res: Response) => {
    await hydrateDomainProbeFromD1IfNeeded();
    const { data, overwriteExisting = false } = req.body || {};
    if (!data) {
      return res.status(400).json({ success: false, error: 'Missing JSON data payload' });
    }

    let rawList: any[] = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (data.domains && typeof data.domains === 'object') {
      rawList = Object.entries(data.domains).map(([k, v]: [string, any]) => ({ host: k, ...(v || {}) }));
    } else if (typeof data === 'object') {
      rawList = Object.entries(data).map(([k, v]: [string, any]) => ({ host: k, ...(v || {}) }));
    }

    let importedCount = 0;
    let skippedExisting = 0;
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const host = normalizeHost(String(item.host || ''));
      if (!host) continue;
      if (domainProbeRegistry[host] && !overwriteExisting) {
        skippedExisting++;
        continue;
      }
      const hasVideo = Boolean(item.hasVideo ?? item.videoUrl);
      domainProbeRegistry[host] = {
        host,
        rootDomain: normalizeHost(String(item.rootDomain || getRootDomain(host))),
        status: hasVideo ? 'confirmed' : 'no_video',
        hasVideo,
        sourcePageUrl: String(item.sourcePageUrl || ''),
        originInputUrl: String(item.originInputUrl || item.sourcePageUrl || ''),
        discoveryDepth: item.discoveryDepth === 1 ? 1 : 0,
        videoUrl: String(item.videoUrl || ''),
        thumbnailUrl: String(item.thumbnailUrl || ''),
        title: String(item.title || host),
        videoType: item.videoType,
        contentType: item.contentType,
        sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : null,
        verifiedLive: Boolean(item.verifiedLive),
        usedPlaywright: Boolean(item.usedPlaywright),
        attemptsUsed: Math.max(1, Number(item.attemptsUsed) || 1),
        checkedAt: String(item.checkedAt || new Date().toISOString()),
      };
      importedCount++;
    }

    await persistDomainProbeRegistry(true);
    res.json({
      success: true,
      importedCount,
      skippedExisting,
      entries: Object.values(domainProbeRegistry).sort((a, b) =>
        String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
      ),
    });
  });

  // POST remove stale entries (> N days old) or clear only no_video entries
  app.post('/api/domain-probe/registry/prune', async (req: Request, res: Response) => {
    await hydrateDomainProbeFromD1IfNeeded();
    const { mode = 'stale_days', days = 7 } = req.body || {};
    let removedCount = 0;
    const cutoffMs = Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;

    for (const [host, entry] of Object.entries(domainProbeRegistry)) {
      if (mode === 'no_video_only') {
        if (!entry.hasVideo) {
          delete domainProbeRegistry[host];
          removedCount++;
        }
      } else {
        const ts = Date.parse(entry.checkedAt || '');
        if (!Number.isNaN(ts) && ts < cutoffMs) {
          delete domainProbeRegistry[host];
          removedCount++;
        }
      }
    }

    if (removedCount > 0) {
      await persistDomainProbeRegistry(true);
    }

    res.json({
      success: true,
      removedCount,
      entries: Object.values(domainProbeRegistry).sort((a, b) =>
        String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
      ),
    });
  });

  // POST clear entire saved JSON registry
  app.post('/api/domain-probe/registry/clear', async (_req: Request, res: Response) => {
    domainProbeRegistry = {};
    await persistDomainProbeRegistry(true);
    res.json({ success: true, entries: [] });
  });

  // DELETE one host from Cloudflare-blocked JSON registry
  app.delete('/api/domain-probe/cloudflare-blocked/:host', async (req: Request, res: Response) => {
    const key = decodeURIComponent(String(req.params.host || '')).toLowerCase();
    if (cloudflareBlockedRegistry[key]) {
      delete cloudflareBlockedRegistry[key];
      await persistCloudflareBlockedRegistry(true);
    }
    res.json({
      success: true,
      cloudflareBlockedEntries: Object.values(cloudflareBlockedRegistry).sort((a, b) =>
        String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
      ),
    });
  });

  // POST clear entire Cloudflare-blocked JSON registry
  app.post('/api/domain-probe/cloudflare-blocked/clear', async (_req: Request, res: Response) => {
    cloudflareBlockedRegistry = {};
    await persistCloudflareBlockedRegistry(true);
    res.json({ success: true, cloudflareBlockedEntries: [] });
  });
}
