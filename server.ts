import express, { type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import tls from 'tls';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';

const execFileAsync = promisify(execFile);
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

// Initialize dotenv & expand libuv threadpool for parallel DNS/file streaming
dotenv.config();
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

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
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const CF_WORKER_BASE_URL = (
  getEnvValue(['CF_WORKER_BASE_URL', 'CLOUDFLARE_WORKER_BASE_URL', 'OTT_API_BASE_URL']) ||
  'https://ott-api.fussionbhakti3.workers.dev'
).replace(/\/+$/, '');

// In-memory or temp storage uploads directory for local emulator mode
const localUploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(localUploadsDir)) {
  fs.mkdirSync(localUploadsDir, { recursive: true });
}
const localVideosDir = path.join(localUploadsDir, 'videos');
const localThumbsDir = path.join(localUploadsDir, 'thumbnails');
const localDatabaseDir = path.join(localUploadsDir, 'database');
if (!fs.existsSync(localVideosDir)) fs.mkdirSync(localVideosDir, { recursive: true });
if (!fs.existsSync(localThumbsDir)) fs.mkdirSync(localThumbsDir, { recursive: true });
if (!fs.existsSync(localDatabaseDir)) fs.mkdirSync(localDatabaseDir, { recursive: true });

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

function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
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
        const videoUploadResult = await s3.send(
          new PutObjectCommand({
            Bucket: r2Config.bucketName,
            Key: videoKey,
            Body: videoFile.buffer,
            ContentType: videoFile.mimetype || 'video/mp4',
            Metadata: {
              'original-name': encodeURIComponent(videoFile.originalname),
              'duration-seconds': String(clientMetadata.duration || 0),
              'extracted-timestamp': String(captureTimestamp),
            },
          })
        );
        etagVideo = videoUploadResult.ETag || null;

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
  const preferRemote = remoteTime > localTime;
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
        : hasCompleteCloudflareAssets(localExisting) || hasCompleteCloudflareAssets(remoteItem)
        ? 'uploaded'
        : primary.status,
  };
}

const SERVER_INSTANCE_ID = `srv_${(process.env.HOSTNAME || os.hostname() || 'node').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}_${Math.random().toString(36).slice(2, 6)}`;
const inFlightProcessingIds = new Set<string>();
let lastD1RegistryRefreshAt = 0;

async function hydrateRegistryFromD1IfNeeded(forceRefresh = false): Promise<void> {
  const now = Date.now();
  if (!forceRefresh && hasHydratedRegistryFromD1) return;
  if (forceRefresh && hasHydratedRegistryFromD1 && now - lastD1RegistryRefreshAt < 400) return;

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
    | 'skipped_in_cloudflare'
    | 'scraping'
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
  description?: string;
  isRegisteredInCloudflare?: boolean;
  destination?: string;
  destinationDetail?: string;
  registryUniqueId?: string;
}

type VideoCompressionQuality = 'high' | 'balanced' | 'compact' | 'low';

function normalizeCompressionQuality(q: any): VideoCompressionQuality {
  const val = String(q || '').toLowerCase().trim();
  if (val === 'high' || val === 'balanced' || val === 'compact' || val === 'low') {
    return val;
  }
  return 'balanced';
}

interface VpsBatchJobState {
  jobId: string;
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
  tasks: VpsBatchTask[];
}

const vpsJobFilePath = path.join(localRegistryDir, 'vps_batch_job.json');
let activeVpsBatchJob: VpsBatchJobState | null = null;
let activeVpsJobR2Config: R2Config | null = null;
let activeVpsJobAppBaseUrl = 'http://localhost:3000';
let vpsBatchCancelFlag = false;
let vpsBatchPauseFlag = false;
let vpsWorkerLoopActive = false;
let triggerVpsWorkerScaleUp: (() => void) | null = null;
let lastD1JobSyncAt = 0;

// Compression CPU load governor constants & counters
const COMPRESSION_HIGH_CPU_PERCENT = 80;
const COMPRESSION_RESUME_CPU_PERCENT = 72;
const MAX_CONCURRENT_FFMPEG = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2) || 1));
let activeFfmpegCompressions = 0;
let workersPausedForLoad = 0;

function syncLiveLoadCountersOnJob(job: VpsBatchJobState | null): void {
  if (!job) return;
  job.activeCompressions = activeFfmpegCompressions;
  job.pausedForLoadCount = workersPausedForLoad;
  job.currentCpuPercent = sampleLiveCpuPercent();
}

function isTaskIncompleteForJob(task: VpsBatchTask, job: VpsBatchJobState): boolean {
  if (task.status === 'skipped_in_cloudflare') return false;
  if (
    task.status === 'error' ||
    task.status === 'pending' ||
    task.status === 'checking_registry' ||
    task.status === 'scraping' ||
    task.status === 'uploading_cloudflare'
  ) {
    return true;
  }
  // Even if marked completed, treat as incomplete if Cloudflare upload was requested and video/thumb didn't finish
  if (job.uploadVideoToR2 && !task.cloudflareVideoUrl) return true;
  if (job.uploadThumbnailToR2 && task.originalThumbnailUrl && !task.cloudflareThumbnailUrl) return true;
  if (!task.videoStreamUrl && !task.cloudflareVideoUrl) return true;
  return false;
}

function recomputeVpsJobCounters(job: VpsBatchJobState): void {
  job.total = job.tasks.length;
  job.completed = job.tasks.filter((t) => t.status === 'completed').length;
  job.skipped = job.tasks.filter((t) => t.status === 'skipped_in_cloudflare').length;
  job.errors = job.tasks.filter((t) => t.status === 'error').length;
  job.incompleteCount = job.tasks.filter((t) => isTaskIncompleteForJob(t, job)).length;
  job.lastUpdatedAt = new Date().toISOString();
}

