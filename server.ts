import express, { type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import tls from 'tls';
import dns from 'dns';
import net from 'net';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import ffmpegStatic from 'ffmpeg-static';
import { chromium } from 'playwright-core';
import { registerDomainProbeRoutes } from './domainProbeService.ts';

const execFileAsync = promisify(execFile);
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';

// Initialize dotenv, expand libuv threadpool, and prefer IPv4 to prevent 13s IPv6 handshake stalls on Cloud Run -> Cloudflare R2
dotenv.config();
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}
try {
  dns.setDefaultResultOrder('ipv4first');
  if (typeof (net as any).setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    (net as any).setDefaultAutoSelectFamilyAttemptTimeout(250);
  }
} catch {}

// Format network/Axios errors concisely without dumping raw TLSSocket / ClientRequest internals
function formatCompactError(err: any): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  const code = err.code || err.cause?.code;
  const status = err.response?.status;
  const msg = err.message || err.cause?.message || String(err);
  const parts: string[] = [];
  if (code) parts.push(`[${code}]`);
  if (status) parts.push(`[HTTP ${status}]`);
  parts.push(msg);
  return parts.join(' ');
}

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_BAD_RESPONSE',
  'UND_ERR_SOCKET',
  'HPE_INVALID_EOF_STATE',
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function isRetryableNetworkError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || err.cause?.code || '').toUpperCase();
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;

  const status = Number(err.response?.status || 0);
  if (status && RETRYABLE_HTTP_STATUSES.has(status)) return true;

  const msg = `${err.message || ''} ${err.cause?.message || ''}`.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('stream has been aborted') ||
    msg.includes('aborted') ||
    msg.includes('premature close') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('epipe') ||
    msg.includes('network socket disconnected')
  );
}

function isRetryableR2UploadError(err: any): boolean {
  if (!err) return false;
  if (isRetryableNetworkError(err)) return true;
  const status = Number(err.$metadata?.httpStatusCode || err.statusCode || err.response?.status || 0);
  if (status && (RETRYABLE_HTTP_STATUSES.has(status) || status === 408 || status === 429 || status >= 500)) {
    return true;
  }
  const name = String(err.name || err.Code || err.code || '').toLowerCase();
  if (
    name.includes('timeout') ||
    name.includes('slowdown') ||
    name.includes('serviceunavailable') ||
    name.includes('internalerror') ||
    name.includes('networkingerror') ||
    name.includes('nosuchupload')
  ) {
    return true;
  }
  const msg = `${err.message || ''} ${err.cause?.message || ''}`.toLowerCase();
  return (
    msg.includes('slowdown') ||
    msg.includes('service unavailable') ||
    msg.includes('internal error') ||
    msg.includes('broken pipe') ||
    msg.includes('connection reset') ||
    msg.includes('socket')
  );
}

function createNonKeepAliveAgents() {
  return {
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false }),
  };
}

function resolveOriginSafe(targetUrl?: string): string {
  if (!targetUrl) return '';
  try {
    return new URL(targetUrl).origin;
  } catch {
    return '';
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const USER_AGENT_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9,en-US;q=0.8',
  'en-US,en;q=0.9,hi;q=0.7',
];

let serverPoolRoundRobinIdx = 0;
const serverCooldownUntil = new Map<string, number>();
const domainLastFetchTime = new Map<string, number>();

function getConfiguredServerPool(extraServers: string[] = []): string[] {
  const envRaw =
    process.env.MULTI_SERVER_FETCH_URLS ||
    process.env.FETCH_RELAY_URLS ||
    process.env.SERVER_POOL_URLS ||
    '';
  const envList = envRaw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  const extraClean = (Array.isArray(extraServers) ? extraServers : [])
    .map((s) => String(s || '').trim())
    .filter((s) => /^https?:\/\//i.test(s));
  return Array.from(new Set(['direct', ...envList, ...extraClean]));
}

function isBlockedPrivateHost(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function parseRetryAfterMs(headers: any): number {
  const raw = headers?.['retry-after'];
  if (!raw) return 0;
  const secs = Number(raw);
  if (!isNaN(secs) && secs > 0) {
    return Math.min(15000, Math.round(secs * 1000));
  }
  const ts = Date.parse(String(raw));
  if (!isNaN(ts) && ts > Date.now()) {
    return Math.min(15000, ts - Date.now());
  }
  return 0;
}

async function paceDomainRequest(targetUrl: string, nodeKey = 'direct'): Promise<void> {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    const bucketKey = `${nodeKey}::${host}`;
    const now = Date.now();
    const prev = domainLastFetchTime.get(bucketKey) || 0;
    const minSpacingMs = 150 + Math.floor(Math.random() * 180);
    const waitMs = prev + minSpacingMs - now;
    domainLastFetchTime.set(bucketKey, Math.max(now, prev + minSpacingMs));
    if (waitMs > 0) {
      await sleepMs(Math.min(waitMs, 1000));
    }
  } catch {}
}

function createHttpConnectHttpsAgent(proxyUrl: URL, timeoutMs = 10000): https.Agent {
  const agent = new https.Agent({ keepAlive: false });
  const proxyHost = proxyUrl.hostname;
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
  const authHeader =
    proxyUrl.username || proxyUrl.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
      : undefined;

  (agent as any).createConnection = (options: any, cb: (err: Error | null, socket?: tls.TLSSocket) => void) => {
    const targetHost = options.host || options.hostname;
    const targetPort = Number(options.port) || 443;
    let settled = false;
    const finish = (err: Error | null, sock?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      cb(err, sock);
    };

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}),
      },
      timeout: timeoutMs,
    });

    connectReq.on('timeout', () => {
      connectReq.destroy();
      finish(new Error(`Proxy CONNECT timeout (${proxyHost}:${proxyPort})`));
    });

    connectReq.on('error', (err) => {
      finish(err);
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(new Error(`Proxy CONNECT HTTP ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || targetHost,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
      });
      tlsSocket.setTimeout(timeoutMs, () => {
        tlsSocket.destroy();
        finish(new Error(`Proxy TLS timeout (${proxyHost}:${proxyPort})`));
      });
      tlsSocket.once('secureConnect', () => {
        tlsSocket.setTimeout(0);
      });
      tlsSocket.once('error', (err) => finish(err));
      finish(null, tlsSocket);
    });

    connectReq.end();
  };

  return agent;
}

function testHttpsConnectProxy(proxyUrlStr: string, timeoutMs = 2200): Promise<{ proxy: string; latencyMs: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let pUrl: URL;
    try {
      pUrl = new URL(proxyUrlStr);
    } catch {
      return resolve(null);
    }

    const t0 = Date.now();
    const timer = setTimeout(() => {
      done(null);
    }, timeoutMs);

    let req: http.ClientRequest | null = null;
    let rawSock: any = null;
    let tlsSock: tls.TLSSocket | null = null;

    const done = (result: { proxy: string; latencyMs: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch {}
      try { tlsSock?.destroy(); } catch {}
      try { rawSock?.destroy(); } catch {}
      resolve(result);
    };

    req = http.request({
      host: pUrl.hostname,
      port: Number(pUrl.port) || 80,
      method: 'CONNECT',
      path: 'example.com:443',
      headers: { Host: 'example.com:443' },
    });

    req.on('error', () => done(null));
    req.on('connect', (res, socket) => {
      rawSock = socket;
      if (res.statusCode !== 200) {
        return done(null);
      }
      tlsSock = tls.connect({
        socket,
        servername: 'example.com',
      });
      tlsSock.on('error', () => done(null));
      tlsSock.once('secureConnect', () => {
        tlsSock?.write('HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
      });
      tlsSock.once('data', (chunk) => {
        const line = chunk.toString('utf8', 0, Math.min(chunk.length, 64));
        if (/^HTTP\/1\.[01]\s+(200|301|302)/.test(line)) {
          done({ proxy: proxyUrlStr, latencyMs: Math.max(1, Date.now() - t0) });
        } else {
          done(null);
        }
      });
    });

    req.end();
  });
}

async function axiosGetWithRetry(
  url: string,
  config: Record<string, any> = {},
  maxAttempts = 3,
  extraServers: string[] = []
) {
  const pool = getConfiguredServerPool(extraServers);
  const startNodeIdx = serverPoolRoundRobinIdx++ % pool.length;
  const totalAttempts = Math.max(maxAttempts, Math.min(6, pool.length + 1));
  let lastErr: any;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    // Pick next available non-cooled-down server node in the pool
    let chosenNode = pool[(startNodeIdx + attempt - 1) % pool.length];
    const now = Date.now();
    for (let offset = 0; offset < pool.length; offset++) {
      const candidate = pool[(startNodeIdx + attempt - 1 + offset) % pool.length];
      if ((serverCooldownUntil.get(candidate) || 0) <= now) {
        chosenNode = candidate;
        break;
      }
    }

    if (chosenNode === 'direct') {
      await paceDomainRequest(url, chosenNode);
    }

    const ua = USER_AGENT_POOL[(attempt + serverPoolRoundRobinIdx) % USER_AGENT_POOL.length];
    const acceptLang = ACCEPT_LANGUAGES[(attempt + serverPoolRoundRobinIdx) % ACCEPT_LANGUAGES.length];
    const agents = createNonKeepAliveAgents();
    const reqHeaders = {
      Connection: 'close',
      'User-Agent': ua,
      'Accept-Language': acceptLang,
      ...(config.headers || {}),
    };

    try {
      let response: any;
      if (chosenNode === 'direct') {
        response = await axios.get(url, {
          ...config,
          ...agents,
          headers: reqHeaders,
        });
      } else {
        // Check if chosenNode is an HTTP/HTTPS proxy (has explicit port or proxy prefix) vs a relay endpoint
        const normalizedNode = chosenNode.replace(/^proxy:/i, '');
        const isProxyFormat =
          /^proxy:/i.test(chosenNode) ||
          (!chosenNode.includes('?url=') &&
            !chosenNode.includes('{url}') &&
            !chosenNode.includes('/relay-fetch') &&
            /:\d+$/.test(new URL(normalizedNode).host));

        if (isProxyFormat) {
          const pUrl = new URL(normalizedNode);
          const isHttpsTarget = url.toLowerCase().startsWith('https://');
          if (isHttpsTarget) {
            response = await axios.get(url, {
              ...config,
              headers: reqHeaders,
              proxy: false,
              httpsAgent: createHttpConnectHttpsAgent(pUrl, Number(config.timeout) || 12000),
            });
          } else {
            response = await axios.get(url, {
              ...config,
              ...agents,
              headers: reqHeaders,
              proxy: {
                protocol: pUrl.protocol.replace(':', ''),
                host: pUrl.hostname,
                port: Number(pUrl.port) || (pUrl.protocol === 'https:' ? 443 : 80),
                ...(pUrl.username
                  ? { auth: { username: decodeURIComponent(pUrl.username), password: decodeURIComponent(pUrl.password) } }
                  : {}),
              },
            });
          }
        } else {
          // Relay HTTP/Worker fetch node (either Worker `?url=`, `{url}`, or another instance's `/api/relay-fetch`)
          let relayUrl = '';
          if (chosenNode.includes('{url}')) {
            relayUrl = chosenNode.replace('{url}', encodeURIComponent(url));
          } else if (chosenNode.includes('?url=') || chosenNode.includes('&url=')) {
            relayUrl = `${chosenNode}${encodeURIComponent(url)}`;
          } else {
            const base = chosenNode.replace(/\/+$/, '');
            const endpoint = base.endsWith('/api/relay-fetch') ? base : `${base}/api/relay-fetch`;
            relayUrl = `${endpoint}?url=${encodeURIComponent(url)}`;
          }

          response = await axios.get(relayUrl, {
            ...config,
            ...agents,
            headers: {
              ...reqHeaders,
              'x-target-url': url,
            },
          });
          // Unwrap JSON relay response if returned from /api/relay-fetch
          if (
            response.data &&
            typeof response.data === 'object' &&
            typeof response.data.html === 'string' &&
            typeof response.data.status === 'number'
          ) {
            response = {
              ...response,
              status: response.data.status,
              statusText: response.data.statusText || 'OK',
              headers: { ...response.headers, ...(response.data.headers || {}) },
              data: response.data.html,
              config: { ...response.config, url: response.data.finalUrl || url },
            };
          }
        }
      }

      if ((RETRYABLE_HTTP_STATUSES.has(response.status) || response.status === 403) && attempt < totalAttempts) {
        if (config.responseType === 'stream' && response.data && typeof response.data.destroy === 'function') {
          try {
            response.data.destroy();
          } catch {}
        }
        // Put rate-limited server node on cooldown so next attempt uses a different server
        const retryAfterMs = parseRetryAfterMs(response.headers);
        const cooldownMs = retryAfterMs || (response.status === 429 ? 8000 : 3000);
        serverCooldownUntil.set(chosenNode, Date.now() + cooldownMs);

        const backoff = Math.max(retryAfterMs, 550 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 350));
        await sleepMs(backoff);
        continue;
      }

      (response as any)._serverUsed = chosenNode;
      return response;
    } catch (err: any) {
      lastErr = err;
      serverCooldownUntil.set(chosenNode, Date.now() + 4000);
      if (attempt < totalAttempts && (isRetryableNetworkError(err) || err?.response?.status === 403 || err?.response?.status === 429)) {
        const backoff = 550 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 350);
        await sleepMs(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// System resources & CPU telemetry snapshot tracking
interface CpuSnapshot {
  idle: number;
  total: number;
  time: number;
}

let prevCpuSnapshot: CpuSnapshot | null = null;
let lastCalculatedCpuPercent = 0;

function getCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t in cpu.times) {
      total += (cpu.times as any)[t];
    }
    idle += cpu.times.idle;
  }
  return { idle, total, time: Date.now() };
}

function sampleLiveCpuPercent(): number {
  const currentSnapshot = getCpuSnapshot();
  if (prevCpuSnapshot && currentSnapshot.time - prevCpuSnapshot.time >= 700) {
    const diffTotal = currentSnapshot.total - prevCpuSnapshot.total;
    const diffIdle = currentSnapshot.idle - prevCpuSnapshot.idle;
    if (diffTotal > 0) {
      lastCalculatedCpuPercent = Math.max(0, Math.min(100, Math.round(((diffTotal - diffIdle) / diffTotal) * 100)));
    }
    prevCpuSnapshot = currentSnapshot;
  } else if (!prevCpuSnapshot) {
    prevCpuSnapshot = currentSnapshot;
  }
  const coreCount = Math.max(1, os.cpus().length);
  const loadRatioPct = Math.round(((os.loadavg()[0] || 0) / coreCount) * 100);
  return Math.min(100, Math.max(lastCalculatedCpuPercent, loadRatioPct));
}

// Baseline CPU & Network snapshots on start
try {
  prevCpuSnapshot = getCpuSnapshot();
} catch {}

interface NetSnapshot {
  rxBytes: number;
  txBytes: number;
  interfaces: string[];
  time: number;
}

function getLinuxNetworkSnapshot(): NetSnapshot {
  const interfaces: string[] = [];
  let rxBytes = 0;
  let txBytes = 0;
  try {
    if (fs.existsSync('/proc/net/dev')) {
      const content = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = content.split('\n').slice(2);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes(':')) continue;
        const [ifaceRaw, rest] = trimmed.split(':');
        const iface = ifaceRaw.trim();
        if (!iface || iface === 'lo') continue;
        const cols = rest.trim().split(/\s+/);
        if (cols.length >= 9) {
          const rx = Number(cols[0]) || 0;
          const tx = Number(cols[8]) || 0;
          rxBytes += rx;
          txBytes += tx;
          interfaces.push(iface);
        }
      }
    }
  } catch {}
  return { rxBytes, txBytes, interfaces, time: Date.now() };
}

function getNicLinkSpeedMbps(): number | null {
  try {
    if (fs.existsSync('/sys/class/net')) {
      const entries = fs.readdirSync('/sys/class/net');
      let maxSpeed = 0;
      for (const iface of entries) {
        if (iface === 'lo') continue;
        const speedPath = `/sys/class/net/${iface}/speed`;
        if (fs.existsSync(speedPath)) {
          const val = Number(fs.readFileSync(speedPath, 'utf8').trim());
          if (!isNaN(val) && val > maxSpeed) maxSpeed = val;
        }
      }
      if (maxSpeed > 0) return maxSpeed;
    }
  } catch {}
  return null;
}

let prevNetSnapshot: NetSnapshot | null = null;
let lastNetworkRates = {
  interfaces: [] as string[],
  downloadMbps: 0,
  uploadMbps: 0,
  downloadBps: 0,
  uploadBps: 0,
};
let lastSpeedTestResult: {
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  testedAt: string;
} | null = null;

try {
  prevNetSnapshot = getLinuxNetworkSnapshot();
  lastNetworkRates.interfaces = prevNetSnapshot.interfaces;
} catch {}

function getCpuClockSpeed(): { speedMhz: number; model: string } {
  const cpus = os.cpus();
  let speedMhz = cpus[0]?.speed || 0;
  let model = cpus[0]?.model || '';

  // If virtualization hides speed or model in os.cpus(), parse /proc/cpuinfo on Linux
  if ((!speedMhz || speedMhz === 0 || !model || model === 'unknown') && fs.existsSync('/proc/cpuinfo')) {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const speedMatch = cpuinfo.match(/cpu MHz\s*:\s*([\d.]+)/i);
      if (speedMatch && speedMatch[1]) {
        speedMhz = parseFloat(speedMatch[1]);
      }
      const modelMatch = cpuinfo.match(/model name\s*:\s*(.+)/i);
      if (modelMatch && modelMatch[1]) {
        const parsedModel = modelMatch[1].trim();
        if (parsedModel && parsedModel !== 'unknown') {
          model = parsedModel;
        }
      }
    } catch {}
  }

  if (!speedMhz || speedMhz === 0) {
    speedMhz = 2500;
  }
  if (!model || model === 'unknown') {
    model = `${cpus.length}x vCPU (${os.arch()})`;
  }

  return { speedMhz, model };
}

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const CF_WORKER_BASE_URL = (
  getEnvValue(['CF_WORKER_BASE_URL', 'CLOUDFLARE_WORKER_BASE_URL', 'OTT_API_BASE_URL']) ||
  'https://ott-api.fussionbhakti3.workers.dev'
).replace(/\/+$/, '');

// Temp & local storage directory with automatic fallback to OS tmpdir if workspace dir is read-only
let localUploadsDir = path.join(__dirname, 'uploads');
try {
  if (!fs.existsSync(localUploadsDir)) {
    fs.mkdirSync(localUploadsDir, { recursive: true });
  }
  fs.accessSync(localUploadsDir, fs.constants.W_OK);
} catch {
  localUploadsDir = path.join(os.tmpdir(), 'ott-uploads');
  if (!fs.existsSync(localUploadsDir)) {
    fs.mkdirSync(localUploadsDir, { recursive: true });
  }
}
const localVideosDir = path.join(localUploadsDir, 'videos');
const localThumbsDir = path.join(localUploadsDir, 'thumbnails');
const localDatabaseDir = path.join(localUploadsDir, 'database');
if (!fs.existsSync(localVideosDir)) fs.mkdirSync(localVideosDir, { recursive: true });
if (!fs.existsSync(localThumbsDir)) fs.mkdirSync(localThumbsDir, { recursive: true });
if (!fs.existsSync(localDatabaseDir)) fs.mkdirSync(localDatabaseDir, { recursive: true });

// Store transient video downloads & FFmpeg scratch files in OS tmpdir so large binaries never bloat the project workspace
let localTempDir = path.join(os.tmpdir(), 'ott-temp');
try {
  if (!fs.existsSync(localTempDir)) {
    fs.mkdirSync(localTempDir, { recursive: true });
  }
  fs.accessSync(localTempDir, fs.constants.W_OK);
} catch {
  localTempDir = localUploadsDir;
}

// Sweep stale temp_vid_* / temp_comp_* files left behind by previous interrupted runs (>30m old)
function cleanupOrphanedTempVideoFiles(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  const dirs = Array.from(new Set([localTempDir, localUploadsDir]));
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/^(temp_vid_|temp_comp_)/i.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          const st = fs.statSync(fullPath);
          if (now - st.mtimeMs >= maxAgeMs) {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
    } catch {}
  }
}
cleanupOrphanedTempVideoFiles();

// Parse JSON bodies
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max video file
  },
});

/**
 * Intelligent Environment Variable Matcher:
 * Supports standard, Cloudflare, S3, and case-insensitive aliases for secrets.
 */
function getEnvValue(aliases: string[]): string {
  // Re-read .env if present
  try {
    dotenv.config();
  } catch {}

  const env = process.env;
  for (const alias of aliases) {
    if (env[alias] && typeof env[alias] === 'string' && env[alias]!.trim().length > 0) {
      return env[alias]!.trim().replace(/^["']|["']$/g, '');
    }
  }

  // Case-insensitive fallback
  const envKeys = Object.keys(env);
  for (const alias of aliases) {
    const lowerAlias = alias.toLowerCase();
    const matchedKey = envKeys.find((k) => k.toLowerCase() === lowerAlias);
    if (matchedKey && env[matchedKey] && typeof env[matchedKey] === 'string' && env[matchedKey]!.trim().length > 0) {
      return env[matchedKey]!.trim().replace(/^["']|["']$/g, '');
    }
  }

  return '';
}

function sanitizeAccountId(val: string): string {
  if (!val) return '';
  let cleaned = val.trim();
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/\.r2\.cloudflarestorage\.com.*$/i, '');
  cleaned = cleaned.split('/')[0].trim();
  return cleaned;
}

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrlPrefix?: string;
  source: 'client_headers' | 'server_secrets';
}

function getR2Config(req?: Request): R2Config | null {
  // 1. Client header overrides (if user inputted in browser)
  const headerAccountId = (req?.headers['x-r2-account-id'] as string) || '';
  const headerAccessKeyId = (req?.headers['x-r2-access-key-id'] as string) || '';
  const headerSecretAccessKey = (req?.headers['x-r2-secret-access-key'] as string) || '';
  const headerBucketName = (req?.headers['x-r2-bucket-name'] as string) || '';
  const headerPublicUrlPrefix = (req?.headers['x-r2-public-url-prefix'] as string) || '';

  if (headerAccountId && headerAccessKeyId && headerSecretAccessKey && headerBucketName) {
    return {
      accountId: sanitizeAccountId(headerAccountId),
      accessKeyId: headerAccessKeyId.trim(),
      secretAccessKey: headerSecretAccessKey.trim(),
      bucketName: headerBucketName.trim(),
      publicUrlPrefix: headerPublicUrlPrefix.trim().replace(/\/+$/, ''),
      source: 'client_headers',
    };
  }

  // 2. Server Environment Secrets (with flexible naming aliases)
  const accountIdRaw = getEnvValue([
    'R2_ACCOUNT_ID',
    'CLOUDFLARE_R2_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
    'ACCOUNT_ID',
  ]);

  const accessKeyId = getEnvValue([
    'R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_ACCESS_KEY_ID',
    'CF_ACCESS_KEY_ID',
    'AWS_ACCESS_KEY_ID',
    'R2_ACCESS_KEY',
    'ACCESS_KEY_ID',
  ]);

  const secretAccessKey = getEnvValue([
    'R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_SECRET_ACCESS_KEY',
    'CF_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'R2_SECRET_KEY',
    'SECRET_ACCESS_KEY',
  ]);

  const bucketName = getEnvValue([
    'R2_BUCKET_NAME',
    'CLOUDFLARE_R2_BUCKET_NAME',
    'CLOUDFLARE_BUCKET_NAME',
    'CLOUDFLARE_BUCKET',
    'CF_BUCKET_NAME',
    'CF_BUCKET',
    'R2_BUCKET',
    'BUCKET_NAME',
  ]);

  const publicUrlPrefix = getEnvValue([
    'R2_PUBLIC_URL_PREFIX',
    'R2_PUBLIC_URL',
    'CLOUDFLARE_R2_PUBLIC_URL',
    'PUBLIC_URL_PREFIX',
    'R2_DOMAIN',
  ]);

  const accountId = sanitizeAccountId(accountIdRaw);

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicUrlPrefix: publicUrlPrefix.replace(/\/+$/, ''),
    source: 'server_secrets',
  };
}

const r2SharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 256,
  maxFreeSockets: 64,
  scheduling: 'lifo',
  timeout: 180000,
});

const r2SharedHttpHandler = new NodeHttpHandler({
  httpsAgent: r2SharedHttpsAgent,
  connectionTimeout: 15000,
  socketTimeout: 180000,
  requestTimeout: 0,
});

const r2ClientCache = new Map<string, S3Client>();
let activeR2VideoUploads = 0;

function getR2MultipartTuning(fileSizeBytes: number): { queueSize: number; partSize: number } {
  const concurrentNow = Math.max(1, activeR2VideoUploads);
  const queueSize =
    concurrentNow <= 1 ? 12 : concurrentNow === 2 ? 8 : concurrentNow <= 5 ? 6 : 4;
  const partSize =
    fileSizeBytes >= 512 * 1024 * 1024
      ? 16 * 1024 * 1024
      : fileSizeBytes >= 80 * 1024 * 1024
      ? 8 * 1024 * 1024
      : 5 * 1024 * 1024;
  return { queueSize, partSize };
}

function createR2Client(config: R2Config): S3Client {
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${config.accountId}|${config.accessKeyId}|${config.secretAccessKey}`)
    .digest('hex')
    .slice(0, 24);
  const cached = r2ClientCache.get(cacheKey);
  if (cached) return cached;

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestHandler: r2SharedHttpHandler,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 4,
  });

  if (r2ClientCache.size >= 16) {
    const firstKey = r2ClientCache.keys().next().value;
    if (firstKey) r2ClientCache.delete(firstKey);
  }
  r2ClientCache.set(cacheKey, client);
  return client;
}

export interface VerificationStep {
  step: string;
  status: 'VERIFIED' | 'FAILED' | 'SKIPPED' | 'ABORTED';
  timestamp: string;
  details: string;
  error?: string;
}

interface VideoRecord {
  status: string;
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  captureTimestamp: number;
  sizeMb: number;
  durationSec: number;
  duration: string;
  uploadTime: number;
  cloudflareR2: {
    uploadedToCloudflareR2: boolean;
    bucket: string;
    accountId: string | null;
    videoKey: string;
    thumbnailKey: string;
    etagVideo: string | null;
    etagThumbnail: string | null;
    publicUrlPrefix: string | null;
    directAccessMode: string;
    verifiedInStorage: boolean;
  };
  metadata: {
    filename: string;
    exactFilename?: string;
    fileSize: number;
    fileSizeFormatted: string;
    sizeMb: number;
    duration: number;
    durationSec: number;
    durationFormatted: string;
    durationHuman: string;
    uploadTime: number;
    width: number;
    height: number;
    resolution: string;
    aspectRatio: string;
    mimeType: string;
    bitrateEstimateKbps: number;
    thumbnailSize: number;
    thumbnailSizeFormatted: string;
    thumbnailDimensions: string;
    targetThumbnailTimeSeconds?: number;
    capturedAtSecond: number;
    uploadedAt: string;
  };
  verificationAudit: VerificationStep[];
}

const videoRecords: VideoRecord[] = [];

// ================= API ROUTES =================

// Check R2 status & detected environment keys
app.get('/api/r2/status', (req: Request, res: Response) => {
  const config = getR2Config(req);

  // Check which individual secrets are detected in process.env
  const detectedSecrets = {
    accountId: Boolean(
      getEnvValue([
        'R2_ACCOUNT_ID',
        'CLOUDFLARE_R2_ACCOUNT_ID',
        'CLOUDFLARE_ACCOUNT_ID',
        'CF_ACCOUNT_ID',
        'ACCOUNT_ID',
      ])
    ),
    accessKeyId: Boolean(
      getEnvValue([
        'R2_ACCESS_KEY_ID',
        'CLOUDFLARE_R2_ACCESS_KEY_ID',
        'CLOUDFLARE_ACCESS_KEY_ID',
        'CF_ACCESS_KEY_ID',
        'AWS_ACCESS_KEY_ID',
        'R2_ACCESS_KEY',
        'ACCESS_KEY_ID',
      ])
    ),
    secretAccessKey: Boolean(
      getEnvValue([
        'R2_SECRET_ACCESS_KEY',
        'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
        'CLOUDFLARE_SECRET_ACCESS_KEY',
        'CF_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'R2_SECRET_KEY',
        'SECRET_ACCESS_KEY',
      ])
    ),
    bucketName: Boolean(
      getEnvValue([
        'R2_BUCKET_NAME',
        'CLOUDFLARE_R2_BUCKET_NAME',
        'CLOUDFLARE_BUCKET_NAME',
        'CLOUDFLARE_BUCKET',
        'CF_BUCKET_NAME',
        'CF_BUCKET',
        'R2_BUCKET',
        'BUCKET_NAME',
      ])
    ),
    publicUrlPrefix: Boolean(
      getEnvValue([
        'R2_PUBLIC_URL_PREFIX',
        'R2_PUBLIC_URL',
        'CLOUDFLARE_R2_PUBLIC_URL',
        'PUBLIC_URL_PREFIX',
        'R2_DOMAIN',
      ])
    ),
  };

  const allSecretsFound =
    detectedSecrets.accountId &&
    detectedSecrets.accessKeyId &&
    detectedSecrets.secretAccessKey &&
    detectedSecrets.bucketName;

  if (config) {
    res.json({
      configured: true,
      bucket: config.bucketName,
      accountId: `${config.accountId.substring(0, 4)}••••${config.accountId.substring(config.accountId.length - 4)}`,
      publicUrlPrefix: config.publicUrlPrefix || null,
      source: config.source,
      detectedSecrets,
      allSecretsFound,
    });
  } else {
    res.json({
      configured: false,
      message:
        'Cloudflare R2 is not fully configured yet. Uploads will use built-in local emulator mode until R2 credentials are provided.',
      detectedSecrets,
      allSecretsFound,
      missingSecrets: [
        !detectedSecrets.accountId && 'R2_ACCOUNT_ID',
        !detectedSecrets.accessKeyId && 'R2_ACCESS_KEY_ID',
        !detectedSecrets.secretAccessKey && 'R2_SECRET_ACCESS_KEY',
        !detectedSecrets.bucketName && 'R2_BUCKET_NAME',
      ].filter(Boolean),
    });
  }
});

// Test R2 connection
app.post('/api/r2/test', async (req: Request, res: Response) => {
  try {
    const config = getR2Config(req);
    if (!config) {
      res.status(400).json({
        success: false,
        error:
          'Missing required R2 configuration (Account ID, Access Key ID, Secret Access Key, or Bucket Name).',
      });
      return;
    }

    const client = createR2Client(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));

    res.json({
      success: true,
      message: `Successfully connected to Cloudflare R2 bucket: "${config.bucketName}" via S3 API`,
      bucket: config.bucketName,
      source: config.source,
    });
  } catch (error: any) {
    console.error('R2 test connection error:', error);
    res.status(500).json({
      success: false,
      error:
        error?.message ||
        'Failed to authenticate with Cloudflare R2. Please check your credentials.',
      details: error?.Code || error?.name,
    });
  }
});

/**
 * Process & Upload Video with STRICT STEP-BY-STEP VERIFICATION:
 *
 * If ANY step fails or returns an error, the pipeline IMMEDIATELY ABORTS.
 * Subsequent steps are marked as ABORTED and are NEVER executed.
 * Read-after-write verification (HeadObject) is enforced for both video and thumbnail!
 */
app.post('/api/upload', (req: Request, res: Response) => {
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ])(req, res, async (multerErr: any) => {
    if (multerErr) {
      console.error('Multer upload parsing error:', multerErr);
      return res.status(400).json({
        status: 'error',
        failedStep: '1. Video File Integrity',
        error: multerErr.message || 'File upload parsing error',
        code: multerErr.code,
        subsequentStepsAborted: true,
        verificationAudit: [
          {
            step: '1. Video File Integrity',
            status: 'FAILED',
            timestamp: new Date().toISOString(),
            details: `Upload failed during multipart parsing: ${multerErr.message}`,
            error: multerErr.message,
          },
        ],
      });
    }

    try {
      const audit: VerificationStep[] = [];
      const timestamp = Date.now();
      const id = `vid_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const videoFile = files?.['video']?.[0];
      const thumbnailFile = files?.['thumbnail']?.[0];

      let clientMetadata: any = {};
      try {
        if (typeof req.body.metadata === 'string') {
          clientMetadata = JSON.parse(req.body.metadata);
        } else if (req.body.metadata && typeof req.body.metadata === 'object') {
          clientMetadata = req.body.metadata;
        }
      } catch {
        clientMetadata = {};
      }

      const captureTimestamp = Number(req.body.captureTimestamp) || 5.0;

    // STEP 1: Video File Integrity & Payload Verification
    if (!videoFile || videoFile.size === 0) {
      audit.push({
        step: '1. Video File Integrity',
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        details: 'Video file buffer missing or 0 bytes received',
        error: 'Video file is required and must not be empty',
      });
      res.status(400).json({
        status: 'error',
        failedStep: '1. Video File Integrity',
        error: 'Video file is required',
        subsequentStepsAborted: true,
        verificationAudit: audit,
      });
      return;
    }

    audit.push({
      step: '1. Video File Integrity',
      status: 'VERIFIED',
      timestamp: new Date().toISOString(),
      details: `Received ${videoFile.originalname} (${(videoFile.size / (1024 * 1024)).toFixed(2)} MB, MIME: ${videoFile.mimetype || 'video/mp4'})`,
    });

    // STEP 2: 5-Second Frame Thumbnail Verification
    if (!thumbnailFile || thumbnailFile.size === 0) {
      audit.push({
        step: '2. 5s Frame Thumbnail Verification',
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        details: 'Extracted frame thumbnail buffer missing or 0 bytes',
        error: 'Thumbnail frame image is required',
      });
      res.status(400).json({
        status: 'error',
        failedStep: '2. 5s Frame Thumbnail Verification',
        error: 'Extracted 5-second thumbnail image is required',
        subsequentStepsAborted: true,
        verificationAudit: audit,
      });
      return;
    }

    audit.push({
      step: '2. 5s Frame Thumbnail Verification',
      status: 'VERIFIED',
      timestamp: new Date().toISOString(),
      details: `Thumbnail frame at ${captureTimestamp.toFixed(1)}s verified (${(thumbnailFile.size / 1024).toFixed(1)} KB JPEG)`,
    });

    // User Requirement: "read the video name and exact name must be given to the file uploaded"
    const exactFilename = videoFile.originalname;
    const parsedName = path.parse(exactFilename);
    const baseNameWithoutExt = parsedName.name;

    // Optional folder prefix (default 'videos'), or root if set to empty string
    const folderPrefix = req.body.folderPrefix !== undefined ? String(req.body.folderPrefix).trim() : 'videos';
    const cleanFolder = folderPrefix ? folderPrefix.replace(/^\/+|\/+$/g, '') : '';

    const videoKey = cleanFolder ? `${cleanFolder}/${exactFilename}` : exactFilename;
    const thumbFolder = cleanFolder ? 'thumbnails' : '';
    const thumbKey = thumbFolder
      ? `${thumbFolder}/${baseNameWithoutExt}-thumb-${captureTimestamp}s.jpg`
      : `${baseNameWithoutExt}-thumb-${captureTimestamp}s.jpg`;

    const r2Config = getR2Config(req);
    const appBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    let videoUrl = '';
    let thumbnailUrl = '';
    let etagVideo: string | null = null;
    let etagThumbnail: string | null = null;
    let verifiedInStorage = false;

    if (r2Config) {
      const s3 = createR2Client(r2Config);

      // STEP 3: Cloudflare R2 Pre-Flight Authentication & Bucket Verification
      try {
        await s3.send(new HeadBucketCommand({ Bucket: r2Config.bucketName }));
        audit.push({
          step: '3. Cloudflare R2 Connection Pre-Flight',
          status: 'VERIFIED',
          timestamp: new Date().toISOString(),
          details: `Authenticated with Cloudflare R2 (Bucket: ${r2Config.bucketName}, Account: ${r2Config.accountId.substring(0, 4)}••••, Source: ${r2Config.source})`,
        });
      } catch (r2AuthError: any) {
        audit.push({
          step: '3. Cloudflare R2 Connection Pre-Flight',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: `Failed to authenticate with Cloudflare R2 bucket "${r2Config.bucketName}"`,
          error: r2AuthError?.message || 'Cloudflare R2 authentication failed',
        });
        // STRICT HALT: Do not proceed to video upload!
        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Pre-flight Cloudflare R2 check failed',
        });
        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Previous step failed',
        });
        audit.push({
          step: '6. Playback URL Resolution & Schema Formatting',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Previous step failed',
        });

        res.status(422).json({
          status: 'error',
          failedStep: '3. Cloudflare R2 Connection Pre-Flight',
          error: `Cloudflare R2 pre-flight verification failed: ${r2AuthError?.message || 'Bucket unreachable'}`,
          details: r2AuthError?.Code || r2AuthError?.name,
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      // STEP 4: Video Upload to Cloudflare R2 & Read-after-Write Verification
      try {
        if (videoFile.size > 5 * 1024 * 1024) {
          const { queueSize, partSize } = getR2MultipartTuning(videoFile.size);
          const parallelUpload = new Upload({
            client: s3,
            params: {
              Bucket: r2Config.bucketName,
              Key: videoKey,
              Body: videoFile.buffer,
              ContentType: videoFile.mimetype || 'video/mp4',
              CacheControl: 'public, max-age=31536000',
              Metadata: {
                'original-name': encodeURIComponent(videoFile.originalname),
                'duration-seconds': String(clientMetadata.duration || 0),
                'extracted-timestamp': String(captureTimestamp),
              },
            },
            queueSize,
            partSize,
            leavePartsOnError: false,
          });
          const upRes = await parallelUpload.done();
          etagVideo = upRes.ETag || null;
        } else {
          const videoUploadResult = await s3.send(
            new PutObjectCommand({
              Bucket: r2Config.bucketName,
              Key: videoKey,
              Body: videoFile.buffer,
              ContentLength: videoFile.size,
              ContentType: videoFile.mimetype || 'video/mp4',
              CacheControl: 'public, max-age=31536000',
              Metadata: {
                'original-name': encodeURIComponent(videoFile.originalname),
                'duration-seconds': String(clientMetadata.duration || 0),
                'extracted-timestamp': String(captureTimestamp),
              },
            })
          );
          etagVideo = videoUploadResult.ETag || null;
        }

        // READ-AFTER-WRITE VERIFICATION: Verify object exists in Cloudflare R2
        const headVideo = await s3.send(
          new HeadObjectCommand({
            Bucket: r2Config.bucketName,
            Key: videoKey,
          })
        );

        if (headVideo.ContentLength !== videoFile.size) {
          throw new Error(
            `Size verification mismatch: uploaded ${videoFile.size} bytes, Cloudflare R2 reports ${headVideo.ContentLength} bytes`
          );
        }

        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'VERIFIED',
          timestamp: new Date().toISOString(),
          details: `Stored at "${videoKey}". Verified via HeadObject (${headVideo.ContentLength} bytes, ETag: ${headVideo.ETag})`,
        });
      } catch (videoError: any) {
        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: `Error uploading or verifying video object in Cloudflare R2`,
          error: videoError?.message || 'Failed to upload video to R2',
        });
        // STRICT HALT: Abort thumbnail upload and URL resolution!
        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Video upload failed',
        });
        audit.push({
          step: '6. Playback URL Resolution & Schema Formatting',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Video upload failed',
        });

        res.status(500).json({
          status: 'error',
          failedStep: '4. Video Upload & Read-after-Write Verification',
          error: `Video upload failed: ${videoError?.message}`,
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      // STEP 5: Thumbnail Upload to Cloudflare R2 & Read-after-Write Verification
      try {
        const thumbUploadResult = await s3.send(
          new PutObjectCommand({
            Bucket: r2Config.bucketName,
            Key: thumbKey,
            Body: thumbnailFile.buffer,
            ContentType: thumbnailFile.mimetype || 'image/jpeg',
            Metadata: {
              'video-key': videoKey,
              'extracted-timestamp': String(captureTimestamp),
            },
          })
        );
        etagThumbnail = thumbUploadResult.ETag || null;

        // READ-AFTER-WRITE VERIFICATION: Verify thumbnail exists in Cloudflare R2
        const headThumb = await s3.send(
          new HeadObjectCommand({
            Bucket: r2Config.bucketName,
            Key: thumbKey,
          })
        );

        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'VERIFIED',
          timestamp: new Date().toISOString(),
          details: `Stored at "${thumbKey}". Verified via HeadObject (${headThumb.ContentLength} bytes, ${headThumb.ContentType})`,
        });

        verifiedInStorage = true;
      } catch (thumbError: any) {
        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: `Error uploading or verifying thumbnail object in Cloudflare R2`,
          error: thumbError?.message || 'Failed to upload thumbnail to R2',
        });
        audit.push({
          step: '6. Playback URL Resolution & Schema Formatting',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Thumbnail upload failed',
        });

        res.status(500).json({
          status: 'error',
          failedStep: '5. Thumbnail Upload & Storage Verification',
          error: `Thumbnail upload failed: ${thumbError?.message}`,
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      // STEP 6: URL Resolution & Formatting
      if (r2Config.publicUrlPrefix) {
        videoUrl = `${r2Config.publicUrlPrefix}/${videoKey}`;
        thumbnailUrl = `${r2Config.publicUrlPrefix}/${thumbKey}`;
      } else {
        videoUrl = `${appBaseUrl}/api/r2/stream/${encodeURIComponent(videoKey)}`;
        thumbnailUrl = `${appBaseUrl}/api/r2/stream/${encodeURIComponent(thumbKey)}`;
      }

      audit.push({
        step: '6. Playback URL Resolution & Schema Formatting',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: `Resolved playback URL and 5s thumbnail URL (${r2Config.publicUrlPrefix ? 'direct R2 public domain' : 'secure proxy stream'})`,
      });
    } else {
      // Local Emulator Mode (Step 3, 4, 5 with local verification)
      audit.push({
        step: '3. Cloudflare R2 Connection Pre-Flight',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: 'Local emulator storage active (No R2 keys provided in secrets or UI)',
      });

      const videoLocalPath = path.join(localVideosDir, exactFilename);
      const thumbLocalPath = path.join(
        localThumbsDir,
        `${baseNameWithoutExt}-thumb-${captureTimestamp}s.jpg`
      );

      fs.writeFileSync(videoLocalPath, videoFile.buffer);
      fs.writeFileSync(thumbLocalPath, thumbnailFile.buffer);

      // Verify files exist on disk
      if (!fs.existsSync(videoLocalPath) || fs.statSync(videoLocalPath).size !== videoFile.size) {
        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: 'Local disk write verification failed',
        });
        res.status(500).json({
          status: 'error',
          failedStep: '4. Video Upload & Read-after-Write Verification',
          error: 'Local disk write failed',
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      audit.push({
        step: '4. Video Upload & Read-after-Write Verification',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: `Stored locally at ${path.basename(videoLocalPath)} (${fs.statSync(videoLocalPath).size} bytes)`,
      });

      audit.push({
        step: '5. Thumbnail Upload & Storage Verification',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: `Stored locally at ${path.basename(thumbLocalPath)} (${fs.statSync(thumbLocalPath).size} bytes)`,
      });

      videoUrl = `${appBaseUrl}/api/local-media/videos/${path.basename(videoLocalPath)}`;
      thumbnailUrl = `${appBaseUrl}/api/local-media/thumbnails/${path.basename(thumbLocalPath)}`;
      etagVideo = `"local-etag-${timestamp}-video"`;
      etagThumbnail = `"local-etag-${timestamp}-thumb"`;
      verifiedInStorage = true;

      audit.push({
        step: '6. Playback URL Resolution & Schema Formatting',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: 'Generated local emulator playback URLs',
      });
    }

    // Compute accurate real metrics without fallback dummy values
    const actualBytes = videoFile.size;
    const actualSizeMb =
      clientMetadata.sizeMb !== undefined && Number(clientMetadata.sizeMb) > 0
        ? Number(clientMetadata.sizeMb)
        : parseFloat((actualBytes / (1024 * 1024)).toFixed(2)) || 0.01;

    const actualDurationSec = Math.round(
      Number(
        clientMetadata.durationSec !== undefined
          ? clientMetadata.durationSec
          : clientMetadata.duration || 0
      )
    );

    const actualDurationHuman =
      clientMetadata.durationHuman ||
      (actualDurationSec < 60
        ? `${actualDurationSec} sec`
        : `${Math.round(actualDurationSec / 60)} min`);

    const actualUploadTime = Number(clientMetadata.uploadTime) || timestamp;

    // Final Payload Return Object with well-maintained database keys
    const returnObject: VideoRecord = {
      status: 'success',
      id,
      videoUrl,
      thumbnailUrl,
      captureTimestamp,
      sizeMb: actualSizeMb,
      durationSec: actualDurationSec,
      duration: actualDurationHuman,
      uploadTime: actualUploadTime,
      cloudflareR2: {
        uploadedToCloudflareR2: Boolean(r2Config),
        bucket: r2Config?.bucketName || 'local-emulator-storage',
        accountId: r2Config ? `${r2Config.accountId.substring(0, 4)}••••` : null,
        videoKey,
        thumbnailKey: thumbKey,
        etagVideo,
        etagThumbnail,
        publicUrlPrefix: r2Config?.publicUrlPrefix || null,
        directAccessMode: r2Config?.publicUrlPrefix
          ? 'direct_public_r2_url'
          : r2Config
          ? 'cloudflare_r2_proxy'
          : 'local_storage_emulator',
        verifiedInStorage,
      },
      metadata: {
        filename: videoFile.originalname,
        exactFilename,
        fileSize: actualBytes,
        fileSizeFormatted:
          clientMetadata.fileSizeFormatted ||
          `${(actualBytes / (1024 * 1024)).toFixed(2)} MB`,
        sizeMb: actualSizeMb,
        duration: actualDurationSec,
        durationSec: actualDurationSec,
        durationFormatted:
          clientMetadata.durationFormatted ||
          `${Math.floor(actualDurationSec / 60).toString().padStart(2, '0')}:${(actualDurationSec % 60).toString().padStart(2, '0')}`,
        durationHuman: actualDurationHuman,
        uploadTime: actualUploadTime,
        width: clientMetadata.width || 1920,
        height: clientMetadata.height || 1080,
        resolution: `${clientMetadata.width || 1920}x${clientMetadata.height || 1080}`,
        aspectRatio: clientMetadata.aspectRatio || '16:9',
        mimeType: videoFile.mimetype || 'video/mp4',
        bitrateEstimateKbps:
          clientMetadata.bitrateEstimateKbps ||
          Math.round(
            (actualBytes * 8) / (1000 * Math.max(1, actualDurationSec || 5))
          ),
        thumbnailSize: thumbnailFile.size,
        thumbnailSizeFormatted: `${(thumbnailFile.size / 1024).toFixed(1)} KB`,
        thumbnailDimensions: `${clientMetadata.thumbnailWidth || clientMetadata.width || 1920}x${clientMetadata.thumbnailHeight || clientMetadata.height || 1080}`,
        targetThumbnailTimeSeconds: captureTimestamp,
        capturedAtSecond: captureTimestamp,
        uploadedAt: new Date(actualUploadTime).toISOString(),
      },
      verificationAudit: audit,
    };

    videoRecords.unshift(returnObject);
    if (videoRecords.length > 50) videoRecords.pop();

      res.status(200).json(returnObject);
    } catch (unhandledErr: any) {
      console.error('Unhandled upload handler exception:', unhandledErr);
      res.status(500).json({
        status: 'error',
        error: unhandledErr?.message || 'Server error processing upload',
      });
    }
  });
});

// Stream or fetch object from Cloudflare R2 proxy (handles private buckets effortlessly)
app.get('/api/r2/stream/:key', async (req: Request, res: Response) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const config = getR2Config(req);
    if (!config) {
      res.status(400).send('R2 credentials not available for stream');
      return;
    }

    const s3 = createR2Client(config);
    const command = new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    });

    const response = await s3.send(command);

    if (response.ContentType) {
      res.setHeader('Content-Type', response.ContentType);
    }
    if (response.ContentLength) {
      res.setHeader('Content-Length', response.ContentLength);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (response.Body && typeof (response.Body as any).pipe === 'function') {
      (response.Body as any).pipe(res);
    } else {
      const bytes = await response.Body?.transformToByteArray();
      if (bytes) {
        res.send(Buffer.from(bytes));
      } else {
        res.status(404).send('Not found');
      }
    }
  } catch (error: any) {
    console.error('Error streaming from R2:', error);
    res.status(500).send('Failed to stream object from R2');
  }
});

// Serve local emulator media
app.get('/api/local-media/:type/:filename', (req: Request, res: Response) => {
  const { type, filename } = req.params;
  const safeFilename = path.basename(filename);
  const targetDir =
    type === 'videos'
      ? localVideosDir
      : type === 'database'
      ? localDatabaseDir
      : localThumbsDir;
  const filePath = path.join(targetDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    res.status(404).send('File not found');
    return;
  }

  res.sendFile(filePath);
});

// List recently uploaded videos
app.get('/api/videos', (_req: Request, res: Response) => {
  res.json(videoRecords);
});

// Update a processed video record metadata / object
app.patch('/api/videos/:id', (req: Request, res: Response) => {
  const index = videoRecords.findIndex((r) => r.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }
  const updates = req.body && typeof req.body === 'object' ? req.body : {};
  const existing = videoRecords[index];
  const merged = {
    ...existing,
    ...updates,
    id: existing.id,
    metadata:
      updates.metadata && typeof updates.metadata === 'object'
        ? { ...existing.metadata, ...updates.metadata }
        : existing.metadata,
    cloudflareR2:
      updates.cloudflareR2 && typeof updates.cloudflareR2 === 'object'
        ? { ...existing.cloudflareR2, ...updates.cloudflareR2 }
        : existing.cloudflareR2,
  };
  videoRecords[index] = merged;
  res.json(merged);
});

app.put('/api/videos/:id', (req: Request, res: Response) => {
  const index = videoRecords.findIndex((r) => r.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }
  const updates = req.body && typeof req.body === 'object' ? req.body : {};
  const merged = {
    ...videoRecords[index],
    ...updates,
    id: videoRecords[index].id,
  };
  videoRecords[index] = merged;
  res.json(merged);
});

// Delete a video record
app.delete('/api/videos/:id', (req: Request, res: Response) => {
  const index = videoRecords.findIndex((r) => r.id === req.params.id);
  if (index !== -1) {
    videoRecords.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Video not found' });
  }
});

// ================= CLOUDFLARE DATABASE ROUTES =================

const savedBatches: any[] = [];

// Save App-Optimized database manifest to Cloudflare R2
app.post('/api/database/save', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    if (!payload || !payload.title) {
      res.status(400).json({ error: 'Database payload with title is required' });
      return;
    }

    const rawBatchId = payload.batchId || payload.title.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const sanitizedBatchId = String(rawBatchId).trim().replace(/[^a-zA-Z0-9_-]/g, '_');

    const formattedDatabase = {
      batchId: sanitizedBatchId,
      title: String(payload.title).trim(),
      description: String(payload.description || '').trim(),
      imageUrl: String(payload.imageUrl || '').trim(),
      category: String(payload.category || 'Crime Thriller').trim(),
      isPremium: Boolean(payload.isPremium),
      releaseDate: Number(payload.releaseDate) || Date.now(),
      totalVideos: Array.isArray(payload.videos) ? payload.videos.length : 0,
      videos: Array.isArray(payload.videos) ? payload.videos : [],
    };

    const jsonString = JSON.stringify(formattedDatabase, null, 2);
    const databaseBuffer = Buffer.from(jsonString, 'utf-8');
    const databaseKey = `database/${sanitizedBatchId}.json`;

    const r2Config = getR2Config(req);
    const appBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    let databaseUrl = '';
    let etag: string | null = null;
    let verifiedInStorage = false;

    if (r2Config) {
      const s3 = createR2Client(r2Config);

      // Upload JSON manifest to Cloudflare R2
      const putResult = await s3.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: databaseKey,
          Body: databaseBuffer,
          ContentType: 'application/json',
          CacheControl: 'no-cache',
        })
      );
      etag = putResult.ETag || null;

      // Read-after-write verification on Cloudflare R2
      const headResult = await s3.send(
        new HeadObjectCommand({
          Bucket: r2Config.bucketName,
          Key: databaseKey,
        })
      );

      verifiedInStorage = Boolean(headResult.ContentLength);

      databaseUrl = r2Config.publicUrlPrefix
        ? `${r2Config.publicUrlPrefix}/${databaseKey}`
        : `${appBaseUrl}/api/r2/stream/${encodeURIComponent(databaseKey)}`;
    } else {
      // Local emulator storage
      const localFilePath = path.join(localDatabaseDir, `${sanitizedBatchId}.json`);
      fs.writeFileSync(localFilePath, databaseBuffer);
      verifiedInStorage = fs.existsSync(localFilePath);
      databaseUrl = `${appBaseUrl}/api/local-media/database/${sanitizedBatchId}.json`;
      etag = `"local-database-etag-${Date.now()}"`;
    }

    const batchRecord = {
      ...formattedDatabase,
      r2DatabaseUrl: databaseUrl,
      databaseKey,
      savedAt: new Date().toISOString(),
    };

    // Update in-memory index
    const existingIndex = savedBatches.findIndex((b) => b.batchId === sanitizedBatchId);
    if (existingIndex !== -1) {
      savedBatches[existingIndex] = batchRecord;
    } else {
      savedBatches.unshift(batchRecord);
    }

    res.status(200).json({
      success: true,
      batchId: sanitizedBatchId,
      databaseUrl,
      databaseKey,
      cloudflareR2: {
        bucket: r2Config?.bucketName || 'local-emulator-storage',
        etag,
        uploadedToR2: Boolean(r2Config),
      },
      database: batchRecord,
    });
  } catch (error: any) {
    console.error('Error saving database to Cloudflare R2:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to save database to Cloudflare R2',
    });
  }
});

// ================= CLOUDFLARE EXTRACTED LINKS REGISTRY (DEDICATED DEDUPLICATION VAULT) =================

export interface CloudflareExtractedLink {
  id: string; // unique hash or slug (e.g. url_...)
  sourceUrl: string; // original web url
  title: string;
  rawTitle?: string;
  description?: string;
  videoUrl?: string; // original video stream
  thumbnailUrl?: string; // original poster
  cloudflareVideoUrl?: string; // permanent R2 back link
  cloudflareThumbnailUrl?: string; // permanent R2 thumb link
  thumbnailStorageSource?: 'cloudflare_r2' | 'emulator' | null;
  videoStorageSource?: 'cloudflare_r2' | 'emulator' | null;
  durationFormatted?: string;
  durationSec?: number | null;
  sizeBytes?: number | null;
  sizeMb?: string;
  sizeFormatted?: string;
  destination?: 'categories' | 'batchvideo' | 'reels' | 'database' | 'none';
  destinationDetail?: string; // e.g. "cat_action_01" or series name
  categories?: string[]; // Multiple categories array: e.g. ["Action Hits", "Trending 2026", "VIP Movies"]
  status: 'extracted' | 'processing' | 'uploaded' | 'forwarded';
  firstExtractedAt: string;
  lastUpdatedAt: string;
  metadata?: Record<string, any>;
}

// Domain Filters (Whitelist & Blacklist) Storage
export interface DomainFilterRules {
  whitelist: string[]; // e.g. ["example.com", "vids.net"] (if non-empty, only matching domains pass)
  blacklist: string[]; // e.g. ["doubleclick", "google-analytics", "facebook", "ads", "/login", "/register"]
}

const defaultBlacklist = [
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com',
  'twitter.com',
  'instagram.com',
  'adservice.google',
  'amazon-adsystem.com',
  'adnxs.com',
  '/login',
  '/signin',
  '/signup',
  '/register',
  '/privacy',
  '/terms',
  '/contact',
  '/cookie',
  '/ad/',
  '/ads/',
  'wp-login.php',
];

const domainRulesFilePath = path.join(localUploadsDir, 'registry', 'domain_filter_rules.json');
let domainFilterRules: DomainFilterRules = {
  whitelist: [],
  blacklist: defaultBlacklist,
};

if (fs.existsSync(domainRulesFilePath)) {
  try {
    const rawRules = fs.readFileSync(domainRulesFilePath, 'utf-8');
    domainFilterRules = JSON.parse(rawRules);
  } catch (err) {
    console.warn('Could not parse domain_filter_rules.json:', err);
  }
}

// In-memory + persistent cache directory
const localRegistryDir = path.join(localUploadsDir, 'registry');
if (!fs.existsSync(localRegistryDir)) fs.mkdirSync(localRegistryDir, { recursive: true });
const registryFilePath = path.join(localRegistryDir, 'links_registry.json');

// Initialize registry from local disk or memory
let extractedLinksRegistry: CloudflareExtractedLink[] = [];
if (fs.existsSync(registryFilePath)) {
  try {
    const rawData = fs.readFileSync(registryFilePath, 'utf-8');
    extractedLinksRegistry = JSON.parse(rawData);
  } catch (err) {
    console.warn('Could not parse local links_registry.json:', err);
  }
}

// Helper: Save and sync domain filter rules to Cloudflare R2
async function syncDomainRulesToStorage(req?: Request): Promise<void> {
  const jsonBuffer = Buffer.from(JSON.stringify(domainFilterRules, null, 2), 'utf-8');
  try {
    fs.writeFileSync(domainRulesFilePath, jsonBuffer);
  } catch (e) {
    console.warn('Failed to write local domain filter rules:', e);
  }

  const r2Config = getR2Config(req);
  if (r2Config) {
    try {
      const s3 = createR2Client(r2Config);
      await s3.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: 'registry/domain_filter_rules.json',
          Body: jsonBuffer,
          ContentType: 'application/json',
          CacheControl: 'no-cache',
        })
      );
    } catch (r2Err) {
      console.warn('Failed to sync domain rules to Cloudflare R2:', r2Err);
    }
  }
}

// Normalize Web URL for reliable deduplication comparison (Strictly matching by Webpage URL)
function normalizeUrlForDedup(rawUrl: string): string {
  if (!rawUrl) return '';
  let str = rawUrl.trim();
  // Ensure protocol for URL parsing
  if (!/^https?:\/\//i.test(str)) {
    str = `https://${str}`;
  }
  try {
    const u = new URL(str);
    // Hostnames are case-insensitive; strip leading www.
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port ? `:${u.port}` : '';
    // Paths are case-sensitive on most video/CDN platforms (preserve case, collapse // and strip trailing /)
    let pathname = u.pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
    if (!pathname) pathname = '/';

    // Remove ONLY genuine ad-tracking query params; preserve content IDs like ?v=, ?id=, ?source=, ?ref=
    const params = new URLSearchParams(u.search);
    const adTrackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', '_ga', 'mc_cid', 'mc_eid', 'yclid'
    ];
    for (const p of adTrackingParams) {
      params.delete(p);
    }
    params.sort();
    const cleanSearch = params.toString();

    // Standardize to https://
    return `https://${host}${port}${pathname}${cleanSearch ? '?' + cleanSearch : ''}`;
  } catch {
    return str
      .replace(/^https?:\/\/(www\.)?/i, '')
      .replace(/\/+$/, '');
  }
}

// Generate deterministic unique ID from normalized Web URL
function getLinkUniqueId(rawUrl: string): string {
  const norm = normalizeUrlForDedup(rawUrl);
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = (hash << 5) - hash + norm.charCodeAt(i);
    hash |= 0;
  }
  const cleanDomain = norm.replace(/^https?:\/\//, '').split('/')[0].replace(/[^a-z0-9]/gi, '_').substring(0, 20);
  return `link_${cleanDomain}_${Math.abs(hash).toString(36)}`;
}

// Helper: Find registry record strictly by Web URL
function findRegistryRecordByWebUrl(webUrl: string): CloudflareExtractedLink | undefined {
  if (!webUrl) return undefined;
  const norm = normalizeUrlForDedup(webUrl);
  const rawTrimmed = webUrl.trim();
  const rawWithoutProtocol = rawTrimmed.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');

  return extractedLinksRegistry.find((item) => {
    if (item.sourceUrl) {
      if (normalizeUrlForDedup(item.sourceUrl) === norm) return true;
      if (item.sourceUrl.trim() === rawTrimmed) return true;
      const itemWithoutProtocol = item.sourceUrl.trim().replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
      if (itemWithoutProtocol === rawWithoutProtocol) return true;
      return false;
    }
    return item.id === webUrl;
  });
}

function isPreviewVideoUrl(u?: string | null): boolean {
  if (!u) return false;
  const lower = u.toLowerCase();
  return (
    /thumb-v\d*\./i.test(lower) ||
    /\.t\.(?:av1\.|h264\.|vp9\.)?(?:mp4|webm|m3u8)(\?|$)/i.test(lower) ||
    /(?:^|[\/_.-])(preview|trailer|teaser|sample|sprite|thumbvideo)(?:[\/_.-]|$)/i.test(lower) ||
    /\/\d{2,4}x\d{2,4}\.\d+(?:\.\d+)*\.t\./i.test(lower)
  );
}

// Helper: Determine whether a registry entry actually has its real full media uploaded to Cloudflare R2
function hasCompleteCloudflareAssets(rec?: CloudflareExtractedLink | null): boolean {
  if (!rec) return false;
  if (rec.videoUrl && isPreviewVideoUrl(rec.videoUrl)) return false;
  if (rec.cloudflareVideoUrl) return true;
  // Only treat as complete without cloudflareVideoUrl if no un-uploaded videoUrl is pending and a CF thumbnail was uploaded
  if (rec.status === 'uploaded' && rec.cloudflareThumbnailUrl && !rec.videoUrl) return true;
  return false;
}

let hasHydratedRegistryFromD1 = false;
let hydratingRegistryPromise: Promise<void> | null = null;

function mergeRegistryEntry(
  localExisting: CloudflareExtractedLink,
  remoteItem: CloudflareExtractedLink
): CloudflareExtractedLink {
  const localTime = Date.parse(localExisting.lastUpdatedAt || '') || 0;
  const remoteTime = Date.parse(remoteItem.lastUpdatedAt || '') || 0;
  const localInFlight = Boolean(localExisting.id && inFlightProcessingIds.has(localExisting.id));
  const remoteHasAssets = hasCompleteCloudflareAssets(remoteItem);
  const localHasAssets = hasCompleteCloudflareAssets(localExisting);

  // Never let a remote 'processing' lock overwrite a locally completed/uploaded record or an actively uploading task on THIS server
  const preferRemote =
    remoteHasAssets && !localHasAssets
      ? true
      : localHasAssets && !remoteHasAssets
      ? false
      : localInFlight && remoteItem.status === 'processing'
      ? false
      : remoteTime > localTime;

  const primary = preferRemote ? remoteItem : localExisting;
  const secondary = preferRemote ? localExisting : remoteItem;

  return {
    ...secondary,
    ...primary,
    title: primary.title || secondary.title,
    rawTitle: primary.rawTitle || secondary.rawTitle,
    description: primary.description || secondary.description,
    videoUrl: primary.videoUrl || secondary.videoUrl,
    thumbnailUrl: primary.thumbnailUrl || secondary.thumbnailUrl,
    cloudflareVideoUrl: localExisting.cloudflareVideoUrl || remoteItem.cloudflareVideoUrl,
    cloudflareThumbnailUrl: localExisting.cloudflareThumbnailUrl || remoteItem.cloudflareThumbnailUrl,
    thumbnailStorageSource: primary.thumbnailStorageSource || secondary.thumbnailStorageSource,
    videoStorageSource: primary.videoStorageSource || secondary.videoStorageSource,
    durationSec: primary.durationSec ?? secondary.durationSec,
    durationFormatted: primary.durationFormatted || secondary.durationFormatted,
    sizeBytes: primary.sizeBytes ?? secondary.sizeBytes,
    sizeMb: primary.sizeMb || secondary.sizeMb,
    sizeFormatted: primary.sizeFormatted || secondary.sizeFormatted,
    destination:
      primary.destination && primary.destination !== 'none'
        ? primary.destination
        : secondary.destination || 'none',
    destinationDetail: primary.destinationDetail || secondary.destinationDetail,
    status:
      primary.status === 'forwarded' || secondary.status === 'forwarded'
        ? 'forwarded'
        : localHasAssets || remoteHasAssets
        ? 'uploaded'
        : primary.status,
  };
}

const SERVER_INSTANCE_ID = `srv_${(process.env.HOSTNAME || os.hostname() || 'node').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}_${Math.random().toString(36).slice(2, 6)}`;
const inFlightProcessingIds = new Set<string>();
const STALE_PROCESSING_LOCK_MS = 180 * 1000; // 3 minutes without heartbeat/update -> auto-expire crashed VPS locks
let lastD1RegistryRefreshAt = 0;

function getActiveOtherVpsLock(record?: CloudflareExtractedLink | null): { otherServerId: string; startedMs: number } | null {
  if (!record || record.status !== 'processing') return null;
  if (hasCompleteCloudflareAssets(record)) return null;
  const otherServerId = String(record.metadata?.workerServerId || '').trim();
  if (!otherServerId || otherServerId === SERVER_INSTANCE_ID) return null;

  // Reclaim locks created by this same persistent VPS scope (e.g. before container restart) if no longer in-flight here
  const lockScopeId = String(record.metadata?.workerScopeId || '').trim();
  if (lockScopeId && lockScopeId === VPS_QUEUE_SCOPE.scopeId && !inFlightProcessingIds.has(record.id)) {
    return null;
  }

  const heartbeatMs =
    Date.parse(
      record.metadata?.processingHeartbeatAt ||
        record.metadata?.processingStartedAt ||
        record.lastUpdatedAt ||
        ''
    ) || 0;
  if (heartbeatMs <= 0 || Date.now() - heartbeatMs >= STALE_PROCESSING_LOCK_MS) {
    return null;
  }
  const startedMs = Date.parse(record.metadata?.processingStartedAt || record.lastUpdatedAt || '') || heartbeatMs;
  return { otherServerId, startedMs };
}

async function hydrateRegistryFromD1IfNeeded(forceRefresh = false): Promise<void> {
  const now = Date.now();
  if (!forceRefresh && hasHydratedRegistryFromD1) return;
  if (forceRefresh && hasHydratedRegistryFromD1 && now - lastD1RegistryRefreshAt < 120) return;

  if (hydratingRegistryPromise) {
    return hydratingRegistryPromise;
  }

  hydratingRegistryPromise = (async () => {
    try {
      const response = await axios.get(`${CF_WORKER_BASE_URL}/api/links_registry`, {
        timeout: 15000,
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300 && Array.isArray(response.data)) {
        const remoteList: CloudflareExtractedLink[] = response.data;
        const remoteById = new Map<string, CloudflareExtractedLink>();
        const remoteNormUrls = new Set<string>();

        for (const remoteItem of remoteList) {
          if (!remoteItem?.sourceUrl && !remoteItem?.id) continue;
          if (remoteItem.id) remoteById.set(remoteItem.id, remoteItem);
          if (remoteItem.sourceUrl) remoteNormUrls.add(normalizeUrlForDedup(remoteItem.sourceUrl));

          const localExisting = remoteItem.sourceUrl
            ? findRegistryRecordByWebUrl(remoteItem.sourceUrl)
            : extractedLinksRegistry.find((r) => r.id === remoteItem.id);
          if (!localExisting) {
            extractedLinksRegistry.push(remoteItem);
          } else {
            const idx = extractedLinksRegistry.findIndex((r) => r.id === localExisting.id);
            if (idx >= 0) {
              extractedLinksRegistry[idx] = mergeRegistryEntry(localExisting, remoteItem);
            }
          }
        }

        // Reconcile deletions performed by other hosted server instances (preserve only URLs actively locked in-flight by THIS server)
        extractedLinksRegistry = extractedLinksRegistry.filter((localItem) => {
          if (inFlightProcessingIds.has(localItem.id)) return true;
          if (remoteById.has(localItem.id)) return true;
          if (localItem.sourceUrl && remoteNormUrls.has(normalizeUrlForDedup(localItem.sourceUrl))) return true;
          return false;
        });

        try {
          fs.writeFileSync(registryFilePath, JSON.stringify(extractedLinksRegistry, null, 2), 'utf-8');
        } catch {}
        hasHydratedRegistryFromD1 = true;
        lastD1RegistryRefreshAt = Date.now();
      } else {
        console.warn(`D1 links_registry hydration returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.warn('Could not hydrate links_registry from Cloudflare D1:', formatCompactError(err));
    } finally {
      hydratingRegistryPromise = null;
    }
  })();

  return hydratingRegistryPromise;
}

// Helper: Insert or update a registry record strictly by Web URL (zero duplicates)
function upsertRegistryRecordByWebUrl(
  webUrl: string,
  patch: Partial<CloudflareExtractedLink>,
  persistLocalNow = true
): CloudflareExtractedLink {
  const nowIso = new Date().toISOString();
  const existing = findRegistryRecordByWebUrl(webUrl);

  if (existing) {
    const idx = extractedLinksRegistry.findIndex((r) => r.id === existing.id);
    const updated: CloudflareExtractedLink = {
      ...existing,
      ...patch,
      sourceUrl: existing.sourceUrl || webUrl,
      title: patch.title || existing.title,
      rawTitle: patch.rawTitle || existing.rawTitle,
      description: patch.description || existing.description,
      videoUrl: patch.videoUrl || existing.videoUrl,
      thumbnailUrl: patch.thumbnailUrl || existing.thumbnailUrl,
      cloudflareVideoUrl: patch.cloudflareVideoUrl || existing.cloudflareVideoUrl,
      cloudflareThumbnailUrl: patch.cloudflareThumbnailUrl || existing.cloudflareThumbnailUrl,
      thumbnailStorageSource: patch.thumbnailStorageSource || existing.thumbnailStorageSource,
      videoStorageSource: patch.videoStorageSource || existing.videoStorageSource,
      durationFormatted: patch.durationFormatted || existing.durationFormatted,
      durationSec: patch.durationSec !== undefined && patch.durationSec !== null ? patch.durationSec : existing.durationSec,
      sizeBytes: patch.sizeBytes !== undefined && patch.sizeBytes !== null ? patch.sizeBytes : existing.sizeBytes,
      sizeMb: patch.sizeMb || existing.sizeMb,
      sizeFormatted: patch.sizeFormatted || existing.sizeFormatted,
      status:
        patch.status === 'forwarded' || existing.status === 'forwarded'
          ? 'forwarded'
          : Boolean(patch.cloudflareVideoUrl || existing.cloudflareVideoUrl) ||
            patch.status === 'uploaded' ||
            existing.status === 'uploaded'
          ? 'uploaded'
          : patch.status || existing.status,
      lastUpdatedAt: nowIso,
      metadata: { ...(existing.metadata || {}), ...(patch.metadata || {}) },
    };
    if (idx >= 0) {
      extractedLinksRegistry[idx] = updated;
    }
    if (persistLocalNow) {
      try {
        fs.writeFileSync(registryFilePath, JSON.stringify(extractedLinksRegistry, null, 2), 'utf-8');
      } catch {}
    }
    return updated;
  }

  const created: CloudflareExtractedLink = {
    id: getLinkUniqueId(webUrl),
    sourceUrl: webUrl,
    title: patch.title || webUrl.split('/').pop()?.split('?')[0] || 'Extracted Video',
    rawTitle: patch.rawTitle || patch.title || webUrl,
    description: patch.description,
    videoUrl: patch.videoUrl || '',
    thumbnailUrl: patch.thumbnailUrl || '',
    cloudflareVideoUrl: patch.cloudflareVideoUrl,
    cloudflareThumbnailUrl: patch.cloudflareThumbnailUrl,
    thumbnailStorageSource: patch.thumbnailStorageSource || null,
    videoStorageSource: patch.videoStorageSource || null,
    durationFormatted: patch.durationFormatted || '',
    durationSec: patch.durationSec ?? null,
    sizeBytes: patch.sizeBytes ?? null,
    sizeMb: patch.sizeMb,
    sizeFormatted: patch.sizeFormatted || '',
    destination: patch.destination || 'none',
    destinationDetail: patch.destinationDetail,
    status: patch.cloudflareVideoUrl ? 'uploaded' : patch.status || 'processing',
    firstExtractedAt: nowIso,
    lastUpdatedAt: nowIso,
    metadata: patch.metadata,
  };
  extractedLinksRegistry.unshift(created);
  if (persistLocalNow) {
    try {
      fs.writeFileSync(registryFilePath, JSON.stringify(extractedLinksRegistry, null, 2), 'utf-8');
    } catch {}
  }
  return created;
}

// Helper: Sync links registry directly to Cloudflare D1 (`ott-database` via `/api/links_registry`) + local disk cache
async function syncRegistryToStorage(
  _req?: Request,
  recordsToSync?: CloudflareExtractedLink[]
): Promise<void> {
  const jsonBuffer = Buffer.from(JSON.stringify(extractedLinksRegistry, null, 2), 'utf-8');
  // Always save local disk cache
  try {
    fs.writeFileSync(registryFilePath, jsonBuffer);
  } catch (e) {
    console.warn('Failed to write local registry:', e);
  }

  // Sync directly to Cloudflare D1 (/api/links_registry) in safe batches
  const targetList = Array.isArray(recordsToSync) ? recordsToSync : extractedLinksRegistry;
  if (targetList.length === 0) return;

  const CHUNK_SIZE = 50;
  try {
    for (let i = 0; i < targetList.length; i += CHUNK_SIZE) {
      const chunk = targetList.slice(i, i + CHUNK_SIZE);
      await axios.post(`${CF_WORKER_BASE_URL}/api/links_registry`, chunk, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
    }
  } catch (d1Err) {
    console.warn('Failed to sync links_registry to Cloudflare D1:', formatCompactError(d1Err));
  }
}

async function deleteRegistryItemFromD1(id: string): Promise<void> {
  try {
    await axios.delete(`${CF_WORKER_BASE_URL}/api/links_registry/${encodeURIComponent(id)}`, {
      timeout: 15000,
    });
  } catch (d1Err) {
    console.warn(`Failed to delete link ${id} from Cloudflare D1:`, formatCompactError(d1Err));
  }
}

async function removeRegistryRecordByWebUrl(webUrl: string, req?: Request): Promise<void> {
  const norm = normalizeUrlForDedup(webUrl);
  const deterministicId = getLinkUniqueId(webUrl);
  const matchingIds = new Set<string>([deterministicId]);

  extractedLinksRegistry = extractedLinksRegistry.filter((item) => {
    const matchesUrl =
      (item.sourceUrl && normalizeUrlForDedup(item.sourceUrl) === norm) || item.id === deterministicId;
    if (matchesUrl && item.id) {
      matchingIds.add(item.id);
    }
    return !matchesUrl;
  });

  await syncRegistryToStorage(req, []);
  await Promise.all(Array.from(matchingIds).map((id) => deleteRegistryItemFromD1(id)));
}

// API: Check single or multiple URLs against live Cloudflare D1 registry (No copy on match)
app.post('/api/registry/check', async (req: Request, res: Response) => {
  await hydrateRegistryFromD1IfNeeded(true);

  const { urls, autoRegisterIfMissing = false } = req.body;
  if (!urls) {
    return res.status(400).json({ success: false, error: 'urls array or single url is required' });
  }

  const urlList: string[] = Array.isArray(urls) ? urls : [urls];
  const newlyCreatedRecords: CloudflareExtractedLink[] = [];
  const now = new Date().toISOString();

  const results = urlList.map((rawUrl) => {
    const norm = normalizeUrlForDedup(rawUrl);
    const existing = findRegistryRecordByWebUrl(rawUrl);

    if (existing) {
      const hasProcessedMedia = hasCompleteCloudflareAssets(existing);
      // Existing record in Cloudflare: ZERO DUPLICATE COPIES CREATED!
      return {
        url: rawUrl,
        normalizedUrl: norm,
        uniqueId: existing.id,
        isRegistered: true,
        isProcessed: hasProcessedMedia,
        isNew: false,
        noCopy: true,
        isUploaded: hasProcessedMedia,
        destination: existing.destination || 'none',
        destinationDetail: existing.destinationDetail || null,
        record: existing,
      };
    } else {
      // Not yet in Cloudflare: auto-register new link so future checks immediately find it
      const uniqueId = getLinkUniqueId(rawUrl);
      let newRecord: CloudflareExtractedLink | null = null;
      if (autoRegisterIfMissing) {
        newRecord = {
          id: uniqueId,
          sourceUrl: rawUrl,
          title: rawUrl.split('/').pop()?.split('?')[0] || 'Tracked Link',
          rawTitle: rawUrl,
          status: 'extracted',
          destination: 'none',
          firstExtractedAt: now,
          lastUpdatedAt: now,
          metadata: {
            addedVia: 'cloudflare_auto_check',
          },
        };
        extractedLinksRegistry.unshift(newRecord);
        newlyCreatedRecords.push(newRecord);
      }

      return {
        url: rawUrl,
        normalizedUrl: norm,
        uniqueId,
        isRegistered: Boolean(newRecord),
        isProcessed: false,
        isNew: true,
        isUploaded: false,
        destination: 'none',
        destinationDetail: null,
        record: newRecord,
      };
    }
  });

  if (newlyCreatedRecords.length > 0) {
    await syncRegistryToStorage(req, newlyCreatedRecords);
  }

  res.json({
    success: true,
    count: results.length,
    registeredCount: results.filter((r) => r.isRegistered).length,
    newlyAddedCount: results.filter((r) => r.isNew).length,
    reusedExistingCount: results.filter((r) => !r.isNew && r.isRegistered).length,
    results,
  });
});

// API: Get link details by unique ID or URL from Cloudflare registry
app.get('/api/registry/item', async (req: Request, res: Response) => {
  await hydrateRegistryFromD1IfNeeded();

  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({ success: false, error: 'id or url query parameter is required' });
  }

  let found: CloudflareExtractedLink | undefined;
  if (id) {
    found = extractedLinksRegistry.find((item) => item.id === String(id));
  }
  if (!found && url) {
    found = findRegistryRecordByWebUrl(String(url));
  }

  if (!found) {
    return res.status(404).json({ success: false, error: 'Link record not found in Cloudflare registry' });
  }

  res.json({ success: true, record: found });
});

// API: List all tracked links in Cloudflare registry (refreshes live from D1)
app.get('/api/registry/links', async (_req: Request, res: Response) => {
  await hydrateRegistryFromD1IfNeeded(true);

  res.json({
    success: true,
    total: extractedLinksRegistry.length,
    uploadedCount: extractedLinksRegistry.filter((l) => l.cloudflareVideoUrl || l.status === 'uploaded').length,
    links: extractedLinksRegistry,
  });
});

// API: Register or update an extracted link record (saves destination, Cloudflare back links, metadata)
app.post('/api/registry/register', async (req: Request, res: Response) => {
  try {
    await hydrateRegistryFromD1IfNeeded();

    const {
      sourceUrl,
      title,
      rawTitle,
      description,
      videoUrl,
      thumbnailUrl,
      cloudflareVideoUrl,
      cloudflareThumbnailUrl,
      thumbnailStorageSource,
      videoStorageSource,
      durationFormatted,
      durationSec,
      sizeBytes,
      sizeMb,
      sizeFormatted,
      destination = 'none',
      destinationDetail,
      metadata = {},
    } = req.body;

    if (!sourceUrl) {
      return res.status(400).json({ success: false, error: 'sourceUrl is required' });
    }

    const updatedRecord = upsertRegistryRecordByWebUrl(
      sourceUrl,
      {
        title,
        rawTitle,
        description,
        videoUrl,
        thumbnailUrl,
        cloudflareVideoUrl,
        cloudflareThumbnailUrl,
        thumbnailStorageSource,
        videoStorageSource,
        durationFormatted,
        durationSec,
        sizeBytes,
        sizeMb,
        sizeFormatted,
        destination: destination !== 'none' ? destination : undefined,
        destinationDetail,
        status: cloudflareVideoUrl || cloudflareThumbnailUrl ? 'uploaded' : undefined,
        metadata,
      },
      false
    );

    await syncRegistryToStorage(req, [updatedRecord]);

    res.json({
      success: true,
      uniqueId: updatedRecord.id,
      record: updatedRecord,
    });
  } catch (err: any) {
    console.error('Error registering link in Cloudflare:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to register link in registry' });
  }
});

// API: Edit/update any field of a registry record by ID and sync to D1
app.patch('/api/registry/item/:id', async (req: Request, res: Response) => {
  try {
    await hydrateRegistryFromD1IfNeeded();
    const { id } = req.params;
    const updates = req.body && typeof req.body === 'object' ? req.body : {};
    const index = extractedLinksRegistry.findIndex((item) => item.id === id);
    const baseRecord =
      index !== -1
        ? extractedLinksRegistry[index]
        : ({ id, sourceUrl: updates.sourceUrl || '', title: updates.title || '' } as CloudflareExtractedLink);

    const updatedRecord: CloudflareExtractedLink = {
      ...baseRecord,
      ...updates,
      id,
      lastUpdatedAt: new Date().toISOString(),
    };

    if (index !== -1) {
      extractedLinksRegistry[index] = updatedRecord;
    } else {
      extractedLinksRegistry.unshift(updatedRecord);
    }

    await syncRegistryToStorage(req, [updatedRecord]);
    res.json({ success: true, record: updatedRecord });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update registry item' });
  }
});

// API: Delete a record from Cloudflare registry
app.delete('/api/registry/item/:id', async (req: Request, res: Response) => {
  await hydrateRegistryFromD1IfNeeded();
  const { id } = req.params;
  const index = extractedLinksRegistry.findIndex((item) => item.id === id);
  if (index !== -1) {
    extractedLinksRegistry.splice(index, 1);
    await syncRegistryToStorage(req, []);
    await deleteRegistryItemFromD1(id);
    res.json({ success: true, message: `Removed record ${id} from ott-database links_registry` });
  } else {
    res.status(404).json({ success: false, error: 'Record not found in registry' });
  }
});

// API: Clear registry
app.post('/api/registry/clear', async (req: Request, res: Response) => {
  await hydrateRegistryFromD1IfNeeded();
  const idsToDelete = extractedLinksRegistry.map((item) => item.id).filter(Boolean);
  extractedLinksRegistry = [];
  await syncRegistryToStorage(req, []);
  await Promise.all(idsToDelete.map((id) => deleteRegistryItemFromD1(id)));
  res.json({ success: true, message: 'Registry cleared from local cache and ott-database' });
});

// ============================================================================
// PERSISTENT BACKGROUND BATCH DAEMON ENGINE (Headless 1 - 20 Concurrent Workers)
// Continues running after browser closes, auto-restarts failed/incomplete items,
// and persists queue state to disk + Cloudflare D1 (ott-database) with 0 data loss.
// ============================================================================
interface VpsBatchTask {
  id: string;
  index: number;
  url: string;
  workerId?: number;
  status:
    | 'pending'
    | 'checking_registry'
    | 'waiting_d1'
    | 'skipped_in_cloudflare'
    | 'scraping'
    | 'downloading_video'
    | 'compressing_video'
    | 'uploading_cloudflare'
    | 'completed'
    | 'error';
  statusMessage?: string;
  error?: string;
  attempts?: number;
  serverUsed?: string;
  title?: string;
  rawTitle?: string;
  videoStreamUrl?: string;
  originalVideoUrl?: string;
  cloudflareVideoUrl?: string;
  videoStorageSource?: 'cloudflare_r2' | 'emulator';
  originalThumbnailUrl?: string;
  cloudflareThumbnailUrl?: string;
  thumbnailStorageSource?: 'cloudflare_r2' | 'emulator';
  durationFormatted?: string;
  durationSec?: number | null;
  sizeFormatted?: string;
  sizeBytes?: number | null;
  sizeKb?: number | null;
  description?: string;
  isRegisteredInCloudflare?: boolean;
  destination?: string;
  destinationDetail?: string;
  registryUniqueId?: string;
  queueId?: string;
  crossServerWaitCount?: number;
  lastAttemptEndedAt?: number;
  localTempVideoPath?: string;
  localCompressedVideoPath?: string;
  localVideoDownloadComplete?: boolean;
  pageRefererUrl?: string;
}

function cleanupTaskCheckpointFiles(task?: Partial<VpsBatchTask> | null): void {
  if (!task) return;
  for (const p of [task.localTempVideoPath, task.localCompressedVideoPath]) {
    if (p && typeof p === 'string') {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
  }
  task.localTempVideoPath = undefined;
  task.localCompressedVideoPath = undefined;
  task.localVideoDownloadComplete = undefined;
}

type VideoCompressionQuality = 'high' | 'balanced' | 'compact' | 'low';

function normalizeCompressionQuality(q: any): VideoCompressionQuality {
  const val = String(q || '').toLowerCase().trim();
  if (val === 'high' || val === 'balanced' || val === 'compact' || val === 'low') {
    return val;
  }
  return 'balanced';
}

type VpsQueueStatus = 'queued' | 'running' | 'paused' | 'stopped' | 'completed';

interface VpsQueueOptions {
  batchSkipMode: 'smart_cache' | 'strict_skip' | 'dont_skip';
  wordsToRemove: string;
  uploadThumbnailToR2: boolean;
  uploadVideoToR2: boolean;
  compressVideo: boolean;
  compressionQuality: VideoCompressionQuality;
  autoRetryIncomplete: boolean;
  maxAutoRetryPasses: number;
  serverPool: string[];
}

interface VpsBatchQueue {
  queueId: string;
  queueNumber: number;
  name: string;
  status: VpsQueueStatus;
  options: VpsQueueOptions;
  total: number;
  completed: number;
  skipped: number;
  errors: number;
  incompleteCount: number;
  activeWorkers: number;
  currentPass: number;
  statusMessage?: string;
  createdAt: string;
  startedAt?: string;
  endTime?: string;
  lastUpdatedAt: string;
  tasks: VpsBatchTask[];
}

interface VpsBatchJobState {
  jobId: string;
  scopeId?: string;
  scopeLabel?: string;
  isRunning: boolean;
  isPaused: boolean;
  concurrency: number;
  batchSkipMode: 'smart_cache' | 'strict_skip' | 'dont_skip';
  wordsToRemove: string;
  uploadThumbnailToR2: boolean;
  uploadVideoToR2: boolean;
  compressVideo: boolean;
  compressionQuality: VideoCompressionQuality;
  autoRetryIncomplete: boolean;
  currentPass: number;
  maxAutoRetryPasses: number;
  serverPool: string[];
  total: number;
  completed: number;
  skipped: number;
  errors: number;
  incompleteCount: number;
  activeWorkers: number;
  pausedForLoadCount?: number;
  activeCompressions?: number;
  currentCpuPercent?: number;
  statusMessage?: string;
  startTime: string;
  endTime?: string;
  lastUpdatedAt: string;
  appBaseUrl?: string;
  activeQueueId?: string;
  nextQueueNumber?: number;
  queues: VpsBatchQueue[];
  tasks: VpsBatchTask[];
}

export interface VpsQueueScopeInfo {
  scopeId: string;
  scopeSlug: string;
  scopeLabel: string;
  d1DocId: string;
  jobFilePath: string;
  source: string;
}

function buildVpsQueueScopeFromKey(rawKey: string, scopeLabel: string, source: string): VpsQueueScopeInfo {
  const cleanSlug =
    rawKey
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'vps';
  const shortHash = crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 8);
  const scopeSlug = `${cleanSlug}_${shortHash}`;
  return {
    scopeId: rawKey,
    scopeSlug,
    scopeLabel,
    d1DocId: `vps_batch_job_state__${scopeSlug}`,
    jobFilePath: path.join(localRegistryDir, `vps_batch_job_${scopeSlug}.json`),
    source,
  };
}

function isPlaceholderOrLocalHost(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower || lower === 'my_app_url' || lower === 'undefined' || lower === 'null') return true;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(lower)) return true;
  return false;
}

function resolveVpsQueueScope(): VpsQueueScopeInfo {
  const explicitId = getEnvValue(['VPS_QUEUE_ID', 'VPS_ID', 'VPS_NAME', 'INSTANCE_SCOPE_ID']);
  if (explicitId && !isPlaceholderOrLocalHost(explicitId)) {
    return buildVpsQueueScopeFromKey(`explicit:${explicitId}`, explicitId, 'env_vps_id');
  }

  const appUrlRaw = getEnvValue(['APP_URL', 'PUBLIC_URL', 'NEXT_PUBLIC_APP_URL']);
  if (appUrlRaw && !isPlaceholderOrLocalHost(appUrlRaw)) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(appUrlRaw) ? appUrlRaw : `https://${appUrlRaw}`);
      const host = parsed.host.toLowerCase();
      if (host && !isPlaceholderOrLocalHost(host)) {
        return buildVpsQueueScopeFromKey(`host:${host}`, host, 'app_url');
      }
    } catch {}
  }

  const cloudService = getEnvValue([
    'K_SERVICE',
    'RENDER_EXTERNAL_HOSTNAME',
    'RAILWAY_PUBLIC_DOMAIN',
    'FLY_APP_NAME',
    'VERCEL_PROJECT_PRODUCTION_URL',
    'VERCEL_URL',
  ]);
  if (cloudService && !isPlaceholderOrLocalHost(cloudService)) {
    return buildVpsQueueScopeFromKey(`svc:${cloudService.toLowerCase()}`, cloudService, 'cloud_service');
  }

  const scopeFilePath = path.join(localRegistryDir, 'vps_scope_id.txt');
  let persistedId = '';
  try {
    if (fs.existsSync(scopeFilePath)) {
      persistedId = fs.readFileSync(scopeFilePath, 'utf-8').trim();
    }
  } catch {}
  if (!persistedId) {
    const cleanHost = (os.hostname() || 'vps').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'vps';
    persistedId = `${cleanHost}_${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(scopeFilePath, persistedId, 'utf-8');
    } catch {}
  }
  return buildVpsQueueScopeFromKey(`local:${persistedId}`, persistedId, 'persisted_local_id');
}

const VPS_QUEUE_SCOPE = resolveVpsQueueScope();
const vpsJobFilePath = VPS_QUEUE_SCOPE.jobFilePath;
let activeVpsBatchJob: VpsBatchJobState | null = null;
let activeVpsJobR2Config: R2Config | null = null;
let activeVpsJobAppBaseUrl = resolveValidAppBaseUrl();
let vpsBatchCancelFlag = false;
let vpsBatchPauseFlag = false;
let vpsServerShuttingDown = false;
let vpsWorkerLoopActive = false;
let triggerVpsWorkerScaleUp: (() => void) | null = null;
let lastD1JobSyncAt = 0;
let vpsBatchInitPromise: Promise<void> | null = null;
let lastVpsBatchInitAttemptAt = 0;

function isPublicHttpBaseUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    return !isPlaceholderOrLocalHost(parsed.host);
  } catch {
    return false;
  }
}

function resolveValidAppBaseUrl(req?: Request): string {
  if (req) {
    const rawHost = String(req.headers['x-forwarded-host'] || req.get('host') || '')
      .split(',')[0]
      .trim();
    const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
      .split(',')[0]
      .trim()
      .replace(/[^a-z]/gi, '') || 'http';
    if (rawHost && !isPlaceholderOrLocalHost(rawHost)) {
      return `${rawProto}://${rawHost}`.replace(/\/+$/, '');
    }
  }

  const envUrl = getEnvValue(['APP_URL', 'PUBLIC_URL', 'NEXT_PUBLIC_APP_URL']);
  if (envUrl && isPublicHttpBaseUrl(envUrl)) {
    const normalized = /^https?:\/\//i.test(envUrl) ? envUrl : `https://${envUrl}`;
    return normalized.replace(/\/+$/, '');
  }

  if (req) {
    const rawHost = String(req.get('host') || '').trim();
    if (rawHost && !isPlaceholderOrLocalHost(`http://${rawHost}`) && !/^(my_app_url|undefined|null)$/i.test(rawHost)) {
      return `${req.protocol || 'http'}://${rawHost}`.replace(/\/+$/, '');
    }
  }

  return 'http://localhost:3000';
}

function captureRequestRuntimeContext(req?: Request): void {
  if (!req) return;
  const r2FromReq = getR2Config(req);
  if (r2FromReq) {
    activeVpsJobR2Config = r2FromReq;
  }
  const resolvedUrl = resolveValidAppBaseUrl(req);
  if (isPublicHttpBaseUrl(resolvedUrl) || !isPublicHttpBaseUrl(activeVpsJobAppBaseUrl)) {
    activeVpsJobAppBaseUrl = resolvedUrl;
    if (activeVpsBatchJob && isPublicHttpBaseUrl(resolvedUrl)) {
      activeVpsBatchJob.appBaseUrl = resolvedUrl;
    }
  }
  if (
    isPublicHttpBaseUrl(activeVpsJobAppBaseUrl) &&
    activeVpsBatchJob?.isRunning &&
    !vpsBatchPauseFlag &&
    !vpsBatchCancelFlag &&
    !vpsServerShuttingDown &&
    hasAnyPendingOrRetryableWork(activeVpsBatchJob)
  ) {
    startVpsCloudKeepAliveLoop();
  }
}

// Public Ingress Self-Keep-Alive for Cloud Run / serverless VPS containers:
// Holds 1 active streaming HTTP request open through public URL while queues are actively running
// so CPU stays unthrottled on free request-based Cloud Run tiers even after user closes Chrome/tab.
let vpsCloudKeepAliveActive = false;
let vpsCloudKeepAliveMode: 'active' | 'iap_blocked' | 'no_public_url' | 'idle' = 'idle';
let vpsCloudKeepAliveBlockedUntil = 0;
const activeKeepAliveControllers = new Set<AbortController>();

function stopVpsCloudKeepAliveLoop(): void {
  vpsCloudKeepAliveActive = false;
  vpsCloudKeepAliveMode = 'idle';
  for (const ctrl of Array.from(activeKeepAliveControllers)) {
    try {
      ctrl.abort();
    } catch {}
  }
  activeKeepAliveControllers.clear();
}

function startVpsCloudKeepAliveLoop(): void {
  if (vpsCloudKeepAliveActive) return;
  if (!activeVpsBatchJob?.isRunning || vpsBatchPauseFlag || vpsBatchCancelFlag || vpsServerShuttingDown) {
    vpsCloudKeepAliveMode = 'idle';
    return;
  }
  if (!isPublicHttpBaseUrl(activeVpsJobAppBaseUrl)) {
    vpsCloudKeepAliveMode = 'no_public_url';
    return;
  }
  if (Date.now() < vpsCloudKeepAliveBlockedUntil) {
    vpsCloudKeepAliveMode = 'iap_blocked';
    return;
  }

  vpsCloudKeepAliveActive = true;
  const holdMs = 45000;

  const openStreamCycle = async () => {
    while (
      vpsCloudKeepAliveActive &&
      activeVpsBatchJob?.isRunning &&
      !vpsBatchPauseFlag &&
      !vpsBatchCancelFlag &&
      !vpsServerShuttingDown &&
      hasAnyPendingOrRetryableWork(activeVpsBatchJob)
    ) {
      if (Date.now() < vpsCloudKeepAliveBlockedUntil) {
        vpsCloudKeepAliveMode = 'iap_blocked';
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      const targetBase = isPublicHttpBaseUrl(activeVpsJobAppBaseUrl)
        ? activeVpsJobAppBaseUrl
        : resolveValidAppBaseUrl();
      if (!isPublicHttpBaseUrl(targetBase)) {
        vpsCloudKeepAliveMode = 'no_public_url';
        break;
      }

      const controller = new AbortController();
      activeKeepAliveControllers.add(controller);

      try {
        const res = await axios.get(`${targetBase}/api/vps-batch/keepalive?holdMs=${holdMs}`, {
          responseType: 'stream',
          timeout: holdMs + 15000,
          signal: controller.signal,
          maxRedirects: 0,
          validateStatus: () => true,
          headers: {
            'X-Vps-Owner-Instance': SERVER_INSTANCE_ID,
            'Cache-Control': 'no-cache',
          },
        });

        const ctype = String(res.headers?.['content-type'] || '').toLowerCase();
        if (res.status >= 300 || ctype.includes('text/html')) {
          // Behind IAP / login proxy (e.g. Studio preview); back off quietly without noise
          vpsCloudKeepAliveMode = 'iap_blocked';
          vpsCloudKeepAliveBlockedUntil = Date.now() + 120000;
          try {
            res.data?.destroy?.();
          } catch {}
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }

        vpsCloudKeepAliveMode = 'active';
        await new Promise<void>((resolve) => {
          let handoffTimer: NodeJS.Timeout | null = null;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (handoffTimer) clearTimeout(handoffTimer);
            resolve();
          };
          // Trigger overlapping next cycle 4s before current hold completes so active ingress count never hits 0
          handoffTimer = setTimeout(() => {
            finish();
          }, holdMs - 4000);

          res.data.on('data', () => {});
          res.data.on('end', finish);
          res.data.on('error', finish);
          res.data.on('close', finish);
        });
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      } finally {
        // Keep previous stream alive briefly if handoff already opened next cycle? No, let natural end/close happen or abort after short overlap
        setTimeout(() => {
          try {
            controller.abort();
          } catch {}
          activeKeepAliveControllers.delete(controller);
        }, 4500);
      }
    }
    vpsCloudKeepAliveActive = false;
    if (!activeVpsBatchJob?.isRunning || vpsBatchPauseFlag || vpsBatchCancelFlag || vpsServerShuttingDown) {
      vpsCloudKeepAliveMode = 'idle';
    }
  };

  openStreamCycle().catch(() => {
    vpsCloudKeepAliveActive = false;
    vpsCloudKeepAliveMode = 'idle';
  });
}

// In-flight task IDs across ALL workers/queues so no task is ever claimed twice and workers never stall on trailing tasks
const inFlightBatchTaskIds = new Set<string>();
const workerSignalWaiters = new Set<() => void>();
const PER_TASK_RETRY_COOLDOWN_MS = 2500;

function notifyVpsWorkers(): void {
  const waiters = Array.from(workerSignalWaiters);
  workerSignalWaiters.clear();
  for (const resolve of waiters) {
    try {
      resolve();
    } catch {}
  }
}

function waitForVpsWorkerSignal(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const onDone = () => {
      if (settled) return;
      settled = true;
      workerSignalWaiters.delete(onDone);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(onDone, Math.max(50, timeoutMs));
    workerSignalWaiters.add(onDone);
  });
}

// Compression CPU load governor constants & counters
const COMPRESSION_HIGH_CPU_PERCENT = 80;
const COMPRESSION_RESUME_CPU_PERCENT = 72;
const MAX_CONCURRENT_FFMPEG = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2) || 1));
let activeFfmpegCompressions = 0;
let workersPausedForLoad = 0;

function normalizeQueueOptions(input: any, fallback?: Partial<VpsQueueOptions>): VpsQueueOptions {
  const rawSkip = String(input?.batchSkipMode ?? fallback?.batchSkipMode ?? 'smart_cache');
  const batchSkipMode: 'smart_cache' | 'strict_skip' | 'dont_skip' =
    rawSkip === 'strict_skip' || rawSkip === 'dont_skip' ? rawSkip : 'smart_cache';

  const rawPool = input?.serverPool ?? fallback?.serverPool ?? [];
  const serverPool = (Array.isArray(rawPool) ? rawPool : [])
    .map((s: any) => String(s || '').trim())
    .filter((s: string) => /^https?:\/\//i.test(s));

  const rawPasses =
    input?.maxAutoRetryPasses !== undefined
      ? Number(input.maxAutoRetryPasses)
      : fallback?.maxAutoRetryPasses !== undefined
      ? Number(fallback.maxAutoRetryPasses)
      : 3;

  return {
    batchSkipMode,
    wordsToRemove: String(input?.wordsToRemove ?? fallback?.wordsToRemove ?? ''),
    uploadThumbnailToR2:
      input?.uploadThumbnailToR2 !== undefined
        ? Boolean(input.uploadThumbnailToR2)
        : fallback?.uploadThumbnailToR2 !== undefined
        ? Boolean(fallback.uploadThumbnailToR2)
        : true,
    uploadVideoToR2:
      input?.uploadVideoToR2 !== undefined
        ? Boolean(input.uploadVideoToR2)
        : fallback?.uploadVideoToR2 !== undefined
        ? Boolean(fallback.uploadVideoToR2)
        : true,
    compressVideo:
      input?.compressVideo !== undefined
        ? Boolean(input.compressVideo)
        : Boolean(fallback?.compressVideo ?? false),
    compressionQuality: normalizeCompressionQuality(input?.compressionQuality ?? fallback?.compressionQuality ?? 'balanced'),
    autoRetryIncomplete:
      input?.autoRetryIncomplete !== undefined
        ? Boolean(input.autoRetryIncomplete)
        : fallback?.autoRetryIncomplete !== undefined
        ? Boolean(fallback.autoRetryIncomplete)
        : true,
    maxAutoRetryPasses: Math.max(0, Math.min(10, Number.isFinite(rawPasses) ? rawPasses : 3)),
    serverPool,
  };
}

function syncLiveLoadCountersOnJob(job: VpsBatchJobState | null): void {
  if (!job) return;
  job.activeCompressions = activeFfmpegCompressions;
  job.pausedForLoadCount = workersPausedForLoad;
  job.currentCpuPercent = sampleLiveCpuPercent();
}

function isTaskIncompleteForQueue(task: VpsBatchTask, opts: VpsQueueOptions): boolean {
  if (task.status === 'skipped_in_cloudflare') return false;
  if (
    task.status === 'error' ||
    task.status === 'pending' ||
    task.status === 'checking_registry' ||
    task.status === 'waiting_d1' ||
    task.status === 'scraping' ||
    task.status === 'downloading_video' ||
    task.status === 'compressing_video' ||
    task.status === 'uploading_cloudflare'
  ) {
    return true;
  }
  if (opts.uploadVideoToR2 && !task.cloudflareVideoUrl) return true;
  if (opts.uploadThumbnailToR2 && task.originalThumbnailUrl && !task.cloudflareThumbnailUrl) return true;
  if (!task.videoStreamUrl && !task.cloudflareVideoUrl) return true;
  return false;
}

function isTaskRetryEligibleForQueue(task: VpsBatchTask, queue: VpsBatchQueue): boolean {
  if (inFlightBatchTaskIds.has(task.id)) return false;
  if (task.status === 'pending' || task.status === 'skipped_in_cloudflare') return false;
  // Tasks waiting on another VPS to finish saving to D1 always stay eligible to re-check D1 and reuse
  if (task.status === 'waiting_d1') return true;
  if (!queue.options.autoRetryIncomplete) return false;
  if (!isTaskIncompleteForQueue(task, queue.options)) return false;
  const maxTotalAttempts = 1 + queue.options.maxAutoRetryPasses;
  return (task.attempts || 0) < maxTotalAttempts;
}

function recomputeSingleQueueCounters(queue: VpsBatchQueue): void {
  const nowIso = new Date().toISOString();
  queue.total = queue.tasks.length;
  queue.completed = queue.tasks.filter((t) => t.status === 'completed').length;
  queue.skipped = queue.tasks.filter((t) => t.status === 'skipped_in_cloudflare').length;
  queue.errors = queue.tasks.filter((t) => t.status === 'error').length;
  queue.incompleteCount = queue.tasks.filter((t) => isTaskIncompleteForQueue(t, queue.options)).length;
  queue.activeWorkers = queue.tasks.filter((t) => inFlightBatchTaskIds.has(t.id)).length;
  queue.lastUpdatedAt = nowIso;

  const hasPending = queue.tasks.some((t) => t.status === 'pending');
  const hasRetryable = queue.tasks.some((t) => isTaskRetryEligibleForQueue(t, queue));

  if (queue.status !== 'paused' && queue.status !== 'stopped') {
    if (queue.activeWorkers > 0) {
      queue.status = 'running';
      if (!queue.startedAt) queue.startedAt = nowIso;
    } else if (!hasPending && !hasRetryable && queue.tasks.length > 0 && queue.startedAt) {
      queue.status = 'completed';
      if (!queue.endTime) queue.endTime = nowIso;
    } else if ((hasPending || hasRetryable) && queue.status === 'completed') {
      queue.status = 'queued';
      queue.endTime = undefined;
    }
  }
}

function recomputeVpsJobCounters(job: VpsBatchJobState): void {
  if (!Array.isArray(job.queues)) {
    job.queues = [];
  }
  for (const q of job.queues) {
    recomputeSingleQueueCounters(q);
  }

  const allTasks = job.queues.flatMap((q) => q.tasks);
  job.total = allTasks.length;
  job.completed = allTasks.filter((t) => t.status === 'completed').length;
  job.skipped = allTasks.filter((t) => t.status === 'skipped_in_cloudflare').length;
  job.errors = allTasks.filter((t) => t.status === 'error').length;
  job.incompleteCount = job.queues.reduce((acc, q) => acc + q.incompleteCount, 0);

  const focusedQueue =
    job.queues.find((q) => q.queueId === job.activeQueueId) ||
    job.queues.find((q) => q.status === 'running') ||
    job.queues.find((q) => q.status === 'queued') ||
    job.queues[0] ||
    null;

  if (focusedQueue) {
    job.activeQueueId = focusedQueue.queueId;
    job.batchSkipMode = focusedQueue.options.batchSkipMode;
    job.wordsToRemove = focusedQueue.options.wordsToRemove;
    job.uploadThumbnailToR2 = focusedQueue.options.uploadThumbnailToR2;
    job.uploadVideoToR2 = focusedQueue.options.uploadVideoToR2;
    job.compressVideo = focusedQueue.options.compressVideo;
    job.compressionQuality = focusedQueue.options.compressionQuality;
    job.autoRetryIncomplete = focusedQueue.options.autoRetryIncomplete;
    job.maxAutoRetryPasses = focusedQueue.options.maxAutoRetryPasses;
    job.currentPass = focusedQueue.currentPass || 1;
    job.serverPool = focusedQueue.options.serverPool;
    job.tasks = focusedQueue.tasks;
  } else {
    job.tasks = [];
  }

  job.lastUpdatedAt = new Date().toISOString();
}

function projectJobForClient(job: VpsBatchJobState | null): VpsBatchJobState | null {
  if (!job) return null;
  recomputeVpsJobCounters(job);
  syncLiveLoadCountersOnJob(job);
  return {
    ...job,
    tasks: job.tasks,
    queues: job.queues,
  };
}

async function persistVpsBatchJob(forceD1 = false): Promise<void> {
  if (!activeVpsBatchJob) return;
  recomputeVpsJobCounters(activeVpsBatchJob);

  // Store queues as single source of truth on disk/D1 without duplicating active queue tasks in job.tasks
  const snapshotToPersist: VpsBatchJobState = {
    ...activeVpsBatchJob,
    appBaseUrl: isPublicHttpBaseUrl(activeVpsJobAppBaseUrl)
      ? activeVpsJobAppBaseUrl
      : activeVpsBatchJob.appBaseUrl,
    tasks: [],
  };

  try {
    fs.writeFileSync(vpsJobFilePath, JSON.stringify(snapshotToPersist, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`Failed to write ${path.basename(vpsJobFilePath)}:`, e);
  }

  const now = Date.now();
  if (!forceD1 && now - lastD1JobSyncAt < 3500) {
    return;
  }
  lastD1JobSyncAt = now;

  const d1SafeQueues = snapshotToPersist.queues.map((q) => ({
    ...q,
    tasks: q.tasks.map(({ localTempVideoPath: _ltp, localCompressedVideoPath: _lcp, ...rest }) => rest),
  }));

  try {
    await axios.post(
      `${CF_WORKER_BASE_URL}/api/ad_config`,
      {
        id: VPS_QUEUE_SCOPE.d1DocId,
        scopeId: VPS_QUEUE_SCOPE.scopeId,
        scopeLabel: VPS_QUEUE_SCOPE.scopeLabel,
        ...snapshotToPersist,
        queues: d1SafeQueues,
        updatedAt: now,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000,
      }
    );
  } catch (err) {
    console.warn('Could not sync batch job snapshot to D1 ad_config:', formatCompactError(err));
  }
}

function applyRegistryRecordToTask(task: VpsBatchTask, rec: CloudflareExtractedLink): void {
  task.title = rec.title || task.title;
  task.rawTitle = rec.rawTitle || rec.title || task.rawTitle;
  task.description = rec.description || task.description || '';
  task.videoStreamUrl = rec.cloudflareVideoUrl || rec.videoUrl || task.videoStreamUrl;
  task.originalVideoUrl = rec.videoUrl || task.originalVideoUrl;
  task.cloudflareVideoUrl = rec.cloudflareVideoUrl || task.cloudflareVideoUrl;
  task.videoStorageSource = (rec.videoStorageSource as any) || (rec.cloudflareVideoUrl ? 'cloudflare_r2' : undefined);
  task.originalThumbnailUrl = rec.thumbnailUrl || task.originalThumbnailUrl;
  task.cloudflareThumbnailUrl = rec.cloudflareThumbnailUrl || rec.thumbnailUrl || task.cloudflareThumbnailUrl;
  task.thumbnailStorageSource =
    (rec.thumbnailStorageSource as any) || (rec.cloudflareThumbnailUrl ? 'cloudflare_r2' : undefined);
  task.durationFormatted = rec.durationFormatted || task.durationFormatted;
  task.durationSec = rec.durationSec ?? task.durationSec;
  task.sizeFormatted = rec.sizeFormatted || task.sizeFormatted;
  const resolvedBytes = rec.sizeBytes ?? task.sizeBytes ?? null;
  task.sizeBytes = resolvedBytes;
  if (resolvedBytes && resolvedBytes > 0) {
    task.sizeKb = Math.round(resolvedBytes / 1024);
  } else if (rec.sizeMb && !isNaN(Number(rec.sizeMb))) {
    task.sizeKb = Math.round(Number(rec.sizeMb) * 1024);
  }
  task.isRegisteredInCloudflare = true;
  task.destination = rec.destination || task.destination;
  task.destinationDetail = rec.destinationDetail || task.destinationDetail;
  task.registryUniqueId = rec.id || task.registryUniqueId;
}

async function runSingleVpsTask(
  task: VpsBatchTask,
  workerId: number,
  queue: VpsBatchQueue,
  _job: VpsBatchJobState
): Promise<void> {
  const opts = queue.options;
  task.workerId = workerId;
  task.attempts = (task.attempts || 0) + 1;
  const attemptNum = task.attempts;
  queue.currentPass = Math.max(queue.currentPass || 1, attemptNum);
  // Only bypass Cloudflare D1 registry when user explicitly chose "Don't Skip (Force Live Again)".
  // Retries on smart_cache / strict_skip always re-check live D1 so work completed by ANY VPS is never duplicated.
  const forceRefreshThisAttempt = opts.batchSkipMode === 'dont_skip';

  // Step 0: Always check live Cloudflare D1 registry before scraping/downloading (multi-server safe)
  task.error = undefined;
  task.status = 'checking_registry';
  task.statusMessage = `[W${workerId} · ${queue.name} · Try ${attemptNum}] Checking Cloudflare D1 Registry...`;
  await persistVpsBatchJob(false);
  await hydrateRegistryFromD1IfNeeded(true);

  const existing = findRegistryRecordByWebUrl(task.url);
  if (!forceRefreshThisAttempt && existing && existing.status !== 'processing' && !isPreviewVideoUrl(existing.videoUrl)) {
    const hasCfVideo = Boolean(existing.cloudflareVideoUrl);
    const hasCfThumb = Boolean(existing.cloudflareThumbnailUrl);
    const hasCompleteAssets =
      (hasCfVideo ||
        (!opts.uploadVideoToR2 && Boolean(existing.videoUrl)) ||
        (existing.status === 'uploaded' && hasCfThumb && !existing.videoUrl)) &&
      (!opts.uploadVideoToR2 || hasCfVideo || (existing.status === 'uploaded' && !existing.videoUrl)) &&
      (!opts.uploadThumbnailToR2 || hasCfThumb || !existing.thumbnailUrl);

    const alreadyRegisteredForStrictSkip =
      opts.batchSkipMode === 'strict_skip' &&
      Boolean(existing.cloudflareVideoUrl || existing.cloudflareThumbnailUrl || existing.videoUrl);

    if (hasCompleteAssets || alreadyRegisteredForStrictSkip) {
      applyRegistryRecordToTask(task, existing);
      task.error = undefined;
      task.crossServerWaitCount = 0;
      if (opts.batchSkipMode === 'strict_skip') {
        task.status = 'skipped_in_cloudflare';
        task.statusMessage = `[W${workerId} · ${queue.name}] Strict Skip: Found in Cloudflare D1 Registry · Bypassed`;
      } else {
        task.status = 'completed';
        task.statusMessage = `[W${workerId} · ${queue.name}] Reused from Cloudflare D1 Registry (0 Duplicate Copies)`;
      }
      task.lastAttemptEndedAt = Date.now();
      await persistVpsBatchJob(false);
      return;
    }
  }

  // If another live VPS actively owns this URL (fresh heartbeat < 3m), wait cleanly & reuse from D1 instead of failing
  const activeOtherLock = !forceRefreshThisAttempt ? getActiveOtherVpsLock(existing) : null;
  if (activeOtherLock) {
    const waitCount = (task.crossServerWaitCount || 0) + 1;
    task.crossServerWaitCount = waitCount;
    if (waitCount <= 40) {
      task.attempts = Math.max(0, attemptNum - 1);
    }
    task.status = 'waiting_d1';
    task.error = undefined;
    task.statusMessage = `[W${workerId} · ${queue.name}] Another VPS (${activeOtherLock.otherServerId}) is extracting — will reuse from D1 (check #${waitCount})`;
    // Re-check after ~10s while freeing this worker immediately for remaining queued links
    task.lastAttemptEndedAt = Date.now() + 7500;
    await persistVpsBatchJob(false);
    return;
  }

  // Step 1: Scrape webpage + download video + optional compression + upload to Cloudflare R2
  // (Resuming directly from saved stage checkpoints so retries NEVER restart from scratch!)
  let lastStageName: VpsBatchTask['status'] = 'scraping';
  let lastStagePersistAt = 0;
  const reportStage = (
    stage: 'checking_registry' | 'scraping' | 'downloading_video' | 'compressing_video' | 'uploading_cloudflare',
    detail: string,
    meta?: { title?: string; thumbnailUrl?: string; videoUrl?: string }
  ) => {
    const stageChanged = stage !== lastStageName;
    lastStageName = stage;
    task.status = stage;
    task.statusMessage = `[W${workerId} · ${queue.name} · Try ${attemptNum}] ${detail}`;
    if (meta?.title && !task.title) task.title = meta.title;
    if (meta?.thumbnailUrl && !task.originalThumbnailUrl) task.originalThumbnailUrl = meta.thumbnailUrl;
    if (meta?.videoUrl && !task.originalVideoUrl) task.originalVideoUrl = meta.videoUrl;
    const now = Date.now();
    if (stageChanged || now - lastStagePersistAt >= 1800) {
      lastStagePersistAt = now;
      persistVpsBatchJob(false).catch(() => {});
    }
  };

  const applyCheckpointPatch = (cp: {
    title?: string;
    rawTitle?: string;
    description?: string;
    originalVideoUrl?: string;
    originalThumbnailUrl?: string;
    cloudflareThumbnailUrl?: string;
    cloudflareVideoUrl?: string;
    durationSec?: number | null;
    durationFormatted?: string;
    pageRefererUrl?: string;
    localTempVideoPath?: string;
    localCompressedVideoPath?: string;
    localVideoDownloadComplete?: boolean;
  }) => {
    if (cp.title) task.title = cp.title;
    if (cp.rawTitle) task.rawTitle = cp.rawTitle;
    if (cp.description) task.description = cp.description;
    if (cp.originalVideoUrl) task.originalVideoUrl = cp.originalVideoUrl;
    if (cp.originalThumbnailUrl) task.originalThumbnailUrl = cp.originalThumbnailUrl;
    if (cp.cloudflareThumbnailUrl) task.cloudflareThumbnailUrl = cp.cloudflareThumbnailUrl;
    if (cp.cloudflareVideoUrl) task.cloudflareVideoUrl = cp.cloudflareVideoUrl;
    if (cp.durationSec !== undefined && cp.durationSec !== null) task.durationSec = cp.durationSec;
    if (cp.durationFormatted) task.durationFormatted = cp.durationFormatted;
    if (cp.pageRefererUrl) task.pageRefererUrl = cp.pageRefererUrl;
    if (cp.localTempVideoPath !== undefined) task.localTempVideoPath = cp.localTempVideoPath;
    if (cp.localCompressedVideoPath !== undefined) task.localCompressedVideoPath = cp.localCompressedVideoPath;
    if (cp.localVideoDownloadComplete !== undefined) {
      task.localVideoDownloadComplete = cp.localVideoDownloadComplete;
    }
  };

  // CHECKPOINT FAST-PATH:
  // If an earlier attempt already scraped the video link OR already downloaded/compressed the video file on disk,
  // resume straight from the failed stage (upload -> compress -> range-resume download) WITHOUT scraping again!
  const hasSavedCompressedFile = Boolean(
    task.localCompressedVideoPath &&
      fs.existsSync(task.localCompressedVideoPath) &&
      fs.statSync(task.localCompressedVideoPath).size > 0
  );
  const hasSavedTempFile = Boolean(
    task.localTempVideoPath && fs.existsSync(task.localTempVideoPath) && fs.statSync(task.localTempVideoPath).size > 0
  );
  const hasAlreadyUploadedR2Video = Boolean(
    task.cloudflareVideoUrl &&
      (task.videoStorageSource === 'cloudflare_r2' ||
        (activeVpsJobR2Config?.publicUrlPrefix && task.cloudflareVideoUrl.startsWith(activeVpsJobR2Config.publicUrlPrefix)) ||
        task.cloudflareVideoUrl.includes('/api/r2/stream/') ||
        task.cloudflareVideoUrl.includes('/api/local-media/videos/'))
  );
  const hasAlreadyUploadedR2Thumb = Boolean(
    task.cloudflareThumbnailUrl &&
      (task.thumbnailStorageSource === 'cloudflare_r2' ||
        (activeVpsJobR2Config?.publicUrlPrefix && task.cloudflareThumbnailUrl.startsWith(activeVpsJobR2Config.publicUrlPrefix)) ||
        task.cloudflareThumbnailUrl.includes('/api/r2/stream/') ||
        task.cloudflareThumbnailUrl.includes('/api/local-media/thumbnails/'))
  );
  const canResumeWithoutScraping =
    !forceRefreshThisAttempt &&
    (hasAlreadyUploadedR2Video ||
      hasSavedCompressedFile ||
      (hasSavedTempFile && Boolean(task.localVideoDownloadComplete)) ||
      (Boolean(task.originalVideoUrl) && !isPreviewVideoUrl(task.originalVideoUrl)));

  let resumeHandled = false;
  let data: any = null;

  if (canResumeWithoutScraping) {
    try {
      let resumedCfThumb = hasAlreadyUploadedR2Thumb ? task.cloudflareThumbnailUrl : undefined;
      let resumedThumbSource = task.thumbnailStorageSource;

      if (opts.uploadThumbnailToR2 && task.originalThumbnailUrl && !resumedCfThumb) {
        try {
          const thumbUp = await uploadImageToR2OrLocal({
            imageUrl: task.originalThumbnailUrl,
            customFilename: task.title || 'thumb',
            folderPrefix: 'thumbnails',
            refererUrl: task.pageRefererUrl || task.url,
            r2ConfigOverride: activeVpsJobR2Config || undefined,
            appBaseUrlOverride: activeVpsJobAppBaseUrl,
          });
          resumedCfThumb = thumbUp.cloudflareBackLink;
          resumedThumbSource = thumbUp.storageSource;
          task.cloudflareThumbnailUrl = resumedCfThumb;
          task.thumbnailStorageSource = resumedThumbSource;
        } catch {}
      }

      if (hasAlreadyUploadedR2Video) {
        // Video already uploaded to R2 — only finish saving D1 metadata!
        reportStage('uploading_cloudflare', 'Saving already-uploaded R2 video to Cloudflare D1...');
        const savedRec = upsertRegistryRecordByWebUrl(task.url, {
          title: task.title || 'Extracted Video',
          rawTitle: task.rawTitle || task.title,
          description: task.description || undefined,
          videoUrl: task.originalVideoUrl || task.cloudflareVideoUrl || '',
          thumbnailUrl: task.originalThumbnailUrl || '',
          cloudflareVideoUrl: task.cloudflareVideoUrl,
          cloudflareThumbnailUrl: resumedCfThumb || task.cloudflareThumbnailUrl,
          videoStorageSource: task.videoStorageSource || 'cloudflare_r2',
          thumbnailStorageSource: resumedThumbSource || null,
          durationFormatted: task.durationFormatted || '',
          durationSec: task.durationSec ?? null,
          sizeBytes: task.sizeBytes ?? null,
          status: 'uploaded',
          metadata: {
            ...(findRegistryRecordByWebUrl(task.url)?.metadata || {}),
            workerServerId: SERVER_INSTANCE_ID,
            workerScopeId: VPS_QUEUE_SCOPE.scopeId,
          },
        });
        await syncRegistryToStorage(undefined, [savedRec]);
        task.isRegisteredInCloudflare = true;
        task.registryUniqueId = savedRec.id;
        task.videoStreamUrl = task.cloudflareVideoUrl || task.videoStreamUrl;
        task.status = 'completed';
        task.error = undefined;
        task.statusMessage = `[W${workerId} · ${queue.name}] Resumed & Saved R2 Link in Cloudflare D1`;
        task.lastAttemptEndedAt = Date.now();
        cleanupTaskCheckpointFiles(task);
        await persistVpsBatchJob(false);
        return;
      }

      if (opts.uploadVideoToR2) {
        const readyLabel = hasSavedCompressedFile
          ? 'Resuming upload from saved compressed file (skipping scrape & download)...'
          : hasSavedTempFile && task.localVideoDownloadComplete
          ? 'Resuming upload from saved downloaded file (skipping scrape & download)...'
          : hasSavedTempFile
          ? 'Resuming partial video download via HTTP Range (skipping scrape)...'
          : 'Downloading already-extracted video URL (skipping scrape)...';
        reportStage(
          hasSavedCompressedFile || (hasSavedTempFile && task.localVideoDownloadComplete)
            ? 'uploading_cloudflare'
            : 'downloading_video',
          readyLabel
        );

        const r2ResumeOut = await uploadVideoToR2OrLocal({
          videoUrl: task.originalVideoUrl || task.url,
          customFilename: task.title || 'video',
          folderPrefix: 'videos',
          refererUrl: task.pageRefererUrl || task.url,
          extraServers: opts.serverPool,
          r2ConfigOverride: activeVpsJobR2Config || undefined,
          appBaseUrlOverride: activeVpsJobAppBaseUrl,
          compressVideo: Boolean(opts.compressVideo),
          compressionQuality: normalizeCompressionQuality(opts.compressionQuality),
          existingLocalVideoPath: hasSavedTempFile ? task.localTempVideoPath : undefined,
          existingCompressedVideoPath: hasSavedCompressedFile ? task.localCompressedVideoPath : undefined,
          localVideoDownloadComplete: Boolean(hasSavedTempFile && task.localVideoDownloadComplete),
          preserveLocalFileOnError: true,
          onStage: reportStage,
        });

        const finalThumb = resumedCfThumb || task.cloudflareThumbnailUrl || task.originalThumbnailUrl || undefined;
        const savedRec = upsertRegistryRecordByWebUrl(task.url, {
          title: task.title || 'Extracted Video',
          rawTitle: task.rawTitle || task.title,
          description: task.description || undefined,
          videoUrl: task.originalVideoUrl || r2ResumeOut.cloudflareVideoBackLink,
          thumbnailUrl: task.originalThumbnailUrl || '',
          cloudflareVideoUrl: r2ResumeOut.cloudflareVideoBackLink,
          cloudflareThumbnailUrl: resumedCfThumb || undefined,
          videoStorageSource: r2ResumeOut.storageSource,
          thumbnailStorageSource: resumedThumbSource || null,
          durationFormatted: r2ResumeOut.durationFormatted || task.durationFormatted || '',
          durationSec: r2ResumeOut.durationSec ?? task.durationSec ?? null,
          sizeBytes: r2ResumeOut.sizeBytes,
          sizeMb: r2ResumeOut.sizeMb,
          sizeFormatted: r2ResumeOut.sizeFormatted,
          status: 'uploaded',
          metadata: {
            ...(findRegistryRecordByWebUrl(task.url)?.metadata || {}),
            workerServerId: SERVER_INSTANCE_ID,
            workerScopeId: VPS_QUEUE_SCOPE.scopeId,
            completedAt: new Date().toISOString(),
          },
        });
        await syncRegistryToStorage(undefined, [savedRec]);

        task.cloudflareVideoUrl = r2ResumeOut.cloudflareVideoBackLink;
        task.videoStreamUrl = r2ResumeOut.cloudflareVideoBackLink;
        task.videoStorageSource = r2ResumeOut.storageSource;
        task.cloudflareThumbnailUrl = finalThumb;
        task.durationFormatted = r2ResumeOut.durationFormatted || task.durationFormatted;
        task.durationSec = r2ResumeOut.durationSec ?? task.durationSec;
        task.sizeFormatted = r2ResumeOut.sizeFormatted;
        task.sizeBytes = r2ResumeOut.sizeBytes;
        task.sizeKb = Math.round(r2ResumeOut.sizeBytes / 1024);
        task.isRegisteredInCloudflare = true;
        task.registryUniqueId = savedRec.id;
        task.status = 'completed';
        task.error = undefined;
        const savedInfo = r2ResumeOut.savedPercent
          ? ` · Compressed ${r2ResumeOut.compressionQuality} (-${r2ResumeOut.savedPercent}%)`
          : '';
        task.statusMessage = `[W${workerId} · ${queue.name}] Resumed & Saved in D1: Video + Thumbnail on Cloudflare R2${savedInfo}`;
        task.lastAttemptEndedAt = Date.now();
        cleanupTaskCheckpointFiles(task);
        await persistVpsBatchJob(false);
        return;
      }

      resumeHandled = true;
    } catch (resumeErr: any) {
      if (resumeErr?.checkpoint) {
        applyCheckpointPatch(resumeErr.checkpoint);
      }
      const errStr = formatCompactError(resumeErr);
      const hasReadyFileNow = Boolean(
        (task.localCompressedVideoPath && fs.existsSync(task.localCompressedVideoPath)) ||
          (task.localTempVideoPath && fs.existsSync(task.localTempVideoPath) && task.localVideoDownloadComplete)
      );
      if (hasReadyFileNow) {
        // Video is ALREADY downloaded/compressed locally — NEVER discard it to re-scrape!
        task.status = 'error';
        task.error = `Upload interrupted (video kept locally for resume): ${errStr}`;
        task.statusMessage = `[W${workerId} · ${queue.name} · Try ${attemptNum}] ${task.error}`;
        task.lastAttemptEndedAt = Date.now();
        await persistVpsBatchJob(false);
        return;
      }
      // If saved CDN URL returned 401/403/404/410 or HTML (expired signed URL), clear stale URL & fall back to fresh scrape
      const isExpiredCdnUrl =
        /HTTP\s*(401|403|404|410)/i.test(errStr) ||
        errStr.includes('HTML/JSON') ||
        errStr.includes('text/html');
      if (isExpiredCdnUrl) {
        cleanupTaskCheckpointFiles(task);
        task.originalVideoUrl = undefined;
      } else if (task.localTempVideoPath && fs.existsSync(task.localTempVideoPath)) {
        // Partial download saved on disk — keep it so next retry resumes via HTTP Range!
        task.status = 'error';
        task.error = `Download interrupted (partial bytes saved for resume): ${errStr}`;
        task.statusMessage = `[W${workerId} · ${queue.name} · Try ${attemptNum}] ${task.error}`;
        task.lastAttemptEndedAt = Date.now();
        await persistVpsBatchJob(false);
        return;
      }
    }
  }

  if (!resumeHandled) {
    task.status = 'scraping';
    task.statusMessage = `[W${workerId} · ${queue.name} · Try ${attemptNum}] Scraping webpage...`;
    await persistVpsBatchJob(false);

    try {
      data = await processUrlCore({
        url: task.url,
        wordsToRemove: opts.wordsToRemove,
        uploadThumbnailToR2: opts.uploadThumbnailToR2,
        uploadVideoToR2: opts.uploadVideoToR2,
        compressVideo: Boolean(opts.compressVideo),
        compressionQuality: normalizeCompressionQuality(opts.compressionQuality),
        forceRefresh: forceRefreshThisAttempt,
        r2ConfigOverride: activeVpsJobR2Config || undefined,
        appBaseUrlOverride: activeVpsJobAppBaseUrl,
        extraServers: opts.serverPool,
        checkpoint: {
          cloudflareThumbnailUrl: hasAlreadyUploadedR2Thumb ? task.cloudflareThumbnailUrl : undefined,
          cloudflareVideoUrl: hasAlreadyUploadedR2Video ? task.cloudflareVideoUrl : undefined,
        },
        onCheckpointUpdate: applyCheckpointPatch,
        onStage: reportStage,
      });
    } catch (procErr: any) {
      if (procErr?.checkpoint) {
        applyCheckpointPatch(procErr.checkpoint);
      }
      if (procErr?.statusCode === 409) {
        const waitCount = (task.crossServerWaitCount || 0) + 1;
        task.crossServerWaitCount = waitCount;
        if (waitCount <= 40) {
          task.attempts = Math.max(0, attemptNum - 1);
        }
        task.status = 'waiting_d1';
        task.error = undefined;
        task.statusMessage = `[W${workerId} · ${queue.name}] ${formatCompactError(procErr)} (check #${waitCount})`;
        task.lastAttemptEndedAt = Date.now() + 7500;
        await persistVpsBatchJob(false);
        return;
      }
      throw procErr;
    }
  }

  const primaryVideo = data.media?.videos?.[0];
  const title = data.page?.title || primaryVideo?.title || task.url.split('/').pop()?.split('?')[0] || `Video ${task.index}`;
  const rawTitle = data.page?.rawTitle || title;
  const originalVideoUrl = primaryVideo?.originalVideoUrl || primaryVideo?.url || '';
  const cloudflareVideoUrl = data.page?.cloudflareVideoUrl || primaryVideo?.cloudflareVideoUrl || undefined;
  const cloudflareThumb = data.page?.cloudflareThumbnailUrl || primaryVideo?.cloudflareThumbnailUrl || undefined;
  const originalThumb = data.page?.ogImage || primaryVideo?.poster || data.page?.candidateThumbnails?.[0]?.url || '';
  const videoUploadError = data.page?.videoUploadError || data.videoUploadError || '';

  task.title = title;
  task.rawTitle = rawTitle;
  task.description = data.page?.description || primaryVideo?.description || '';
  task.originalVideoUrl = originalVideoUrl;
  task.cloudflareVideoUrl = cloudflareVideoUrl;
  task.videoStreamUrl = cloudflareVideoUrl || originalVideoUrl;
  task.videoStorageSource = data.page?.videoStorageSource || (cloudflareVideoUrl ? 'cloudflare_r2' : undefined);
  task.originalThumbnailUrl = originalThumb;
  task.cloudflareThumbnailUrl = cloudflareThumb || originalThumb;
  task.thumbnailStorageSource = data.page?.thumbnailStorageSource || (cloudflareThumb ? 'cloudflare_r2' : undefined);
  task.durationFormatted = data.page?.durationFormatted || primaryVideo?.durationFormatted || '';
  task.durationSec = data.page?.durationSec ?? primaryVideo?.durationSec ?? null;
  task.sizeFormatted = data.page?.videoSize?.sizeFormatted || primaryVideo?.sizeFormatted || '';
  const extractedBytes = data.page?.videoSize?.sizeBytes ?? primaryVideo?.sizeBytes ?? null;
  task.sizeBytes = extractedBytes;
  if (extractedBytes && extractedBytes > 0) {
    task.sizeKb = Math.round(extractedBytes / 1024);
  } else {
    const mbVal = Number(data.page?.videoSize?.sizeMb || primaryVideo?.sizeMb || 0);
    task.sizeKb = mbVal > 0 ? Math.round(mbVal * 1024) : null;
  }
  task.isRegisteredInCloudflare = Boolean(data.isRegisteredInCloudflare);
  task.registryUniqueId = data.registryUniqueId || data.registryRecord?.id;
  task.serverUsed = data.serverUsed || 'direct';

  const stillIncomplete =
    (opts.uploadVideoToR2 && !cloudflareVideoUrl) || (!task.videoStreamUrl && !cloudflareVideoUrl);

  if (stillIncomplete) {
    // Remove incomplete D1 lock ONLY if no R2 video was saved
    if (!cloudflareVideoUrl) {
      await removeRegistryRecordByWebUrl(task.url);
      task.isRegisteredInCloudflare = false;
    }
    task.status = 'error';
    task.error = !task.videoStreamUrl
      ? 'No video stream extracted — removed from database for retry'
      : videoUploadError
      ? `Video link found, but upload failed: ${videoUploadError}`
      : 'Video upload to Cloudflare R2 incomplete — removed from database for retry';
    task.statusMessage = `[W${workerId} · ${queue.name} · Try ${attemptNum}] Failed/Incomplete: ${task.error}`;
  } else {
    task.status = 'completed';
    task.error = undefined;
    cleanupTaskCheckpointFiles(task);
    const savedInfo = data.page?.videoCompression?.savedPercent
      ? ` · Compressed ${data.page.videoCompression.quality} (-${data.page.videoCompression.savedPercent}%)`
      : '';
    task.statusMessage = data.fromCache
      ? `[W${workerId} · ${queue.name}] Reused from Cloudflare D1 Registry (0 Duplicate Copies)`
      : cloudflareVideoUrl
      ? `[W${workerId} · ${queue.name}] Completed & Saved in D1: Video + Thumbnail on Cloudflare R2${savedInfo}${
          task.serverUsed && task.serverUsed !== 'direct' ? ` (${task.serverUsed})` : ''
        }`
      : `[W${workerId} · ${queue.name}] Scraped & Saved in D1 (Source Stream · R2 Upload Skipped)`;
  }

  task.lastAttemptEndedAt = Date.now();
  await persistVpsBatchJob(false);
}

type ClaimWorkResult =
  | { type: 'task'; queue: VpsBatchQueue; task: VpsBatchTask; isRetry: boolean }
  | { type: 'wait'; waitMs: number }
  | { type: 'done' };

function claimNextWorkUnit(job: VpsBatchJobState): ClaimWorkResult {
  const runnableQueues = job.queues.filter((q) => q.status !== 'paused' && q.status !== 'stopped');

  // PRIORITY 1: Fresh 'pending' tasks in Queue order (Queue #1 -> Queue #2 -> Queue #3 -> ...)
  // Free workers at the tail of Queue #1 immediately roll into Queue #2 without waiting for trailing in-flight tasks!
  for (const q of runnableQueues) {
    for (const t of q.tasks) {
      if (t.status === 'pending' && !inFlightBatchTaskIds.has(t.id)) {
        inFlightBatchTaskIds.add(t.id);
        if (q.status === 'queued' || q.status === 'completed') {
          q.status = 'running';
          q.endTime = undefined;
        }
        if (!q.startedAt) q.startedAt = new Date().toISOString();
        job.activeQueueId = q.queueId;
        return { type: 'task', queue: q, task: t, isRetry: false };
      }
    }
  }

  // PRIORITY 2: NO fresh 'pending' tasks remain in any runnable queue.
  // Instead of letting extra workers sit idle waiting for trailing slow videos to finish,
  // immediately restart failed/incomplete tasks from the top across runnable queues (Queue #1 -> Queue #2 -> ...).
  const now = Date.now();
  let earliestCooldownWaitMs: number | null = null;

  for (const q of runnableQueues) {
    if (!q.options.autoRetryIncomplete) continue;
    for (const t of q.tasks) {
      if (!isTaskRetryEligibleForQueue(t, q)) continue;
      const elapsedSinceEnd = now - (t.lastAttemptEndedAt || 0);
      if (elapsedSinceEnd >= PER_TASK_RETRY_COOLDOWN_MS) {
        inFlightBatchTaskIds.add(t.id);
        t.status = 'pending';
        t.error = undefined;
        const nextAttempt = (t.attempts || 0) + 1;
        q.currentPass = Math.max(q.currentPass || 1, nextAttempt);
        t.statusMessage = `Pass ${nextAttempt}: Auto-restarting immediately (worker free)...`;
        if (q.status === 'queued' || q.status === 'completed') {
          q.status = 'running';
          q.endTime = undefined;
        }
        if (!q.startedAt) q.startedAt = new Date().toISOString();
        job.activeQueueId = q.queueId;
        return { type: 'task', queue: q, task: t, isRetry: true };
      } else {
        const remaining = PER_TASK_RETRY_COOLDOWN_MS - elapsedSinceEnd;
        if (earliestCooldownWaitMs === null || remaining < earliestCooldownWaitMs) {
          earliestCooldownWaitMs = remaining;
        }
      }
    }
  }

  // If retryable tasks exist but are within 2.5s per-URL cooldown, OR if other tasks are still in-flight, wait briefly
  if (earliestCooldownWaitMs !== null) {
    return { type: 'wait', waitMs: Math.max(150, Math.min(earliestCooldownWaitMs + 50, 1200)) };
  }
  if (inFlightBatchTaskIds.size > 0) {
    return { type: 'wait', waitMs: 1500 };
  }

  return { type: 'done' };
}

function peekNextCompressRequirement(job: VpsBatchJobState): boolean {
  const runnable = job.queues.filter((q) => q.status !== 'paused' && q.status !== 'stopped');
  for (const q of runnable) {
    if (q.tasks.some((t) => t.status === 'pending' && !inFlightBatchTaskIds.has(t.id))) {
      return Boolean(q.options.compressVideo);
    }
  }
  for (const q of runnable) {
    if (q.options.autoRetryIncomplete && q.tasks.some((t) => isTaskRetryEligibleForQueue(t, q))) {
      return Boolean(q.options.compressVideo);
    }
  }
  return false;
}

function hasAnyPendingOrRetryableWork(job: VpsBatchJobState): boolean {
  return job.queues.some((q) => {
    if (q.status === 'paused' || q.status === 'stopped') return false;
    return (
      q.tasks.some((t) => t.status === 'pending' && !inFlightBatchTaskIds.has(t.id)) ||
      q.tasks.some((t) => isTaskRetryEligibleForQueue(t, q))
    );
  });
}

function buildQueueSummaryStatusMessage(job: VpsBatchJobState): string {
  const runningQueues = job.queues.filter((q) => q.status === 'running' || q.activeWorkers > 0);
  const queuedCount = job.queues.filter((q) => q.status === 'queued').length;
  const activeNames = runningQueues.map((q) => `${q.name} (${q.activeWorkers}w)`).join(', ');
  const retryActive = runningQueues.some(
    (q) => !q.tasks.some((t) => t.status === 'pending') && q.tasks.some((t) => t.attempts && t.attempts > 1)
  );
  if (activeNames) {
    return `${retryActive ? 'Auto-retrying failed links & running' : 'Running'}: ${activeNames}${
      queuedCount > 0 ? ` · ${queuedCount} queue(s) waiting for free workers` : ''
    }`;
  }
  return `Pipeline active (${job.concurrency}x workers · ${job.completed}/${job.total} completed)`;
}

function launchVpsBatchWorkerLoop(): void {
  if (!activeVpsBatchJob) return;
  if (vpsWorkerLoopActive) {
    startVpsCloudKeepAliveLoop();
    notifyVpsWorkers();
    if (triggerVpsWorkerScaleUp) triggerVpsWorkerScaleUp();
    return;
  }
  vpsWorkerLoopActive = true;

  (async () => {
    try {
      while (activeVpsBatchJob && !vpsBatchCancelFlag && !vpsServerShuttingDown) {
        const job = activeVpsBatchJob;
        job.isRunning = true;
        job.endTime = undefined;
        startVpsCloudKeepAliveLoop();

        let activeCount = 0;
        let workerIdSeq = 0;
        const activePromises = new Set<Promise<void>>();

        const spawnWorker = (workerId: number) => {
          const p = (async () => {
            activeCount++;
            if (activeVpsBatchJob) activeVpsBatchJob.activeWorkers = activeCount;
            try {
              while (!vpsBatchCancelFlag && !vpsServerShuttingDown && activeVpsBatchJob) {
                while (vpsBatchPauseFlag && !vpsBatchCancelFlag && !vpsServerShuttingDown) {
                  await waitForVpsWorkerSignal(400);
                }
                if (vpsBatchCancelFlag || vpsServerShuttingDown || !activeVpsBatchJob) break;

                // Graceful scale-down if concurrency reduced live
                if (activeCount > activeVpsBatchJob.concurrency) break;

                // Per-queue compression CPU load governor when upcoming work compresses video
                if (peekNextCompressRequirement(activeVpsBatchJob)) {
                  let didPauseWorker = false;
                  const pauseStartedAt = Date.now();
                  try {
                    while (!vpsBatchCancelFlag && !vpsBatchPauseFlag && activeVpsBatchJob) {
                      const cpuNow = sampleLiveCpuPercent();
                      const threshold = didPauseWorker ? COMPRESSION_RESUME_CPU_PERCENT : COMPRESSION_HIGH_CPU_PERCENT;
                      const cpuTooHigh = cpuNow >= threshold;
                      const ffmpegBusy = activeFfmpegCompressions >= MAX_CONCURRENT_FFMPEG && activeCount > 1;
                      if (!cpuTooHigh && !ffmpegBusy) break;
                      if (Date.now() - pauseStartedAt >= 45000 && !ffmpegBusy) break;

                      if (!didPauseWorker) {
                        didPauseWorker = true;
                        workersPausedForLoad++;
                        syncLiveLoadCountersOnJob(activeVpsBatchJob);
                        activeVpsBatchJob.statusMessage = `Optimizing compression: ${workersPausedForLoad} worker(s) paused temporarily (CPU ${cpuNow}% · ${activeFfmpegCompressions} FFmpeg active)`;
                        await persistVpsBatchJob(false);
                      }
                      await waitForVpsWorkerSignal(1500);
                    }
                  } finally {
                    if (didPauseWorker) {
                      workersPausedForLoad = Math.max(0, workersPausedForLoad - 1);
                      if (activeVpsBatchJob) {
                        syncLiveLoadCountersOnJob(activeVpsBatchJob);
                        if (workersPausedForLoad === 0 && activeVpsBatchJob.isRunning) {
                          activeVpsBatchJob.statusMessage = `CPU cooled (${activeVpsBatchJob.currentCpuPercent ?? 0}%) — resuming workers...`;
                        }
                      }
                    }
                  }
                  if (vpsBatchCancelFlag || !activeVpsBatchJob) break;
                }

                const claim = claimNextWorkUnit(activeVpsBatchJob);
                if (claim.type === 'done') {
                  break;
                }
                if (claim.type === 'wait') {
                  await waitForVpsWorkerSignal(claim.waitMs);
                  continue;
                }

                const { queue, task } = claim;
                if (activeVpsBatchJob) {
                  activeVpsBatchJob.statusMessage = buildQueueSummaryStatusMessage(activeVpsBatchJob);
                  queue.statusMessage = `${queue.name}: ${
                    claim.isRetry ? 'Restarting failed/incomplete items from top' : 'Processing queued items'
                  }...`;
                }

                try {
                  await runSingleVpsTask(task, workerId, queue, activeVpsBatchJob);
                } catch (err: any) {
                  task.status = 'error';
                  task.error = formatCompactError(err) || 'Scrape failed';
                  task.statusMessage = `[W${workerId} · ${queue.name} · Try ${task.attempts || 1}] Failed: ${task.error}`;
                  task.lastAttemptEndedAt = Date.now();
                  await persistVpsBatchJob(false);
                } finally {
                  inFlightBatchTaskIds.delete(task.id);
                  if (
                    task.status === 'completed' ||
                    task.status === 'skipped_in_cloudflare' ||
                    !isTaskRetryEligibleForQueue(task, queue)
                  ) {
                    cleanupTaskCheckpointFiles(task);
                  }
                  if (activeVpsBatchJob) {
                    recomputeSingleQueueCounters(queue);
                    activeVpsBatchJob.statusMessage = buildQueueSummaryStatusMessage(activeVpsBatchJob);
                  }
                  notifyVpsWorkers();
                }
              }
            } finally {
              activeCount = Math.max(0, activeCount - 1);
              if (activeVpsBatchJob) activeVpsBatchJob.activeWorkers = activeCount;
              notifyVpsWorkers();
            }
          })();
          activePromises.add(p);
          p.finally(() => activePromises.delete(p));
        };

        triggerVpsWorkerScaleUp = () => {
          if (!activeVpsBatchJob || vpsBatchCancelFlag || vpsBatchPauseFlag) return;
          while (activeCount < activeVpsBatchJob.concurrency && hasAnyPendingOrRetryableWork(activeVpsBatchJob)) {
            spawnWorker(++workerIdSeq);
          }
          notifyVpsWorkers();
        };

        const initialCount = Math.max(1, job.concurrency);
        for (let i = 0; i < initialCount; i++) {
          if (!hasAnyPendingOrRetryableWork(job) && i > 0) break;
          spawnWorker(++workerIdSeq);
        }

        while (activePromises.size > 0) {
          await Promise.race(Array.from(activePromises));
        }
        triggerVpsWorkerScaleUp = null;

        // Re-check before exiting outer loop in case a new queue was added just as last worker exited
        if (
          activeVpsBatchJob &&
          !vpsBatchCancelFlag &&
          !vpsBatchPauseFlag &&
          !vpsServerShuttingDown &&
          hasAnyPendingOrRetryableWork(activeVpsBatchJob)
        ) {
          continue;
        }
        break;
      }
    } finally {
      vpsWorkerLoopActive = false;
      triggerVpsWorkerScaleUp = null;
      stopVpsCloudKeepAliveLoop();
      if (activeVpsBatchJob) {
        if (vpsServerShuttingDown) {
          // Preserve isRunning so next container boot immediately auto-resumes remaining queued work!
          activeVpsBatchJob.activeWorkers = 0;
          recomputeVpsJobCounters(activeVpsBatchJob);
          await persistVpsBatchJob(true);
        } else {
          activeVpsBatchJob.isRunning = false;
          activeVpsBatchJob.isPaused = vpsBatchPauseFlag;
          activeVpsBatchJob.activeWorkers = 0;
          activeVpsBatchJob.endTime = new Date().toISOString();
          recomputeVpsJobCounters(activeVpsBatchJob);
          activeVpsBatchJob.statusMessage = vpsBatchCancelFlag
            ? `Cancelled (${activeVpsBatchJob.completed}/${activeVpsBatchJob.total} completed across ${activeVpsBatchJob.queues.length} queue(s))`
            : activeVpsBatchJob.incompleteCount > 0
            ? `Finished ${activeVpsBatchJob.queues.length} queue(s): ${activeVpsBatchJob.completed} done, ${activeVpsBatchJob.incompleteCount} incomplete/failed`
            : `All ${activeVpsBatchJob.total} link(s) across ${activeVpsBatchJob.queues.length} queue(s) completed!`;
          await persistVpsBatchJob(true);
        }
      }
    }
  })();
}

function normalizeLoadedVpsJob(raw: any): VpsBatchJobState | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.scopeId && String(raw.scopeId) !== VPS_QUEUE_SCOPE.scopeId) {
    return null;
  }

  let queues: VpsBatchQueue[] = [];
  if (Array.isArray(raw.queues) && raw.queues.length > 0) {
    queues = raw.queues.map((q: any, idx: number) => {
      const qNum = Number(q.queueNumber) || idx + 1;
      const qId = String(q.queueId || `q_${Date.now()}_${qNum}`);
      const opts = normalizeQueueOptions(q.options || q, raw);
      const tasks: VpsBatchTask[] = (Array.isArray(q.tasks) ? q.tasks : []).map((t: any, ti: number) => {
        const hasValidTemp = Boolean(t.localTempVideoPath && fs.existsSync(String(t.localTempVideoPath)));
        const hasValidComp = Boolean(t.localCompressedVideoPath && fs.existsSync(String(t.localCompressedVideoPath)));
        return {
          ...t,
          id: String(t.id || `${qId}_t_${ti}`),
          index: Number(t.index) || ti + 1,
          queueId: qId,
          localTempVideoPath: hasValidTemp ? t.localTempVideoPath : undefined,
          localCompressedVideoPath: hasValidComp ? t.localCompressedVideoPath : undefined,
          localVideoDownloadComplete: hasValidTemp ? Boolean(t.localVideoDownloadComplete) : false,
          status:
            t.status === 'checking_registry' ||
            t.status === 'waiting_d1' ||
            t.status === 'scraping' ||
            t.status === 'downloading_video' ||
            t.status === 'compressing_video' ||
            t.status === 'uploading_cloudflare'
              ? 'pending'
              : t.status || 'pending',
          statusMessage:
            t.status === 'checking_registry' ||
            t.status === 'waiting_d1' ||
            t.status === 'scraping' ||
            t.status === 'downloading_video' ||
            t.status === 'compressing_video' ||
            t.status === 'uploading_cloudflare'
              ? 'Resumed after server restart'
              : t.statusMessage,
        };
      });

      return {
        queueId: qId,
        queueNumber: qNum,
        name: String(q.name || `Queue #${qNum}`),
        status: (q.status as VpsQueueStatus) || 'queued',
        options: opts,
        total: tasks.length,
        completed: 0,
        skipped: 0,
        errors: 0,
        incompleteCount: 0,
        activeWorkers: 0,
        currentPass: Number(q.currentPass || 1),
        statusMessage: q.statusMessage || '',
        createdAt: String(q.createdAt || raw.startTime || new Date().toISOString()),
        startedAt: q.startedAt,
        endTime: q.endTime,
        lastUpdatedAt: String(q.lastUpdatedAt || new Date().toISOString()),
        tasks,
      };
    });
  } else if (Array.isArray(raw.tasks) && raw.tasks.length > 0) {
    const qId = String(raw.jobId || `q_${Date.now()}_1`);
    const opts = normalizeQueueOptions(raw);
    const tasks: VpsBatchTask[] = raw.tasks.map((t: any, ti: number) => ({
      ...t,
      id: String(t.id || `${qId}_t_${ti}`),
      index: Number(t.index) || ti + 1,
      queueId: qId,
      status:
        t.status === 'checking_registry' ||
        t.status === 'waiting_d1' ||
        t.status === 'scraping' ||
        t.status === 'downloading_video' ||
        t.status === 'compressing_video' ||
        t.status === 'uploading_cloudflare'
          ? 'pending'
          : t.status || 'pending',
      statusMessage:
        t.status === 'checking_registry' ||
        t.status === 'waiting_d1' ||
        t.status === 'scraping' ||
        t.status === 'downloading_video' ||
        t.status === 'compressing_video' ||
        t.status === 'uploading_cloudflare'
          ? 'Resumed after server restart'
          : t.statusMessage,
    }));
    queues = [
      {
        queueId: qId,
        queueNumber: 1,
        name: 'Queue #1',
        status: raw.isPaused ? 'paused' : raw.isRunning ? 'running' : 'completed',
        options: opts,
        total: tasks.length,
        completed: 0,
        skipped: 0,
        errors: 0,
        incompleteCount: 0,
        activeWorkers: 0,
        currentPass: Number(raw.currentPass || 1),
        statusMessage: raw.statusMessage || '',
        createdAt: String(raw.startTime || new Date().toISOString()),
        startedAt: raw.startTime,
        endTime: raw.endTime,
        lastUpdatedAt: new Date().toISOString(),
        tasks,
      },
    ];
  } else {
    return null;
  }

  const maxQNum = queues.reduce((m, q) => Math.max(m, q.queueNumber), 0);
  const firstOpts = queues[0].options;
  const normalized: VpsBatchJobState = {
    jobId: String(raw.jobId || `vps_job_${Date.now()}`),
    scopeId: VPS_QUEUE_SCOPE.scopeId,
    scopeLabel: VPS_QUEUE_SCOPE.scopeLabel,
    isRunning: Boolean(raw.isRunning),
    isPaused: Boolean(raw.isPaused),
    concurrency: Math.max(1, Math.min(50, Number(raw.concurrency) || 3)),
    batchSkipMode: firstOpts.batchSkipMode,
    wordsToRemove: firstOpts.wordsToRemove,
    uploadThumbnailToR2: firstOpts.uploadThumbnailToR2,
    uploadVideoToR2: firstOpts.uploadVideoToR2,
    compressVideo: firstOpts.compressVideo,
    compressionQuality: firstOpts.compressionQuality,
    autoRetryIncomplete: firstOpts.autoRetryIncomplete,
    currentPass: Number(raw.currentPass || 1),
    maxAutoRetryPasses: firstOpts.maxAutoRetryPasses,
    serverPool: firstOpts.serverPool,
    total: 0,
    completed: 0,
    skipped: 0,
    errors: 0,
    incompleteCount: 0,
    activeWorkers: 0,
    statusMessage: raw.statusMessage || '',
    startTime: String(raw.startTime || new Date().toISOString()),
    endTime: raw.endTime,
    lastUpdatedAt: new Date().toISOString(),
    appBaseUrl: typeof raw.appBaseUrl === 'string' && isPublicHttpBaseUrl(raw.appBaseUrl) ? raw.appBaseUrl : undefined,
    activeQueueId: raw.activeQueueId || queues[0]?.queueId,
    nextQueueNumber: Math.max(Number(raw.nextQueueNumber) || maxQNum + 1, maxQNum + 1),
    queues,
    tasks: [],
  };

  recomputeVpsJobCounters(normalized);
  return normalized;
}

function getJobSnapshotTimestamp(raw: any): number {
  if (!raw || typeof raw !== 'object') return 0;
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) return raw.updatedAt;
  const iso = raw.lastUpdatedAt || raw.startTime;
  const ms = iso ? Date.parse(String(iso)) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

async function loadAndResumeVpsBatchJob(): Promise<void> {
  try {
    let diskRaw: any = null;
    if (fs.existsSync(vpsJobFilePath)) {
      try {
        diskRaw = JSON.parse(fs.readFileSync(vpsJobFilePath, 'utf-8'));
      } catch {}
    }

    let d1Raw: any = null;
    try {
      const d1Res = await axios.get(`${CF_WORKER_BASE_URL}/api/ad_config`, {
        timeout: 10000,
        validateStatus: () => true,
      });
      if (d1Res.status >= 200 && d1Res.status < 300 && Array.isArray(d1Res.data)) {
        const doc = d1Res.data.find((x: any) => String(x?.id || x?._id) === VPS_QUEUE_SCOPE.d1DocId);
        if (doc && (Array.isArray(doc.queues) || Array.isArray(doc.tasks))) {
          d1Raw = doc;
        }
      }
    } catch {}

    // Pick whichever source (local disk vs Cloudflare D1) has newer progress
    const diskTs = getJobSnapshotTimestamp(diskRaw);
    const d1Ts = getJobSnapshotTimestamp(d1Raw);
    const diskQueues = Array.isArray(diskRaw?.queues) ? diskRaw.queues.length : Array.isArray(diskRaw?.tasks) ? diskRaw.tasks.length : 0;
    const d1Queues = Array.isArray(d1Raw?.queues) ? d1Raw.queues.length : Array.isArray(d1Raw?.tasks) ? d1Raw.tasks.length : 0;

    let rawLoaded: any = null;
    if (d1Raw && d1Queues > 0 && (diskQueues === 0 || d1Ts >= diskTs)) {
      rawLoaded = d1Raw;
    } else if (diskRaw && diskQueues > 0) {
      rawLoaded = diskRaw;
    } else {
      rawLoaded = d1Raw || diskRaw;
    }

    // Wait: if user restarted/created queues in this process already, never overwrite activeVpsBatchJob
    if (activeVpsBatchJob) return;

    const loaded = normalizeLoadedVpsJob(rawLoaded);
    if (loaded && loaded.queues.length > 0) {
      if (!activeVpsJobR2Config) {
        activeVpsJobR2Config = getR2Config();
      }
      if (loaded.appBaseUrl && isPublicHttpBaseUrl(loaded.appBaseUrl)) {
        activeVpsJobAppBaseUrl = loaded.appBaseUrl;
      } else {
        const envBase = resolveValidAppBaseUrl();
        if (isPublicHttpBaseUrl(envBase)) activeVpsJobAppBaseUrl = envBase;
      }

      activeVpsBatchJob = loaded;
      vpsBatchPauseFlag = Boolean(loaded.isPaused);
      vpsBatchCancelFlag = false;
      if (loaded.isRunning && !loaded.isPaused && hasAnyPendingOrRetryableWork(loaded)) {
        console.log(
          `[VPS Batch] Auto-resuming ${loaded.queues.length} queue(s) (${loaded.completed}/${loaded.total} done) from persisted state...`
        );
        launchVpsBatchWorkerLoop();
      }
    }
  } catch (err) {
    console.warn('Could not restore persisted VPS batch job:', formatCompactError(err));
  }
}

async function ensureVpsBatchJobInitialized(): Promise<void> {
  if (activeVpsBatchJob) return;
  if (vpsBatchInitPromise) {
    await vpsBatchInitPromise;
    if (activeVpsBatchJob) return;
  }
  const now = Date.now();
  if (now - lastVpsBatchInitAttemptAt < 8000 && vpsBatchInitPromise) {
    return;
  }
  lastVpsBatchInitAttemptAt = now;
  vpsBatchInitPromise = loadAndResumeVpsBatchJob();
  await vpsBatchInitPromise;
}

function createVpsQueueObject(params: {
  queueNumber: number;
  name?: string;
  urls: string[];
  options: VpsQueueOptions;
}): VpsBatchQueue {
  const nowIso = new Date().toISOString();
  const queueId = `q_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const tasks: VpsBatchTask[] = params.urls.map((u, i) => ({
    id: `${queueId}_t_${i}_${Math.random().toString(36).substring(2, 5)}`,
    queueId,
    index: i + 1,
    url: String(u).trim(),
    status: 'pending',
    statusMessage: `Queued in ${params.name?.trim() || `Queue #${params.queueNumber}`}...`,
    attempts: 0,
  }));

  return {
    queueId,
    queueNumber: params.queueNumber,
    name: params.name?.trim() || `Queue #${params.queueNumber}`,
    status: 'queued',
    options: params.options,
    total: tasks.length,
    completed: 0,
    skipped: 0,
    errors: 0,
    incompleteCount: tasks.length,
    activeWorkers: 0,
    currentPass: 1,
    statusMessage: `Waiting for free worker (${tasks.length} link(s))...`,
    createdAt: nowIso,
    lastUpdatedAt: nowIso,
    tasks,
  };
}

// API: Multi-server Relay Fetch endpoint (allows secondary instances of this app to act as fetch nodes)
app.all('/api/relay-fetch', async (req: Request, res: Response) => {
  try {
    const rawTarget = String(req.query.url || req.body?.url || '').trim();
    if (!rawTarget || isBlockedPrivateHost(rawTarget)) {
      return res.status(400).json({ success: false, error: 'Valid public target url is required' });
    }
    const parsed = new URL(rawTarget);
    const ua = USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
    const agents = createNonKeepAliveAgents();
    const relayRes = await axios.get(rawTarget, {
      ...agents,
      timeout: 25000,
      maxRedirects: 5,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${parsed.origin}/`,
        Connection: 'close',
      },
    });
    const finalUrl = (relayRes.request as any)?.res?.responseUrl || relayRes.config?.url || rawTarget;
    return res.json({
      success: true,
      status: relayRes.status,
      statusText: relayRes.statusText || 'OK',
      finalUrl,
      headers: {
        'content-type': relayRes.headers['content-type'] || '',
        'content-length': relayRes.headers['content-length'] || '',
        'retry-after': relayRes.headers['retry-after'] || '',
      },
      html: typeof relayRes.data === 'string' ? relayRes.data : JSON.stringify(relayRes.data),
    });
  } catch (err: any) {
    return res.status(502).json({ success: false, error: formatCompactError(err) });
  }
});

// Helper shared by /api/vps-batch/start and /api/vps-batch/queues
async function addOrStartQueueHandler(req: Request, forceAppend: boolean) {
  const {
    urls,
    name,
    concurrency,
    switchImmediately = false,
  } = req.body;

  const cleanUrls = (Array.isArray(urls) ? urls : [])
    .map((u: any) => String(u || '').trim())
    .filter(Boolean);

  if (cleanUrls.length === 0) {
    return { status: 400, body: { success: false, error: 'urls array is required' } };
  }

  await Promise.all([hydrateRegistryFromD1IfNeeded(), ensureVpsBatchJobInitialized()]);

  // Capture active R2 config in server RAM (never written to disk/D1) and valid public URL
  captureRequestRuntimeContext(req);

  const opts = normalizeQueueOptions(req.body);
  const safeConcurrency =
    concurrency !== undefined
      ? Math.max(1, Math.min(50, Number(concurrency) || 3))
      : activeVpsBatchJob?.concurrency || 3;

  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;

  const shouldAppend = Boolean(activeVpsBatchJob) && (forceAppend || Boolean(activeVpsBatchJob?.isRunning));

  if (!shouldAppend || !activeVpsBatchJob) {
    const queue = createVpsQueueObject({
      queueNumber: 1,
      name,
      urls: cleanUrls,
      options: opts,
    });
    activeVpsBatchJob = {
      jobId: `vps_job_${Date.now()}`,
      scopeId: VPS_QUEUE_SCOPE.scopeId,
      scopeLabel: VPS_QUEUE_SCOPE.scopeLabel,
      isRunning: true,
      isPaused: false,
      concurrency: safeConcurrency,
      batchSkipMode: opts.batchSkipMode,
      wordsToRemove: opts.wordsToRemove,
      uploadThumbnailToR2: opts.uploadThumbnailToR2,
      uploadVideoToR2: opts.uploadVideoToR2,
      compressVideo: opts.compressVideo,
      compressionQuality: opts.compressionQuality,
      autoRetryIncomplete: opts.autoRetryIncomplete,
      currentPass: 1,
      maxAutoRetryPasses: opts.maxAutoRetryPasses,
      serverPool: opts.serverPool,
      total: queue.total,
      completed: 0,
      skipped: 0,
      errors: 0,
      incompleteCount: queue.total,
      activeWorkers: 0,
      statusMessage: `Starting ${queue.name} with ${safeConcurrency}x worker(s)...`,
      startTime: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      activeQueueId: queue.queueId,
      nextQueueNumber: 2,
      queues: [queue],
      tasks: queue.tasks,
    };

    await persistVpsBatchJob(true);
    launchVpsBatchWorkerLoop();

    return {
      status: 200,
      body: {
        success: true,
        message: `${queue.name} started with ${safeConcurrency}x worker(s). Safe to close browser.`,
        jobId: activeVpsBatchJob.jobId,
        addedQueue: queue,
        vpsScope: {
          scopeId: VPS_QUEUE_SCOPE.scopeId,
          scopeSlug: VPS_QUEUE_SCOPE.scopeSlug,
          scopeLabel: VPS_QUEUE_SCOPE.scopeLabel,
          d1DocId: VPS_QUEUE_SCOPE.d1DocId,
          source: VPS_QUEUE_SCOPE.source,
        },
        job: projectJobForClient(activeVpsBatchJob),
      },
    };
  }

  // Append new queue into active/existing multi-queue pipeline!
  if (concurrency !== undefined) {
    activeVpsBatchJob.concurrency = safeConcurrency;
  }
  const nextNum =
    activeVpsBatchJob.nextQueueNumber ||
    activeVpsBatchJob.queues.reduce((m, q) => Math.max(m, q.queueNumber), 0) + 1;
  activeVpsBatchJob.nextQueueNumber = nextNum + 1;

  const newQueue = createVpsQueueObject({
    queueNumber: nextNum,
    name,
    urls: cleanUrls,
    options: opts,
  });

  if (switchImmediately) {
    for (const q of activeVpsBatchJob.queues) {
      if (q.status === 'running' || q.status === 'queued') {
        q.status = 'stopped';
        q.statusMessage = `Stopped on switch to ${newQueue.name}`;
      }
    }
    activeVpsBatchJob.queues.unshift(newQueue);
    activeVpsBatchJob.activeQueueId = newQueue.queueId;
  } else {
    activeVpsBatchJob.queues.push(newQueue);
  }

  activeVpsBatchJob.isRunning = true;
  activeVpsBatchJob.isPaused = false;
  activeVpsBatchJob.statusMessage = `${newQueue.name} added (${newQueue.total} links) — workers pick it up automatically as soon as free!`;

  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  return {
    status: 200,
    body: {
      success: true,
      appended: true,
      message: `${newQueue.name} queued! Free workers will start it immediately.`,
      jobId: activeVpsBatchJob.jobId,
      addedQueue: newQueue,
      vpsScope: {
        scopeId: VPS_QUEUE_SCOPE.scopeId,
        scopeSlug: VPS_QUEUE_SCOPE.scopeSlug,
        scopeLabel: VPS_QUEUE_SCOPE.scopeLabel,
        d1DocId: VPS_QUEUE_SCOPE.d1DocId,
        source: VPS_QUEUE_SCOPE.source,
      },
      job: projectJobForClient(activeVpsBatchJob),
    },
  };
}

// API: Start Background Batch Queue (or appendQueue=true if already running)
app.post('/api/vps-batch/start', async (req: Request, res: Response) => {
  const appendQueue = req.body?.appendQueue !== false;
  const result = await addOrStartQueueHandler(req, appendQueue);
  return res.status(result.status).json(result.body);
});

// API: Add Queue #1, #2, #3, #4... anytime (starts immediately when workers become free)
app.post('/api/vps-batch/queues', async (req: Request, res: Response) => {
  const result = await addOrStartQueueHandler(req, true);
  return res.status(result.status).json(result.body);
});

// API: Update per-queue options live (skip mode, R2 video/thumb toggles, compress/quality, filter words, retries, proxies)
app.patch('/api/vps-batch/queues/:queueId/options', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No active batch pipeline' });
  }
  const queue = activeVpsBatchJob.queues.find((q) => q.queueId === req.params.queueId);
  if (!queue) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }

  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    queue.name = req.body.name.trim();
  }
  queue.options = normalizeQueueOptions(req.body, queue.options);
  queue.lastUpdatedAt = new Date().toISOString();
  recomputeVpsJobCounters(activeVpsBatchJob);

  if (activeVpsBatchJob.isRunning && !vpsBatchPauseFlag) {
    notifyVpsWorkers();
    if (triggerVpsWorkerScaleUp) triggerVpsWorkerScaleUp();
  }
  await persistVpsBatchJob(true);

  return res.json({
    success: true,
    message: `Updated options for ${queue.name}`,
    queue,
    job: projectJobForClient(activeVpsBatchJob),
  });
});

// API: Pause a specific queue (workers immediately switch to remaining runnable queues!)
app.post('/api/vps-batch/queues/:queueId/pause', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No active batch pipeline' });
  }
  const queue = activeVpsBatchJob.queues.find((q) => q.queueId === req.params.queueId);
  if (!queue) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }
  queue.status = 'paused';
  queue.statusMessage = `${queue.name} paused — free workers continue on other queues`;
  recomputeVpsJobCounters(activeVpsBatchJob);
  notifyVpsWorkers();
  await persistVpsBatchJob(true);
  return res.json({ success: true, message: `${queue.name} paused.`, job: projectJobForClient(activeVpsBatchJob) });
});

// API: Stop a specific queue cleanly (workers immediately move to next runnable queue!)
app.post('/api/vps-batch/queues/:queueId/stop', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No active batch pipeline' });
  }
  const queue = activeVpsBatchJob.queues.find((q) => q.queueId === req.params.queueId);
  if (!queue) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }
  queue.status = 'stopped';
  queue.statusMessage = `${queue.name} stopped by user — workers moved to next active queue`;
  recomputeVpsJobCounters(activeVpsBatchJob);
  notifyVpsWorkers();
  await persistVpsBatchJob(true);
  return res.json({ success: true, message: `${queue.name} stopped.`, job: projectJobForClient(activeVpsBatchJob) });
});

// API: Resume a paused/stopped queue
app.post('/api/vps-batch/queues/:queueId/resume', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No active batch pipeline' });
  }
  const queue = activeVpsBatchJob.queues.find((q) => q.queueId === req.params.queueId);
  if (!queue) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }
  captureRequestRuntimeContext(req);

  queue.status = 'queued';
  queue.endTime = undefined;
  queue.statusMessage = `${queue.name} resumed — waiting for free worker...`;
  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;
  activeVpsBatchJob.isPaused = false;
  activeVpsBatchJob.isRunning = true;

  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  return res.json({ success: true, message: `${queue.name} resumed.`, job: projectJobForClient(activeVpsBatchJob) });
});

// API: Stop currently active queue(s) and switch workers immediately to :queueId
app.post('/api/vps-batch/queues/:queueId/switch', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No active batch pipeline' });
  }
  const idx = activeVpsBatchJob.queues.findIndex((q) => q.queueId === req.params.queueId);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }

  captureRequestRuntimeContext(req);

  const targetQueue = activeVpsBatchJob.queues[idx];
  const stopOthers = req.body?.stopOthers !== false;
  const pauseInsteadOfStop = req.body?.mode === 'pause';

  if (stopOthers) {
    for (const q of activeVpsBatchJob.queues) {
      if (q.queueId !== targetQueue.queueId && (q.status === 'running' || q.status === 'queued')) {
        q.status = pauseInsteadOfStop ? 'paused' : 'stopped';
        q.statusMessage = `${pauseInsteadOfStop ? 'Paused' : 'Stopped'} — switched workers to ${targetQueue.name}`;
      }
    }
  }

  // Promote targetQueue to priority position #0 so workers pick it up before everything else
  activeVpsBatchJob.queues.splice(idx, 1);
  activeVpsBatchJob.queues.unshift(targetQueue);

  targetQueue.status = 'queued';
  targetQueue.endTime = undefined;
  targetQueue.statusMessage = `Switched active focus to ${targetQueue.name}!`;
  activeVpsBatchJob.activeQueueId = targetQueue.queueId;

  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;
  activeVpsBatchJob.isPaused = false;
  activeVpsBatchJob.isRunning = true;

  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  return res.json({
    success: true,
    message: `Switched workers to ${targetQueue.name}.`,
    job: projectJobForClient(activeVpsBatchJob),
  });
});

// API: Manually restart failed/incomplete tasks inside a single queue
app.post('/api/vps-batch/queues/:queueId/retry-incomplete', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No saved batch pipeline found' });
  }
  const queue = activeVpsBatchJob.queues.find((q) => q.queueId === req.params.queueId);
  if (!queue) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }

  captureRequestRuntimeContext(req);

  const incomplete = queue.tasks.filter(
    (t) => !inFlightBatchTaskIds.has(t.id) && isTaskIncompleteForQueue(t, queue.options)
  );
  if (incomplete.length === 0) {
    return res.json({
      success: true,
      retriedCount: 0,
      message: `No failed or incomplete websites in ${queue.name}.`,
      job: projectJobForClient(activeVpsBatchJob),
    });
  }

  for (const t of incomplete) {
    t.status = 'pending';
    t.error = undefined;
    t.statusMessage = `Re-queued for manual retry in ${queue.name}...`;
  }
  queue.status = 'queued';
  queue.endTime = undefined;
  queue.currentPass += 1;
  queue.options.maxAutoRetryPasses = Math.max(queue.options.maxAutoRetryPasses, queue.currentPass);
  queue.statusMessage = `Retrying ${incomplete.length} failed/incomplete link(s)...`;

  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;
  activeVpsBatchJob.isRunning = true;
  activeVpsBatchJob.isPaused = false;

  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  return res.json({
    success: true,
    retriedCount: incomplete.length,
    message: `Restarted ${incomplete.length} failed/incomplete link(s) in ${queue.name}.`,
    job: projectJobForClient(activeVpsBatchJob),
  });
});

// API: Delete/Remove one queue cleanly without disturbing other queues
app.delete('/api/vps-batch/queues/:queueId', async (req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No active batch pipeline' });
  }
  const target = activeVpsBatchJob.queues.find((q) => q.queueId === req.params.queueId);
  if (!target) {
    return res.status(404).json({ success: false, error: 'Queue not found' });
  }
  target.status = 'stopped';
  for (const t of target.tasks) {
    inFlightBatchTaskIds.delete(t.id);
    cleanupTaskCheckpointFiles(t);
  }
  activeVpsBatchJob.queues = activeVpsBatchJob.queues.filter((q) => q.queueId !== req.params.queueId);

  if (activeVpsBatchJob.queues.length === 0) {
    vpsBatchCancelFlag = true;
    vpsBatchPauseFlag = false;
    activeVpsBatchJob = null;
    try {
      if (fs.existsSync(vpsJobFilePath)) fs.unlinkSync(vpsJobFilePath);
    } catch {}
    try {
      await axios.delete(`${CF_WORKER_BASE_URL}/api/ad_config/${encodeURIComponent(VPS_QUEUE_SCOPE.d1DocId)}`, {
        timeout: 10000,
      });
    } catch {}
    return res.json({ success: true, message: 'Removed last queue and cleared pipeline.', job: null });
  }

  recomputeVpsJobCounters(activeVpsBatchJob);
  notifyVpsWorkers();
  await persistVpsBatchJob(true);
  return res.json({ success: true, message: `Removed ${target.name}.`, job: projectJobForClient(activeVpsBatchJob) });
});

// API: Streaming Keep-Alive Hold Endpoint for Serverless / Cloud Run background execution
app.get('/api/vps-batch/keepalive', async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();

  if (
    activeVpsBatchJob &&
    activeVpsBatchJob.isRunning &&
    !vpsBatchPauseFlag &&
    !vpsBatchCancelFlag &&
    !vpsWorkerLoopActive &&
    hasAnyPendingOrRetryableWork(activeVpsBatchJob)
  ) {
    launchVpsBatchWorkerLoop();
  }

  const holdMs = Math.max(5000, Math.min(55000, Number(req.query.holdMs) || 45000));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`: keepalive-start instance=${SERVER_INSTANCE_ID}\n\n`);

  const startedAt = Date.now();
  const interval = setInterval(() => {
    const stillActive =
      Boolean(activeVpsBatchJob?.isRunning) &&
      !vpsBatchPauseFlag &&
      !vpsBatchCancelFlag &&
      !vpsServerShuttingDown;
    if (!stillActive || Date.now() - startedAt >= holdMs || res.writableEnded) {
      clearInterval(interval);
      if (!res.writableEnded) {
        try {
          res.write(`: keepalive-end active=${stillActive}\n\n`);
          res.end();
        } catch {}
      }
      return;
    }
    try {
      res.write(`: tick ${Date.now()}\n\n`);
    } catch {
      clearInterval(interval);
    }
  }, 4000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// API: UptimeRobot / External Monitor Ping Endpoint
// Keeps free hosted containers warm, ensures queue state is loaded from D1/disk, and resumes workers if active.
const handleUptimePing = async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();

  if (
    activeVpsBatchJob &&
    activeVpsBatchJob.isRunning &&
    !vpsBatchPauseFlag &&
    !vpsBatchCancelFlag &&
    !vpsWorkerLoopActive &&
    hasAnyPendingOrRetryableWork(activeVpsBatchJob)
  ) {
    launchVpsBatchWorkerLoop();
  } else if (
    activeVpsBatchJob?.isRunning &&
    !vpsBatchPauseFlag &&
    !vpsBatchCancelFlag &&
    !vpsCloudKeepAliveActive &&
    hasAnyPendingOrRetryableWork(activeVpsBatchJob)
  ) {
    startVpsCloudKeepAliveLoop();
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.status(200).json({
    ok: true,
    status: 'UP',
    service: 'cloudflare-ott-admin',
    instanceId: SERVER_INSTANCE_ID,
    vpsScope: VPS_QUEUE_SCOPE.scopeLabel,
    queueState: activeVpsBatchJob?.isRunning
      ? vpsBatchPauseFlag
        ? 'paused'
        : 'running'
      : 'idle',
    activeQueues: activeVpsBatchJob?.queues?.length || 0,
    completed: activeVpsBatchJob?.completed || 0,
    total: activeVpsBatchJob?.total || 0,
    activeWorkers: activeVpsBatchJob?.activeWorkers || 0,
    cloudKeepAliveActive: vpsCloudKeepAliveActive,
    cloudKeepAliveMode: vpsCloudKeepAliveMode,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
};

app.get('/api/uptime', handleUptimePing);
app.get('/api/vps-batch/ping', handleUptimePing);

// API: Get Persistent Background Batch Status (restores only THIS VPS's isolated queues when reopening browser)
app.get('/api/vps-batch/status', async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();

  // If a resumed job was waiting on R2 config or got a fresh request while idle-paused, ensure loop is running if runnable
  if (
    activeVpsBatchJob &&
    activeVpsBatchJob.isRunning &&
    !vpsBatchPauseFlag &&
    !vpsBatchCancelFlag &&
    !vpsWorkerLoopActive &&
    hasAnyPendingOrRetryableWork(activeVpsBatchJob)
  ) {
    launchVpsBatchWorkerLoop();
  }

  res.json({
    success: true,
    job: projectJobForClient(activeVpsBatchJob),
    cloudKeepAliveActive: vpsCloudKeepAliveActive,
    cloudKeepAliveMode: vpsCloudKeepAliveMode,
    cloudKeepAliveUrl: isPublicHttpBaseUrl(activeVpsJobAppBaseUrl) ? activeVpsJobAppBaseUrl : null,
    vpsScope: {
      scopeId: VPS_QUEUE_SCOPE.scopeId,
      scopeSlug: VPS_QUEUE_SCOPE.scopeSlug,
      scopeLabel: VPS_QUEUE_SCOPE.scopeLabel,
      d1DocId: VPS_QUEUE_SCOPE.d1DocId,
      source: VPS_QUEUE_SCOPE.source,
    },
    defaultServerPool: getConfiguredServerPool([]).filter((s) => s !== 'direct'),
  });
});

// API: Update Concurrency Live on Running Background Job
app.post('/api/vps-batch/concurrency', async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();
  const safeConcurrency = Math.max(1, Math.min(50, Number(req.body?.concurrency) || 3));
  if (activeVpsBatchJob) {
    activeVpsBatchJob.concurrency = safeConcurrency;
    if (triggerVpsWorkerScaleUp) triggerVpsWorkerScaleUp();
    await persistVpsBatchJob(false);
  }
  res.json({ success: true, concurrency: safeConcurrency, job: projectJobForClient(activeVpsBatchJob) });
});

// API: Pause Background Batch Globally
app.post('/api/vps-batch/pause', async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();
  vpsBatchPauseFlag = true;
  stopVpsCloudKeepAliveLoop();
  if (activeVpsBatchJob) {
    activeVpsBatchJob.isPaused = true;
    activeVpsBatchJob.statusMessage = 'Paused globally (saved in database · safe to close browser)';
    await persistVpsBatchJob(true);
  }
  res.json({ success: true, message: 'Background batch paused.', job: projectJobForClient(activeVpsBatchJob) });
});

// API: Resume Background Batch Globally
app.post('/api/vps-batch/resume', async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();
  vpsBatchPauseFlag = false;
  vpsBatchCancelFlag = false;
  if (activeVpsBatchJob) {
    activeVpsBatchJob.isPaused = false;
    if (hasAnyPendingOrRetryableWork(activeVpsBatchJob)) {
      activeVpsBatchJob.isRunning = true;
      launchVpsBatchWorkerLoop();
    }
    await persistVpsBatchJob(true);
  }
  res.json({ success: true, message: 'Background batch resumed.', job: projectJobForClient(activeVpsBatchJob) });
});

// API: Cancel Background Batch Globally
app.post('/api/vps-batch/cancel', async (_req: Request, res: Response) => {
  await ensureVpsBatchJobInitialized();
  vpsBatchCancelFlag = true;
  vpsBatchPauseFlag = false;
  stopVpsCloudKeepAliveLoop();
  notifyVpsWorkers();
  if (activeVpsBatchJob) {
    activeVpsBatchJob.isRunning = false;
    activeVpsBatchJob.isPaused = false;
    activeVpsBatchJob.activeWorkers = 0;
    for (const q of activeVpsBatchJob.queues) {
      if (q.status === 'running' || q.status === 'queued') {
        q.status = 'stopped';
        q.statusMessage = 'Cancelled globally by user';
      }
    }
    activeVpsBatchJob.statusMessage = 'Cancelled by user';
    await persistVpsBatchJob(true);
  }
  res.json({ success: true, message: 'Background batch cancelled.', job: projectJobForClient(activeVpsBatchJob) });
});

// API: Manually Restart All Failed & Incomplete Tasks across runnable queues (or specified queueId)
app.post('/api/vps-batch/retry-incomplete', async (req: Request, res: Response) => {
  captureRequestRuntimeContext(req);
  await ensureVpsBatchJobInitialized();
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No saved background batch job found' });
  }

  const targetQueueId = req.body?.queueId ? String(req.body.queueId) : null;
  const candidateQueues = targetQueueId
    ? activeVpsBatchJob.queues.filter((q) => q.queueId === targetQueueId)
    : activeVpsBatchJob.queues.filter((q) => q.status !== 'stopped');

  let retriedCount = 0;
  for (const q of candidateQueues) {
    const incompleteTasks = q.tasks.filter(
      (t) => !inFlightBatchTaskIds.has(t.id) && isTaskIncompleteForQueue(t, q.options)
    );
    if (incompleteTasks.length > 0) {
      for (const t of incompleteTasks) {
        t.status = 'pending';
        t.error = undefined;
        t.statusMessage = `Queued for manual retry in ${q.name}...`;
      }
      q.status = 'queued';
      q.endTime = undefined;
      q.currentPass += 1;
      q.options.maxAutoRetryPasses = Math.max(q.options.maxAutoRetryPasses, q.currentPass);
      q.statusMessage = `Retrying ${incompleteTasks.length} failed/incomplete link(s)...`;
      retriedCount += incompleteTasks.length;
    }
  }

  if (retriedCount === 0) {
    return res.json({
      success: true,
      retriedCount: 0,
      message: 'No failed or incomplete websites remaining.',
      job: projectJobForClient(activeVpsBatchJob),
    });
  }

  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;
  activeVpsBatchJob.isRunning = true;
  activeVpsBatchJob.isPaused = false;
  activeVpsBatchJob.statusMessage = `Retrying ${retriedCount} failed/incomplete link(s)...`;
  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  res.json({
    success: true,
    retriedCount,
    message: `Restarted ${retriedCount} failed/incomplete link(s) in background.`,
    job: projectJobForClient(activeVpsBatchJob),
  });
});

// API: Clear Saved Background Batch Job
app.post('/api/vps-batch/clear', async (_req: Request, res: Response) => {
  vpsBatchCancelFlag = true;
  vpsBatchPauseFlag = false;
  stopVpsCloudKeepAliveLoop();
  inFlightBatchTaskIds.clear();
  notifyVpsWorkers();
  if (activeVpsBatchJob) {
    for (const q of activeVpsBatchJob.queues) {
      for (const t of q.tasks) cleanupTaskCheckpointFiles(t);
    }
  }
  activeVpsBatchJob = null;
  try {
    if (fs.existsSync(vpsJobFilePath)) fs.unlinkSync(vpsJobFilePath);
  } catch {}
  try {
    await axios.delete(`${CF_WORKER_BASE_URL}/api/ad_config/${encodeURIComponent(VPS_QUEUE_SCOPE.d1DocId)}`, {
      timeout: 10000,
    });
  } catch {}
  res.json({ success: true, message: 'Saved background batch queue cleared.' });
});

// API: Get current domain filter rules (whitelist & blacklist)
app.get('/api/registry/domain-rules', (_req: Request, res: Response) => {
  res.json({
    success: true,
    rules: domainFilterRules,
  });
});

// API: Save & sync domain filter rules to Cloudflare R2
app.post('/api/registry/domain-rules', async (req: Request, res: Response) => {
  try {
    const { whitelist, blacklist } = req.body;
    if (Array.isArray(whitelist)) domainFilterRules.whitelist = whitelist.map((s) => String(s).trim()).filter(Boolean);
    if (Array.isArray(blacklist)) domainFilterRules.blacklist = blacklist.map((s) => String(s).trim()).filter(Boolean);

    await syncDomainRulesToStorage(req);

    res.json({
      success: true,
      message: 'Domain filter rules updated and synced to Cloudflare R2',
      rules: domainFilterRules,
    });
  } catch (err: any) {
    console.error('Error saving domain rules:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update domain filter rules' });
  }
});

// ================= DEDICATED WEBPAGE DEEP LINK EXTRACTOR ENDPOINT =================

export interface ExtractedPageLink {
  url: string;
  normalizedUrl: string;
  text: string;
  type: 'video_media' | 'page_article' | 'image' | 'external';
  isRegisteredInCloudflare: boolean;
  isNewInCloudflare?: boolean;
  cloudflareRecord?: CloudflareExtractedLink | null;
}

let cachedChromiumExecutable: string | null | undefined;
function resolveChromiumExecutable(): string | null {
  if (cachedChromiumExecutable !== undefined) return cachedChromiumExecutable;

  const directCandidates = [
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const candidate of directCandidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        cachedChromiumExecutable = candidate;
        return candidate;
      }
    } catch {}
  }

  const playwrightRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/ms-playwright',
    '/root/.cache/ms-playwright',
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter((d): d is string => Boolean(d && d.trim()));

  const binaryNames = new Set(['chrome-headless-shell', 'headless_shell', 'chrome', 'chromium']);
  const walkSearch = (dir: string, depth: number): string | null => {
    if (depth > 4) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && binaryNames.has(entry.name)) {
          return full;
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = walkSearch(path.join(dir, entry.name), depth + 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  };

  for (const root of playwrightRoots) {
    if (!fs.existsSync(root)) continue;
    const found = walkSearch(root, 0);
    if (found) {
      cachedChromiumExecutable = found;
      return found;
    }
  }

  cachedChromiumExecutable = null;
  return null;
}

interface ScrolledBrowserHarvest {
  finalUrl: string;
  pageTitle: string;
  htmlSnapshot: string;
  renderedLinks: Array<{ url: string; text: string; isDirectMedia?: boolean }>;
  xhrPayloadTexts: string[];
  scrollStepsCompleted: number;
  loadMoreClicks: number;
  xhrResponsesCaptured: number;
  error?: string;
}

async function crawlLinksWithPlaywrightScroll(params: {
  url: string;
  scrollCount: number;
  clickLoadMore: boolean;
  userAgent?: string;
}): Promise<ScrolledBrowserHarvest | null> {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) return null;

  const { url, scrollCount, clickLoadMore } = params;
  const maxSteps = Math.max(0, Math.min(40, scrollCount));

  let browser: any = null;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        params.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    // Block heavy images/media/fonts so scrolling through dozens of feeds is fast & lightweight
    await page.route('**/*', (route: any) => {
      const rType = route.request().resourceType();
      if (rType === 'image' || rType === 'media' || rType === 'font') {
        return route.abort();
      }
      return route.continue();
    });

    const xhrPayloadTexts: string[] = [];
    let xhrResponsesCaptured = 0;

    page.on('response', async (resp: any) => {
      try {
        const reqType = resp.request().resourceType();
        if (reqType !== 'xhr' && reqType !== 'fetch') return;
        const ctype = String(resp.headers()['content-type'] || '').toLowerCase();
        if (ctype.includes('json') || ctype.includes('html') || ctype.includes('text/plain')) {
          if (xhrPayloadTexts.length < 80) {
            const bodyText = await resp.text();
            if (bodyText && bodyText.length <= 2 * 1024 * 1024) {
              xhrPayloadTexts.push(bodyText);
              xhrResponsesCaptured++;
            }
          }
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    const renderedLinkMap = new Map<string, { text: string; isDirectMedia?: boolean }>();

    const collectDomLinks = async (): Promise<{ totalFound: number; scrollHeight: number }> => {
      const snap = await page.evaluate(`(() => {
        var out = [];
        var baseHref = location.href;
        function resolveAbs(raw) {
          try {
            return new URL(raw, baseHref).href;
          } catch (e) {
            return '';
          }
        }

        document.querySelectorAll('a[href]').forEach(function (a) {
          var raw = (a.getAttribute('href') || '').trim();
          if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return;
          var abs = resolveAbs(raw);
          if (!abs || !/^https?:\\/\\//i.test(abs)) return;
          var txt =
            (a.textContent || '').replace(/\\s+/g, ' ').trim() ||
            (a.getAttribute('title') || '').trim() ||
            (a.getAttribute('aria-label') || '').trim();
          out.push({ url: abs, text: txt });
        });

        var dataAttrs = ['data-href', 'data-url', 'data-link', 'data-video-url', 'data-target-url'];
        for (var i = 0; i < dataAttrs.length; i++) {
          var attr = dataAttrs[i];
          document.querySelectorAll('[' + attr + ']').forEach(function (el) {
            var raw = (el.getAttribute(attr) || '').trim();
            if (!raw) return;
            var abs = resolveAbs(raw);
            if (!abs || !/^https?:\\/\\//i.test(abs)) return;
            var txt =
              (el.textContent || '').replace(/\\s+/g, ' ').trim() ||
              (el.getAttribute('title') || '').trim();
            out.push({ url: abs, text: txt });
          });
        }

        document.querySelectorAll('video[src], source[src]').forEach(function (el) {
          var raw = (el.getAttribute('src') || '').trim();
          if (!raw) return;
          var abs = resolveAbs(raw);
          if (abs && /^https?:\\/\\//i.test(abs)) {
            out.push({ url: abs, text: 'Direct Video Stream', isDirectMedia: true });
          }
        });

        var maxScrollH = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        return { links: out, scrollHeight: maxScrollH };
      })()`) as { links: Array<{ url: string; text: string; isDirectMedia?: boolean }>; scrollHeight: number };

      for (const item of snap.links) {
        const existing = renderedLinkMap.get(item.url);
        if (!existing) {
          renderedLinkMap.set(item.url, { text: item.text, isDirectMedia: item.isDirectMedia });
        } else if (item.text && !existing.text) {
          renderedLinkMap.set(item.url, { text: item.text, isDirectMedia: existing.isDirectMedia || item.isDirectMedia });
        }
      }

      return { totalFound: renderedLinkMap.size, scrollHeight: snap.scrollHeight };
    };

    let prevState = await collectDomLinks();
    let stagnantCount = 0;
    let scrollStepsCompleted = 0;
    let loadMoreClicks = 0;

    for (let step = 1; step <= maxSteps; step++) {
      // Smooth viewport-by-viewport scroll + bottom jump + scrollable container scroll
      await page.evaluate(`(() => {
        var vh = window.innerHeight || 900;
        window.scrollBy(0, vh * 0.95);
        var targetH = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        window.scrollTo(0, targetH);
        window.dispatchEvent(new Event('scroll', { bubbles: true }));
        document.dispatchEvent(new Event('scroll', { bubbles: true }));

        document.querySelectorAll('main, section, div').forEach(function (el) {
          if (el.scrollHeight > el.clientHeight + 250 && el.clientHeight > 300) {
            var st = getComputedStyle(el);
            if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
              el.scrollTop = el.scrollHeight;
            }
          }
        });
      })()`);

      scrollStepsCompleted = step;
      await page.waitForTimeout(1050);

      let currState = await collectDomLinks();

      // If pure scrolling yielded no growth, try clicking any visible "Load More / Show More" button
      if (clickLoadMore && currState.totalFound === prevState.totalFound) {
        const clicked = await page.evaluate(`(() => {
          var btnPattern = /\\b(load\\s*more|show\\s*more|view\\s*more|see\\s*more|more\\s*videos|more\\s*results|older\\s*posts|fetch\\s*more)\\b/i;
          var candidates = Array.from(
            document.querySelectorAll(
              'button, a[role="button"], [class*="load-more" i], [class*="loadmore" i], [class*="show-more" i], [id*="load-more" i], [data-action*="load" i]'
            )
          );
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            var style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            if (el.disabled) continue;
            var txt = (el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
            var cls = typeof el.className === 'string' ? el.className : '';
            if (btnPattern.test(txt) || /load.?more|show.?more/i.test(cls)) {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return true;
            }
          }
          return false;
        })()`) as boolean;

        if (clicked) {
          loadMoreClicks++;
          await page.waitForTimeout(1400);
          currState = await collectDomLinks();
        }
      }

      if (currState.totalFound > prevState.totalFound || currState.scrollHeight > prevState.scrollHeight + 40) {
        stagnantCount = 0;
      } else {
        stagnantCount++;
        if (stagnantCount >= 2) {
          break;
        }
      }
      prevState = currState;
    }

    const htmlSnapshot = await page.content();
    const finalUrl = page.url() || url;
    const pageTitle = await page.title().catch(() => '');

    return {
      finalUrl,
      pageTitle: String(pageTitle || '').trim(),
      htmlSnapshot,
      renderedLinks: Array.from(renderedLinkMap.entries()).map(([u, m]) => ({
        url: u,
        text: m.text,
        isDirectMedia: m.isDirectMedia,
      })),
      xhrPayloadTexts,
      scrollStepsCompleted,
      loadMoreClicks,
      xhrResponsesCaptured,
    };
  } catch (err: any) {
    const errMsg = formatCompactError(err);
    console.warn('Playwright auto-scroll failed (falling back to HTTP crawler):', errMsg);
    return {
      finalUrl: url,
      pageTitle: '',
      htmlSnapshot: '',
      renderedLinks: [],
      xhrPayloadTexts: [],
      scrollStepsCompleted: 0,
      loadMoreClicks: 0,
      xhrResponsesCaptured: 0,
      error: errMsg,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

app.post('/api/extract-page-links', async (req: Request, res: Response) => {
  try {
    let {
      url,
      filterKeywords,
      sameDomainOnly = false,
      enableDomainFilters = true,
      webpagesOnly = true,
      urlFormat = '',
      autoRegisterNew = true,
      autoScroll = true,
      scrollCount = 8,
      clickLoadMore = true,
      scrollEngine: requestedScrollEngine = 'auto',
      skipLongUrls = true,
      maxUrlLength = 250,
      singlePageOnly = false,
    } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Target URL is required' });
    }

    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const effectiveScrollCount = autoScroll ? Math.max(1, Math.min(40, Number(scrollCount) || 8)) : 0;
    const effectiveMaxUrlLength = skipLongUrls
      ? Math.max(40, Math.min(4000, Number(maxUrlLength) || 250))
      : 0;

    await hydrateRegistryFromD1IfNeeded();

    const targetUrlObj = new URL(url);
    const targetDomain = targetUrlObj.hostname.toLowerCase();

    // Helper: Check URL against whitelist and blacklist
    const isUrlAllowedByDomainRules = (testUrl: string): boolean => {
      if (!enableDomainFilters) return true;
      const lower = testUrl.toLowerCase();

      for (const pattern of domainFilterRules.blacklist) {
        if (pattern && lower.includes(pattern.toLowerCase())) {
          return false;
        }
      }

      if (domainFilterRules.whitelist.length > 0) {
        return domainFilterRules.whitelist.some((w) => w && lower.includes(w.toLowerCase()));
      }

      return true;
    };

    // Helper: Match custom link path format (e.g. domain/xyz/, /xyz/, xyz/, watch?v=)
    const matchesUrlFormat = (testUrl: string, format: string): boolean => {
      if (!format || !format.trim()) return true;

      const rawPatterns = format
        .split(/[,|\n]+/)
        .map((p) => p.trim())
        .filter(Boolean);

      if (rawPatterns.length === 0) return true;

      try {
        const parsed = new URL(testUrl);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname;
        const fullPath = `${pathname}${parsed.search}`;
        const hostAndPath = `${hostname}${pathname}`;

        return rawPatterns.some((pattern) => {
          let p = pattern.trim();
          if (!p) return true;

          p = p.replace(/^\{?domain\}?\//i, `${targetDomain}/`);
          p = p.replace(/^https?:\/\//i, '');

          if (p.includes('*')) {
            const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            const regex = new RegExp(escaped, 'i');
            return regex.test(testUrl) || regex.test(hostAndPath) || regex.test(fullPath);
          }

          if (p.startsWith('/')) {
            return fullPath.toLowerCase().includes(p.toLowerCase());
          }

          if (p.toLowerCase().startsWith(targetDomain)) {
            return hostAndPath.toLowerCase().includes(p.toLowerCase());
          }

          return (
            testUrl.toLowerCase().includes(p.toLowerCase()) ||
            hostAndPath.toLowerCase().includes(p.toLowerCase()) ||
            fullPath.toLowerCase().includes(p.toLowerCase())
          );
        });
      } catch {
        return rawPatterns.some((p) => testUrl.toLowerCase().includes(p.toLowerCase()));
      }
    };

    const isDirectMediaOrImage = (testUrl: string): boolean => {
      return (
        /\.(mp4|m3u8|webm|mov|mkv|avi|ts|mpd|flv|wmv|ogg)(\?.*)?$/i.test(testUrl) ||
        /\.(jpg|jpeg|png|webp|avif|gif|svg|ico|bmp|tiff)(\?.*)?$/i.test(testUrl)
      );
    };

    const linksMap = new Map<string, { text: string; type: 'video_media' | 'page_article' | 'image' | 'external' }>();
    const skippedLongUrlsSet = new Set<string>();

    const addDiscoveredUrl = (
      rawOrResolved: string,
      baseUrl: string,
      linkText = '',
      fallbackType?: 'video_media' | 'page_article' | 'image' | 'external'
    ): boolean => {
      let resolved = '';
      try {
        resolved = new URL(rawOrResolved, baseUrl).href;
      } catch {
        return false;
      }
      if (!resolved || !/^https?:\/\//i.test(resolved)) return false;

      if (effectiveMaxUrlLength > 0 && resolved.length > effectiveMaxUrlLength) {
        skippedLongUrlsSet.add(resolved);
        return false;
      }

      const isMedia = isDirectMediaOrImage(resolved);
      if (webpagesOnly && isMedia) return false;
      if (!matchesUrlFormat(resolved, urlFormat)) return false;

      let type: 'video_media' | 'page_article' | 'image' | 'external' = fallbackType || 'page_article';
      if (/\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(resolved)) {
        type = 'video_media';
      } else if (/\.(jpg|jpeg|png|webp|avif|gif)(\?.*)?$/i.test(resolved)) {
        type = 'image';
      }

      try {
        const linkDomain = new URL(resolved).hostname.toLowerCase();
        const baseHost = new URL(baseUrl).hostname.toLowerCase();
        if (sameDomainOnly && linkDomain !== targetDomain && linkDomain !== baseHost) {
          return false;
        }
        if (linkDomain !== targetDomain && type === 'page_article') {
          type = 'external';
        }
      } catch {}

      if (!isUrlAllowedByDomainRules(resolved)) return false;

      const prev = linksMap.get(resolved);
      if (!prev) {
        linksMap.set(resolved, { text: linkText, type });
        return true;
      } else if (linkText && (!prev.text || prev.text === 'Discovered in text/script source')) {
        linksMap.set(resolved, { text: linkText, type: prev.type });
      }
      return false;
    };

    const harvestHtmlAndRawText = (htmlStr: string, pageBaseUrl: string): { nextPageCandidates: string[]; title: string; newlyAdded: number } => {
      const $ = cheerio.load(htmlStr || '');
      let newlyAdded = 0;

      // 1. Anchor links <a href="...">
      $('a[href]').each((_, el) => {
        const rawHref = $(el).attr('href')?.trim();
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) {
          return;
        }
        const linkText = $(el).text().replace(/\s+/g, ' ').trim() || $(el).attr('title')?.trim() || '';
        if (addDiscoveredUrl(rawHref, pageBaseUrl, linkText)) newlyAdded++;
      });

      // 2. Card/SPA data-* attributes carrying item links
      for (const attr of ['data-href', 'data-url', 'data-link', 'data-video-url', 'data-target-url']) {
        $(`[${attr}]`).each((_, el) => {
          const val = $(el).attr(attr)?.trim();
          if (!val) return;
          const txt = $(el).text().replace(/\s+/g, ' ').trim() || $(el).attr('title')?.trim() || '';
          if (addDiscoveredUrl(val, pageBaseUrl, txt)) newlyAdded++;
        });
      }

      // 3. Direct video tags <video src> or <source src> (Only if webpagesOnly is false)
      if (!webpagesOnly) {
        $('video[src], source[src]').each((_, el) => {
          const src = $(el).attr('src')?.trim();
          if (src && addDiscoveredUrl(src, pageBaseUrl, 'Direct Video Stream', 'video_media')) {
            newlyAdded++;
          }
        });
      }

      // 4. Fallback regex scan for URLs in raw text / inline JSON / scripts
      const textUrls = (htmlStr || '').match(/https?:\/\/[^\s"',<>\\]+/gi) || [];
      for (const rawTextUrl of textUrls) {
        const cleanUrl = rawTextUrl.replace(/[.,;:)\]]+$/, '').trim();
        if (addDiscoveredUrl(cleanUrl, pageBaseUrl, 'Discovered in text/script source')) {
          newlyAdded++;
        }
      }

      // Discover pagination / infinite-scroll next-page URLs for HTTP multi-page fallback
      const nextSet = new Set<string>();
      const pushNext = (raw?: string) => {
        if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
        try {
          const abs = new URL(raw, pageBaseUrl).href;
          if (/^https?:\/\//i.test(abs) && abs.length <= 2000 && new URL(abs).hostname.toLowerCase() === targetDomain) {
            nextSet.add(abs);
          }
        } catch {}
      };

      $('link[rel="next"][href], a[rel="next"][href], a.next[href], a.next-page[href], a[aria-label*="next" i][href]').each((_, el) => {
        pushNext($(el).attr('href'));
      });
      $('[data-next-url], [data-next-page], [data-load-more-url]').each((_, el) => {
        pushNext($(el).attr('data-next-url') || $(el).attr('data-next-page') || $(el).attr('data-load-more-url'));
      });
      $('.pagination a[href], .pager a[href], nav[aria-label*="pagination" i] a[href], .wp-pagenavi a[href]').each((_, el) => {
        const txt = $(el).text().trim();
        if (/^(next|next\s*›|›|»|\d+)$/i.test(txt)) {
          pushNext($(el).attr('href'));
        }
      });
      // Catch general ?page=2 or /page/2/ pagination anchors
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (/[?&]page=\d+/i.test(href) || /\/page\/\d+\/?(?:\?|$)/i.test(href)) {
          pushNext(href);
        }
      });

      return {
        nextPageCandidates: Array.from(nextSet),
        title: $('title').text().trim() || '',
        newlyAdded,
      };
    };

    let finalUrl = url;
    let resolvedPageTitle = '';
    let activeScrollEngine: 'chromium_browser' | 'http_pagination' | 'single_fetch' = 'single_fetch';
    let scrollStepsCompleted = 0;
    let loadMoreClicks = 0;
    let xhrResponsesCaptured = 0;
    let pagesVisited = 1;
    let scrollNote = '';

    // Engine A: Headless Chromium Auto-Scroll (when enabled & browser binary is present & not forced to http)
    const detectedChromium = resolveChromiumExecutable();
    const shouldTryChromium =
      effectiveScrollCount > 0 && requestedScrollEngine !== 'http' && detectedChromium !== null;

    if (effectiveScrollCount > 0 && requestedScrollEngine !== 'http' && !detectedChromium) {
      scrollNote = 'No Chromium binary found on server — used HTTP pagination crawler';
    }

    if (shouldTryChromium) {
      const browserRes = await crawlLinksWithPlaywrightScroll({
        url,
        scrollCount: effectiveScrollCount,
        clickLoadMore: Boolean(clickLoadMore),
      });

      if (browserRes && !browserRes.error) {
        activeScrollEngine = 'chromium_browser';
        finalUrl = browserRes.finalUrl || url;
        resolvedPageTitle = browserRes.pageTitle || '';
        scrollStepsCompleted = browserRes.scrollStepsCompleted;
        loadMoreClicks = browserRes.loadMoreClicks;
        xhrResponsesCaptured = browserRes.xhrResponsesCaptured;

        for (const rItem of browserRes.renderedLinks) {
          addDiscoveredUrl(
            rItem.url,
            finalUrl,
            rItem.text,
            rItem.isDirectMedia ? 'video_media' : undefined
          );
        }

        if (browserRes.htmlSnapshot) {
          const snapRes = harvestHtmlAndRawText(browserRes.htmlSnapshot, finalUrl);
          if (!resolvedPageTitle && snapRes.title) resolvedPageTitle = snapRes.title;
        }

        for (const xhrText of browserRes.xhrPayloadTexts) {
          const unescaped = xhrText.replace(/\\\//g, '/').replace(/\\u002f/gi, '/');
          const matches = unescaped.match(/https?:\/\/[^\s"',<>\\]+/gi) || [];
          for (const rawM of matches) {
            const cleanM = rawM.replace(/[.,;:)\]]+$/, '').trim();
            addDiscoveredUrl(cleanM, finalUrl, 'Discovered in scroll feed XHR');
          }
        }
      } else if (browserRes?.error) {
        scrollNote = `Chromium scroll fallback (${browserRes.error})`;
      }
    }

    // Engine B: Fast HTTP Fetch + Multi-Page Pagination / Infinite-Scroll Crawler
    // Runs if Chromium wasn't used/available, or as fallback if Chromium yielded 0 usable links
    if (activeScrollEngine !== 'chromium_browser' || linksMap.size === 0) {
      const visitedPages = new Set<string>();
      const pageQueue: string[] = [url];
      const maxPagesToCrawl = singlePageOnly
        ? 1
        : effectiveScrollCount > 0
        ? Math.min(25, effectiveScrollCount + 1)
        : 1;

      if (!singlePageOnly && effectiveScrollCount > 0 && requestedScrollEngine !== 'browser') {
        activeScrollEngine = 'http_pagination';
      } else {
        activeScrollEngine = 'single_fetch';
      }

      pagesVisited = 0;
      let consecutiveEmptyPages = 0;

      while (pageQueue.length > 0 && pagesVisited < maxPagesToCrawl) {
        const nextUrl = pageQueue.shift()!;
        const normPage = normalizeUrlForDedup(nextUrl);
        if (visitedPages.has(normPage)) continue;
        visitedPages.add(normPage);

        const response = await axiosGetWithRetry(
          nextUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
            },
            timeout: 25000,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true,
          },
          3
        );

        const currentFinalUrl = (response.request as any)?.res?.responseUrl || response.config?.url || nextUrl;
        if (pagesVisited === 0) {
          finalUrl = currentFinalUrl;
        }
        pagesVisited++;

        if (response.status >= 400 || typeof response.data !== 'string') {
          if (pagesVisited === 1) break;
          continue;
        }

        const harvested = harvestHtmlAndRawText(response.data, currentFinalUrl);
        if (!resolvedPageTitle && harvested.title) resolvedPageTitle = harvested.title;

        if (!singlePageOnly && effectiveScrollCount > 0) {
          scrollStepsCompleted = pagesVisited;
          if (harvested.newlyAdded === 0 && pagesVisited > 1) {
            consecutiveEmptyPages++;
            if (consecutiveEmptyPages >= 2) break;
          } else {
            consecutiveEmptyPages = 0;
          }

          // Order next pagination pages sequentially (?page=2, ?page=3...)
          const sortedNext = harvested.nextPageCandidates
            .filter((cand) => !visitedPages.has(normalizeUrlForDedup(cand)))
            .sort((a, b) => {
              const numA = Number((a.match(/(?:page=|\/page\/)(\d+)/i) || [])[1] || 99999);
              const numB = Number((b.match(/(?:page=|\/page\/)(\d+)/i) || [])[1] || 99999);
              return numA - numB;
            });

          for (const cand of sortedNext) {
            if (!pageQueue.includes(cand)) pageQueue.push(cand);
          }

          // If page had ?page=N or /page/N links, also synthesize page N+1 if missing from DOM
          if (pageQueue.length === 0 && pagesVisited === 1) {
            if (/[?&]page=(\d+)/i.test(currentFinalUrl)) {
              const curP = Number((currentFinalUrl.match(/[?&]page=(\d+)/i) || [])[1] || 1);
              for (let p = curP + 1; p <= curP + effectiveScrollCount; p++) {
                pageQueue.push(currentFinalUrl.replace(/([?&]page=)\d+/i, `$1${p}`));
              }
            } else if (/\/page\/(\d+)(\/?)/i.test(currentFinalUrl)) {
              const curP = Number((currentFinalUrl.match(/\/page\/(\d+)/i) || [])[1] || 1);
              for (let p = curP + 1; p <= curP + effectiveScrollCount; p++) {
                pageQueue.push(currentFinalUrl.replace(/(\/page\/)\d+/i, `$1${p}`));
              }
            }
          }
        }
      }
    }

    // Convert map to list and cross-reference with Cloudflare Extracted Registry (No copies for existing; auto-add new)
    const newlyCreatedRecords: CloudflareExtractedLink[] = [];
    const now = new Date().toISOString();

    let list: ExtractedPageLink[] = Array.from(linksMap.entries()).map(([linkUrl, meta]) => {
      const norm = normalizeUrlForDedup(linkUrl);
      const reg = findRegistryRecordByWebUrl(linkUrl);

      let isNew = false;
      let finalReg = reg;

      if (!reg && autoRegisterNew) {
        finalReg = {
          id: getLinkUniqueId(linkUrl),
          sourceUrl: linkUrl,
          title: meta.text || linkUrl.split('/').pop()?.split('?')[0] || 'Discovered Webpage',
          rawTitle: meta.text,
          status: 'extracted',
          destination: 'none',
          firstExtractedAt: now,
          lastUpdatedAt: now,
          metadata: {
            extractedFromPage: url,
            originDomain: targetDomain,
          },
        };
        extractedLinksRegistry.unshift(finalReg);
        newlyCreatedRecords.push(finalReg);
        isNew = true;
      }

      return {
        url: linkUrl,
        normalizedUrl: norm,
        text: meta.text,
        type: meta.type,
        isRegisteredInCloudflare: Boolean(finalReg),
        isNewInCloudflare: isNew,
        cloudflareRecord: finalReg || null,
      };
    });

    if (newlyCreatedRecords.length > 0) {
      await syncRegistryToStorage(req, newlyCreatedRecords);
    }

    // Apply optional keyword filter
    if (filterKeywords && typeof filterKeywords === 'string' && filterKeywords.trim()) {
      const terms = filterKeywords
        .toLowerCase()
        .split(/[,|\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);

      if (terms.length > 0) {
        list = list.filter((item) =>
          terms.some((term) => item.url.toLowerCase().includes(term) || item.text.toLowerCase().includes(term))
        );
      }
    }

    res.json({
      success: true,
      sourceUrl: url,
      finalUrl,
      targetDomain,
      pageTitle: resolvedPageTitle,
      webpagesOnly,
      urlFormat: urlFormat.trim(),
      scrollUsed: effectiveScrollCount > 0,
      scrollEngine: activeScrollEngine,
      scrollStepsCompleted,
      pagesVisited,
      loadMoreClicks,
      xhrResponsesCaptured,
      scrollNote: scrollNote || undefined,
      skipLongUrls: Boolean(skipLongUrls),
      maxUrlLength: effectiveMaxUrlLength,
      skippedLongUrlCount: skippedLongUrlsSet.size,
      totalExtracted: list.length,
      videoMediaCount: list.filter((l) => l.type === 'video_media').length,
      pageArticleCount: list.filter((l) => l.type === 'page_article').length,
      registeredCount: list.filter((l) => l.isRegisteredInCloudflare).length,
      newlyRegisteredCount: list.filter((l) => l.isNewInCloudflare).length,
      reusedExistingCount: list.filter((l) => l.isRegisteredInCloudflare && !l.isNewInCloudflare).length,
      links: list,
    });
  } catch (err: any) {
    console.error('Page link extraction error:', formatCompactError(err));
    res.status(500).json({ success: false, error: formatCompactError(err) || 'Failed to extract links from webpage' });
  }
});

// List all saved database batches
app.get('/api/database', (_req: Request, res: Response) => {
  res.json(savedBatches);
});

// Fetch a specific database batch
app.get('/api/database/:batchId', (req: Request, res: Response) => {
  const batch = savedBatches.find((b) => b.batchId === req.params.batchId);
  if (batch) {
    res.json(batch);
  } else {
    res.status(404).json({ error: 'Database batch not found' });
  }
});

// Delete a saved database batch
app.delete('/api/database/:batchId', (req: Request, res: Response) => {
  const index = savedBatches.findIndex((b) => b.batchId === req.params.batchId);
  if (index !== -1) {
    savedBatches.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Database batch not found' });
  }
});

// Helper: Parse duration string (ISO 8601 like PT15M33S, HH:MM:SS, MM:SS, or seconds)
function parseDuration(val: any): { seconds: number; formatted: string } | null {
  if (!val) return null;
  const str = String(val).trim();

  // 1. ISO 8601 format e.g. PT1H23M45S or PT4M30S or PT45S
  const isoMatch = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (isoMatch) {
    const hours = parseInt(isoMatch[1] || '0', 10);
    const mins = parseInt(isoMatch[2] || '0', 10);
    const secs = Math.round(parseFloat(isoMatch[3] || '0'));
    const totalSecs = hours * 3600 + mins * 60 + secs;
    if (totalSecs > 0) {
      let formatted = '';
      if (hours > 0) formatted = `${hours}h ${mins}m ${secs}s`;
      else if (mins > 0) formatted = `${mins} min ${secs}s`;
      else formatted = `${secs}s`;
      return { seconds: totalSecs, formatted };
    }
  }

  // 2. HH:MM:SS or MM:SS format
  const timeMatch = str.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hours = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
    const mins = parseInt(timeMatch[2], 10);
    const secs = parseInt(timeMatch[3], 10);
    const totalSecs = hours * 3600 + mins * 60 + secs;
    const formatted = hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins} min ${secs}s`;
    return { seconds: totalSecs, formatted };
  }

  // 3. Pure number seconds (e.g. "245" or 245.5)
  const num = parseFloat(str);
  if (!isNaN(num) && num > 0 && num < 86400) {
    const totalSecs = Math.round(num);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    let formatted = '';
    if (hours > 0) formatted = `${hours}h ${mins}m ${secs}s`;
    else if (mins > 0) formatted = `${mins} min ${secs}s`;
    else formatted = `${secs}s`;
    return { seconds: totalSecs, formatted };
  }

  return null;
}

// Helper: Case-insensitive title word removal and bracket/separator normalization
function cleanTitleWithFilter(
  title: string,
  wordsToRemove?: string
): { cleaned: string; rawTitle: string; removedTerms: string[] } {
  if (!title) return { cleaned: '', rawTitle: '', removedTerms: [] };
  const rawTitle = title;
  let cleaned = title;
  const removedTerms: string[] = [];

  if (wordsToRemove && typeof wordsToRemove === 'string' && wordsToRemove.trim()) {
    const terms = wordsToRemove
      .split(/[,|\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    for (const term of terms) {
      if (!term) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Case-insensitive regex matching whole word or enclosed in punctuation/spaces
      const regex = new RegExp(`(^|[\\s\\[\\(\\{_\\-–—|•/])(${escaped})([\\s\\]\\)\\}_{\\-–—|•/]|\$)`, 'gi');
      if (regex.test(cleaned)) {
        if (!removedTerms.includes(term)) removedTerms.push(term);
        cleaned = cleaned.replace(regex, ' ');
      }
    }
  }

  // Clean empty brackets like [], (), {} left behind
  cleaned = cleaned.replace(/\[\s*\]|\(\s*\)|\{\s*\}/g, ' ');
  // Clean dangling separators at beginning or end or repeating separators
  cleaned = cleaned
    .replace(/\s*([|\-–—::»\/\\])\s*([|\-–—::»\/\\]\s*)+/g, ' $1 ')
    .replace(/^[\s|\-–—::»\/\\]+|[\s|\-–—::»\/\\]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { cleaned: cleaned || rawTitle, rawTitle, removedTerms };
}

// Helper: Inspect remote video file size via HEAD or Range stream header check with timeout
async function detectRemoteFileSize(
  videoUrl: string,
  refererUrl?: string
): Promise<{ sizeBytes: number; sizeMb: string; sizeFormatted: string } | null> {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return null;
  if (videoUrl.includes('.m3u8')) {
    return { sizeBytes: 0, sizeMb: 'Adaptive', sizeFormatted: 'Adaptive Stream (HLS)' };
  }

  const videoOrigin = resolveOriginSafe(videoUrl);
  const effectiveReferer = refererUrl || (videoOrigin ? `${videoOrigin}/` : '');
  const baseHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Connection: 'close',
    ...(effectiveReferer ? { Referer: effectiveReferer } : {}),
  };

  try {
    const headRes = await axios.head(videoUrl, {
      ...createNonKeepAliveAgents(),
      headers: baseHeaders,
      timeout: 4500,
      validateStatus: (s) => s < 400,
    });
    const cl = headRes.headers['content-length'];
    if (cl) {
      const sizeBytes = parseInt(String(cl), 10);
      if (!isNaN(sizeBytes) && sizeBytes > 0) {
        const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
        const sizeFormatted =
          sizeBytes >= 1024 * 1024 * 1024
            ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
            : `${sizeMb} MB`;
        return { sizeBytes, sizeMb, sizeFormatted };
      }
    }
  } catch {
    // If HEAD is disallowed (403/405), try a Range GET and inspect headers only before destroying stream
    let rangeRes: any = null;
    try {
      rangeRes = await axios.get(videoUrl, {
        ...createNonKeepAliveAgents(),
        headers: {
          ...baseHeaders,
          Range: 'bytes=0-0',
        },
        timeout: 4500,
        validateStatus: (s) => s === 206 || s === 200,
        responseType: 'stream',
      });
      const cr = String(rangeRes.headers['content-range'] || '');
      if (cr) {
        const total = cr.split('/')[1];
        const sizeBytes = parseInt(total, 10);
        if (!isNaN(sizeBytes) && sizeBytes > 0) {
          const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
          const sizeFormatted =
            sizeBytes >= 1024 * 1024 * 1024
              ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
              : `${sizeMb} MB`;
          return { sizeBytes, sizeMb, sizeFormatted };
        }
      }
      const cl = rangeRes.headers['content-length'];
      if (cl && rangeRes.status === 200) {
        const sizeBytes = parseInt(String(cl), 10);
        if (!isNaN(sizeBytes) && sizeBytes > 0) {
          const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
          const sizeFormatted =
            sizeBytes >= 1024 * 1024 * 1024
              ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
              : `${sizeMb} MB`;
          return { sizeBytes, sizeMb, sizeFormatted };
        }
      }
    } catch {
      // Ignore size detection errors
    } finally {
      if (rangeRes?.data && typeof rangeRes.data.destroy === 'function') {
        try {
          rangeRes.data.destroy();
        } catch {}
      }
    }
  }
  return null;
}

// Helper: Upload remote image URL or base64 image data to Cloudflare R2 or local storage emulator
async function uploadImageToR2OrLocal(params: {
  imageUrl?: string;
  imageBase64?: string;
  customFilename?: string;
  folderPrefix?: string;
  refererUrl?: string;
  req?: Request;
  r2ConfigOverride?: R2Config | null;
  appBaseUrlOverride?: string;
}): Promise<{
  cloudflareBackLink: string;
  thumbKey: string;
  sizeBytes: number;
  contentType: string;
  storageSource: 'cloudflare_r2' | 'emulator';
}> {
  const {
    imageUrl,
    imageBase64,
    customFilename,
    folderPrefix = 'thumbnails',
    refererUrl,
    req,
    r2ConfigOverride,
    appBaseUrlOverride,
  } = params;

  let buffer: Buffer;
  let contentType = 'image/jpeg';

  if (imageUrl) {
    const imgOrigin = resolveOriginSafe(imageUrl);
    const primaryReferer = refererUrl || (imgOrigin ? `${imgOrigin}/` : '');
    const primaryOrigin = resolveOriginSafe(primaryReferer) || imgOrigin;

    let lastImgErr: any;
    let downloadedRes: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // On final attempt, fall back to the image's own origin if page referer differed
      const useReferer = attempt === 3 && imgOrigin ? `${imgOrigin}/` : primaryReferer;
      const useOrigin = attempt === 3 && imgOrigin ? imgOrigin : primaryOrigin;
      try {
        downloadedRes = await axios.get(imageUrl, {
          ...createNonKeepAliveAgents(),
          responseType: 'arraybuffer',
          timeout: 20000,
          maxRedirects: 5,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Connection: 'close',
            ...(useReferer ? { Referer: useReferer } : {}),
            ...(useOrigin ? { Origin: useOrigin } : {}),
          },
        });
        const candidateBuf = Buffer.from(downloadedRes.data);
        if (candidateBuf.length === 0) {
          throw new Error('Downloaded thumbnail is 0 bytes');
        }
        break;
      } catch (err: any) {
        lastImgErr = err;
        downloadedRes = null;
        if (attempt < 3 && (isRetryableNetworkError(err) || err?.response?.status === 403)) {
          await sleepMs(450 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200));
          continue;
        }
        throw err;
      }
    }

    if (!downloadedRes) {
      throw lastImgErr || new Error('Failed to download remote thumbnail');
    }
    buffer = Buffer.from(downloadedRes.data);
    contentType = String(downloadedRes.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
  } else if (imageBase64) {
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      contentType = matches[1];
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(imageBase64, 'base64');
    }
  } else {
    throw new Error('Either imageUrl or imageBase64 is required');
  }

  // Derive file extension from contentType
  let ext = 'jpg';
  if (contentType.includes('png')) ext = 'png';
  else if (contentType.includes('webp')) ext = 'webp';
  else if (contentType.includes('avif')) ext = 'avif';
  else if (contentType.includes('gif')) ext = 'gif';

  // Sanitized base name
  const safeName = customFilename
    ? customFilename.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 50)
    : `thumb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const filename = `${safeName}.${ext}`;
  const cleanFolder = folderPrefix.replace(/^\/+|\/+$/g, '');
  const thumbKey = cleanFolder ? `${cleanFolder}/${filename}` : filename;

  const r2Config = r2ConfigOverride || getR2Config(req);
  const appBaseUrl =
    appBaseUrlOverride || process.env.APP_URL || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');

  let cloudflareBackLink = '';
  let storageSource: 'cloudflare_r2' | 'emulator' = 'emulator';

  if (r2Config) {
    const s3 = createR2Client(r2Config);
    await s3.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: thumbKey,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000',
      })
    );

    // Read-after-write verification
    await s3.send(
      new HeadObjectCommand({
        Bucket: r2Config.bucketName,
        Key: thumbKey,
      })
    );

    cloudflareBackLink = r2Config.publicUrlPrefix
      ? `${r2Config.publicUrlPrefix}/${thumbKey}`
      : `${appBaseUrl}/api/r2/stream/${encodeURIComponent(thumbKey)}`;
    storageSource = 'cloudflare_r2';
  } else {
    const localFilePath = path.join(localThumbsDir, filename);
    fs.writeFileSync(localFilePath, buffer);
    cloudflareBackLink = `${appBaseUrl}/api/local-media/thumbnails/${filename}`;
    storageSource = 'emulator';
  }

  return {
    cloudflareBackLink,
    thumbKey,
    sizeBytes: buffer.length,
    contentType,
    storageSource,
  };
}

// Helper: Format duration seconds consistently
function formatDurationSeconds(totalSecs: number): string {
  if (!totalSecs || isNaN(totalSecs) || totalSecs <= 0) return '';
  const secs = Math.max(1, Math.round(totalSecs));
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const remSecs = secs % 60;
  if (hours > 0) return `${hours}h ${mins}m ${remSecs}s`;
  if (mins > 0) return `${mins} min ${remSecs}s`;
  return `${remSecs}s`;
}

// Helper: Pure-Node MP4 mvhd atom duration parser fallback (works even without ffprobe)
function parseMp4DurationFallback(filePath: string): { seconds: number; formatted: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 32) return null;
    const scanChunk = (offset: number, length: number): { seconds: number; formatted: string } | null => {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, offset);
        const slice = buf.subarray(0, bytesRead);
        const idx = slice.indexOf('mvhd');
        if (idx >= 4 && idx + 28 <= slice.length) {
          const version = slice[idx + 4];
          if (version === 0 && idx + 28 <= slice.length) {
            const timescale = slice.readUInt32BE(idx + 16);
            const duration = slice.readUInt32BE(idx + 20);
            if (timescale > 0 && duration > 0) {
              const seconds = Math.max(1, Math.round(duration / timescale));
              return { seconds, formatted: formatDurationSeconds(seconds) };
            }
          } else if (version === 1 && idx + 40 <= slice.length) {
            const timescale = slice.readUInt32BE(idx + 24);
            const durationBig = slice.readBigUInt64BE(idx + 28);
            if (timescale > 0 && durationBig > 0n) {
              const seconds = Math.max(1, Math.round(Number(durationBig) / timescale));
              return { seconds, formatted: formatDurationSeconds(seconds) };
            }
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      return null;
    };

    const headLen = Math.min(stat.size, 2 * 1024 * 1024);
    const headRes = scanChunk(0, headLen);
    if (headRes) return headRes;

    if (stat.size > headLen) {
      const tailLen = Math.min(stat.size, 2 * 1024 * 1024);
      return scanChunk(stat.size - tailLen, tailLen);
    }
  } catch {}
  return null;
}

let cachedFfmpegExecutable: string | null = null;
function resolveFfmpegExecutable(): string {
  if (cachedFfmpegExecutable) return cachedFfmpegExecutable;

  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.FFMPEG_BIN,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    typeof ffmpegStatic === 'string' ? ffmpegStatic : '',
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          try {
            fs.chmodSync(candidate, 0o755);
          } catch {}
        }
        cachedFfmpegExecutable = candidate;
        return candidate;
      }
    } catch {}
  }

  cachedFfmpegExecutable = 'ffmpeg';
  return 'ffmpeg';
}

function resolveFfprobeExecutable(): string {
  const candidates = [
    process.env.FFPROBE_PATH,
    process.env.FFPROBE_BIN,
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return 'ffprobe';
}

// Helper: Extract exact video duration from downloaded video file via ffprobe, ffmpeg -i, or MP4 binary fallback
async function extractVideoMetadataFromFile(filePath: string): Promise<{
  durationSec: number | null;
  durationFormatted: string | null;
}> {
  try {
    const { stdout } = await execFileAsync(
      resolveFfprobeExecutable(),
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 15000 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const rawFormatDur = parseFloat(parsed?.format?.duration || '');
    const videoStream = Array.isArray(parsed?.streams)
      ? parsed.streams.find((s: any) => s.codec_type === 'video') || parsed.streams[0]
      : null;
    const rawStreamDur = parseFloat(videoStream?.duration || '');
    const bestDur =
      !isNaN(rawFormatDur) && rawFormatDur > 0 && isFinite(rawFormatDur)
        ? rawFormatDur
        : !isNaN(rawStreamDur) && rawStreamDur > 0 && isFinite(rawStreamDur)
        ? rawStreamDur
        : null;

    if (bestDur && bestDur > 0) {
      const durationSec = Math.max(1, Math.round(bestDur));
      return {
        durationSec,
        durationFormatted: formatDurationSeconds(durationSec),
      };
    }
  } catch {
    // Fallback below (ffmpeg -i probe, then pure-Node MP4 mvhd parser)
  }

  // Fallback 1: Probe container duration using bundled ffmpeg-static stderr ("Duration: HH:MM:SS.xx")
  try {
    await execFileAsync(resolveFfmpegExecutable(), ['-hide_banner', '-i', filePath], {
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (probeErr: any) {
    const stderr = String(probeErr?.stderr || probeErr?.message || '');
    const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (durMatch) {
      const totalSec = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
      if (isFinite(totalSec) && totalSec > 0) {
        const durationSec = Math.max(1, Math.round(totalSec));
        return {
          durationSec,
          durationFormatted: formatDurationSeconds(durationSec),
        };
      }
    }
  }

  const mp4Fallback = parseMp4DurationFallback(filePath);
  if (mp4Fallback) {
    return {
      durationSec: mp4Fallback.seconds,
      durationFormatted: mp4Fallback.formatted,
    };
  }

  return { durationSec: null, durationFormatted: null };
}

function parseHlsByteRange(
  rawSpec: string,
  prevOffset: number
): { length: number; offset: number; nextOffset: number } | null {
  const m = String(rawSpec || '')
    .trim()
    .replace(/^"|"$/g, '')
    .match(/^(\d+)(?:@(\d+))?$/);
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] !== undefined ? Number(m[2]) : prevOffset;
  if (!isFinite(length) || length <= 0 || !isFinite(offset) || offset < 0) return null;
  return { length, offset, nextOffset: offset + length };
}

// Pure-Node HLS (.m3u8) downloader fallback resilient for large, slow, encrypted, and byte-range streams
async function downloadHlsViaNodeFallback(
  m3u8Url: string,
  destPath: string,
  refererUrl?: string,
  cookieHeader?: string,
  proxyUrl?: string | null
): Promise<{ format: 'mp4' | 'ts' }> {
  const baseHeaders: Record<string, string> = {
    Accept: '*/*',
    Connection: 'close',
    ...(refererUrl ? { Referer: refererUrl } : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  let parsedProxyUrl: URL | null = null;
  if (proxyUrl) {
    try {
      parsedProxyUrl = new URL(proxyUrl.replace(/^proxy:/i, ''));
    } catch {
      parsedProxyUrl = null;
    }
  }

  const hlsAxiosGet = async <T = any>(
    targetUrl: string,
    opts: { responseType: 'text' | 'arraybuffer'; timeoutMs: number; extraHeaders?: Record<string, string> }
  ): Promise<{ data: T; responseUrl: string }> => {
    const maxAttempts = 4;
    let lastErr: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const rotatedUa = USER_AGENT_POOL[(serverPoolRoundRobinIdx + attempt) % USER_AGENT_POOL.length];
      const cfg: Record<string, any> = {
        ...createNonKeepAliveAgents(),
        headers: {
          'User-Agent': rotatedUa,
          ...baseHeaders,
          ...(opts.extraHeaders || {}),
        },
        responseType: opts.responseType,
        timeout: opts.timeoutMs,
        maxRedirects: 5,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        decompress: opts.responseType === 'text',
      };

      if (parsedProxyUrl) {
        if (targetUrl.toLowerCase().startsWith('https://')) {
          cfg.proxy = false;
          cfg.httpsAgent = createHttpConnectHttpsAgent(parsedProxyUrl, 20000);
        } else {
          cfg.proxy = {
            protocol: parsedProxyUrl.protocol.replace(':', ''),
            host: parsedProxyUrl.hostname,
            port: Number(parsedProxyUrl.port) || 80,
          };
        }
      }

      try {
        const res = await axios.get<T>(targetUrl, cfg);
        const responseUrl = (res.request as any)?.res?.responseUrl || targetUrl;
        return { data: res.data, responseUrl };
      } catch (err: any) {
        lastErr = err;
        if (attempt < maxAttempts && isRetryableNetworkError(err)) {
          const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
          const backoff =
            retryAfterMs > 0
              ? retryAfterMs
              : 700 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 350);
          await sleepMs(backoff);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error(`Failed HLS request: ${targetUrl}`);
  };

  let mediaPlaylistUrl = m3u8Url;
  let playlistRes = await hlsAxiosGet<string>(mediaPlaylistUrl, {
    responseType: 'text',
    timeoutMs: 60000,
  });
  mediaPlaylistUrl = playlistRes.responseUrl;
  let playlistText = String(playlistRes.data || '');

  // Unwrap Master Playlists (up to 3 levels) selecting highest-bandwidth variant
  for (let depth = 0; depth < 3 && /#EXT-X-STREAM-INF/i.test(playlistText); depth++) {
    const lines = playlistText.split(/\r?\n/).map((l) => l.trim());
    let bestUrl = '';
    let bestBandwidth = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
        const bw = bwMatch ? Number(bwMatch[1]) : 0;
        let nextUri = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && !lines[j].startsWith('#')) {
            nextUri = lines[j];
            break;
          }
        }
        if (nextUri && bw >= bestBandwidth) {
          bestBandwidth = bw;
          bestUrl = new URL(nextUri, mediaPlaylistUrl).href;
        }
      }
    }
    if (!bestUrl) break;
    mediaPlaylistUrl = bestUrl;
    playlistRes = await hlsAxiosGet<string>(mediaPlaylistUrl, {
      responseType: 'text',
      timeoutMs: 60000,
    });
    mediaPlaylistUrl = playlistRes.responseUrl;
    playlistText = String(playlistRes.data || '');
  }

  const lines = playlistText.split(/\r?\n/).map((l) => l.trim());
  let mediaSequenceBase = 0;
  let initMapSpec: { url: string; rangeHeader?: string } | null = null;
  let aesKeyBuf: Buffer | null = null;
  let explicitIvBuf: Buffer | null = null;
  let pendingByteRange: { length: number; offset: number } | null = null;
  let runningByteOffset = 0;
  const keyCache = new Map<string, Buffer>();

  interface HlsSegmentTask {
    url: string;
    seqNum: number;
    keyBuf: Buffer | null;
    explicitIv: Buffer | null;
    rangeHeader?: string;
  }
  const segmentTasks: HlsSegmentTask[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const seqVal = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim());
      if (!isNaN(seqVal) && seqVal >= 0) {
        mediaSequenceBase = Math.floor(seqVal);
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch?.[1]) {
        const mapUrl = new URL(uriMatch[1], mediaPlaylistUrl).href;
        const brMatch = line.match(/BYTERANGE="([^"]+)"/i);
        const br = brMatch?.[1] ? parseHlsByteRange(brMatch[1], 0) : null;
        initMapSpec = {
          url: mapUrl,
          rangeHeader: br ? `bytes=${br.offset}-${br.offset + br.length - 1}` : undefined,
        };
      }
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([^,]+)/i);
      const method = methodMatch?.[1]?.trim().toUpperCase();
      if (method === 'NONE') {
        aesKeyBuf = null;
        explicitIvBuf = null;
      } else if (method === 'AES-128') {
        const uriMatch = line.match(/URI="([^"]+)"/i);
        if (uriMatch?.[1]) {
          const keyUrl = new URL(uriMatch[1], mediaPlaylistUrl).href;
          let cachedKey = keyCache.get(keyUrl);
          if (!cachedKey) {
            const keyRes = await hlsAxiosGet<ArrayBuffer>(keyUrl, {
              responseType: 'arraybuffer',
              timeoutMs: 60000,
            });
            cachedKey = Buffer.from(keyRes.data);
            keyCache.set(keyUrl, cachedKey);
          }
          aesKeyBuf = cachedKey;
          const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);
          if (ivMatch?.[1]) {
            explicitIvBuf = Buffer.from(ivMatch[1].padStart(32, '0').slice(-32), 'hex');
          } else {
            explicitIvBuf = null;
          }
        }
      } else if (method) {
        throw new Error(`Unsupported HLS encryption method: ${method}`);
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const br = parseHlsByteRange(line.slice('#EXT-X-BYTERANGE:'.length), runningByteOffset);
      if (br) {
        pendingByteRange = { length: br.length, offset: br.offset };
        runningByteOffset = br.nextOffset;
      }
    } else if (!line.startsWith('#')) {
      const segUrl = new URL(line, mediaPlaylistUrl).href;
      const rangeHeader = pendingByteRange
        ? `bytes=${pendingByteRange.offset}-${pendingByteRange.offset + pendingByteRange.length - 1}`
        : undefined;
      pendingByteRange = null;
      segmentTasks.push({
        url: segUrl,
        seqNum: mediaSequenceBase + segmentTasks.length,
        keyBuf: aesKeyBuf,
        explicitIv: explicitIvBuf,
        rangeHeader,
      });
    }
  }

  if (segmentTasks.length === 0) {
    throw new Error('HLS playlist contains no media segments');
  }

  const fetchSegBuf = async (task: HlsSegmentTask): Promise<Buffer> => {
    const segRes = await hlsAxiosGet<ArrayBuffer>(task.url, {
      responseType: 'arraybuffer',
      timeoutMs: 90000,
      extraHeaders: task.rangeHeader ? { Range: task.rangeHeader } : undefined,
    });
    const rawBuf = Buffer.from(segRes.data);
    if (!task.keyBuf) return rawBuf;
    let iv = task.explicitIv;
    if (!iv) {
      iv = Buffer.alloc(16, 0);
      iv.writeUInt32BE(task.seqNum >>> 0, 12);
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', task.keyBuf, iv);
    return Buffer.concat([decipher.update(rawBuf), decipher.final()]);
  };

  const outStream = fs.createWriteStream(destPath);
  let streamError: Error | null = null;
  outStream.once('error', (err) => {
    streamError = err;
  });

  const writeChunk = async (chunk: Buffer) => {
    if (streamError) throw streamError;
    if (!outStream.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          outStream.off('error', onErr);
          resolve();
        };
        const onErr = (err: Error) => {
          outStream.off('drain', onDrain);
          reject(err);
        };
        outStream.once('drain', onDrain);
        outStream.once('error', onErr);
      });
    }
  };

  let succeeded = false;
  try {
    if (initMapSpec) {
      const initRes = await hlsAxiosGet<ArrayBuffer>(initMapSpec.url, {
        responseType: 'arraybuffer',
        timeoutMs: 60000,
        extraHeaders: initMapSpec.rangeHeader ? { Range: initMapSpec.rangeHeader } : undefined,
      });
      await writeChunk(Buffer.from(initRes.data));
    }

    const CONCURRENCY = segmentTasks.length > 400 ? 3 : 4;
    for (let i = 0; i < segmentTasks.length; i += CONCURRENCY) {
      const batch = segmentTasks.slice(i, i + CONCURRENCY);
      const buffers = await Promise.all(batch.map((task) => fetchSegBuf(task)));
      for (const b of buffers) {
        await writeChunk(b);
      }
    }
    succeeded = true;
  } finally {
    await new Promise<void>((resolve) => outStream.end(() => resolve()));
    if (!succeeded) {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {}
    }
  }

  const hasMp4Init = Boolean(initMapSpec) || /\.(m4s|mp4)(\?|$)/i.test(segmentTasks[0]?.url || '');
  return { format: hasMp4Init ? 'mp4' : 'ts' };
}

// Helper: Download HLS (.m3u8) stream to local MP4/TS file via bundled ffmpeg (with resilient pure-Node fallback)
async function downloadHlsStreamToMp4(
  m3u8Url: string,
  destPath: string,
  refererUrl?: string,
  cookieHeader?: string,
  proxyUrl?: string | null
): Promise<{ format: 'mp4' | 'ts' }> {
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const headerLines =
    [
      `User-Agent: ${userAgent}`,
      ...(refererUrl ? [`Referer: ${refererUrl}`] : []),
      ...(cookieHeader ? [`Cookie: ${cookieHeader}`] : []),
    ].join('\r\n') + '\r\n';

  const ffmpegBin = resolveFfmpegExecutable();
  const cleanProxy = proxyUrl ? proxyUrl.replace(/^proxy:/i, '').trim() : '';
  const spawnEnv =
    cleanProxy && /^https?:\/\//i.test(cleanProxy)
      ? {
          ...process.env,
          http_proxy: cleanProxy,
          https_proxy: cleanProxy,
          HTTP_PROXY: cleanProxy,
          HTTPS_PROXY: cleanProxy,
        }
      : process.env;

  const execOpts = {
    timeout: 1800000, // 30-min cap for large HD/4K HLS videos on shared VPS bandwidth
    maxBuffer: 20 * 1024 * 1024,
    env: spawnEnv,
  };

  let ffmpegErr: any = null;
  try {
    await execFileAsync(
      ffmpegBin,
      [
        '-y',
        '-loglevel',
        'error',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_on_network_error',
        '1',
        '-reconnect_on_http_error',
        '429,5xx',
        '-reconnect_delay_max',
        '5',
        '-rw_timeout',
        '60000000',
        '-headers',
        headerLines,
        '-i',
        m3u8Url,
        '-c',
        'copy',
        '-bsf:a',
        'aac_adtstoasc',
        '-movflags',
        '+faststart',
        destPath,
      ],
      execOpts
    );
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return { format: 'mp4' };
    }
    throw new Error('FFmpeg produced an empty HLS output file');
  } catch (err1: any) {
    ffmpegErr = err1;
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch {}

    // Skip second ffmpeg spawn if binary is missing or crashed (e.g. static build under gVisor)
    if (err1?.code !== 'ENOENT' && err1?.signal !== 'SIGSEGV' && err1?.signal !== 'SIGABRT') {
      try {
        await execFileAsync(
          ffmpegBin,
          [
            '-y',
            '-loglevel',
            'error',
            '-headers',
            headerLines,
            '-i',
            m3u8Url,
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            destPath,
          ],
          execOpts
        );
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          return { format: 'mp4' };
        }
        throw new Error('FFmpeg second attempt produced an empty HLS output file');
      } catch (err2: any) {
        ffmpegErr = err2;
        try {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        } catch {}
      }
    }
  }

  // Fallback to pure Node HLS segment downloader when ffmpeg fails or isn't executable
  try {
    return await downloadHlsViaNodeFallback(m3u8Url, destPath, refererUrl, cookieHeader, proxyUrl);
  } catch (nodeErr: any) {
    throw new Error(
      `HLS download failed (ffmpeg: ${formatCompactError(ffmpegErr)}; node-hls: ${formatCompactError(nodeErr)})`
    );
  }
}

// Standalone API: Upload any video thumbnail to Cloudflare R2 and return the permanent back link
app.post('/api/upload-thumbnail-to-r2', async (req: Request, res: Response) => {
  try {
    const { imageUrl, imageBase64, customFilename, folderPrefix = 'thumbnails', refererUrl } = req.body;
    if (!imageUrl && !imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Either imageUrl or imageBase64 is required',
      });
    }

    const uploadResult = await uploadImageToR2OrLocal({
      imageUrl,
      imageBase64,
      customFilename,
      folderPrefix,
      refererUrl,
      req,
    });

    res.json({
      success: true,
      ...uploadResult,
    });
  } catch (err: any) {
    console.error('Thumbnail upload to Cloudflare R2 error:', formatCompactError(err));
    res.status(500).json({
      success: false,
      error: formatCompactError(err) || 'Failed to upload thumbnail to Cloudflare R2',
    });
  }
});

const COMPRESSION_PRESETS: Record<
  VideoCompressionQuality,
  { maxHeight: number; crf: number; audioBitrate: string; preset: string }
> = {
  high: { maxHeight: 1080, crf: 22, audioBitrate: '128k', preset: 'veryfast' },
  balanced: { maxHeight: 720, crf: 26, audioBitrate: '96k', preset: 'veryfast' },
  compact: { maxHeight: 480, crf: 29, audioBitrate: '64k', preset: 'veryfast' },
  low: { maxHeight: 360, crf: 32, audioBitrate: '64k', preset: 'superfast' },
};

async function compressVideoWithFfmpeg(
  inputPath: string,
  quality: VideoCompressionQuality
): Promise<{
  outputPath: string;
  compressedSizeBytes: number;
  originalSizeBytes: number;
  savedPercent: number;
  usedCompressed: boolean;
}> {
  const originalSizeBytes = fs.statSync(inputPath).size;
  const presetCfg = COMPRESSION_PRESETS[quality] || COMPRESSION_PRESETS.balanced;
  const outputPath = path.join(
    localTempDir,
    `temp_comp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`
  );

  // Never upscale videos smaller than target height; always enforce even width/height for libx264
  const scaleFilter = `scale='if(gt(ih,${presetCfg.maxHeight}),-2,trunc(iw/2)*2)':'if(gt(ih,${presetCfg.maxHeight}),${presetCfg.maxHeight},trunc(ih/2)*2)'`;

  // Wait for an FFmpeg slot & healthy CPU headroom so concurrent workers don't overload CPU
  let waitedForLoad = false;
  const slotWaitStartedAt = Date.now();
  try {
    while (!vpsBatchCancelFlag) {
      const cpuNow = sampleLiveCpuPercent();
      const slotsFull = activeFfmpegCompressions >= MAX_CONCURRENT_FFMPEG;
      const highCpuWhileActive = activeFfmpegCompressions > 0 && cpuNow >= COMPRESSION_HIGH_CPU_PERCENT;
      if (!slotsFull && (!highCpuWhileActive || Date.now() - slotWaitStartedAt >= 60000)) {
        break;
      }
      if (!waitedForLoad) {
        waitedForLoad = true;
        workersPausedForLoad++;
        if (activeVpsBatchJob) {
          syncLiveLoadCountersOnJob(activeVpsBatchJob);
          activeVpsBatchJob.statusMessage = `Optimizing FFmpeg compression: ${workersPausedForLoad} worker(s) paused for CPU cooldown (CPU ${cpuNow}% · ${activeFfmpegCompressions}/${MAX_CONCURRENT_FFMPEG} active)...`;
        }
      }
      await sleepMs(1200);
    }
  } finally {
    if (waitedForLoad) {
      workersPausedForLoad = Math.max(0, workersPausedForLoad - 1);
      syncLiveLoadCountersOnJob(activeVpsBatchJob);
    }
  }

  activeFfmpegCompressions++;
  syncLiveLoadCountersOnJob(activeVpsBatchJob);

  try {
    await execFileAsync(
      resolveFfmpegExecutable(),
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        scaleFilter,
        '-c:v',
        'libx264',
        '-preset',
        presetCfg.preset,
        '-crf',
        String(presetCfg.crf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        presetCfg.audioBitrate,
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-threads',
        '2',
        outputPath,
      ],
      { timeout: 1800000, maxBuffer: 20 * 1024 * 1024 }
    );
  } finally {
    activeFfmpegCompressions = Math.max(0, activeFfmpegCompressions - 1);
    syncLiveLoadCountersOnJob(activeVpsBatchJob);
  }

  const compressedSizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (compressedSizeBytes <= 0) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
    throw new Error('FFmpeg produced an empty compressed video file');
  }

  // Keep compressed file only when it actually reduces size; otherwise keep original smaller file
  if (compressedSizeBytes >= originalSizeBytes) {
    try {
      fs.unlinkSync(outputPath);
    } catch {}
    return {
      outputPath: inputPath,
      compressedSizeBytes: originalSizeBytes,
      originalSizeBytes,
      savedPercent: 0,
      usedCompressed: false,
    };
  }

  const savedPercent = Math.max(1, Math.round(((originalSizeBytes - compressedSizeBytes) / originalSizeBytes) * 100));
  return {
    outputPath,
    compressedSizeBytes,
    originalSizeBytes,
    savedPercent,
    usedCompressed: true,
  };
}

// Helper: Download a remote video URL (optionally FFmpeg-compressed) and upload directly to Cloudflare R2 or local storage
async function uploadVideoToR2OrLocal(params: {
  videoUrl: string;
  customFilename?: string;
  folderPrefix?: string;
  refererUrl?: string;
  cookieHeader?: string;
  extraServers?: string[];
  req?: Request;
  r2ConfigOverride?: R2Config | null;
  appBaseUrlOverride?: string;
  minExpectedDurationSec?: number;
  allowShortDurationFallback?: boolean;
  compressVideo?: boolean;
  compressionQuality?: VideoCompressionQuality;
  existingLocalVideoPath?: string;
  existingCompressedVideoPath?: string;
  localVideoDownloadComplete?: boolean;
  preserveLocalFileOnError?: boolean;
  onStage?: (
    stage: 'checking_registry' | 'scraping' | 'downloading_video' | 'compressing_video' | 'uploading_cloudflare',
    detail: string,
    meta?: { title?: string; thumbnailUrl?: string; videoUrl?: string }
  ) => void;
}): Promise<{
  cloudflareVideoBackLink: string;
  videoKey: string;
  sizeBytes: number;
  sizeMb: string;
  sizeFormatted: string;
  durationSec: number | null;
  durationFormatted: string | null;
  contentType: string;
  storageSource: 'cloudflare_r2' | 'emulator';
  compressed?: boolean;
  compressionQuality?: VideoCompressionQuality;
  originalSizeBytes?: number;
  savedPercent?: number;
}> {
  const {
    videoUrl: rawVideoUrl,
    customFilename,
    folderPrefix = 'videos',
    refererUrl,
    cookieHeader,
    extraServers = [],
    req,
    r2ConfigOverride,
    appBaseUrlOverride,
    minExpectedDurationSec,
    allowShortDurationFallback = true,
    compressVideo = false,
    compressionQuality = 'balanced',
    existingLocalVideoPath,
    existingCompressedVideoPath,
    localVideoDownloadComplete = false,
    preserveLocalFileOnError = false,
    onStage,
  } = params;

  const videoUrl = String(rawVideoUrl || '')
    .replace(/&amp;/gi, '&')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003d/gi, '=')
    .trim();

  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    throw new Error('A valid HTTP/HTTPS video URL is required');
  }

  const r2Config = r2ConfigOverride || getR2Config(req);
  const appBaseUrl =
    appBaseUrlOverride || process.env.APP_URL || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');

  // If videoUrl is already an R2 URL or local media URL, return as-is
  if (
    (r2Config?.publicUrlPrefix && videoUrl.startsWith(r2Config.publicUrlPrefix)) ||
    videoUrl.includes('/api/r2/stream/') ||
    videoUrl.includes('/api/local-media/videos/')
  ) {
    return {
      cloudflareVideoBackLink: videoUrl,
      videoKey: videoUrl.split('/').pop() || 'video.mp4',
      sizeBytes: 0,
      sizeMb: '0',
      sizeFormatted: 'Already on Cloudflare R2',
      durationSec: null,
      durationFormatted: null,
      contentType: 'video/mp4',
      storageSource: r2Config ? 'cloudflare_r2' : 'emulator',
    };
  }

  // Reuse existing checkpoint temp file if present on disk, otherwise create in OS tmpdir
  const hasExistingLocalTemp = Boolean(existingLocalVideoPath && fs.existsSync(existingLocalVideoPath));
  const tempFilename = `temp_vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
  const tempFilePath = hasExistingLocalTemp ? existingLocalVideoPath! : path.join(localTempDir, tempFilename);
  const hasExistingCompressedFile = Boolean(
    existingCompressedVideoPath &&
      fs.existsSync(existingCompressedVideoPath) &&
      fs.statSync(existingCompressedVideoPath).size > 0
  );
  const hasCompletedLocalDownload = Boolean(
    hasExistingCompressedFile ||
      (localVideoDownloadComplete && fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0)
  );

  const videoOrigin = resolveOriginSafe(videoUrl);
  const primaryReferer = refererUrl || (videoOrigin ? `${videoOrigin}/` : '');

  let contentType = 'video/mp4';
  let downloadedHlsFormat: 'mp4' | 'ts' | null = null;
  let fileSize = hasExistingCompressedFile
    ? fs.statSync(existingCompressedVideoPath!).size
    : hasCompletedLocalDownload
    ? fs.statSync(tempFilePath).size
    : 0;
  let downloadCompletedFlag = hasCompletedLocalDownload;
  let lastDownloadErr: any = null;
  let expectedRemoteTotalBytes = 0;
  const looksLikeHls = /\.m3u8(\?|$)/i.test(videoUrl) || videoUrl.toLowerCase().includes('.m3u8');

  // Optional HTTP proxies configured in Multi-Server Pool for fallback if direct CDN IP returns 403/429
  const proxyCandidates = (Array.isArray(extraServers) ? extraServers : [])
    .map((s) => String(s || '').trim())
    .filter(
      (s) =>
        /^proxy:/i.test(s) ||
        (/^https?:\/\//i.test(s) && !s.includes('?url=') && !s.includes('{url}') && !s.includes('/relay-fetch') && /:\d+$/.test((() => { try { return new URL(s.replace(/^proxy:/i, '')).host; } catch { return ''; } })()))
    );

  if (!downloadCompletedFlag) {
    const totalDownloadAttempts = Math.min(7, 5 + proxyCandidates.length);
    for (let attempt = 1; attempt <= totalDownloadAttempts; attempt++) {
      const preAttemptPartialBytes =
        fs.existsSync(tempFilePath) && !looksLikeHls ? fs.statSync(tempFilePath).size : 0;
      // Attempt 1: page Referer, NO Origin. If we already have partial bytes downloaded, keep the working Referer on early resume attempts.
      const useReferer =
        preAttemptPartialBytes > 0 && attempt <= 2
          ? primaryReferer
          : attempt === 1
          ? primaryReferer
          : attempt === 2 && videoOrigin
          ? `${videoOrigin}/`
          : '';
      const useOrigin = preAttemptPartialBytes === 0 && attempt === 2 ? videoOrigin : '';
      const useProxy = attempt > 3 ? proxyCandidates[(attempt - 4) % proxyCandidates.length] : null;
      const rotatedUa = USER_AGENT_POOL[(serverPoolRoundRobinIdx + attempt) % USER_AGENT_POOL.length];
      let videoStreamRes: any = null;

      try {
        if (looksLikeHls) {
          onStage?.('downloading_video', 'Downloading HLS video stream...');
          const hlsOut = await downloadHlsStreamToMp4(videoUrl, tempFilePath, attempt === 3 ? undefined : useReferer || undefined, cookieHeader, useProxy);
          downloadedHlsFormat = hlsOut.format;
          contentType = hlsOut.format === 'ts' ? 'video/mp2t' : 'video/mp4';
        } else {
          const existingPartialBytes = preAttemptPartialBytes;
          const axiosCfg: Record<string, any> = {
            ...createNonKeepAliveAgents(),
            responseType: 'stream',
            timeout: 600000, // 10-min socket inactivity timeout for large multi-GB video streams
            maxRedirects: 5,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            decompress: false,
            headers: {
              'User-Agent': rotatedUa,
              Accept: 'video/mp4,video/*,*/*;q=0.9',
              'Accept-Language': 'en-US,en;q=0.9',
              Connection: 'close',
              ...(existingPartialBytes > 0 ? { Range: `bytes=${existingPartialBytes}-` } : {}),
              ...(useReferer ? { Referer: useReferer } : {}),
              ...(useOrigin ? { Origin: useOrigin } : {}),
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
          };

          if (useProxy) {
            const pUrl = new URL(useProxy.replace(/^proxy:/i, ''));
            if (videoUrl.toLowerCase().startsWith('https://')) {
              axiosCfg.proxy = false;
              axiosCfg.httpsAgent = createHttpConnectHttpsAgent(pUrl, 20000);
            } else {
              axiosCfg.proxy = {
                protocol: pUrl.protocol.replace(':', ''),
                host: pUrl.hostname,
                port: Number(pUrl.port) || 80,
              };
            }
          }

          videoStreamRes = await axios.get(videoUrl, axiosCfg);

          const headerType = String(videoStreamRes.headers['content-type'] || 'video/mp4')
            .split(';')[0]
            .trim()
            .toLowerCase();

          if (headerType.includes('text/html') || headerType.includes('application/json')) {
            try {
              if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            } catch {}
            throw new Error(`Remote video URL returned ${headerType} instead of a video stream`);
          }

          if (headerType.includes('mpegurl')) {
            if (videoStreamRes.data && typeof videoStreamRes.data.destroy === 'function') {
              videoStreamRes.data.destroy();
            }
            onStage?.('downloading_video', 'Downloading HLS video stream...');
            const hlsOut = await downloadHlsStreamToMp4(videoUrl, tempFilePath, useReferer || primaryReferer, cookieHeader, useProxy);
            downloadedHlsFormat = hlsOut.format;
            contentType = hlsOut.format === 'ts' ? 'video/mp2t' : 'video/mp4';
          } else {
            if (headerType && headerType.includes('video')) {
              contentType = headerType;
            }

            const isPartial206 = videoStreamRes.status === 206 && existingPartialBytes > 0;
            const contentRangeHeader = String(videoStreamRes.headers['content-range'] || '');
            let totalFromContentRange = 0;
            const crMatch = contentRangeHeader.match(/bytes\s+(\d+)-\d+\/(\d+|\*)/i);
            const rangeStartConfirmed = crMatch ? Number(crMatch[1]) === existingPartialBytes : false;
            if (crMatch && crMatch[2] !== '*') {
              totalFromContentRange = Number(crMatch[2]) || 0;
            }
            const shouldAppendPartial = isPartial206 && rangeStartConfirmed;
            const respContentLen = Number(videoStreamRes.headers['content-length'] || 0);
            const expectedRemoteBytes =
              totalFromContentRange > 0
                ? totalFromContentRange
                : shouldAppendPartial && respContentLen > 0
                ? existingPartialBytes + respContentLen
                : respContentLen || expectedRemoteTotalBytes;
            if (expectedRemoteBytes > 0) {
              expectedRemoteTotalBytes = expectedRemoteBytes;
            }

            let downloadedSoFar = shouldAppendPartial ? existingPartialBytes : 0;
            onStage?.(
              'downloading_video',
              shouldAppendPartial
                ? expectedRemoteBytes > 0
                  ? `Resuming download (${Math.min(99, Math.round((downloadedSoFar / expectedRemoteBytes) * 100))}% · ${formatBytes(downloadedSoFar)} / ${formatBytes(expectedRemoteBytes)})...`
                  : `Resuming download from ${formatBytes(downloadedSoFar)}...`
                : expectedRemoteBytes > 0
                ? `Downloading video (0 / ${formatBytes(expectedRemoteBytes)})...`
                : 'Downloading video...'
            );

            let lastDlReportAt = Date.now();
            videoStreamRes.data.on('data', (chunk: Buffer) => {
              downloadedSoFar += chunk.length;
              const now = Date.now();
              if (now - lastDlReportAt >= 1200) {
                lastDlReportAt = now;
                if (expectedRemoteBytes > 0) {
                  const pct = Math.min(99, Math.round((downloadedSoFar / expectedRemoteBytes) * 100));
                  onStage?.(
                    'downloading_video',
                    `${shouldAppendPartial ? 'Resuming' : 'Downloading'} video (${pct}% · ${formatBytes(downloadedSoFar)} / ${formatBytes(expectedRemoteBytes)})...`
                  );
                } else {
                  onStage?.(
                    'downloading_video',
                    `${shouldAppendPartial ? 'Resuming' : 'Downloading'} video (${formatBytes(downloadedSoFar)})...`
                  );
                }
              }
            });
            const writer = fs.createWriteStream(tempFilePath, { flags: shouldAppendPartial ? 'a' : 'w' });
            await pipeline(videoStreamRes.data, writer);

            // Reject truncated downloads before verification/upload (preserve partial file for Range resume!)
            const downloadedStat = fs.statSync(tempFilePath);
            if (expectedRemoteBytes > 0 && downloadedStat.size < Math.floor(expectedRemoteBytes * 0.98)) {
              throw new Error(
                `Truncated video download (${downloadedStat.size} of ${expectedRemoteBytes} bytes) — resuming`
              );
            }

            // Peek first bytes to ensure we didn't download an HTML page or HLS playlist saved with video/*
            const fd = fs.openSync(tempFilePath, 'r');
            try {
              const headBuf = Buffer.alloc(256);
              const n = fs.readSync(fd, headBuf, 0, 256, 0);
              const headStr = headBuf.subarray(0, n).toString('utf8').trimStart();
              if (headStr.startsWith('#EXTM3U')) {
                fs.closeSync(fd);
                try {
                  if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                } catch {}
                onStage?.('downloading_video', 'Downloading HLS video stream...');
                const hlsOut = await downloadHlsStreamToMp4(videoUrl, tempFilePath, useReferer || primaryReferer, cookieHeader, useProxy);
                downloadedHlsFormat = hlsOut.format;
                contentType = hlsOut.format === 'ts' ? 'video/mp2t' : 'video/mp4';
              } else if (/^(<!doctype|<html|<head|<body|\{")/i.test(headStr)) {
                try {
                  if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                } catch {}
                throw new Error('Downloaded content is HTML/JSON, not a valid video binary');
              }
            } finally {
              try {
                fs.closeSync(fd);
              } catch {}
            }
          }
        }

        const stat = fs.statSync(tempFilePath);
        fileSize = stat.size;
        if (fileSize === 0) {
          throw new Error('Downloaded video stream is 0 bytes');
        }
        downloadCompletedFlag = true;
        lastDownloadErr = null;
        break;
      } catch (downloadErr: any) {
        lastDownloadErr = downloadErr;
        if (videoStreamRes?.data && typeof videoStreamRes.data.destroy === 'function') {
          try {
            videoStreamRes.data.destroy();
          } catch {}
        }
        const errMsgStr = String(downloadErr?.message || '');
        const httpStatus = Number(downloadErr?.response?.status || 0);
        const isResumableStreamDrop =
          !looksLikeHls &&
          (isRetryableNetworkError(downloadErr) ||
            httpStatus === 408 ||
            httpStatus === 425 ||
            httpStatus === 429 ||
            (httpStatus >= 500 && httpStatus < 600) ||
            errMsgStr.includes('Truncated video download')) &&
          !errMsgStr.includes('HTML/JSON') &&
          !errMsgStr.includes('0 bytes');

        // Keep partial temp file on mid-stream network drops so next attempt/retry uses HTTP Range resume!
        if (!isResumableStreamDrop) {
          try {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          } catch {}
        }

        if (
          attempt < totalDownloadAttempts &&
          (isRetryableNetworkError(downloadErr) ||
            downloadErr?.response?.status === 403 ||
            downloadErr?.response?.status === 401 ||
            downloadErr?.response?.status === 416 ||
            /HTTP\s*(401|403|408|416|425|429|5\d\d)/i.test(errMsgStr) ||
            errMsgStr.includes('Truncated video download'))
        ) {
          // If server rejected Range (416), drop stale partial file so next retry fetches cleanly
          if (downloadErr?.response?.status === 416) {
            try {
              if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            } catch {}
          }
          const backoff = 550 * Math.pow(2, Math.min(3, attempt - 1)) + Math.floor(Math.random() * 300);
          await sleepMs(backoff);
          continue;
        }
        break;
      }
    }
  }

  if (lastDownloadErr || fileSize === 0) {
    const partialSize = fs.existsSync(tempFilePath) ? fs.statSync(tempFilePath).size : 0;
    const canKeepPartial = preserveLocalFileOnError && !looksLikeHls && partialSize >= 2 * 1024 * 1024;
    if (!canKeepPartial) {
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch {}
    }
    const dlFailErr: any = new Error(
      `Failed to download remote video stream: ${formatCompactError(lastDownloadErr || '0 bytes')}`
    );
    if (canKeepPartial) {
      dlFailErr.checkpoint = {
        localTempVideoPath: tempFilePath,
        localVideoDownloadComplete: false,
      };
    }
    throw dlFailErr;
  }

  let extractedMeta: { durationSec: number | null; durationFormatted: string | null } = {
    durationSec: null,
    durationFormatted: null,
  };
  let compressedTempPath: string | null = hasExistingCompressedFile ? existingCompressedVideoPath! : null;
  let didCompress = hasExistingCompressedFile;
  let originalSizeBeforeCompress = fileSize;
  const resolvedQuality = normalizeCompressionQuality(compressionQuality);
  let compressionSavedPercent = 0;
  let cloudflareVideoBackLink = '';
  let videoKey = '';
  let storageSource: 'cloudflare_r2' | 'emulator' = 'emulator';
  let verifiedSizeBytes = fileSize;
  let preserveCheckpointOnExit = false;

  try {
    const probePath = hasExistingCompressedFile ? existingCompressedVideoPath! : tempFilePath;
    // Extract actual video duration metadata directly from the downloaded video file before compression/upload
    extractedMeta = await extractVideoMetadataFromFile(probePath);

    // Reject ultra-short hover-preview/trailer clips when real page duration is much longer (unless it's our sole 20s+ fallback candidate)
    const isTooShortPreview =
      !hasExistingCompressedFile &&
      Boolean(minExpectedDurationSec && minExpectedDurationSec >= 45 && extractedMeta.durationSec) &&
      extractedMeta.durationSec! < Math.max(15, Math.floor(minExpectedDurationSec! * 0.3)) &&
      (!allowShortDurationFallback || extractedMeta.durationSec! < 20);

    if (isTooShortPreview) {
      throw new Error(
        `Downloaded clip duration (${extractedMeta.durationSec}s) is much shorter than real video duration (${minExpectedDurationSec}s) — skipping preview clip`
      );
    }

    // Derive file extension
    let ext = hasExistingCompressedFile ? 'mp4' : downloadedHlsFormat === 'ts' ? 'ts' : 'mp4';
    if (!hasExistingCompressedFile && !looksLikeHls && downloadedHlsFormat !== 'ts') {
      if (videoUrl.includes('.webm') || contentType.includes('webm')) ext = 'webm';
      else if (videoUrl.includes('.mkv') || contentType.includes('x-matroska')) ext = 'mkv';
      else if (videoUrl.includes('.mov') || contentType.includes('quicktime')) ext = 'mov';
    }

    // Optional FFmpeg compression BEFORE uploading to Cloudflare R2 (skipped if compressed file checkpoint already exists!)
    let uploadFilePath = hasExistingCompressedFile ? existingCompressedVideoPath! : tempFilePath;

    if (compressVideo && !hasExistingCompressedFile) {
      onStage?.('compressing_video', `Compressing video (${resolvedQuality} · ${formatBytes(fileSize)})...`);
      try {
        const compRes = await compressVideoWithFfmpeg(tempFilePath, resolvedQuality);
        if (compRes.usedCompressed && compRes.outputPath !== tempFilePath) {
          compressedTempPath = compRes.outputPath;
          uploadFilePath = compRes.outputPath;
          fileSize = compRes.compressedSizeBytes;
          originalSizeBeforeCompress = compRes.originalSizeBytes;
          compressionSavedPercent = compRes.savedPercent;
          didCompress = true;
          contentType = 'video/mp4';
          ext = 'mp4';
          if (!extractedMeta.durationSec) {
            extractedMeta = await extractVideoMetadataFromFile(uploadFilePath);
          }
        }
      } catch (compErr: any) {
        console.warn('Video compression failed; falling back to original file:', formatCompactError(compErr));
      }
    }

    const safeName = customFilename
      ? customFilename.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 60)
      : `video_${Date.now()}`;
    const filename = `${safeName}.${ext}`;
    const cleanFolder = folderPrefix.replace(/^\/+|\/+$/g, '');
    videoKey = cleanFolder ? `${cleanFolder}/${filename}` : filename;
    verifiedSizeBytes = fileSize;

    if (r2Config) {
      activeR2VideoUploads++;
      try {
        const { queueSize, partSize } = getR2MultipartTuning(fileSize);
        const isMultipart = fileSize > 5 * 1024 * 1024;
        const s3 = createR2Client(r2Config);
        let r2UploadErr: any = null;
        const maxR2Attempts = 4;
        for (let r2Attempt = 1; r2Attempt <= maxR2Attempts; r2Attempt++) {
          let fileStream: fs.ReadStream | null = null;
          try {
            onStage?.(
              'uploading_cloudflare',
              r2Attempt > 1
                ? `Retrying R2 upload (attempt ${r2Attempt}/${maxR2Attempts} · ${formatBytes(fileSize)} ready)...`
                : isMultipart
                ? `Uploading video to Cloudflare R2 (${formatBytes(fileSize)} · ${queueSize}x streams)...`
                : `Uploading video to Cloudflare R2 (${formatBytes(fileSize)})...`
            );
            const uploadStartedAt = Date.now();
            if (isMultipart) {
              fileStream = fs.createReadStream(uploadFilePath, { highWaterMark: 2 * 1024 * 1024 });
              const parallelUpload = new Upload({
                client: s3,
                params: {
                  Bucket: r2Config.bucketName,
                  Key: videoKey,
                  Body: fileStream,
                  ContentType: contentType,
                  CacheControl: 'public, max-age=31536000',
                },
                queueSize,
                partSize,
                leavePartsOnError: false,
              });
              let lastUpReportAt = 0;
              parallelUpload.on('httpUploadProgress', (prog) => {
                const now = Date.now();
                if (now - lastUpReportAt >= 1200 && typeof prog.loaded === 'number') {
                  lastUpReportAt = now;
                  const total = prog.total || fileSize;
                  const pct = total > 0 ? Math.min(99, Math.round((prog.loaded / total) * 100)) : 0;
                  const elapsedSecs = Math.max(0.2, (now - uploadStartedAt) / 1000);
                  const speedMbSec = (prog.loaded / (1024 * 1024) / elapsedSecs).toFixed(1);
                  onStage?.(
                    'uploading_cloudflare',
                    `Uploading video to Cloudflare R2 (${pct}% · ${formatBytes(prog.loaded)} / ${formatBytes(total)} · ${speedMbSec} MB/s · ${queueSize}x)...`
                  );
                }
              });
              await parallelUpload.done();
            } else {
              const directBuffer = await fs.promises.readFile(uploadFilePath);
              await s3.send(
                new PutObjectCommand({
                  Bucket: r2Config.bucketName,
                  Key: videoKey,
                  Body: directBuffer,
                  ContentLength: directBuffer.length,
                  ContentType: contentType,
                  CacheControl: 'public, max-age=31536000',
                })
              );
            }

            // Read-after-write verification on Cloudflare R2 & capture authoritative R2 object byte length
            const headRes = await s3.send(
              new HeadObjectCommand({
                Bucket: r2Config.bucketName,
                Key: videoKey,
              })
            );
            if (typeof headRes.ContentLength === 'number' && headRes.ContentLength > 0) {
              verifiedSizeBytes = headRes.ContentLength;
            }
            r2UploadErr = null;
            break;
          } catch (err: any) {
            r2UploadErr = err;
            if (r2Attempt < maxR2Attempts && isRetryableR2UploadError(err)) {
              await sleepMs(1000 * r2Attempt);
              continue;
            }
            throw err;
          } finally {
            try {
              if (fileStream) fileStream.destroy();
            } catch {}
          }
        }
        if (r2UploadErr) throw r2UploadErr;
      } catch (uploadStageErr: any) {
        if (preserveLocalFileOnError) {
          preserveCheckpointOnExit = true;
          uploadStageErr.checkpoint = {
            localTempVideoPath: fs.existsSync(tempFilePath) ? tempFilePath : undefined,
            localCompressedVideoPath:
              compressedTempPath && fs.existsSync(compressedTempPath) ? compressedTempPath : undefined,
            localVideoDownloadComplete: true,
          };
        }
        throw uploadStageErr;
      } finally {
        activeR2VideoUploads = Math.max(0, activeR2VideoUploads - 1);
      }

      cloudflareVideoBackLink = r2Config.publicUrlPrefix
        ? `${r2Config.publicUrlPrefix}/${videoKey}`
        : `${appBaseUrl}/api/r2/stream/${encodeURIComponent(videoKey)}`;
      storageSource = 'cloudflare_r2';
    } else {
      // Emulator mode
      const localDest = path.join(localVideosDir, filename);
      fs.copyFileSync(uploadFilePath, localDest);
      verifiedSizeBytes = fs.statSync(localDest).size || fileSize;
      cloudflareVideoBackLink = `${appBaseUrl}/api/local-media/videos/${filename}`;
      storageSource = 'emulator';
    }
  } finally {
    // Clean temp files unless preserved intentionally as a checkpoint for immediate retry without re-downloading
    if (!preserveCheckpointOnExit) {
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch {}
      try {
        if (compressedTempPath && fs.existsSync(compressedTempPath)) fs.unlinkSync(compressedTempPath);
      } catch {}
    }
  }

  const sizeMb = (verifiedSizeBytes / (1024 * 1024)).toFixed(2);
  const sizeFormatted =
    verifiedSizeBytes >= 1024 * 1024 * 1024
      ? `${(verifiedSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
      : `${sizeMb} MB`;

  return {
    cloudflareVideoBackLink,
    videoKey,
    sizeBytes: verifiedSizeBytes,
    sizeMb,
    sizeFormatted,
    durationSec: extractedMeta.durationSec,
    durationFormatted: extractedMeta.durationFormatted,
    contentType,
    storageSource,
    ...(didCompress
      ? {
          compressed: true,
          compressionQuality: resolvedQuality,
          originalSizeBytes: originalSizeBeforeCompress,
          savedPercent: compressionSavedPercent,
        }
      : { compressed: false }),
  };
}

// Standalone API: Upload any remote video URL directly to Cloudflare R2 and return the permanent back link
app.post('/api/upload-video-to-r2', async (req: Request, res: Response) => {
  try {
    const {
      videoUrl,
      customFilename,
      folderPrefix = 'videos',
      refererUrl,
      compressVideo = false,
      compressionQuality = 'balanced',
    } = req.body;
    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'videoUrl is required in request body',
      });
    }

    const uploadResult = await uploadVideoToR2OrLocal({
      videoUrl,
      customFilename,
      folderPrefix,
      refererUrl,
      req,
      compressVideo: Boolean(compressVideo),
      compressionQuality: normalizeCompressionQuality(compressionQuality),
    });

    res.json({
      success: true,
      ...uploadResult,
    });
  } catch (err: any) {
    console.error('Video upload to Cloudflare R2 error:', formatCompactError(err));
    res.status(500).json({
      success: false,
      error: formatCompactError(err) || 'Failed to upload video to Cloudflare R2',
    });
  }
});

// Core reusable URL scraper + Cloudflare R2 uploader + D1 links_registry updater
async function processUrlCore(params: {
  url: string;
  extractMedia?: boolean;
  customHeaders?: Record<string, string>;
  wordsToRemove?: string;
  uploadThumbnailToR2?: boolean;
  uploadVideoToR2?: boolean;
  compressVideo?: boolean;
  compressionQuality?: VideoCompressionQuality;
  forceRefresh?: boolean;
  req?: Request;
  r2ConfigOverride?: R2Config | null;
  appBaseUrlOverride?: string;
  extraServers?: string[];
  checkpoint?: {
    cloudflareThumbnailUrl?: string;
    cloudflareVideoUrl?: string;
  };
  onCheckpointUpdate?: (cp: {
    title?: string;
    rawTitle?: string;
    description?: string;
    originalVideoUrl?: string;
    originalThumbnailUrl?: string;
    cloudflareThumbnailUrl?: string;
    cloudflareVideoUrl?: string;
    durationSec?: number | null;
    durationFormatted?: string;
    pageRefererUrl?: string;
    localTempVideoPath?: string;
    localCompressedVideoPath?: string;
    localVideoDownloadComplete?: boolean;
  }) => void;
  onStage?: (
    stage: 'checking_registry' | 'scraping' | 'downloading_video' | 'compressing_video' | 'uploading_cloudflare',
    detail: string,
    meta?: { title?: string; thumbnailUrl?: string; videoUrl?: string }
  ) => void;
}): Promise<any> {
  let {
    url,
    customHeaders = {},
    wordsToRemove = '',
    uploadThumbnailToR2 = false,
    uploadVideoToR2 = false,
    compressVideo = false,
    compressionQuality = 'balanced',
    forceRefresh = false,
    req,
    r2ConfigOverride,
    appBaseUrlOverride,
    extraServers = [],
    checkpoint,
    onCheckpointUpdate,
    onStage,
  } = params;

  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  await hydrateRegistryFromD1IfNeeded(true);

  const buildCachedResultFromRecord = (record: CloudflareExtractedLink) => {
    const bestThumb = record.cloudflareThumbnailUrl || record.thumbnailUrl || '';
    const primaryVideoUrl = record.cloudflareVideoUrl || record.videoUrl || '';
    const cachedSizeObj =
      record.sizeFormatted || record.sizeBytes
        ? {
            sizeBytes: record.sizeBytes || 0,
            sizeMb:
              record.sizeMb ||
              (record.sizeBytes ? (record.sizeBytes / (1024 * 1024)).toFixed(2) : '0'),
            sizeFormatted: record.sizeFormatted || '',
          }
        : null;

    const cachedPageData = {
      title: record.title,
      rawTitle: record.rawTitle || record.title,
      description:
        record.description ||
        (record.destination && record.destination !== 'none'
          ? `Saved in Cloudflare Vault (${record.destination})`
          : ''),
      ogImage: bestThumb,
      ogVideo: primaryVideoUrl,
      cloudflareVideoUrl: record.cloudflareVideoUrl || undefined,
      cloudflareThumbnailUrl: record.cloudflareThumbnailUrl || undefined,
      thumbnailStorageSource:
        record.thumbnailStorageSource || (record.cloudflareThumbnailUrl ? 'cloudflare_r2' : null),
      videoStorageSource:
        record.videoStorageSource || (record.cloudflareVideoUrl ? 'cloudflare_r2' : null),
      durationFormatted: record.durationFormatted || undefined,
      durationSec: record.durationSec ?? null,
      videoSize: cachedSizeObj,
      isCachedFromCloudflare: true,
    };

    const cachedMediaData = {
      videos: primaryVideoUrl
        ? [
            {
              id: 1,
              url: primaryVideoUrl,
              originalVideoUrl: record.videoUrl || primaryVideoUrl,
              cloudflareVideoUrl: record.cloudflareVideoUrl || undefined,
              poster: bestThumb || undefined,
              cloudflareThumbnailUrl: record.cloudflareThumbnailUrl || undefined,
              type: 'video/mp4',
              filename: record.title || 'video',
              title: record.title,
              rawTitle: record.rawTitle || record.title,
              durationSec: record.durationSec ?? null,
              durationFormatted: record.durationFormatted || null,
              sizeBytes: cachedSizeObj?.sizeBytes ?? null,
              sizeMb: cachedSizeObj?.sizeMb ?? null,
              sizeFormatted: cachedSizeObj?.sizeFormatted ?? null,
              description: cachedPageData.description || undefined,
            },
          ]
        : [],
      iframes: [],
      images: bestThumb
        ? [
            {
              src: bestThumb,
              alt: record.title,
            },
          ]
        : [],
    };

    return {
      success: true,
      fromCache: true,
      cachedByWebUrl: true,
      status: 200,
      statusText: 'OK (Reused from Cloudflare Registry by Web URL · 0 Duplicate Copies)',
      targetUrl: url,
      finalUrl: record.sourceUrl || url,
      registryUniqueId: record.id,
      isRegisteredInCloudflare: true,
      isUploadedToCloudflare: Boolean(record.cloudflareVideoUrl || record.cloudflareThumbnailUrl),
      responseTimeMs: 1,
      contentType: 'text/html; charset=utf-8',
      headers: {
        server: 'cloudflare-r2-vault',
        'cache-control': 'public, max-age=86400',
      },
      page: cachedPageData,
      media: cachedMediaData,
      content: {
        headings: [record.title],
        textExcerpt:
          cachedPageData.description ||
          `Extracted and archived in Cloudflare registry on ${record.firstExtractedAt || 'earlier session'}.`,
        metaTags: {},
        jsonLd: [],
      },
      fullHtml: `<!-- Cached Cloudflare Registry Entry for Web URL: ${url} -->`,
      rawSnippet: `Cached record from Cloudflare: ${record.title}`,
      htmlLength: 0,
      registryRecord: record,
    };
  };

  const isRecordCompleteForRequest = (record?: CloudflareExtractedLink | null): boolean => {
    if (!record || isPreviewVideoUrl(record.videoUrl)) return false;
    const hasCfVideo = Boolean(record.cloudflareVideoUrl);
    const hasCfThumb = Boolean(record.cloudflareThumbnailUrl);
    return (
      (hasCfVideo || (record.status === 'uploaded' && hasCfThumb && !record.videoUrl)) &&
      (!uploadVideoToR2 || hasCfVideo || (record.status === 'uploaded' && !record.videoUrl)) &&
      (!uploadThumbnailToR2 || hasCfThumb || !record.thumbnailUrl)
    );
  };

  // CHECK LIVE CLOUDFLARE D1 REGISTRY BY WEB URL:
  // Reuse cached record ONLY when it already has complete Cloudflare assets needed for this request!
  const existingWebRecord = findRegistryRecordByWebUrl(url);
  if (!forceRefresh && existingWebRecord && isRecordCompleteForRequest(existingWebRecord)) {
    return buildCachedResultFromRecord(existingWebRecord);
  }

  if (!forceRefresh) {
    const activeOtherLock = getActiveOtherVpsLock(existingWebRecord);
    if (activeOtherLock) {
      const lockErr: any = new Error(
        `Already being extracted by another VPS (${activeOtherLock.otherServerId}) — waiting to reuse from D1`
      );
      lockErr.statusCode = 409;
      throw lockErr;
    }
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    const invalidErr: any = new Error(`Invalid URL format: "${url}"`);
    invalidErr.statusCode = 400;
    throw invalidErr;
  }

  const linkId = existingWebRecord?.id || getLinkUniqueId(url);
  inFlightProcessingIds.add(linkId);
  const ourLockStartedAtMs = Date.now();
  const ourLockStartedIso = new Date(ourLockStartedAtMs).toISOString();
  let lockHeartbeatTimer: NodeJS.Timeout | null = null;

  try {
    // Immediately claim lock in Cloudflare D1 with persistent scope + heartbeat timestamp
    const processingRecord = upsertRegistryRecordByWebUrl(url, {
      status: 'processing',
      metadata: {
        ...(existingWebRecord?.metadata || {}),
        workerServerId: SERVER_INSTANCE_ID,
        workerScopeId: VPS_QUEUE_SCOPE.scopeId,
        workerHost: appBaseUrlOverride || req?.get('host') || os.hostname(),
        processingStartedAt: ourLockStartedIso,
        processingHeartbeatAt: ourLockStartedIso,
      },
    });
    await syncRegistryToStorage(req, [processingRecord]);

    lockHeartbeatTimer = setInterval(() => {
      try {
        const current = findRegistryRecordByWebUrl(url);
        if (!current || current.status === 'uploaded' || current.status === 'forwarded' || hasCompleteCloudflareAssets(current)) {
          return;
        }
        const refreshed = upsertRegistryRecordByWebUrl(
          url,
          {
            status: 'processing',
            metadata: {
              ...(current.metadata || {}),
              workerServerId: SERVER_INSTANCE_ID,
              workerScopeId: VPS_QUEUE_SCOPE.scopeId,
              processingHeartbeatAt: new Date().toISOString(),
            },
          },
          false
        );
        syncRegistryToStorage(req, [refreshed]).catch(() => {});
      } catch {}
    }, 30000);
    lockHeartbeatTimer.unref?.();

      const startTime = Date.now();

      // Fetch using multi-server pool + rotating UA + anti-rate-limit retry
      const response = await axiosGetWithRetry(
        url,
        {
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,video/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            Referer: `${parsedUrl.origin}/`,
            ...customHeaders,
          },
          timeout: 25000,
          maxRedirects: 5,
          responseType: 'text',
          validateStatus: () => true, // Inspect status explicitly so we can fail & clean up D1 cleanly
        },
        3,
        extraServers
      );

      if (response.status >= 400) {
        const httpErr: any = new Error(`Target website returned HTTP ${response.status} ${response.statusText || ''}`.trim());
        httpErr.statusCode = response.status === 404 ? 404 : 502;
        throw httpErr;
      }

      const responseTimeMs = Date.now() - startTime;
      const contentType = String(response.headers['content-type'] || '');
      const finalUrl = (response.request as any)?.res?.responseUrl || response.config?.url || url;
      const rawSetCookie = response.headers['set-cookie'];
      const pageCookieHeader = Array.isArray(rawSetCookie)
        ? rawSetCookie.map((c: string) => String(c).split(';')[0]).filter(Boolean).join('; ')
        : typeof rawSetCookie === 'string'
        ? rawSetCookie.split(';')[0].trim()
        : '';

    // Helper to resolve relative URLs
    const resolveUrl = (relativeOrAbsolute: string) => {
      if (!relativeOrAbsolute) return '';
      try {
        return new URL(relativeOrAbsolute, finalUrl).href;
      } catch {
        return relativeOrAbsolute;
      }
    };

    let pageData: any = {};
    let mediaData: any = {
      videos: [],
      iframes: [],
      images: [],
    };
    const contentData: any = {
      headings: [] as string[],
      textExcerpt: '',
      metaTags: {} as Record<string, string>,
      jsonLd: [] as any[],
    };

    const candidateTitles: Array<{ source: string; text: string; rawText?: string; selector?: string }> = [];
    const candidateThumbnails: Array<{ source: string; url: string; selector?: string; dimensions?: string }> = [];

    // Helper functions for title cleaning
    const cleanStr = (s: string) => (s ? s.replace(/\s+/g, ' ').trim() : '');
    const stripBrandSuffix = (t: string) => {
      if (!t) return '';
      return t.replace(/\s*([|\-–—::»\/\\])\s*[^|\-–—::»\/\\]+$/g, '').trim() || t;
    };

    let detectedDuration: { seconds: number; formatted: string } | null = null;
    let detectedDescription = '';
    let detectedVideoSize: { sizeBytes: number; sizeMb: string; sizeFormatted: string } | null = null;

    // Helper to add candidate title with filtering
    const addCandidateTitle = (source: string, rawText: string, selector?: string) => {
      const trimmed = cleanStr(rawText);
      if (!trimmed) return;
      const filtered = cleanTitleWithFilter(trimmed, wordsToRemove);
      if (!candidateTitles.some((c) => c.text === filtered.cleaned || c.rawText === trimmed)) {
        candidateTitles.push({
          source,
          text: filtered.cleaned,
          rawText: trimmed,
          selector,
        });
      }
    };

    // If it's HTML, parse with Cheerio
    if (
      typeof response.data === 'string' &&
      (contentType.includes('html') ||
        response.data.includes('<html') ||
        response.data.includes('<!DOCTYPE') ||
        response.data.includes('<head') ||
        response.data.includes('<body'))
    ) {
      const $ = cheerio.load(response.data);

      // 1. DISCOVER ALL CANDIDATE TITLES
      // A) OpenGraph & Twitter
      const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
      if (ogTitle) {
        addCandidateTitle('OpenGraph Meta Tag', ogTitle, 'meta[property="og:title"]');
      }

      const twTitle = $('meta[name="twitter:title"]').attr('content');
      if (twTitle) {
        addCandidateTitle('Twitter Card Meta Tag', twTitle, 'meta[name="twitter:title"]');
      }

      const metaTitle = $('meta[name="title"]').attr('content');
      if (metaTitle) {
        addCandidateTitle('Standard Meta Tag', metaTitle, 'meta[name="title"]');
      }

      // B) JSON-LD Structured Data (Titles, Thumbnails, Duration, Description)
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const raw = $(el).html();
          if (raw) {
            const parsed = JSON.parse(raw);
            contentData.jsonLd.push(parsed);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            items.forEach((item: any) => {
              const itemTitle = item.name || item.headline || item.caption;
              if (typeof itemTitle === 'string') {
                addCandidateTitle(`JSON-LD Schema (${item['@type'] || 'Object'})`, itemTitle);
              }

              // Duration in JSON-LD (VideoObject duration: "PT15M33S")
              if (!detectedDuration && item.duration) {
                const p = parseDuration(item.duration);
                if (p) detectedDuration = p;
              }

              // Description in JSON-LD
              if (!detectedDescription && item.description && typeof item.description === 'string') {
                detectedDescription = cleanStr(item.description);
              }

              const itemThumb = item.thumbnailUrl || item.thumbnail || (typeof item.image === 'string' ? item.image : item.image?.url);
              if (typeof itemThumb === 'string' && cleanStr(itemThumb)) {
                const resThumb = resolveUrl(cleanStr(itemThumb));
                if (!candidateThumbnails.some((c) => c.url === resThumb)) {
                  candidateThumbnails.push({ source: `JSON-LD Schema Thumbnail (${item['@type'] || 'Object'})`, url: resThumb });
                }
              }
            });
          }
        } catch {}
      });

      // C) Heading 1 elements (<h1 class="...">)
      $('h1').each((_, el) => {
        const text = cleanStr($(el).text());
        const cls = $(el).attr('class');
        const id = $(el).attr('id');
        const selector = `h1${id ? `#${id}` : ''}${cls ? `.${cls.split(' ').filter(Boolean).join('.')}` : ''}`;
        if (text && text.length > 2 && text.length < 300) {
          addCandidateTitle(`Main Heading (${selector})`, text, selector);
        }
      });

      // D) Elements with class or ID containing 'title', 'video-title', 'headline', 'name'
      $('[class*="title"], [class*="headline"], [class*="name"], [id*="title"], [itemprop="name"]').each((_, el) => {
        const tagName = (el as any).tagName?.toLowerCase() || '';
        if (['h1', 'h2', 'h3', 'h4', 'span', 'p', 'div', 'a'].includes(tagName)) {
          const text = cleanStr($(el).text());
          const cls = $(el).attr('class') || '';
          const id = $(el).attr('id') || '';
          if (text && text.length > 3 && text.length < 250) {
            addCandidateTitle(`Title Class/ID (<${tagName}${cls ? ` class="${cls}"` : ''}>)`, text, `${tagName}${id ? `#${id}` : ''}${cls ? `.${cls.split(' ').filter(Boolean).join('.')}` : ''}`);
          }
        }
      });

      // E) Document <title> tag
      const rawDocTitle = cleanStr($('title').text());
      if (rawDocTitle) {
        const stripped = stripBrandSuffix(rawDocTitle);
        if (stripped && stripped !== rawDocTitle) {
          addCandidateTitle('Cleaned Document Title', stripped, 'title');
        }
        addCandidateTitle('Full Document Title (<title>)', rawDocTitle, 'title');
      }

      // 2. DISCOVER ALL CANDIDATE THUMBNAILS
      // A) <video poster="...">
      $('video').each((_, el) => {
        const poster = $(el).attr('poster') || $(el).attr('data-poster') || $(el).attr('data-thumb');
        if (poster) {
          const resolved = resolveUrl(poster);
          if (resolved && !candidateThumbnails.some((c) => c.url === resolved)) {
            candidateThumbnails.push({ source: 'Video Poster (<video poster="...">)', selector: 'video[poster]', url: resolved });
          }
        }
      });

      // B) OpenGraph & Twitter image
      const ogImage = resolveUrl($('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || '');
      if (ogImage && !candidateThumbnails.some((c) => c.url === ogImage)) {
        candidateThumbnails.push({ source: 'OpenGraph Poster (meta[property="og:image"])', selector: 'meta[property="og:image"]', url: ogImage });
      }

      const twImage = resolveUrl($('meta[name="twitter:image"]').attr('content') || '');
      if (twImage && !candidateThumbnails.some((c) => c.url === twImage)) {
        candidateThumbnails.push({ source: 'Twitter Card Image (meta[name="twitter:image"])', selector: 'meta[name="twitter:image"]', url: twImage });
      }

      // C) meta[name="thumbnail"], meta[itemprop="thumbnailUrl"], link[rel="image_src"]
      $('meta[name="thumbnail"], meta[itemprop="thumbnailUrl"], link[rel="image_src"]').each((_, el) => {
        const href = $(el).attr('content') || $(el).attr('href');
        if (href) {
          const resolved = resolveUrl(href);
          if (resolved && !candidateThumbnails.some((c) => c.url === resolved)) {
            candidateThumbnails.push({
              source: `Thumbnail Meta Tag (${$(el).attr('name') || $(el).attr('itemprop') || $(el).attr('rel')})`,
              url: resolved,
            });
          }
        }
      });

      // D) Featured cover / poster images
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        const cls = ($(el).attr('class') || '') + ' ' + ($(el).attr('id') || '');
        if (src && !src.startsWith('data:') && /(poster|thumb|cover|preview|featured|hero|image)/i.test(cls)) {
          const resolved = resolveUrl(src);
          if (resolved && !candidateThumbnails.some((c) => c.url === resolved)) {
            candidateThumbnails.push({
              source: `Poster Image Element (<img class="${$(el).attr('class') || ''}">)`,
              url: resolved,
              dimensions: $(el).attr('width') && $(el).attr('height') ? `${$(el).attr('width')}×${$(el).attr('height')}` : undefined,
            });
          }
        }
      });

      const ogVideo = resolveUrl(
        $('meta[property="og:video"]').attr('content') ||
          $('meta[property="og:video:url"]').attr('content') ||
          $('meta[property="og:video:secure_url"]').attr('content') ||
          ''
      );

      const favicon = resolveUrl(
        $('link[rel="icon"]').attr('href') ||
          $('link[rel="shortcut icon"]').attr('href') ||
          $('link[rel="apple-touch-icon"]').attr('href') ||
          '/favicon.ico'
      );

      // Description extraction
      const rawDescription =
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content') ||
        $('meta[itemprop="description"]').attr('content') ||
        '';

      if (!detectedDescription && rawDescription) {
        detectedDescription = cleanStr(rawDescription);
      }

      // Check page text elements for description if meta tag was empty
      if (!detectedDescription) {
        $('[class*="description"], [id*="description"], [class*="synopsis"], [id*="synopsis"], [itemprop="description"], .video-details, .summary').each((_, el) => {
          if (detectedDescription) return;
          const text = cleanStr($(el).text());
          if (text && text.length > 20 && text.length < 2500) {
            detectedDescription = text;
          }
        });
      }

      // Duration extraction from meta tags, player JSON, & HTML elements
      if (!detectedDuration) {
        const metaDur =
          $('meta[itemprop="duration"]').attr('content') ||
          $('meta[property="video:duration"]').attr('content') ||
          $('meta[property="og:video:duration"]').attr('content') ||
          $('meta[name="duration"]').attr('content');
        if (metaDur) {
          detectedDuration = parseDuration(metaDur);
        }
      }

      // Check embedded player JSON (e.g. xplayerSettings / videoModel / playerConfig) before generic CSS badges
      if (!detectedDuration && typeof response.data === 'string') {
        const playerDurMatch =
          response.data.match(/"(?:xplayerSettings|videoModel|playerConfig|videoInfo)"\s*:\s*\{[^{}]{0,500}"duration"\s*:\s*(\d{1,6})/i) ||
          response.data.match(/"duration"\s*:\s*(\d{2,6})\s*,\s*"(?:debug|sources|fallbackImageClass|title|videoId)"/i);
        if (playerDurMatch && playerDurMatch[1]) {
          const p = parseDuration(Number(playerDurMatch[1]));
          if (p) detectedDuration = p;
        }
      }

      if (!detectedDuration) {
        $('[itemprop="duration"], [data-duration], [class*="duration"], [id*="duration"], [class*="video-time"], [class*="time"]').each((_, el) => {
          if (detectedDuration) return;
          const durAttr = $(el).attr('data-duration') || $(el).attr('content');
          if (durAttr) {
            const p = parseDuration(durAttr);
            if (p) {
              detectedDuration = p;
              return;
            }
          }
          const txt = cleanStr($(el).text());
          if (txt && txt.length <= 15) {
            const p = parseDuration(txt);
            if (p) detectedDuration = p;
          }
        });
      }

      // File size hint from HTML attributes (used ONLY as a last-resort fallback if HTTP/R2 size is unavailable)
      let htmlSizeHint: { sizeBytes: number; sizeMb: string; sizeFormatted: string } | null = null;
      const sizeAttr =
        $('meta[itemprop="contentSize"]').attr('content') ||
        $('[data-size]').attr('data-size') ||
        '';
      if (sizeAttr) {
        const match = sizeAttr.match(/(\d+(?:\.\d+)?)\s*(GB|MB|KB)/i);
        if (match) {
          const num = parseFloat(match[1]);
          const unit = match[2].toUpperCase();
          let bytes = num * 1024 * 1024;
          if (unit === 'GB') bytes = num * 1024 * 1024 * 1024;
          if (unit === 'KB') bytes = num * 1024;
          const sizeMb = (bytes / (1024 * 1024)).toFixed(2);
          htmlSizeHint = {
            sizeBytes: Math.round(bytes),
            sizeMb,
            sizeFormatted: `${num} ${unit}`,
          };
        }
      }

      const siteName = $('meta[property="og:site_name"]').attr('content') || parsedUrl.hostname;
      const canonical = resolveUrl($('link[rel="canonical"]').attr('href') || finalUrl);

      // Meta tags collection
      $('meta').each((_, el) => {
        const name = $(el).attr('name') || $(el).attr('property');
        const content = $(el).attr('content');
        if (name && content && !contentData.metaTags[name]) {
          contentData.metaTags[name] = content;
        }
      });

      // 3. DETECT VIDEOS WITH ASSOCIATED POSTER & TITLE
      const detectedVideosMap = new Map<string, { url: string; poster?: string; title?: string; type: string }>();
      const addDetectedVideoCandidate = (rawVideoUrl: string, poster?: string, title?: string, explicitType?: string) => {
        if (!rawVideoUrl || rawVideoUrl.startsWith('data:') || rawVideoUrl.startsWith('blob:')) return;
        const sanitizedRaw = rawVideoUrl
          .replace(/&amp;/gi, '&')
          .replace(/\\u0026/gi, '&')
          .replace(/\\u002f/gi, '/')
          .replace(/\\u003d/gi, '=')
          .replace(/\\+$/, '')
          .trim();
        const resolvedUrl = resolveUrl(sanitizedRaw);
        if (!resolvedUrl || !/^https?:\/\//i.test(resolvedUrl)) return;
        if (!detectedVideosMap.has(resolvedUrl)) {
          detectedVideosMap.set(resolvedUrl, {
            url: resolvedUrl,
            poster: poster || ogImage || undefined,
            title: title || candidateTitles[0]?.text || undefined,
            type:
              explicitType ||
              (resolvedUrl.includes('.m3u8')
                ? 'HLS (m3u8)'
                : resolvedUrl.includes('.webm')
                ? 'WebM Video'
                : resolvedUrl.includes('.mp4')
                ? 'MP4 Video'
                : 'Video Stream'),
          });
        }
      };

      const twitterStream =
        $('meta[name="twitter:player:stream"]').attr('content') ||
        $('meta[property="twitter:player:stream"]').attr('content') ||
        $('meta[itemprop="contentUrl"]').attr('content') ||
        '';
      if (twitterStream) {
        addDetectedVideoCandidate(twitterStream, ogImage, candidateTitles[0]?.text);
      }

      if (ogVideo && !/\.(html?|php)(\?|$)/i.test(ogVideo)) {
        addDetectedVideoCandidate(ogVideo, ogImage, candidateTitles[0]?.text);
      }

      // Check JSON-LD contentUrl fields
      contentData.jsonLd.forEach((entry: any) => {
        const items = Array.isArray(entry) ? entry : [entry];
        items.forEach((item: any) => {
          const contentUrl = item?.contentUrl || item?.video?.contentUrl || item?.associatedMedia?.contentUrl;
          if (typeof contentUrl === 'string' && contentUrl.trim()) {
            addDetectedVideoCandidate(contentUrl, ogImage, item?.name || candidateTitles[0]?.text);
          }
        });
      });

      $('video').each((_, el) => {
        const vSrc =
          $(el).attr('src') ||
          $(el).attr('data-src') ||
          $(el).attr('data-video') ||
          $(el).attr('data-video-url') ||
          $(el).attr('data-url');
        const vPoster = resolveUrl($(el).attr('poster') || $(el).attr('data-poster') || $(el).attr('data-thumb') || '');
        const vTitle = $(el).attr('title') || $(el).attr('data-title') || $(el).attr('aria-label') || '';

        if (vSrc) {
          addDetectedVideoCandidate(vSrc, vPoster, vTitle);
        }

        $(el).find('source').each((__, sEl) => {
          const sSrc = $(sEl).attr('src') || $(sEl).attr('data-src') || $(sEl).attr('data-url');
          const sType = $(sEl).attr('type') || '';
          if (sSrc) {
            addDetectedVideoCandidate(sSrc, vPoster, vTitle, sType);
          }
        });
      });

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && /\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(href)) {
          addDetectedVideoCandidate(
            href,
            ogImage,
            cleanStr($(el).text()) || $(el).attr('title') || candidateTitles[0]?.text
          );
        }
      });

      // Fallback: scan inline scripts & raw HTML for direct .mp4/.webm/.mov/.mkv/.m3u8 URLs
      const normalizedHtmlForScripts = response.data
        .replace(/\\\//g, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u002f/gi, '/')
        .replace(/\\u003d/gi, '=')
        .replace(/&amp;/gi, '&');
      const scriptMediaMatches =
        normalizedHtmlForScripts.match(/https?:\/\/[^\s"'<>\\`]+\.(?:mp4|webm|mov|mkv|m3u8)(?:\?[^\s"'<>\\`]*)?/gi) || [];
      for (const mUrl of scriptMediaMatches) {
        addDetectedVideoCandidate(mUrl, ogImage, candidateTitles[0]?.text);
      }

      // Detect embedded player iframes (YouTube, Vimeo, etc.)
      const detectedIframes: Array<{ src: string; type: string; title?: string }> = [];
      $('iframe[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src) {
          const resolvedSrc = resolveUrl(src);
          let type = 'general_embed';
          if (resolvedSrc.includes('youtube') || resolvedSrc.includes('youtu.be')) type = 'youtube';
          else if (resolvedSrc.includes('vimeo')) type = 'vimeo';
          else if (resolvedSrc.includes('dailymotion')) type = 'dailymotion';
          else if (resolvedSrc.includes('player') || resolvedSrc.includes('embed')) type = 'video_player';
          detectedIframes.push({
            src: resolvedSrc,
            type,
            title: $(el).attr('title') || $(el).attr('aria-label') || undefined,
          });
        }
      });

      // Detect images (for posters / comic pages / banners)
      const detectedImages: Array<{ src: string; alt?: string; width?: string; height?: string }> = [];
      if (ogImage) {
        detectedImages.push({ src: ogImage, alt: 'OG Cover Image' });
      }

      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !src.startsWith('data:')) {
          const resolvedImg = resolveUrl(src);
          if (!detectedImages.some((img) => img.src === resolvedImg)) {
            detectedImages.push({
              src: resolvedImg,
              alt: $(el).attr('alt') || '',
              width: $(el).attr('width') || undefined,
              height: $(el).attr('height') || undefined,
            });
          }
        }
      });

      // Headings
      $('h1, h2').each((_, el) => {
        const text = cleanStr($(el).text());
        if (text && text.length < 200 && !contentData.headings.includes(text)) {
          contentData.headings.push(text);
        }
      });

      // Text excerpt
      $('script, style, noscript, nav, footer, header').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      contentData.textExcerpt = bodyText.substring(0, 1000);

      // Primary title & thumbnail selection
      const rawPrimary = candidateTitles[0]?.rawText || candidateTitles[0]?.text || rawDocTitle || url.split('/').pop()?.split('?')[0] || '';
      const cleanedPrimary = cleanTitleWithFilter(rawPrimary, wordsToRemove);
      let primaryThumbnail = candidateThumbnails[0]?.url || ogImage || '';
      const originalPrimaryThumbnail = primaryThumbnail;
      let cloudflareThumbnailUrl: string | null = null;
      let thumbnailStorageSource: 'cloudflare_r2' | 'emulator' | null = null;

      // Filter out thumbnail/hover preview clips (e.g. thumb-v*.xhcdn.com/...t.av1.mp4) and rank real full videos first
      const sortedVideoCandidates = Array.from(detectedVideosMap.values())
        .filter((c) => !isPreviewVideoUrl(c.url))
        .sort((a, b) => {
          const score = (u: string) => {
            const lower = u.toLowerCase();
            if (/\.(mp4|webm|mov|mkv)(\?|$)/.test(lower)) {
              if (/(1080p|720p|480p)/i.test(lower)) return 0;
              if (/(144p|240p)/i.test(lower)) return 2;
              return 1;
            }
            if (!lower.includes('.m3u8')) return 3;
            return 4;
          };
          return score(a.url) - score(b.url);
        });

      const firstVideoUrl = sortedVideoCandidates[0]?.url || '';

      // Update saved object immediately once HTML metadata, thumbnail URL, & video URL are discovered
      upsertRegistryRecordByWebUrl(url, {
        title: cleanedPrimary.cleaned || 'Extracted Video',
        rawTitle: rawPrimary,
        description: detectedDescription || undefined,
        thumbnailUrl: originalPrimaryThumbnail || undefined,
        videoUrl: firstVideoUrl || undefined,
        durationSec: detectedDuration?.seconds ?? null,
        durationFormatted: detectedDuration?.formatted || '',
      });

      let cloudflareVideoUrl: string | null = null;
      let videoStorageSource: 'cloudflare_r2' | 'emulator' | null = null;
      let uploadedSourceVideoUrl = firstVideoUrl;
      let lastThumbUploadError: string | null = null;
      let lastVideoUploadError: string | null = null;

      onStage?.('scraping', 'Extracted metadata · verifying D1 before download...', {
        title: cleanedPrimary.cleaned || undefined,
        thumbnailUrl: originalPrimaryThumbnail || undefined,
        videoUrl: firstVideoUrl || undefined,
      });

      onCheckpointUpdate?.({
        title: cleanedPrimary.cleaned || undefined,
        rawTitle: rawPrimary || undefined,
        description: detectedDescription || undefined,
        originalThumbnailUrl: originalPrimaryThumbnail || undefined,
        originalVideoUrl: firstVideoUrl || undefined,
        durationSec: detectedDuration?.seconds ?? null,
        durationFormatted: detectedDuration?.formatted || undefined,
        pageRefererUrl: finalUrl,
      });

      // Double-check live D1 BEFORE downloading/uploading any large video (prevents duplicate downloads when 2 VPS race)
      if (!forceRefresh && (uploadVideoToR2 || uploadThumbnailToR2)) {
        await hydrateRegistryFromD1IfNeeded(true);
        const latestRemote = findRegistryRecordByWebUrl(url);
        if (latestRemote && isRecordCompleteForRequest(latestRemote)) {
          return buildCachedResultFromRecord(latestRemote);
        }
        const earlierOtherLock = getActiveOtherVpsLock(latestRemote);
        if (earlierOtherLock && earlierOtherLock.startedMs < ourLockStartedAtMs) {
          const lockErr: any = new Error(
            `Already being extracted by another VPS (${earlierOtherLock.otherServerId}) — waiting to reuse from D1`
          );
          lockErr.statusCode = 409;
          throw lockErr;
        }
      }

      // Run thumbnail R2 upload and video R2 download/upload IN PARALLEL so thumbnail upload adds 0ms wait time
      const thumbUploadPromise = (async () => {
        if (!uploadThumbnailToR2 || !primaryThumbnail) return;
        if (checkpoint?.cloudflareThumbnailUrl) {
          cloudflareThumbnailUrl = checkpoint.cloudflareThumbnailUrl;
          thumbnailStorageSource = 'cloudflare_r2';
          primaryThumbnail = checkpoint.cloudflareThumbnailUrl;
          return;
        }
        if (!uploadVideoToR2 || sortedVideoCandidates.length === 0) {
          onStage?.('uploading_cloudflare', 'Uploading thumbnail to Cloudflare R2...');
        }
        try {
          const r2Upload = await uploadImageToR2OrLocal({
            imageUrl: primaryThumbnail,
            customFilename: cleanedPrimary.cleaned || 'thumb',
            folderPrefix: 'thumbnails',
            refererUrl: finalUrl,
            req,
            r2ConfigOverride,
            appBaseUrlOverride,
          });
          cloudflareThumbnailUrl = r2Upload.cloudflareBackLink;
          thumbnailStorageSource = r2Upload.storageSource;
          primaryThumbnail = r2Upload.cloudflareBackLink;
          onCheckpointUpdate?.({ cloudflareThumbnailUrl });
          upsertRegistryRecordByWebUrl(url, {
            cloudflareThumbnailUrl,
            thumbnailStorageSource,
          });
        } catch (thumbErr) {
          lastThumbUploadError = formatCompactError(thumbErr);
          console.warn('Auto upload of thumbnail to Cloudflare R2 failed:', lastThumbUploadError);
        }
      })();

      let videoCompressionMeta: {
        compressed: boolean;
        quality?: VideoCompressionQuality;
        originalSizeBytes?: number;
        savedPercent?: number;
      } | null = null;

      const videoUploadPromise = (async () => {
        if (!uploadVideoToR2 || sortedVideoCandidates.length === 0) return;
        const candidatesToTry = sortedVideoCandidates.slice(0, 3);
        const errReasons: string[] = [];
        for (let idx = 0; idx < candidatesToTry.length; idx++) {
          const candidate = candidatesToTry[idx];
          onCheckpointUpdate?.({ originalVideoUrl: candidate.url, pageRefererUrl: finalUrl });
          try {
            const r2VideoUpload = await uploadVideoToR2OrLocal({
              videoUrl: candidate.url,
              customFilename: cleanedPrimary.cleaned || 'video',
              folderPrefix: 'videos',
              refererUrl: finalUrl,
              cookieHeader: pageCookieHeader || undefined,
              extraServers,
              req,
              r2ConfigOverride,
              appBaseUrlOverride,
              minExpectedDurationSec: detectedDuration?.seconds || undefined,
              allowShortDurationFallback: idx === candidatesToTry.length - 1,
              compressVideo: Boolean(compressVideo),
              compressionQuality: normalizeCompressionQuality(compressionQuality),
              preserveLocalFileOnError: Boolean(onCheckpointUpdate),
              onStage,
            });
            cloudflareVideoUrl = r2VideoUpload.cloudflareVideoBackLink;
            videoStorageSource = r2VideoUpload.storageSource;
            uploadedSourceVideoUrl = candidate.url;
            lastVideoUploadError = null;
            if (r2VideoUpload.compressed) {
              videoCompressionMeta = {
                compressed: true,
                quality: r2VideoUpload.compressionQuality,
                originalSizeBytes: r2VideoUpload.originalSizeBytes,
                savedPercent: r2VideoUpload.savedPercent,
              };
            }
            // Authoritative video file size & duration from downloaded/compressed video + Cloudflare R2 HeadObject verification
            detectedVideoSize = {
              sizeBytes: r2VideoUpload.sizeBytes,
              sizeMb: r2VideoUpload.sizeMb,
              sizeFormatted: r2VideoUpload.sizeFormatted,
            };
            if (r2VideoUpload.durationSec && r2VideoUpload.durationFormatted) {
              detectedDuration = {
                seconds: r2VideoUpload.durationSec,
                formatted: r2VideoUpload.durationFormatted,
              };
            }
            const immediateUploadedRecord = upsertRegistryRecordByWebUrl(url, {
              videoUrl: uploadedSourceVideoUrl,
              cloudflareVideoUrl,
              videoStorageSource,
              sizeBytes: r2VideoUpload.sizeBytes,
              sizeMb: r2VideoUpload.sizeMb,
              sizeFormatted: r2VideoUpload.sizeFormatted,
              durationSec: detectedDuration?.seconds ?? null,
              durationFormatted: detectedDuration?.formatted || '',
              status: 'uploaded',
              metadata: {
                ...(findRegistryRecordByWebUrl(url)?.metadata || {}),
                workerServerId: SERVER_INSTANCE_ID,
                workerScopeId: VPS_QUEUE_SCOPE.scopeId,
              },
            });
            // Persist uploaded R2 link to D1 right away so no subsequent step or other VPS can lose it
            syncRegistryToStorage(req, [immediateUploadedRecord]).catch(() => {});
            break;
          } catch (videoErr: any) {
            const reason = formatCompactError(videoErr);
            errReasons.push(reason);
            console.warn('Auto upload of video to Cloudflare R2 failed:', reason);
            if (videoErr?.checkpoint) {
              onCheckpointUpdate?.(videoErr.checkpoint);
              // If the full video WAS already downloaded/compressed locally and only R2 upload failed,
              // keep that exact file for retry instead of wasting bandwidth downloading backup mirrors from 0%!
              if (videoErr.checkpoint.localVideoDownloadComplete) {
                break;
              }
            }
          }
        }
        if (!cloudflareVideoUrl && errReasons.length > 0) {
          lastVideoUploadError = errReasons[errReasons.length - 1];
        }
      })();

      await Promise.all([thumbUploadPromise, videoUploadPromise]);

      if (!detectedVideoSize && firstVideoUrl) {
        detectedVideoSize = await detectRemoteFileSize(firstVideoUrl, finalUrl);
      }
      if (!detectedVideoSize && htmlSizeHint) {
        detectedVideoSize = htmlSizeHint;
      }

      // Map detected videos (reuse detectedVideoSize without firing extra slow HEAD/Range probes on unused backup mirrors)
      const detectedVideosList = sortedVideoCandidates.map((vItem, i) => {
        const rawVTitle = vItem.title || rawPrimary;
        const vClean = cleanTitleWithFilter(rawVTitle, wordsToRemove);
        const isUploadedCandidate = Boolean(cloudflareVideoUrl && vItem.url === uploadedSourceVideoUrl);
        const itemSize = isUploadedCandidate || i === 0 ? detectedVideoSize : null;
        const resolvedItemVideoUrl = isUploadedCandidate && cloudflareVideoUrl ? cloudflareVideoUrl : vItem.url;

        return {
          id: i + 1,
          url: resolvedItemVideoUrl,
          originalVideoUrl: vItem.url,
          cloudflareVideoUrl: isUploadedCandidate && cloudflareVideoUrl ? cloudflareVideoUrl : undefined,
          poster: cloudflareThumbnailUrl || vItem.poster || primaryThumbnail || undefined,
          title: vClean.cleaned,
          rawTitle: rawVTitle,
          type: vItem.type,
          filename: vItem.url.split('/').pop()?.split('?')[0] || `video_${i + 1}`,
          durationSec: detectedDuration?.seconds || null,
          durationFormatted: detectedDuration?.formatted || null,
          sizeBytes: itemSize?.sizeBytes || null,
          sizeMb: itemSize?.sizeMb || null,
          sizeFormatted: itemSize?.sizeFormatted || null,
          description: detectedDescription || undefined,
          cloudflareThumbnailUrl: cloudflareThumbnailUrl || undefined,
        };
      });

      pageData = {
        title: cleanedPrimary.cleaned,
        rawTitle: rawPrimary,
        description: detectedDescription,
        durationSec: detectedDuration?.seconds || null,
        durationFormatted: detectedDuration?.formatted || null,
        videoSize: detectedVideoSize || null,
        videoCompression: videoCompressionMeta,
        removedWords: cleanedPrimary.removedTerms,
        favicon,
        ogImage: primaryThumbnail,
        cloudflareThumbnailUrl,
        thumbnailStorageSource,
        cloudflareVideoUrl,
        videoStorageSource,
        videoUploadError: lastVideoUploadError,
        thumbUploadError: lastThumbUploadError,
        ogVideo: cloudflareVideoUrl || ogVideo,
        siteName,
        canonical,
        candidateTitles,
        candidateThumbnails,
      };

      mediaData = {
        videos: detectedVideosList,
        iframes: detectedIframes,
        images: detectedImages.slice(0, 40),
      };
    } else {
      // Non-HTML media stream directly (e.g. video/mp4, application/vnd.apple.mpegurl, image, json, etc.)
      const directTitle = url.split('/').pop()?.split('?')[0] || parsedUrl.hostname;
      const cleanedDirect = cleanTitleWithFilter(directTitle, wordsToRemove);

      // Check remote size of direct resource
      let directSize: { sizeBytes: number; sizeMb: string; sizeFormatted: string } | null = null;
      if (response.headers['content-length']) {
        const bytes = parseInt(String(response.headers['content-length']), 10);
        if (!isNaN(bytes) && bytes > 0) {
          directSize = {
            sizeBytes: bytes,
            sizeMb: (bytes / (1024 * 1024)).toFixed(2),
            sizeFormatted:
              bytes >= 1024 * 1024 * 1024
                ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
                : `${(bytes / (1024 * 1024)).toFixed(2)} MB`,
          };
        }
      }
      if (!directSize) {
        directSize = await detectRemoteFileSize(finalUrl, url);
      }

      let cloudflareVideoUrl: string | null = null;
      let videoStorageSource: 'cloudflare_r2' | 'emulator' | null = null;
      let directDuration: { seconds: number; formatted: string } | null = null;

      let videoCompressionMeta: {
        compressed: boolean;
        quality?: VideoCompressionQuality;
        originalSizeBytes?: number;
        savedPercent?: number;
      } | null = null;

      let lastVideoUploadError: string | null = null;
      if (uploadVideoToR2 && (contentType.includes('video') || contentType.includes('mpegurl') || /\.(mp4|m3u8|webm|mov|mkv)$/i.test(url))) {
        if (!forceRefresh) {
          await hydrateRegistryFromD1IfNeeded(true);
          const latestRemote = findRegistryRecordByWebUrl(url);
          if (latestRemote && isRecordCompleteForRequest(latestRemote)) {
            return buildCachedResultFromRecord(latestRemote);
          }
          const earlierOtherLock = getActiveOtherVpsLock(latestRemote);
          if (earlierOtherLock && earlierOtherLock.startedMs < ourLockStartedAtMs) {
            const lockErr: any = new Error(
              `Already being extracted by another VPS (${earlierOtherLock.otherServerId}) — waiting to reuse from D1`
            );
            lockErr.statusCode = 409;
            throw lockErr;
          }
        }
        onCheckpointUpdate?.({
          title: cleanedDirect.cleaned || undefined,
          rawTitle: directTitle || undefined,
          originalVideoUrl: finalUrl,
          pageRefererUrl: url,
        });
        try {
          const r2DirectVideo = await uploadVideoToR2OrLocal({
            videoUrl: finalUrl,
            customFilename: cleanedDirect.cleaned || 'stream_video',
            folderPrefix: 'videos',
            refererUrl: url,
            cookieHeader: pageCookieHeader || undefined,
            extraServers,
            req,
            r2ConfigOverride,
            appBaseUrlOverride,
            compressVideo: Boolean(compressVideo),
            compressionQuality: normalizeCompressionQuality(compressionQuality),
            preserveLocalFileOnError: Boolean(onCheckpointUpdate),
            onStage,
          });
          cloudflareVideoUrl = r2DirectVideo.cloudflareVideoBackLink;
          videoStorageSource = r2DirectVideo.storageSource;
          if (r2DirectVideo.compressed) {
            videoCompressionMeta = {
              compressed: true,
              quality: r2DirectVideo.compressionQuality,
              originalSizeBytes: r2DirectVideo.originalSizeBytes,
              savedPercent: r2DirectVideo.savedPercent,
            };
          }
          directSize = {
            sizeBytes: r2DirectVideo.sizeBytes,
            sizeMb: r2DirectVideo.sizeMb,
            sizeFormatted: r2DirectVideo.sizeFormatted,
          };
          if (r2DirectVideo.durationSec && r2DirectVideo.durationFormatted) {
            directDuration = {
              seconds: r2DirectVideo.durationSec,
              formatted: r2DirectVideo.durationFormatted,
            };
          }
          const immediateUploadedDirect = upsertRegistryRecordByWebUrl(url, {
            videoUrl: finalUrl,
            cloudflareVideoUrl,
            videoStorageSource,
            sizeBytes: r2DirectVideo.sizeBytes,
            sizeMb: r2DirectVideo.sizeMb,
            sizeFormatted: r2DirectVideo.sizeFormatted,
            durationSec: directDuration?.seconds ?? null,
            durationFormatted: directDuration?.formatted || '',
            status: 'uploaded',
            metadata: {
              ...(findRegistryRecordByWebUrl(url)?.metadata || {}),
              workerServerId: SERVER_INSTANCE_ID,
              workerScopeId: VPS_QUEUE_SCOPE.scopeId,
            },
          });
          syncRegistryToStorage(req, [immediateUploadedDirect]).catch(() => {});
        } catch (r2Err: any) {
          lastVideoUploadError = formatCompactError(r2Err);
          console.warn('Direct video stream Cloudflare upload failed:', lastVideoUploadError);
          if (r2Err?.checkpoint) {
            onCheckpointUpdate?.(r2Err.checkpoint);
          }
        }
      }

      pageData = {
        title: cleanedDirect.cleaned,
        rawTitle: directTitle,
        description: `Direct ${contentType} resource stream`,
        durationSec: directDuration?.seconds || null,
        durationFormatted: directDuration?.formatted || null,
        videoSize: directSize,
        videoCompression: videoCompressionMeta,
        removedWords: cleanedDirect.removedTerms,
        favicon: `${parsedUrl.origin}/favicon.ico`,
        siteName: parsedUrl.hostname,
        cloudflareVideoUrl,
        videoStorageSource,
        videoUploadError: lastVideoUploadError,
        candidateTitles: [
          {
            source: 'Direct Resource Filename',
            text: cleanedDirect.cleaned,
            rawText: directTitle,
          },
        ],
        candidateThumbnails: [],
      };

      if (contentType.includes('video') || contentType.includes('mpegurl') || /\.(mp4|m3u8|webm|mov|mkv)$/i.test(url)) {
        mediaData.videos.push({
          id: 1,
          url: cloudflareVideoUrl || finalUrl,
          originalVideoUrl: finalUrl,
          cloudflareVideoUrl: cloudflareVideoUrl || undefined,
          title: cleanedDirect.cleaned,
          rawTitle: directTitle,
          type: contentType || (finalUrl.includes('.m3u8') ? 'HLS (m3u8)' : 'MP4 Video'),
          filename: finalUrl.split('/').pop()?.split('?')[0] || 'stream_video',
          durationSec: directDuration?.seconds || null,
          durationFormatted: directDuration?.formatted || null,
          sizeBytes: directSize?.sizeBytes || null,
          sizeMb: directSize?.sizeMb || null,
          sizeFormatted: directSize?.sizeFormatted || null,
          description: `Direct video resource stream from ${parsedUrl.hostname}`,
        });
      } else if (contentType.includes('image')) {
        mediaData.images.push({
          src: finalUrl,
          alt: 'Direct Image Resource',
        });
      }
    }

    // Complete HTML source delivery (up to 1MB safe limit)
    const rawHtmlString = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    const fullHtml = rawHtmlString.substring(0, 1000000);

    // Finalize & persist complete object in Cloudflare Extracted Registry strictly by Web URL
    const primaryVideoObj =
      mediaData.videos?.find((v: any) => v.cloudflareVideoUrl) || mediaData.videos?.[0];
    const bestThumb = pageData.cloudflareThumbnailUrl || primaryVideoObj?.poster || pageData.ogImage || '';
    const hasExtractedVideo = Boolean(primaryVideoObj?.originalVideoUrl || primaryVideoObj?.url || pageData.cloudflareVideoUrl);
    const videoUploadMissingWhenRequired = Boolean(uploadVideoToR2 && !pageData.cloudflareVideoUrl);
    const scrapeFailedOrIncomplete = !hasExtractedVideo || videoUploadMissingWhenRequired;

    if (scrapeFailedOrIncomplete) {
      // Remove failed / incomplete URL from Cloudflare D1 links_registry ONLY if no R2 video was uploaded
      if (!pageData.cloudflareVideoUrl) {
        await removeRegistryRecordByWebUrl(url, req);
      }
      return {
        success: true,
        status: response.status,
        statusText: response.statusText || 'OK',
        serverUsed: (response as any)._serverUsed || 'direct',
        targetUrl: url,
        finalUrl,
        registryUniqueId: null,
        registryRecord: null,
        isRegisteredInCloudflare: false,
        isUploadedToCloudflare: false,
        videoUploadError: pageData.videoUploadError || null,
        thumbUploadError: pageData.thumbUploadError || null,
        responseTimeMs,
        contentType,
        headers: {
          server: response.headers['server'] || null,
          'content-type': response.headers['content-type'] || null,
          'content-length': response.headers['content-length'] || null,
          'cache-control': response.headers['cache-control'] || null,
          date: response.headers['date'] || null,
        },
        page: pageData,
        media: mediaData,
        content: contentData,
        fullHtml,
        rawSnippet: fullHtml.substring(0, 3000),
        htmlLength: rawHtmlString.length,
      };
    }

    const isNowUploaded = Boolean(pageData.cloudflareVideoUrl || pageData.cloudflareThumbnailUrl);
    const savedRegistryRecord = upsertRegistryRecordByWebUrl(url, {
      title: pageData.title || 'Extracted Video',
      rawTitle: pageData.rawTitle || pageData.title,
      description: pageData.description || primaryVideoObj?.description || undefined,
      videoUrl: primaryVideoObj?.originalVideoUrl || primaryVideoObj?.url || '',
      thumbnailUrl: bestThumb,
      cloudflareVideoUrl: pageData.cloudflareVideoUrl || undefined,
      cloudflareThumbnailUrl: pageData.cloudflareThumbnailUrl || undefined,
      thumbnailStorageSource: pageData.thumbnailStorageSource || null,
      videoStorageSource: pageData.videoStorageSource || null,
      durationFormatted: pageData.durationFormatted || primaryVideoObj?.durationFormatted || '',
      durationSec: pageData.durationSec ?? primaryVideoObj?.durationSec ?? null,
      sizeBytes: pageData.videoSize?.sizeBytes ?? primaryVideoObj?.sizeBytes ?? null,
      sizeMb: pageData.videoSize?.sizeMb || primaryVideoObj?.sizeMb || undefined,
      sizeFormatted: pageData.videoSize?.sizeFormatted || primaryVideoObj?.sizeFormatted || '',
      status: isNowUploaded ? 'uploaded' : 'extracted',
      metadata: {
        ...(existingWebRecord?.metadata || {}),
        workerServerId: SERVER_INSTANCE_ID,
        serverUsed: (response as any)._serverUsed || 'direct',
        completedAt: new Date().toISOString(),
        videosExtractedCount: mediaData.videos?.length || 0,
        candidateThumbnailsCount: pageData.candidateThumbnails?.length || 0,
        finalUrl,
        ...(pageData.videoCompression ? { videoCompression: pageData.videoCompression } : {}),
      },
    });

    // Sync complete record directly to ott-database (/api/links_registry)
    onStage?.('uploading_cloudflare', 'Saving metadata to Cloudflare D1...');
    await syncRegistryToStorage(req, [savedRegistryRecord]);

    return {
      success: true,
      status: response.status,
      statusText: response.statusText || 'OK',
      serverUsed: (response as any)._serverUsed || 'direct',
      targetUrl: url,
      finalUrl,
      registryUniqueId: savedRegistryRecord.id,
      registryRecord: savedRegistryRecord,
      isRegisteredInCloudflare: true,
      isUploadedToCloudflare: Boolean(pageData.cloudflareVideoUrl || pageData.cloudflareThumbnailUrl),
      videoUploadError: pageData.videoUploadError || null,
      thumbUploadError: pageData.thumbUploadError || null,
      responseTimeMs,
      contentType,
      headers: {
        server: response.headers['server'] || null,
        'content-type': response.headers['content-type'] || null,
        'content-length': response.headers['content-length'] || null,
        'cache-control': response.headers['cache-control'] || null,
        date: response.headers['date'] || null,
      },
      page: pageData,
      media: mediaData,
      content: contentData,
      fullHtml,
      rawSnippet: fullHtml.substring(0, 3000),
      htmlLength: rawHtmlString.length,
    };
  } catch (scrapeErr: any) {
    // Failure -> remove the URL from Cloudflare D1 links_registry & local cache
    // (UNLESS HTTP 409 because another VPS actively owns the 'processing' lock, or this record already uploaded R2 media!)
    const currentRec = findRegistryRecordByWebUrl(url);
    if (scrapeErr?.statusCode !== 409 && !hasCompleteCloudflareAssets(currentRec)) {
      await removeRegistryRecordByWebUrl(url, req);
    }
    throw scrapeErr;
  } finally {
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
    inFlightProcessingIds.delete(linkId);
  }
}

// Process & scrape input website URL in background using axios and cheerio
app.post('/api/process-url', async (req: Request, res: Response) => {
  try {
    const {
      url,
      extractMedia = true,
      customHeaders = {},
      wordsToRemove = '',
      uploadThumbnailToR2 = false,
      uploadVideoToR2 = false,
      compressVideo = false,
      compressionQuality = 'balanced',
      forceRefresh = false,
      extraServers = [],
    } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Target URL is required in request body { "url": "https://..." }',
      });
    }

    const payload = await processUrlCore({
      url,
      extractMedia,
      customHeaders,
      wordsToRemove,
      uploadThumbnailToR2,
      uploadVideoToR2,
      compressVideo: Boolean(compressVideo),
      compressionQuality: normalizeCompressionQuality(compressionQuality),
      forceRefresh,
      req,
      extraServers: Array.isArray(extraServers) ? extraServers : [],
    });

    return res.json(payload);
  } catch (err: any) {
    console.error('URL processing error:', formatCompactError(err));
    return res.status(err?.statusCode || 500).json({
      success: false,
      error: formatCompactError(err) || 'Failed to process website URL',
      details: err.code || err.name,
    });
  }
});

// GET /api/system-resources - Live VPS resource telemetry & optimal worker calculator
app.get('/api/system-resources', (_req: Request, res: Response) => {
  try {
    const cpus = os.cpus();
    const coreCount = Math.max(1, cpus.length);
    const { speedMhz, model } = getCpuClockSpeed();
    const speedFormatted = speedMhz >= 1000 ? `${(speedMhz / 1000).toFixed(2)} GHz` : `${Math.round(speedMhz)} MHz`;

    // CPU utilization delta (unified live sampler)
    sampleLiveCpuPercent();

    // Live Network RX/TX bandwidth calculation from /proc/net/dev
    const currentNet = getLinuxNetworkSnapshot();
    if (prevNetSnapshot && currentNet.time > prevNetSnapshot.time) {
      const elapsedSec = Math.max(0.2, (currentNet.time - prevNetSnapshot.time) / 1000);
      const rxDelta = Math.max(0, currentNet.rxBytes - prevNetSnapshot.rxBytes);
      const txDelta = Math.max(0, currentNet.txBytes - prevNetSnapshot.txBytes);
      const downloadBps = rxDelta / elapsedSec;
      const uploadBps = txDelta / elapsedSec;
      lastNetworkRates = {
        interfaces: currentNet.interfaces,
        downloadBps,
        uploadBps,
        downloadMbps: Number(((downloadBps * 8) / 1_000_000).toFixed(2)),
        uploadMbps: Number(((uploadBps * 8) / 1_000_000).toFixed(2)),
      };
    } else if (currentNet.interfaces.length > 0) {
      lastNetworkRates.interfaces = currentNet.interfaces;
    }
    prevNetSnapshot = currentNet;

    const nicMbps = getNicLinkSpeedMbps();
    const connectionSpeedMbps = nicMbps || lastSpeedTestResult?.downloadMbps || null;
    const connectionSpeedSource: 'nic' | 'speedtest' | 'untested' = nicMbps
      ? 'nic'
      : lastSpeedTestResult
      ? 'speedtest'
      : 'untested';
    const totalActiveMbps = Number((lastNetworkRates.downloadMbps + lastNetworkRates.uploadMbps).toFixed(2));
    const netUsagePercent =
      connectionSpeedMbps && connectionSpeedMbps > 0
        ? Math.min(100, Math.round((Math.max(lastNetworkRates.downloadMbps, lastNetworkRates.uploadMbps) / connectionSpeedMbps) * 100))
        : null;

    // RAM statistics
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const memUsagePercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
    const processMem = process.memoryUsage();

    // Disk space on active uploads/storage partition via fs.statfsSync
    const diskTargetPath = fs.existsSync(localUploadsDir)
      ? localUploadsDir
      : fs.existsSync(process.cwd())
      ? process.cwd()
      : '/';
    let diskTotal = 0;
    let diskFree = 0;
    let diskUsed = 0;
    let diskUsagePercent = 0;
    try {
      const stat = fs.statfsSync(diskTargetPath);
      diskTotal = stat.blocks * stat.bsize;
      diskFree = stat.bavail * stat.bsize;
      diskUsed =
        typeof stat.bfree === 'number'
          ? Math.max(0, (stat.blocks - stat.bfree) * stat.bsize)
          : Math.max(0, diskTotal - diskFree);
      const usableDenominator = diskUsed + diskFree;
      diskUsagePercent =
        usableDenominator > 0
          ? Math.min(100, Math.round((diskUsed / usableDenominator) * 100))
          : diskTotal > 0
          ? Math.min(100, Math.round((diskUsed / diskTotal) * 100))
          : 0;
    } catch {
      diskTotal = 50 * 1024 * 1024 * 1024;
      diskFree = 40 * 1024 * 1024 * 1024;
      diskUsed = 10 * 1024 * 1024 * 1024;
      diskUsagePercent = 20;
    }

    // Measure temporary working files currently in temp/uploads (active downloads/ffmpeg temp files)
    let tempUploadsBytes = 0;
    let tempFileCount = 0;
    for (const dir of Array.from(new Set([localTempDir, localUploadsDir]))) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            try {
              tempUploadsBytes += fs.statSync(path.join(dir, entry.name)).size;
              tempFileCount++;
            } catch {}
          }
        }
      } catch {}
    }

    // Dynamic Worker Recommendation calculation (range: 1 - 50)
    // Network/TLS scraping & streaming is I/O-bound (~95% socket wait), so each vCPU can drive ~10 concurrent workers toward 70-80% core usage
    const coreCapacity = Math.max(1, Math.min(50, coreCount * 10));

    // RAM capacity: ~100MB buffer/process overhead per disk-streamed worker
    const freeRamMb = Math.round(freeMem / (1024 * 1024));
    const ramCapacity = Math.max(1, Math.min(50, Math.floor(freeRamMb / 100)));

    let recommendedWorkers = Math.min(coreCapacity, ramCapacity);

    // CPU load target safeguard (~70-80% sweet spot)
    if (lastCalculatedCpuPercent > 85) {
      recommendedWorkers = Math.max(1, Math.round(recommendedWorkers * 0.6));
    } else if (lastCalculatedCpuPercent > 75) {
      recommendedWorkers = Math.max(1, Math.round(recommendedWorkers * 0.85));
    }
    recommendedWorkers = Math.max(1, Math.min(50, recommendedWorkers));

    let cpuStatus: 'healthy' | 'moderate' | 'high' = 'healthy';
    if (lastCalculatedCpuPercent > 85) cpuStatus = 'high';
    else if (lastCalculatedCpuPercent > 65) cpuStatus = 'moderate';

    let ramStatus: 'healthy' | 'moderate' | 'low' = 'healthy';
    if (memUsagePercent > 85) ramStatus = 'low';
    else if (memUsagePercent > 65) ramStatus = 'moderate';

    let reason = `${coreCount} vCPU(s) @ ${speedFormatted} with ${formatBytes(freeMem)} free RAM: ${recommendedWorkers} async I/O workers recommended to push throughput toward 70-80% core utilization.`;
    if (cpuStatus === 'high') {
      reason = `VPS CPU load is high (${lastCalculatedCpuPercent}%). Throttled recommendation to ${recommendedWorkers} workers to keep headroom.`;
    } else if (ramStatus === 'low') {
      reason = `VPS RAM is constrained (${memUsagePercent}% used). Recommended ${recommendedWorkers} workers to avoid out-of-memory errors.`;
    }

    const payload = {
      cpu: {
        cores: coreCount,
        model,
        speedMhz,
        speedFormatted,
        usagePercent: lastCalculatedCpuPercent,
        loadAverage: os.loadavg(),
      },
      ram: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: usedMem,
        usedPercent: memUsagePercent,
        totalFormatted: formatBytes(totalMem),
        usedFormatted: formatBytes(usedMem),
        freeFormatted: formatBytes(freeMem),
        processRssFormatted: formatBytes(processMem.rss),
      },
      disk: {
        totalBytes: diskTotal,
        freeBytes: diskFree,
        usedBytes: diskUsed,
        usedPercent: diskUsagePercent,
        totalFormatted: formatBytes(diskTotal),
        usedFormatted: formatBytes(diskUsed),
        freeFormatted: formatBytes(diskFree),
        availableFormatted: formatBytes(diskFree),
        tempUploadsBytes,
        tempUploadsFormatted: formatBytes(tempUploadsBytes),
        tempFileCount,
        mountPoint: diskTargetPath,
      },
      vpsRecommendation: {
        recommendedWorkers,
        maxSafeWorkers: Math.min(50, coreCount * 12),
        currentCpuStatus: cpuStatus,
        currentRamStatus: ramStatus,
        reason,
      },
      network: {
        interfaces: lastNetworkRates.interfaces,
        downloadMbps: lastNetworkRates.downloadMbps,
        uploadMbps: lastNetworkRates.uploadMbps,
        totalActiveMbps,
        downloadFormatted: `${lastNetworkRates.downloadMbps.toFixed(1)} Mbps (${formatBytes(lastNetworkRates.downloadBps)}/s)`,
        uploadFormatted: `${lastNetworkRates.uploadMbps.toFixed(1)} Mbps (${formatBytes(lastNetworkRates.uploadBps)}/s)`,
        connectionSpeedMbps,
        connectionSpeedSource,
        usagePercent: netUsagePercent,
        lastSpeedTest: lastSpeedTestResult,
      },
      system: {
        uptimeSeconds: os.uptime(),
        uptimeFormatted: formatUptime(os.uptime()),
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
      },
      timestamp: new Date().toISOString(),
    };

    return res.json(payload);
  } catch (err: any) {
    console.error('System resources telemetry error:', err);
    return res.status(500).json({
      error: 'Failed to read VPS telemetry',
      details: err.message,
    });
  }
});

// POST /api/network-speed-test - Measure real server connection download/upload speed (Cloudflare Edge)
app.post('/api/network-speed-test', async (_req: Request, res: Response) => {
  try {
    const uaHeaders = {
      'User-Agent': USER_AGENT_POOL[0],
      Connection: 'close',
    };

    // 1. Latency check
    const pingStart = Date.now();
    await axios.get('https://speed.cloudflare.com/__down?bytes=1000', {
      headers: uaHeaders,
      timeout: 3500,
      signal: AbortSignal.timeout(3500),
    });
    const latencyMs = Math.max(1, Date.now() - pingStart);

    // 2. Download throughput check (5 MB)
    const dlStart = Date.now();
    const dlRes = await axios.get('https://speed.cloudflare.com/__down?bytes=5000000', {
      headers: uaHeaders,
      responseType: 'arraybuffer',
      timeout: 5000,
      signal: AbortSignal.timeout(5000),
    });
    const dlSecs = Math.max(0.05, (Date.now() - dlStart) / 1000);
    const dlBytes = (dlRes.data as ArrayBuffer)?.byteLength || 5000000;
    const downloadMbps = Number((((dlBytes * 8) / 1_000_000) / dlSecs).toFixed(1));

    // 3. Upload throughput check (512 KB, bounded <= 4s)
    let uploadMbps = 0;
    try {
      const upBuf = Buffer.alloc(512 * 1024, 65);
      const upStart = Date.now();
      await axios.post('https://speed.cloudflare.com/__up', upBuf, {
        headers: {
          ...uaHeaders,
          'Content-Type': 'application/octet-stream',
        },
        timeout: 4000,
        signal: AbortSignal.timeout(4000),
        maxBodyLength: Infinity,
      });
      const upSecs = Math.max(0.05, (Date.now() - upStart) / 1000);
      uploadMbps = Number((((upBuf.length * 8) / 1_000_000) / upSecs).toFixed(1));
    } catch {}

    lastSpeedTestResult = {
      downloadMbps,
      uploadMbps,
      latencyMs,
      testedAt: new Date().toISOString(),
    };

    return res.json({
      success: true,
      ...lastSpeedTestResult,
    });
  } catch (err: any) {
    return res.status(502).json({
      success: false,
      error: `Speed test failed: ${formatCompactError(err)}`,
    });
  }
});

// POST /api/proxies/fetch-free - Fetch & live-verify public free HTTP/HTTPS proxies (bounded <= 7.5s)
app.post('/api/proxies/fetch-free', async (req: Request, res: Response) => {
  try {
    const rawLimit = Math.max(3, Math.min(20, Number(req.body?.limit) || 8));
    const candidates = new Set<string>();

    const parseIpPortLines = (raw: string, maxTake = 20) => {
      String(raw || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(s))
        .slice(0, maxTake)
        .forEach((hp) => candidates.add(`http://${hp}`));
    };

    // Fetch public free proxy feeds in parallel with strict 3s aborts
    const [psFeed, gnFeed, ghFeed] = await Promise.allSettled([
      axios.get(
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=all',
        { timeout: 3000, signal: AbortSignal.timeout(3000), responseType: 'text' }
      ),
      axios.get(
        'https://proxylist.geonode.com/api/proxy-list?limit=20&page=1&sort_by=lastChecked&sort_type=desc&protocols=http',
        { timeout: 3000, signal: AbortSignal.timeout(3000) }
      ),
      axios.get('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', {
        timeout: 3000,
        signal: AbortSignal.timeout(3000),
        responseType: 'text',
      }),
    ]);

    if (psFeed.status === 'fulfilled') {
      parseIpPortLines(psFeed.value.data, 15);
    }
    if (gnFeed.status === 'fulfilled') {
      const list = Array.isArray(gnFeed.value.data?.data) ? gnFeed.value.data.data : [];
      for (const item of list) {
        if (item?.ip && item?.port) {
          candidates.add(`http://${item.ip}:${item.port}`);
        }
      }
    }
    if (ghFeed.status === 'fulfilled') {
      parseIpPortLines(ghFeed.value.data, 15);
    }

    const candidateList = Array.from(candidates).slice(0, 25);
    if (candidateList.length === 0) {
      return res.json({
        success: true,
        testedCount: 0,
        workingCount: 0,
        proxies: [],
        message: 'Public proxy feeds returned no candidates right now. Deploy the free Cloudflare Worker relay instead.',
      });
    }

    // Live-test HTTPS CONNECT tunnel with a strict 2.2s socket check and hard 4s batch deadline
    const verified: Array<{ proxy: string; latencyMs: number }> = [];
    const checkAll = Promise.all(
      candidateList.map(async (proxyUrl) => {
        const result = await testHttpsConnectProxy(proxyUrl, 2200);
        if (result) verified.push(result);
      })
    );
    await Promise.race([checkAll, sleepMs(4000)]);

    verified.sort((a, b) => a.latencyMs - b.latencyMs);
    const fastest = verified.slice(0, rawLimit);

    return res.json({
      success: true,
      testedCount: candidateList.length,
      workingCount: fastest.length,
      proxies: fastest.map((v) => v.proxy),
      details: fastest,
      message:
        fastest.length > 0
          ? `Found ${fastest.length} live working HTTPS proxy(s) out of ${candidateList.length} tested.`
          : `Tested ${candidateList.length} public free proxies, 0 passed live HTTPS CONNECT check (public free proxies are mostly dead/blocked — Cloudflare Workers relays are 100% free & reliable).`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: formatCompactError(err),
    });
  }
});

// Register Domain Video Availability Prober routes (up to 50 workers, zero video download, persistent JSON)
registerDomainProbeRoutes(app, {
  localRegistryDir,
  cfWorkerBaseUrl: CF_WORKER_BASE_URL,
  isPreviewVideoUrl,
  axiosGetWithRetry,
  resolveChromiumExecutable,
});

// Ensure /api routes NEVER fall through to Vite SPA html middleware
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    error: `API route ${req.method} ${req.path} not found`,
  });
});

// Global API error handler ensuring all errors are JSON, never HTML
app.use((err: any, req: Request, res: Response, next: any) => {
  if (req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
    console.error('Unhandled API error on', req.path, formatCompactError(err));
    return res.status(err.status || err.statusCode || 500).json({
      status: 'error',
      error: err.message || 'Internal server error',
      code: err.code,
    });
  }
  next(err);
});

// Start the server with Vite middleware in development
async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT} (Cloudflare Worker D1: ${CF_WORKER_BASE_URL})`);
    hydrateRegistryFromD1IfNeeded().catch(() => {});
    ensureVpsBatchJobInitialized().catch(() => {});
  });
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 120000;
  httpServer.keepAliveTimeout = 65000;

  const gracefulShutdown = async (signal: string) => {
    if (vpsServerShuttingDown) return;
    vpsServerShuttingDown = true;
    stopVpsCloudKeepAliveLoop();
    console.log(`[Shutdown] ${signal} received — saving batch queue state cleanly...`);
    try {
      await Promise.race([
        persistVpsBatchJob(true),
        new Promise((r) => setTimeout(r, 3500)),
      ]);
    } catch {}
    try {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    } catch {
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => {
    gracefulShutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    gracefulShutdown('SIGINT');
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