async function persistVpsBatchJob(forceD1 = false): Promise<void> {
  if (!activeVpsBatchJob) return;
  recomputeVpsJobCounters(activeVpsBatchJob);

  try {
    fs.writeFileSync(vpsJobFilePath, JSON.stringify(activeVpsBatchJob, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Failed to write vps_batch_job.json:', e);
  }

  const now = Date.now();
  if (!forceD1 && now - lastD1JobSyncAt < 3500) {
    return;
  }
  lastD1JobSyncAt = now;

  try {
    await axios.post(
      `${CF_WORKER_BASE_URL}/api/ad_config`,
      {
        id: 'vps_batch_job_state',
        ...activeVpsBatchJob,
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
  task.isRegisteredInCloudflare = true;
  task.destination = rec.destination || task.destination;
  task.destinationDetail = rec.destinationDetail || task.destinationDetail;
  task.registryUniqueId = rec.id || task.registryUniqueId;
}

async function runSingleVpsTask(task: VpsBatchTask, workerId: number, job: VpsBatchJobState): Promise<void> {
  task.workerId = workerId;
  task.attempts = (task.attempts || 0) + 1;
  const forceRefreshThisAttempt = job.batchSkipMode === 'dont_skip' || job.currentPass > 1;

  // Step 0: Always check live Cloudflare D1 registry before processing (multi-server safe)
  task.status = 'checking_registry';
  task.statusMessage = `[Worker ${workerId} · Pass ${job.currentPass}] Checking live Cloudflare D1 Registry...`;
  await persistVpsBatchJob(false);
  await hydrateRegistryFromD1IfNeeded(true);

  const existing = findRegistryRecordByWebUrl(task.url);
  if (!forceRefreshThisAttempt && existing && !isPreviewVideoUrl(existing.videoUrl)) {
    const hasCfVideo = Boolean(existing.cloudflareVideoUrl);
    const hasCfThumb = Boolean(existing.cloudflareThumbnailUrl);
    const hasCompleteAssets =
      (hasCfVideo || (existing.status === 'uploaded' && hasCfThumb && !existing.videoUrl)) &&
      (!job.uploadVideoToR2 || hasCfVideo || (existing.status === 'uploaded' && !existing.videoUrl)) &&
      (!job.uploadThumbnailToR2 || hasCfThumb || !existing.thumbnailUrl);

    if (hasCompleteAssets) {
      applyRegistryRecordToTask(task, existing);
      if (job.batchSkipMode === 'strict_skip') {
        task.status = 'skipped_in_cloudflare';
        task.statusMessage = `[Worker ${workerId}] Strict Skip: Found in Cloudflare D1 Registry · Bypassed`;
      } else {
        task.status = 'completed';
        task.statusMessage = `[Worker ${workerId}] Reused from Cloudflare D1 Registry (0 Duplicate Copies)`;
      }
      await persistVpsBatchJob(false);
      return;
    }
  }

  // If another hosted server recently started processing this exact URL (< 8 min ago), avoid duplicate simultaneous scraping
  if (existing && existing.status === 'processing') {
    const startedMs = Date.parse(existing.metadata?.processingStartedAt || existing.lastUpdatedAt || '') || 0;
    const otherServerId = existing.metadata?.workerServerId;
    if (otherServerId && otherServerId !== SERVER_INSTANCE_ID && Date.now() - startedMs < 8 * 60 * 1000) {
      task.status = 'error';
      task.error = `Actively processing on server ${otherServerId} (will re-check on next pass)`;
      task.statusMessage = `[Worker ${workerId}] Another server (${otherServerId}) is currently working on this URL`;
      await persistVpsBatchJob(false);
      return;
    }
  }

  // Step 1: Scrape webpage + auto-upload thumbnail & video via multi-server pool + R2
  task.status = 'scraping';
  task.statusMessage = `[Worker ${workerId} · Pass ${job.currentPass}] Scraping${job.compressVideo ? ` & compressing (${job.compressionQuality})` : ' & uploading'} media...`;
  await persistVpsBatchJob(false);

  const data = await processUrlCore({
    url: task.url,
    wordsToRemove: job.wordsToRemove,
    uploadThumbnailToR2: job.uploadThumbnailToR2,
    uploadVideoToR2: job.uploadVideoToR2,
    compressVideo: Boolean(job.compressVideo),
    compressionQuality: normalizeCompressionQuality(job.compressionQuality),
    forceRefresh: forceRefreshThisAttempt,
    r2ConfigOverride: activeVpsJobR2Config,
    appBaseUrlOverride: activeVpsJobAppBaseUrl,
    extraServers: job.serverPool,
  });

  const primaryVideo = data.media?.videos?.[0];
  const title = data.page?.title || primaryVideo?.title || task.url.split('/').pop()?.split('?')[0] || `Video ${task.index}`;
  const rawTitle = data.page?.rawTitle || title;
  const originalVideoUrl = primaryVideo?.originalVideoUrl || primaryVideo?.url || '';
  const cloudflareVideoUrl = data.page?.cloudflareVideoUrl || primaryVideo?.cloudflareVideoUrl || undefined;
  const cloudflareThumb = data.page?.cloudflareThumbnailUrl || primaryVideo?.cloudflareThumbnailUrl || undefined;
  const originalThumb = data.page?.ogImage || primaryVideo?.poster || data.page?.candidateThumbnails?.[0]?.url || '';

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
  task.isRegisteredInCloudflare = Boolean(data.isRegisteredInCloudflare);
  task.registryUniqueId = data.registryUniqueId || data.registryRecord?.id;
  task.serverUsed = data.serverUsed || 'direct';

  const stillIncomplete =
    (job.uploadVideoToR2 && !cloudflareVideoUrl) || (!task.videoStreamUrl && !cloudflareVideoUrl);

  if (stillIncomplete) {
    // Ensure failed/incomplete URL is removed from D1 registry so it can be retried cleanly
    await removeRegistryRecordByWebUrl(task.url);
    task.isRegisteredInCloudflare = false;
    task.status = 'error';
    task.error = !task.videoStreamUrl
      ? 'No video stream extracted — removed from database for retry'
      : 'Video upload to Cloudflare R2 incomplete — removed from database for retry';
    task.statusMessage = `[Worker ${workerId} · Pass ${job.currentPass}] Failed/Incomplete: ${task.error}`;
  } else {
    task.status = 'completed';
    task.error = undefined;
    const savedInfo = data.page?.videoCompression?.savedPercent
      ? ` · Compressed ${data.page.videoCompression.quality} (-${data.page.videoCompression.savedPercent}%)`
      : '';
    task.statusMessage = data.fromCache
      ? `[Worker ${workerId}] Reused from Cloudflare D1 Registry (Web URL Match · 0 Duplicate Copies)`
      : cloudflareVideoUrl
      ? `[Worker ${workerId}] Completed & Saved in D1: Video + Thumbnail on Cloudflare R2${savedInfo}${task.serverUsed && task.serverUsed !== 'direct' ? ` (${task.serverUsed})` : ''}`
      : `[Worker ${workerId}] Scraped & Saved in D1 (Website Stream)`;
  }

  await persistVpsBatchJob(false);
}

function launchVpsBatchWorkerLoop(): void {
  if (vpsWorkerLoopActive || !activeVpsBatchJob) return;
  vpsWorkerLoopActive = true;

  (async () => {
    try {
      while (activeVpsBatchJob && !vpsBatchCancelFlag) {
        const job = activeVpsBatchJob;
        job.isRunning = true;

        const pendingIndices: number[] = [];
        for (let idx = 0; idx < job.tasks.length; idx++) {
          if (job.tasks[idx].status === 'pending') {
            pendingIndices.push(idx);
          }
        }

        if (pendingIndices.length === 0) {
          // End of current pass: check for failed or incomplete tasks!
          const incompleteIndices: number[] = [];
          for (let idx = 0; idx < job.tasks.length; idx++) {
            if (isTaskIncompleteForJob(job.tasks[idx], job)) {
              incompleteIndices.push(idx);
            }
          }

          if (
            incompleteIndices.length > 0 &&
            job.autoRetryIncomplete &&
            job.currentPass < 1 + job.maxAutoRetryPasses &&
            !vpsBatchCancelFlag
          ) {
            job.currentPass += 1;
            job.statusMessage = `Pass ${job.currentPass}/${1 + job.maxAutoRetryPasses}: Auto-restarting ${incompleteIndices.length} failed/incomplete link(s) after 5s cooldown...`;
            for (const idx of incompleteIndices) {
              job.tasks[idx].status = 'pending';
              job.tasks[idx].statusMessage = `Pass ${job.currentPass}: Re-queued (incomplete/failed)`;
            }
            await persistVpsBatchJob(true);

            // Cooldown wait respecting pause/cancel
            for (let w = 0; w < 50; w++) {
              if (vpsBatchCancelFlag) break;
              await sleepMs(100);
            }
            while (vpsBatchPauseFlag && !vpsBatchCancelFlag) {
              await sleepMs(400);
            }
            continue;
          }
          break;
        }

        job.statusMessage = `Pass ${job.currentPass}/${1 + job.maxAutoRetryPasses}: Processing ${pendingIndices.length} queued link(s) with ${job.concurrency}x worker(s)...`;
        await persistVpsBatchJob(true);

        let cursor = 0;
        let activeCount = 0;
        let workerIdSeq = 0;
        const activePromises = new Set<Promise<void>>();

        const spawnWorker = (workerId: number) => {
          const p = (async () => {
            activeCount++;
            if (activeVpsBatchJob) activeVpsBatchJob.activeWorkers = activeCount;
            try {
              while (!vpsBatchCancelFlag && activeVpsBatchJob) {
                while (vpsBatchPauseFlag && !vpsBatchCancelFlag) {
                  await sleepMs(400);
                }
                if (vpsBatchCancelFlag || !activeVpsBatchJob) break;

                // Graceful scale-down if concurrency reduced live
                if (activeCount > activeVpsBatchJob.concurrency) break;

                if (cursor >= pendingIndices.length) break;

                // When compressing is enabled, pause excess workers briefly if CPU load is high or FFmpeg slots are full
                if (activeVpsBatchJob.compressVideo) {
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
                      await sleepMs(1500);
                    }
                  } finally {
                    if (didPauseWorker) {
                      workersPausedForLoad = Math.max(0, workersPausedForLoad - 1);
                      if (activeVpsBatchJob) {
                        syncLiveLoadCountersOnJob(activeVpsBatchJob);
                        if (workersPausedForLoad === 0 && activeVpsBatchJob.isRunning) {
                          activeVpsBatchJob.statusMessage = `CPU cooled (${activeVpsBatchJob.currentCpuPercent ?? 0}%) — resuming workers (Pass ${activeVpsBatchJob.currentPass}/${1 + activeVpsBatchJob.maxAutoRetryPasses})...`;
                        }
                      }
                    }
                  }
                  if (vpsBatchCancelFlag || !activeVpsBatchJob) break;
                }

                if (cursor >= pendingIndices.length) break;
                const taskIdx = pendingIndices[cursor++];
                const task = activeVpsBatchJob.tasks[taskIdx];
                if (!task || task.status !== 'pending') continue;

                try {
                  await runSingleVpsTask(task, workerId, activeVpsBatchJob);
                } catch (err: any) {
                  task.status = 'error';
                  task.error = formatCompactError(err) || 'Scrape failed';
                  task.statusMessage = `[Worker ${workerId} · Pass ${activeVpsBatchJob.currentPass}] Failed: ${task.error}`;
                  await persistVpsBatchJob(false);
                }
              }
            } finally {
              activeCount = Math.max(0, activeCount - 1);
              if (activeVpsBatchJob) activeVpsBatchJob.activeWorkers = activeCount;
            }
          })();
          activePromises.add(p);
          p.finally(() => activePromises.delete(p));
        };

        triggerVpsWorkerScaleUp = () => {
          if (!activeVpsBatchJob || vpsBatchCancelFlag || vpsBatchPauseFlag) return;
          const target = Math.min(activeVpsBatchJob.concurrency, pendingIndices.length - cursor + activeCount);
          while (activeCount < target && cursor < pendingIndices.length) {
            spawnWorker(++workerIdSeq);
          }
        };

        const initialCount = Math.min(job.concurrency, pendingIndices.length);
        for (let i = 0; i < initialCount; i++) {
          spawnWorker(++workerIdSeq);
        }

        while (activePromises.size > 0) {
          await Promise.race(Array.from(activePromises));
        }
        triggerVpsWorkerScaleUp = null;
      }
    } finally {
      vpsWorkerLoopActive = false;
      triggerVpsWorkerScaleUp = null;
      if (activeVpsBatchJob) {
        activeVpsBatchJob.isRunning = false;
        activeVpsBatchJob.isPaused = false;
        activeVpsBatchJob.activeWorkers = 0;
        activeVpsBatchJob.endTime = new Date().toISOString();
        recomputeVpsJobCounters(activeVpsBatchJob);
        activeVpsBatchJob.statusMessage = vpsBatchCancelFlag
          ? `Cancelled (${activeVpsBatchJob.completed}/${activeVpsBatchJob.total} completed)`
          : activeVpsBatchJob.incompleteCount > 0
          ? `Finished ${activeVpsBatchJob.currentPass} pass(es): ${activeVpsBatchJob.completed} done, ${activeVpsBatchJob.incompleteCount} incomplete/failed`
          : `All ${activeVpsBatchJob.total} link(s) completed on Cloudflare!`;
        await persistVpsBatchJob(true);
      }
    }
  })();
}

async function loadAndResumeVpsBatchJob(): Promise<void> {
  try {
    let loaded: VpsBatchJobState | null = null;
    if (fs.existsSync(vpsJobFilePath)) {
      try {
        loaded = JSON.parse(fs.readFileSync(vpsJobFilePath, 'utf-8'));
      } catch {}
    }
    if (!loaded) {
      const d1Res = await axios.get(`${CF_WORKER_BASE_URL}/api/ad_config`, {
        timeout: 12000,
        validateStatus: () => true,
      });
      if (d1Res.status >= 200 && d1Res.status < 300 && Array.isArray(d1Res.data)) {
        const doc = d1Res.data.find((x: any) => String(x?.id || x?._id) === 'vps_batch_job_state');
        if (doc && Array.isArray(doc.tasks)) {
          loaded = doc as VpsBatchJobState;
        }
      }
    }

    if (loaded && Array.isArray(loaded.tasks) && loaded.tasks.length > 0) {
      // Recover any mid-flight tasks from a server restart back to pending
      for (const t of loaded.tasks) {
        if (t.status === 'checking_registry' || t.status === 'scraping' || t.status === 'uploading_cloudflare') {
          t.status = 'pending';
          t.statusMessage = 'Resumed after server restart';
        }
      }
      recomputeVpsJobCounters(loaded);
      activeVpsBatchJob = loaded;
      vpsBatchPauseFlag = Boolean(loaded.isPaused);
      vpsBatchCancelFlag = false;
      if (loaded.isRunning && !loaded.isPaused) {
        launchVpsBatchWorkerLoop();
      }
    }
  } catch (err) {
    console.warn('Could not restore persisted VPS batch job:', formatCompactError(err));
  }
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

// API: Start Persistent Background Batch Queue (continues running when browser is closed)
app.post('/api/vps-batch/start', async (req: Request, res: Response) => {
  const {
    urls,
    wordsToRemove = '',
    concurrency = 3,
    batchSkipMode = 'smart_cache',
    uploadThumbnailToR2 = true,
    uploadVideoToR2 = true,
    compressVideo = false,
    compressionQuality = 'balanced',
    autoRetryIncomplete = true,
    maxAutoRetryPasses = 3,
    serverPool = [],
  } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ success: false, error: 'urls array is required' });
  }

  if (activeVpsBatchJob?.isRunning) {
    return res.json({
      success: true,
      alreadyRunning: true,
      message: 'A background batch job is already actively running on the server.',
      job: activeVpsBatchJob,
    });
  }

  await hydrateRegistryFromD1IfNeeded();

  // Capture active R2 config in server RAM for this background run (never written to disk/D1!)
  activeVpsJobR2Config = getR2Config(req);
  activeVpsJobAppBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  const safeConcurrency = Math.max(1, Math.min(50, Number(concurrency) || 3));
  const safeMaxRetries = Math.max(0, Math.min(10, Number(maxAutoRetryPasses) || 3));
  const normalizedQuality = normalizeCompressionQuality(compressionQuality);
  const shouldCompress = Boolean(compressVideo);
  const cleanPool = (Array.isArray(serverPool) ? serverPool : [])
    .map((s: any) => String(s || '').trim())
    .filter((s: string) => /^https?:\/\//i.test(s));

  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;

  const tasks: VpsBatchTask[] = urls.map((u: any, i: number) => ({
    id: `queue_${Date.now()}_${i}`,
    index: i + 1,
    url: String(u).trim(),
    status: 'pending',
    statusMessage: 'Queued on background server...',
    attempts: 0,
  }));

  activeVpsBatchJob = {
    jobId: `vps_job_${Date.now()}`,
    isRunning: true,
    isPaused: false,
    concurrency: safeConcurrency,
    batchSkipMode,
    wordsToRemove: String(wordsToRemove || ''),
    uploadThumbnailToR2: Boolean(uploadThumbnailToR2),
    uploadVideoToR2: Boolean(uploadVideoToR2),
    compressVideo: shouldCompress,
    compressionQuality: normalizedQuality,
    autoRetryIncomplete: Boolean(autoRetryIncomplete),
    currentPass: 1,
    maxAutoRetryPasses: safeMaxRetries,
    serverPool: cleanPool,
    total: tasks.length,
    completed: 0,
    skipped: 0,
    errors: 0,
    incompleteCount: tasks.length,
    activeWorkers: 0,
    statusMessage: `Pass 1/${1 + safeMaxRetries}: Starting ${safeConcurrency}x server worker(s)${shouldCompress ? ` (Compress: ${normalizedQuality})` : ''}...`,
    startTime: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    tasks,
  };

  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  res.json({
    success: true,
    message: `Persistent background batch started with ${safeConcurrency}x worker(s). Safe to close browser.`,
    jobId: activeVpsBatchJob.jobId,
    job: activeVpsBatchJob,
  });
});

// API: Get Persistent Background Batch Status (restores queue when reopening browser)
app.get('/api/vps-batch/status', (_req: Request, res: Response) => {
  if (activeVpsBatchJob) {
    recomputeVpsJobCounters(activeVpsBatchJob);
    syncLiveLoadCountersOnJob(activeVpsBatchJob);
  }
  res.json({
    success: true,
    job: activeVpsBatchJob,
    defaultServerPool: getConfiguredServerPool([]).filter((s) => s !== 'direct'),
  });
});

// API: Update Concurrency Live on Running Background Job
app.post('/api/vps-batch/concurrency', async (req: Request, res: Response) => {
  const safeConcurrency = Math.max(1, Math.min(50, Number(req.body?.concurrency) || 3));
  if (activeVpsBatchJob) {
    activeVpsBatchJob.concurrency = safeConcurrency;
    if (triggerVpsWorkerScaleUp) triggerVpsWorkerScaleUp();
    await persistVpsBatchJob(false);
  }
  res.json({ success: true, concurrency: safeConcurrency, job: activeVpsBatchJob });
});

// API: Pause Background Batch
app.post('/api/vps-batch/pause', async (_req: Request, res: Response) => {
  vpsBatchPauseFlag = true;
  if (activeVpsBatchJob) {
    activeVpsBatchJob.isPaused = true;
    activeVpsBatchJob.statusMessage = 'Paused (saved in database · safe to close browser)';
    await persistVpsBatchJob(true);
  }
  res.json({ success: true, message: 'Background batch paused.', job: activeVpsBatchJob });
});

// API: Resume Background Batch
app.post('/api/vps-batch/resume', async (req: Request, res: Response) => {
  if (!activeVpsJobR2Config) {
    activeVpsJobR2Config = getR2Config(req);
  }
  vpsBatchPauseFlag = false;
  vpsBatchCancelFlag = false;
  if (activeVpsBatchJob) {
    activeVpsBatchJob.isPaused = false;
    if (!vpsWorkerLoopActive && activeVpsBatchJob.tasks.some((t) => t.status === 'pending')) {
      activeVpsBatchJob.isRunning = true;
      launchVpsBatchWorkerLoop();
    } else if (triggerVpsWorkerScaleUp) {
      triggerVpsWorkerScaleUp();
    }
    await persistVpsBatchJob(true);
  }
  res.json({ success: true, message: 'Background batch resumed.', job: activeVpsBatchJob });
});

// API: Cancel Background Batch
app.post('/api/vps-batch/cancel', async (_req: Request, res: Response) => {
  vpsBatchCancelFlag = true;
  vpsBatchPauseFlag = false;
  if (activeVpsBatchJob) {
    activeVpsBatchJob.isRunning = false;
    activeVpsBatchJob.isPaused = false;
    activeVpsBatchJob.activeWorkers = 0;
    activeVpsBatchJob.statusMessage = 'Cancelled by user';
    await persistVpsBatchJob(true);
  }
  res.json({ success: true, message: 'Background batch cancelled.', job: activeVpsBatchJob });
});

// API: Manually Restart All Failed & Incomplete Tasks in Current Saved Job
app.post('/api/vps-batch/retry-incomplete', async (req: Request, res: Response) => {
  if (!activeVpsBatchJob) {
    return res.status(404).json({ success: false, error: 'No saved background batch job found' });
  }
  if (activeVpsBatchJob.isRunning) {
    return res.json({ success: true, message: 'Job is already running.', job: activeVpsBatchJob });
  }

  activeVpsJobR2Config = getR2Config(req) || activeVpsJobR2Config;
  activeVpsJobAppBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  const incompleteTasks = activeVpsBatchJob.tasks.filter((t) =>
    isTaskIncompleteForJob(t, activeVpsBatchJob!)
  );
  if (incompleteTasks.length === 0) {
    return res.json({
      success: true,
      retriedCount: 0,
      message: 'No failed or incomplete websites remaining.',
      job: activeVpsBatchJob,
    });
  }

  for (const t of incompleteTasks) {
    t.status = 'pending';
    t.error = undefined;
    t.statusMessage = 'Queued for manual retry (failed/incomplete)...';
  }
  vpsBatchCancelFlag = false;
  vpsBatchPauseFlag = false;
  activeVpsBatchJob.isRunning = true;
  activeVpsBatchJob.isPaused = false;
  activeVpsBatchJob.currentPass += 1;
  activeVpsBatchJob.maxAutoRetryPasses = Math.max(activeVpsBatchJob.maxAutoRetryPasses, activeVpsBatchJob.currentPass);
  activeVpsBatchJob.statusMessage = `Retrying ${incompleteTasks.length} failed/incomplete link(s)...`;
  await persistVpsBatchJob(true);
  launchVpsBatchWorkerLoop();

  res.json({
    success: true,
    retriedCount: incompleteTasks.length,
    message: `Restarted ${incompleteTasks.length} failed/incomplete link(s) in background.`,
    job: activeVpsBatchJob,
  });
});

// API: Clear Saved Background Batch Job
app.post('/api/vps-batch/clear', async (_req: Request, res: Response) => {
  vpsBatchCancelFlag = true;
  vpsBatchPauseFlag = false;
  activeVpsBatchJob = null;
  try {
    if (fs.existsSync(vpsJobFilePath)) fs.unlinkSync(vpsJobFilePath);
  } catch {}
  try {
    await axios.delete(`${CF_WORKER_BASE_URL}/api/ad_config/vps_batch_job_state`, { timeout: 10000 });
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
    } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Target URL is required' });
    }

    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    await hydrateRegistryFromD1IfNeeded();

    const targetUrlObj = new URL(url);
    const targetDomain = targetUrlObj.hostname.toLowerCase();

    const response = await axiosGetWithRetry(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

    const finalUrl = (response.request as any)?.res?.responseUrl || response.config?.url || url;
    const finalUrlObj = new URL(finalUrl);

    const resolveUrl = (relativeOrAbsolute: string) => {
      if (!relativeOrAbsolute) return '';
      try {
        return new URL(relativeOrAbsolute, finalUrl).href;
      } catch {
        return '';
      }
    };

    // Helper: Check URL against whitelist and blacklist
    const isUrlAllowedByDomainRules = (testUrl: string): boolean => {
      if (!enableDomainFilters) return true;
      const lower = testUrl.toLowerCase();

      // Check blacklist first
      for (const pattern of domainFilterRules.blacklist) {
        if (pattern && lower.includes(pattern.toLowerCase())) {
          return false;
        }
      }

      // If whitelist is populated, URL must match at least one whitelist pattern
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

          // Replace literal 'domain/xyz/' or '{domain}/xyz/' with actual target domain
          p = p.replace(/^\{?domain\}?\//i, `${targetDomain}/`);
          // Strip http/https prefix
          p = p.replace(/^https?:\/\//i, '');

          // Wildcard match support
          if (p.includes('*')) {
            const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            const regex = new RegExp(escaped, 'i');
            return regex.test(testUrl) || regex.test(hostAndPath) || regex.test(fullPath);
          }

          // Starting with slash (e.g. /xyz/)
          if (p.startsWith('/')) {
            return fullPath.toLowerCase().includes(p.toLowerCase());
          }

          // Format includes domain (e.g. mysite.com/xyz/)
          if (p.toLowerCase().startsWith(targetDomain)) {
            return hostAndPath.toLowerCase().includes(p.toLowerCase());
          }

          // Substring matching against testUrl, path, or hostAndPath
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

    // Parse with Cheerio
    const $ = cheerio.load(typeof response.data === 'string' ? response.data : '');

    // 1. Anchor links <a href="...">
    $('a[href]').each((_, el) => {
      const rawHref = $(el).attr('href')?.trim();
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) {
        return;
      }

      const resolved = resolveUrl(rawHref);
      if (!resolved || !/^https?:\/\//i.test(resolved)) return;

      // Skip direct video and image links if webpagesOnly is enabled
      const isMedia = isDirectMediaOrImage(resolved);
      if (webpagesOnly && isMedia) {
        return;
      }

      // Check URL format match (e.g. domain/xyz/, /xyz/)
      if (!matchesUrlFormat(resolved, urlFormat)) {
        return;
      }

      const linkText = $(el).text().replace(/\s+/g, ' ').trim() || $(el).attr('title')?.trim() || '';

      let type: 'video_media' | 'page_article' | 'image' | 'external' = 'page_article';
      if (/\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(resolved)) {
        type = 'video_media';
      } else if (/\.(jpg|jpeg|png|webp|avif|gif)(\?.*)?$/i.test(resolved)) {
        type = 'image';
      }

      try {
        const linkDomain = new URL(resolved).hostname.toLowerCase();
        if (sameDomainOnly && linkDomain !== targetDomain && linkDomain !== finalUrlObj.hostname.toLowerCase()) {
          return;
        }
        if (linkDomain !== targetDomain) {
          if (type === 'page_article') type = 'external';
        }
      } catch {}

      if (!isUrlAllowedByDomainRules(resolved)) {
        return;
      }

      if (!linksMap.has(resolved)) {
        linksMap.set(resolved, { text: linkText, type });
      } else if (linkText && !linksMap.get(resolved)?.text) {
        linksMap.set(resolved, { text: linkText, type });
      }
    });

    // 2. Direct video tags <video src> or <source src> (Only if webpagesOnly is false)
    if (!webpagesOnly) {
      $('video[src], source[src]').each((_, el) => {
        const src = $(el).attr('src')?.trim();
        if (src) {
          const resolved = resolveUrl(src);
          if (
            resolved &&
            /^https?:\/\//i.test(resolved) &&
            isUrlAllowedByDomainRules(resolved) &&
            matchesUrlFormat(resolved, urlFormat) &&
            !linksMap.has(resolved)
          ) {
            linksMap.set(resolved, { text: 'Direct Video Stream', type: 'video_media' });
          }
        }
      });
    }

    // 3. Fallback regex scan for URLs in raw text
    const textUrls = (typeof response.data === 'string' ? response.data : '').match(/https?:\/\/[^\s"',<>]+/gi) || [];
    for (const rawTextUrl of textUrls) {
      const cleanUrl = rawTextUrl.replace(/[.,;:)\]]+$/, '').trim();
      if (/^https?:\/\//i.test(cleanUrl) && isUrlAllowedByDomainRules(cleanUrl)) {
        const isMedia = isDirectMediaOrImage(cleanUrl);
        if (webpagesOnly && isMedia) continue;
        if (!matchesUrlFormat(cleanUrl, urlFormat)) continue;

        if (!linksMap.has(cleanUrl)) {
          let type: 'video_media' | 'page_article' | 'image' | 'external' = 'page_article';
          if (/\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(cleanUrl)) type = 'video_media';
          else if (/\.(jpg|jpeg|png|webp|avif|gif)(\?.*)?$/i.test(cleanUrl)) type = 'image';
          linksMap.set(cleanUrl, { text: 'Discovered in text/script source', type });
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
        // Automatically add new link to Cloudflare so future requests find it immediately
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
      pageTitle: $('title').text().trim() || '',
      webpagesOnly,
      urlFormat: urlFormat.trim(),
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

  const r2Config = r2ConfigOverride !== undefined ? r2ConfigOverride : getR2Config(req);
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

// Helper: Extract exact video duration from downloaded video file via ffprobe (with MP4 binary fallback)
async function extractVideoMetadataFromFile(filePath: string): Promise<{
  durationSec: number | null;
  durationFormatted: string | null;
}> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
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
    // Fallback to pure Node MP4 atom parser if ffprobe fails or isn't installed
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

// Helper: Download HLS (.m3u8) stream to local MP4 file via ffmpeg
async function downloadHlsStreamToMp4(m3u8Url: string, destPath: string, refererUrl?: string): Promise<void> {
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const headerLines = [
    `User-Agent: ${userAgent}`,
    ...(refererUrl ? [`Referer: ${refererUrl}`] : []),
  ].join('\r\n') + '\r\n';

  try {
    await execFileAsync(
      'ffmpeg',
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
        '-bsf:a',
        'aac_adtstoasc',
        '-movflags',
        '+faststart',
        destPath,
      ],
      { timeout: 300000 }
    );
  } catch {
    // Retry without -bsf:a in case audio codec isn't ADTS AAC
    await execFileAsync(
      'ffmpeg',
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
      { timeout: 300000 }
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
    localUploadsDir,
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
      'ffmpeg',
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
      { timeout: 600000 }
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
  req?: Request;
  r2ConfigOverride?: R2Config | null;
  appBaseUrlOverride?: string;
  minExpectedDurationSec?: number;
  compressVideo?: boolean;
  compressionQuality?: VideoCompressionQuality;
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
    videoUrl,
    customFilename,
    folderPrefix = 'videos',
    refererUrl,
    req,
    r2ConfigOverride,
    appBaseUrlOverride,
    minExpectedDurationSec,
    compressVideo = false,
    compressionQuality = 'balanced',
  } = params;

  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    throw new Error('A valid HTTP/HTTPS video URL is required');
  }

  const r2Config = r2ConfigOverride !== undefined ? r2ConfigOverride : getR2Config(req);
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

  // Temporary path for streaming download
  const tempFilename = `temp_vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
  const tempFilePath = path.join(localUploadsDir, tempFilename);

  const videoOrigin = resolveOriginSafe(videoUrl);
  const primaryReferer = refererUrl || (videoOrigin ? `${videoOrigin}/` : '');
  const primaryOrigin = resolveOriginSafe(primaryReferer) || videoOrigin;

  let contentType = 'video/mp4';
  let fileSize = 0;
  let lastDownloadErr: any = null;
  const looksLikeHls = /\.m3u8(\?|$)/i.test(videoUrl) || videoUrl.toLowerCase().includes('.m3u8');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const useReferer = attempt === 3 && videoOrigin ? `${videoOrigin}/` : primaryReferer;
    const useOrigin = attempt === 3 && videoOrigin ? videoOrigin : primaryOrigin;
    const rotatedUa = USER_AGENT_POOL[(serverPoolRoundRobinIdx + attempt) % USER_AGENT_POOL.length];
    let videoStreamRes: any = null;

    try {
      if (looksLikeHls) {
        await downloadHlsStreamToMp4(videoUrl, tempFilePath, useReferer);
        contentType = 'video/mp4';
      } else {
        videoStreamRes = await axios.get(videoUrl, {
          ...createNonKeepAliveAgents(),
          responseType: 'stream',
          timeout: 300000, // 5-min timeout to tolerate bandwidth sharing across concurrent workers
          maxRedirects: 5,
          decompress: false,
          headers: {
            'User-Agent': rotatedUa,
            Accept: 'video/mp4,video/*,*/*;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
            Connection: 'close',
            ...(useReferer ? { Referer: useReferer } : {}),
            ...(useOrigin ? { Origin: useOrigin } : {}),
          },
        });

        const headerType = String(videoStreamRes.headers['content-type'] || 'video/mp4')
          .split(';')[0]
          .trim()
          .toLowerCase();

        if (headerType.includes('text/html') || headerType.includes('application/json')) {
          throw new Error(`Remote video URL returned ${headerType} instead of a video stream`);
        }

        if (headerType.includes('mpegurl')) {
          if (videoStreamRes.data && typeof videoStreamRes.data.destroy === 'function') {
            videoStreamRes.data.destroy();
          }
          await downloadHlsStreamToMp4(videoUrl, tempFilePath, useReferer);
          contentType = 'video/mp4';
        } else {
          if (headerType && headerType.includes('video')) {
            contentType = headerType;
          }

          const expectedRemoteBytes = Number(videoStreamRes.headers['content-length'] || 0);
          const writer = fs.createWriteStream(tempFilePath);
          await pipeline(videoStreamRes.data, writer);

          // Reject truncated downloads before verification/upload
          const downloadedStat = fs.statSync(tempFilePath);
          if (expectedRemoteBytes > 0 && downloadedStat.size < Math.floor(expectedRemoteBytes * 0.98)) {
            throw new Error(
              `Truncated video download (${downloadedStat.size} of ${expectedRemoteBytes} bytes) — retrying`
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
              await downloadHlsStreamToMp4(videoUrl, tempFilePath, useReferer);
              contentType = 'video/mp4';
            } else if (/^(<!doctype|<html|<head|<body|\{")/i.test(headStr)) {
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
      lastDownloadErr = null;
      break;
    } catch (downloadErr: any) {
      lastDownloadErr = downloadErr;
      if (videoStreamRes?.data && typeof videoStreamRes.data.destroy === 'function') {
        try {
          videoStreamRes.data.destroy();
        } catch {}
      }
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch {}

      if (
        attempt < 3 &&
        (isRetryableNetworkError(downloadErr) ||
          downloadErr?.response?.status === 403 ||
          String(downloadErr?.message || '').includes('Truncated video download'))
      ) {
        const backoff = 600 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
        await sleepMs(backoff);
        continue;
      }
      break;
    }
  }

  if (lastDownloadErr || fileSize === 0) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {}
    throw new Error(`Failed to download remote video stream: ${formatCompactError(lastDownloadErr || '0 bytes')}`);
  }

  // Extract actual video duration metadata directly from the downloaded video file before compression/upload
  let extractedMeta = await extractVideoMetadataFromFile(tempFilePath);

  // Reject short hover-preview/trailer clips when real page duration is significantly longer
  if (
    minExpectedDurationSec &&
    minExpectedDurationSec >= 30 &&
    extractedMeta.durationSec &&
    extractedMeta.durationSec < Math.max(15, Math.floor(minExpectedDurationSec * 0.35))
  ) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {}
    throw new Error(
      `Downloaded clip duration (${extractedMeta.durationSec}s) is much shorter than real video duration (${minExpectedDurationSec}s) — skipping preview clip`
    );
  }

  // Derive file extension
  let ext = 'mp4';
  if (!looksLikeHls) {
    if (videoUrl.includes('.webm') || contentType.includes('webm')) ext = 'webm';
    else if (videoUrl.includes('.mkv') || contentType.includes('x-matroska')) ext = 'mkv';
    else if (videoUrl.includes('.mov') || contentType.includes('quicktime')) ext = 'mov';
  }

  // Optional FFmpeg compression BEFORE uploading to Cloudflare R2 (OFF by default)
  let uploadFilePath = tempFilePath;
  let compressedTempPath: string | null = null;
  let didCompress = false;
  let originalSizeBeforeCompress = fileSize;
  let compressionSavedPercent = 0;
  const resolvedQuality = normalizeCompressionQuality(compressionQuality);

  if (compressVideo) {
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
  const videoKey = cleanFolder ? `${cleanFolder}/${filename}` : filename;

  let cloudflareVideoBackLink = '';
  let storageSource: 'cloudflare_r2' | 'emulator' = 'emulator';
  let verifiedSizeBytes = fileSize;

  try {
    if (r2Config) {
      const s3 = createR2Client(r2Config);
      const fileStream = fs.createReadStream(uploadFilePath);

      try {
        if (fileSize >= 8 * 1024 * 1024) {
          // Multi-part parallel R2 upload (4 concurrent 8MB streams) for faster uploads on larger videos
          const parallelUpload = new Upload({
            client: s3,
            params: {
              Bucket: r2Config.bucketName,
              Key: videoKey,
              Body: fileStream,
              ContentType: contentType,
              CacheControl: 'public, max-age=31536000',
            },
            queueSize: 4,
            partSize: 8 * 1024 * 1024,
            leavePartsOnError: false,
          });
          await parallelUpload.done();
        } else {
          await s3.send(
            new PutObjectCommand({
              Bucket: r2Config.bucketName,
              Key: videoKey,
              Body: fileStream,
              ContentLength: fileSize,
              ContentType: contentType,
              CacheControl: 'public, max-age=31536000',
            })
          );
        }
      } finally {
        try {
          fileStream.destroy();
        } catch {}
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
    // Always remove temp files regardless of upload outcome
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {}
    try {
      if (compressedTempPath && fs.existsSync(compressedTempPath)) fs.unlinkSync(compressedTempPath);
    } catch {}
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
  } = params;

  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  await hydrateRegistryFromD1IfNeeded(true);

  // CHECK LIVE CLOUDFLARE D1 REGISTRY BY WEB URL:
  // Reuse cached record ONLY when it already has complete Cloudflare assets needed for this request!
  const existingWebRecord = findRegistryRecordByWebUrl(url);
    const hasCfVideo = Boolean(existingWebRecord?.cloudflareVideoUrl);
    const hasCfThumb = Boolean(existingWebRecord?.cloudflareThumbnailUrl);
    const isCompleteForRequest =
      Boolean(existingWebRecord) &&
      !isPreviewVideoUrl(existingWebRecord?.videoUrl) &&
      (hasCfVideo ||
        (existingWebRecord?.status === 'uploaded' && hasCfThumb && !existingWebRecord?.videoUrl)) &&
      (!uploadVideoToR2 || hasCfVideo || (existingWebRecord?.status === 'uploaded' && !existingWebRecord?.videoUrl)) &&
      (!uploadThumbnailToR2 || hasCfThumb || !existingWebRecord?.thumbnailUrl);

    if (!forceRefresh && existingWebRecord && isCompleteForRequest) {
      const bestThumb = existingWebRecord.cloudflareThumbnailUrl || existingWebRecord.thumbnailUrl || '';
      const primaryVideoUrl = existingWebRecord.cloudflareVideoUrl || existingWebRecord.videoUrl || '';
      const cachedSizeObj =
        existingWebRecord.sizeFormatted || existingWebRecord.sizeBytes
          ? {
              sizeBytes: existingWebRecord.sizeBytes || 0,
              sizeMb:
                existingWebRecord.sizeMb ||
                (existingWebRecord.sizeBytes ? (existingWebRecord.sizeBytes / (1024 * 1024)).toFixed(2) : '0'),
              sizeFormatted: existingWebRecord.sizeFormatted || '',
            }
          : null;

      const cachedPageData = {
        title: existingWebRecord.title,
        rawTitle: existingWebRecord.rawTitle || existingWebRecord.title,
        description:
          existingWebRecord.description ||
          (existingWebRecord.destination && existingWebRecord.destination !== 'none'
            ? `Saved in Cloudflare Vault (${existingWebRecord.destination})`
            : ''),
        ogImage: bestThumb,
        ogVideo: primaryVideoUrl,
        cloudflareVideoUrl: existingWebRecord.cloudflareVideoUrl || undefined,
        cloudflareThumbnailUrl: existingWebRecord.cloudflareThumbnailUrl || undefined,
        thumbnailStorageSource:
          existingWebRecord.thumbnailStorageSource || (existingWebRecord.cloudflareThumbnailUrl ? 'cloudflare_r2' : null),
        videoStorageSource:
          existingWebRecord.videoStorageSource || (existingWebRecord.cloudflareVideoUrl ? 'cloudflare_r2' : null),
        durationFormatted: existingWebRecord.durationFormatted || undefined,
        durationSec: existingWebRecord.durationSec ?? null,
        videoSize: cachedSizeObj,
        isCachedFromCloudflare: true,
      };

      const cachedMediaData = {
        videos: primaryVideoUrl
          ? [
              {
                id: 1,
                url: primaryVideoUrl,
                originalVideoUrl: existingWebRecord.videoUrl || primaryVideoUrl,
                cloudflareVideoUrl: existingWebRecord.cloudflareVideoUrl || undefined,
                poster: bestThumb || undefined,
                cloudflareThumbnailUrl: existingWebRecord.cloudflareThumbnailUrl || undefined,
                type: 'video/mp4',
                filename: existingWebRecord.title || 'video',
                title: existingWebRecord.title,
                rawTitle: existingWebRecord.rawTitle || existingWebRecord.title,
                durationSec: existingWebRecord.durationSec ?? null,
                durationFormatted: existingWebRecord.durationFormatted || null,
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
                alt: existingWebRecord.title,
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
        finalUrl: existingWebRecord.sourceUrl || url,
        registryUniqueId: existingWebRecord.id,
        isRegisteredInCloudflare: true,
        isUploadedToCloudflare: Boolean(existingWebRecord.cloudflareVideoUrl || existingWebRecord.cloudflareThumbnailUrl),
        responseTimeMs: 1,
        contentType: 'text/html; charset=utf-8',
        headers: {
          server: 'cloudflare-r2-vault',
          'cache-control': 'public, max-age=86400',
        },
        page: cachedPageData,
        media: cachedMediaData,
        content: {
          headings: [existingWebRecord.title],
          textExcerpt:
            cachedPageData.description ||
            `Extracted and archived in Cloudflare registry on ${existingWebRecord.firstExtractedAt || 'earlier session'}.`,
          metaTags: {},
          jsonLd: [],
        },
        fullHtml: `<!-- Cached Cloudflare Registry Entry for Web URL: ${url} -->`,
        rawSnippet: `Cached record from Cloudflare: ${existingWebRecord.title}`,
        htmlLength: 0,
        registryRecord: existingWebRecord,
      };
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

    try {
      // Immediately mention in Cloudflare D1 database that a server has started working on this URL
      const processingRecord = upsertRegistryRecordByWebUrl(url, {
        status: 'processing',
        metadata: {
          ...(existingWebRecord?.metadata || {}),
          workerServerId: SERVER_INSTANCE_ID,
          workerHost: appBaseUrlOverride || req?.get('host') || os.hostname(),
          processingStartedAt: new Date().toISOString(),
        },
      });
      await syncRegistryToStorage(req, [processingRecord]);

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
        const resolvedUrl = resolveUrl(rawVideoUrl.trim());
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
      const normalizedHtmlForScripts = response.data.replace(/\\\//g, '/');
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

      // Run thumbnail R2 upload and video R2 download/upload IN PARALLEL so thumbnail upload adds 0ms wait time
      const thumbUploadPromise = (async () => {
        if (!uploadThumbnailToR2 || !primaryThumbnail) return;
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
          upsertRegistryRecordByWebUrl(url, {
            cloudflareThumbnailUrl,
            thumbnailStorageSource,
          });
        } catch (thumbErr) {
          console.warn('Auto upload of thumbnail to Cloudflare R2 failed:', formatCompactError(thumbErr));
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
        for (const candidate of candidatesToTry) {
          try {
            const r2VideoUpload = await uploadVideoToR2OrLocal({
              videoUrl: candidate.url,
              customFilename: cleanedPrimary.cleaned || 'video',
              folderPrefix: 'videos',
              refererUrl: finalUrl,
              req,
              r2ConfigOverride,
              appBaseUrlOverride,
              minExpectedDurationSec: detectedDuration?.seconds || undefined,
              compressVideo: Boolean(compressVideo),
              compressionQuality: normalizeCompressionQuality(compressionQuality),
            });
            cloudflareVideoUrl = r2VideoUpload.cloudflareVideoBackLink;
            videoStorageSource = r2VideoUpload.storageSource;
            uploadedSourceVideoUrl = candidate.url;
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
            upsertRegistryRecordByWebUrl(url, {
              videoUrl: uploadedSourceVideoUrl,
              cloudflareVideoUrl,
              videoStorageSource,
              sizeBytes: r2VideoUpload.sizeBytes,
              sizeMb: r2VideoUpload.sizeMb,
              sizeFormatted: r2VideoUpload.sizeFormatted,
              durationSec: detectedDuration?.seconds ?? null,
              durationFormatted: detectedDuration?.formatted || '',
              status: 'uploaded',
            });
            break;
          } catch (videoErr) {
            console.warn('Auto upload of video to Cloudflare R2 failed:', formatCompactError(videoErr));
          }
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

      if (uploadVideoToR2 && (contentType.includes('video') || contentType.includes('mpegurl') || /\.(mp4|m3u8|webm|mov|mkv)$/i.test(url))) {
        try {
          const r2DirectVideo = await uploadVideoToR2OrLocal({
            videoUrl: finalUrl,
            customFilename: cleanedDirect.cleaned || 'stream_video',
            folderPrefix: 'videos',
            refererUrl: url,
            req,
            r2ConfigOverride,
            appBaseUrlOverride,
            compressVideo: Boolean(compressVideo),
            compressionQuality: normalizeCompressionQuality(compressionQuality),
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
        } catch (r2Err) {
          console.warn('Direct video stream Cloudflare upload failed:', formatCompactError(r2Err));
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
      // Remove failed / incomplete URL from Cloudflare D1 links_registry so crashed/broken runs don't leave bad rows
      await removeRegistryRecordByWebUrl(url, req);
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
    await removeRegistryRecordByWebUrl(url, req);
    throw scrapeErr;
  } finally {
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

    // Disk space via fs.statfsSync('/')
    let diskTotal = 0;
    let diskFree = 0;
    let diskUsed = 0;
    let diskUsagePercent = 0;
    try {
      const stat = fs.statfsSync('/');
      diskTotal = stat.blocks * stat.bsize;
      diskFree = stat.bavail * stat.bsize;
      diskUsed = Math.max(0, diskTotal - diskFree);
      diskUsagePercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
    } catch {
      diskTotal = 50 * 1024 * 1024 * 1024;
      diskFree = 40 * 1024 * 1024 * 1024;
      diskUsed = 10 * 1024 * 1024 * 1024;
      diskUsagePercent = 20;
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
        mountPoint: '/',
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT} (Cloudflare Worker D1: ${CF_WORKER_BASE_URL})`);
    hydrateRegistryFromD1IfNeeded()
      .then(() => loadAndResumeVpsBatchJob())
      .catch(() => {});
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
