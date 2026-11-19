import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search,
  Play,
  Square,
  Download,
  Copy,
  Check,
  Trash2,
  Send,
  Globe,
  Film,
  Image as ImageIcon,
  RefreshCw,
  AlertCircle,
  Eraser,
  ExternalLink,
  Upload,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';

type DomainScopeMode = 'exact_host' | 'root_domain';

interface DomainProbeVerifiedEntry {
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

interface CloudflareBlockedEntry {
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

type ProbeTaskStatus =
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

interface DomainProbeTask {
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

interface DomainProbeJobState {
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

interface DomainVideoProbeProps {
  incomingAppendUrls?: { nonce: number; urls: string[] } | null;
  onSendToMultiExtractor?: (urls: string[], openTab?: boolean) => void;
}

const formatBytesShort = (bytes?: number | null) => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const parseRawUrlLines = (raw: string): string[] => {
  return Array.from(
    new Set(
      raw
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
    )
  );
};

const extractHostLabel = (rawUrl: string, scope: DomainScopeMode): string => {
  try {
    const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const host = new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return '';
    if (scope === 'exact_host') return host;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost') return host;
    const parts = host.split('.').filter(Boolean);
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  } catch {
    return '';
  }
};

export const DomainVideoProbe: React.FC<DomainVideoProbeProps> = ({
  incomingAppendUrls,
  onSendToMultiExtractor,
}) => {
  const [rawUrls, setRawUrls] = useState<string>('');
  const [concurrency, setConcurrency] = useState<number>(20);
  const [maxPerDomain, setMaxPerDomain] = useState<number>(5);
  const [maxInnerLinksPerPage, setMaxInnerLinksPerPage] = useState<number>(5);
  const [domainScope, setDomainScope] = useState<DomainScopeMode>('exact_host');
  const [verifyVideoHeaders, setVerifyVideoHeaders] = useState<boolean>(true);
  const [includeEmbedIframes, setIncludeEmbedIframes] = useState<boolean>(false);
  const [saveNoVideoDomains, setSaveNoVideoDomains] = useState<boolean>(false);
  const [usePlaywrightFallback, setUsePlaywrightFallback] = useState<boolean>(false);
  const [autoPassCloudflare, setAutoPassCloudflare] = useState<boolean>(true);
  const [excludePatternsText, setExcludePatternsText] = useState<string>('/blog/, /tag/, /category/');

  const [entries, setEntries] = useState<DomainProbeVerifiedEntry[]>([]);
  const [cfBlockedEntries, setCfBlockedEntries] = useState<CloudflareBlockedEntry[]>([]);
  const [job, setJob] = useState<DomainProbeJobState | null>(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);

  const [activeView, setActiveView] = useState<'registry' | 'queue' | 'cloudflare'>('registry');
  const [registryFilter, setRegistryFilter] = useState<'all' | 'yes' | 'no_video'>('all');
  const [registrySearch, setRegistrySearch] = useState<string>('');
  const [cfSearch, setCfSearch] = useState<string>('');
  const [queueFilter, setQueueFilter] = useState<
    | 'all'
    | 'active'
    | 'found_yes'
    | 'cloudflare_blocked'
    | 'skipped_in_json'
    | 'skipped_cloudflare_json'
    | 'skipped_domain_limit'
    | 'no_video'
    | 'error'
  >('all');
  const [queueSearch, setQueueSearch] = useState<string>('');

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmClearRegistry, setConfirmClearRegistry] = useState<boolean>(false);
  const [confirmClearCfRegistry, setConfirmClearCfRegistry] = useState<boolean>(false);
  const confirmTimerRef = useRef<number | null>(null);
  const confirmCfTimerRef = useRef<number | null>(null);
  const lastAppendNonceRef = useRef<number>(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/domain-probe/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) {
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        setCfBlockedEntries(Array.isArray(data.cloudflareBlockedEntries) ? data.cloudflareBlockedEntries : []);
        setJob(data.job || null);
      }
    } catch {
      // ignore transient poll failures
    } finally {
      setIsLoadingInitial(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Adaptive polling: fast 1.2s while probing is active, gentle 10s when idle
  useEffect(() => {
    const intervalMs = job?.isRunning ? 1200 : 10000;
    const timer = window.setInterval(() => {
      fetchStatus();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [job?.isRunning, fetchStatus]);

  // Append URLs sent from URL Extractor without overwriting existing lines
  useEffect(() => {
    if (!incomingAppendUrls || incomingAppendUrls.nonce === lastAppendNonceRef.current) return;
    lastAppendNonceRef.current = incomingAppendUrls.nonce;
    const incoming = incomingAppendUrls.urls.map((u) => String(u || '').trim()).filter(Boolean);
    if (incoming.length === 0) return;
    setRawUrls((prev) => {
      const existing = parseRawUrlLines(prev);
      const merged = Array.from(new Set([...existing, ...incoming]));
      const addedCount = merged.length - existing.length;
      setNoticeBanner(
        `Appended ${addedCount} new link${addedCount === 1 ? '' : 's'} from URL Extractor (${merged.length} total in input).`
      );
      return merged.join('\n');
    });
  }, [incomingAppendUrls]);

  const parsedPreview = useMemo(() => {
    const urls = parseRawUrlLines(rawUrls);
    const hosts = new Set<string>();
    const savedSet = new Set(entries.map((e) => e.host));
    const cfSet = new Set(cfBlockedEntries.map((e) => e.host));
    let alreadyInJsonCount = 0;
    let alreadyInCfJsonCount = 0;
    for (const u of urls) {
      const h = extractHostLabel(u, domainScope);
      if (h) {
        hosts.add(h);
        if (savedSet.has(h)) alreadyInJsonCount++;
        else if (cfSet.has(h)) alreadyInCfJsonCount++;
      }
    }
    return {
      urlCount: urls.length,
      uniqueHosts: hosts.size,
      alreadyInJsonLinks: alreadyInJsonCount,
      alreadyInCfJsonLinks: alreadyInCfJsonCount,
      urls,
    };
  }, [rawUrls, domainScope, entries, cfBlockedEntries]);

  const handleCopyText = async (text: string, key: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1600);
    } catch {}
  };

  const handleStartProbe = async () => {
    setErrorBanner(null);
    setNoticeBanner(null);
    if (parsedPreview.urlCount === 0) {
      setErrorBanner('Paste at least one website URL (one per line) before starting.');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/domain-probe/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: parsedPreview.urls,
          concurrency: Math.max(1, Math.min(50, Number(concurrency) || 20)),
          maxPerDomain: Math.max(1, Math.min(20, Number(maxPerDomain) || 5)),
          maxInnerLinksPerPage: Math.max(1, Math.min(15, Number(maxInnerLinksPerPage) || 5)),
          domainScope,
          verifyVideoHeaders,
          includeEmbedIframes,
          saveNoVideoDomains,
          usePlaywrightFallback,
          autoPassCloudflare,
          excludePatterns: excludePatternsText
            .split(/[,|\n]+/)
            .map((p) => p.trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setErrorBanner(data?.error || 'Could not start domain probe.');
        return;
      }
      setJob(data.job);
      setActiveView('queue');
      const excludedNote = data.job?.excludedCount
        ? ` (${data.job.excludedCount} excluded by path filter)`
        : '';
      setNoticeBanner(
        `Started ${data.job?.concurrency || concurrency} workers across ${data.job?.total || parsedPreview.urlCount} links (max ${maxPerDomain} links per domain/subdomain)${excludedNote}.`
      );
      fetchStatus();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Network error while starting probe.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStopProbe = async () => {
    try {
      const res = await fetch('/api/domain-probe/stop', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        setJob(data.job || null);
        setNoticeBanner('Stopped active domain probe workers.');
      }
    } catch {}
  };

  const handleClearQueueView = async () => {
    try {
      await fetch('/api/domain-probe/clear-job', { method: 'POST' });
      setJob(null);
      if (activeView === 'queue') setActiveView('registry');
    } catch {}
  };

  const handleDeleteEntry = async (host: string) => {
    try {
      const res = await fetch(`/api/domain-probe/registry/${encodeURIComponent(host)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data?.success && Array.isArray(data.entries)) {
        setEntries(data.entries);
      }
    } catch {}
  };

  const handleClearEntireRegistry = async () => {
    if (!confirmClearRegistry) {
      setConfirmClearRegistry(true);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setConfirmClearRegistry(false), 3500);
      return;
    }
    setConfirmClearRegistry(false);
    try {
      const res = await fetch('/api/domain-probe/registry/clear', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        setEntries([]);
        setNoticeBanner('Cleared saved domain_video_probe.json registry.');
      }
    } catch {}
  };

  const handleImportJsonFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErrorBanner(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await fetch('/api/domain-probe/registry/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: parsed, overwriteExisting: false }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setErrorBanner(data?.error || 'Failed to import JSON.');
        return;
      }
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setNoticeBanner(
        `Imported ${data.importedCount} domain(s) into JSON (${data.skippedExisting} already existed).`
      );
    } catch (err: any) {
      setErrorBanner(err?.message || 'Invalid JSON file.');
    }
  };

  const handlePruneRegistry = async (mode: 'no_video_only' | 'stale_days', days = 7) => {
    setErrorBanner(null);
    try {
      const res = await fetch('/api/domain-probe/registry/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, days }),
      });
      const data = await res.json();
      if (data?.success) {
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        setNoticeBanner(
          mode === 'no_video_only'
            ? `Removed ${data.removedCount} no-video domain(s) from JSON so they can be re-probed.`
            : `Removed ${data.removedCount} stale domain(s) older than ${days} days from JSON.`
        );
      }
    } catch {}
  };

  const handleDeleteCfEntry = async (host: string) => {
    try {
      const res = await fetch(`/api/domain-probe/cloudflare-blocked/${encodeURIComponent(host)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data?.success && Array.isArray(data.cloudflareBlockedEntries)) {
        setCfBlockedEntries(data.cloudflareBlockedEntries);
      }
    } catch {}
  };

  const handleClearCfRegistry = async () => {
    if (!confirmClearCfRegistry) {
      setConfirmClearCfRegistry(true);
      if (confirmCfTimerRef.current) window.clearTimeout(confirmCfTimerRef.current);
      confirmCfTimerRef.current = window.setTimeout(() => setConfirmClearCfRegistry(false), 3500);
      return;
    }
    setConfirmClearCfRegistry(false);
    try {
      const res = await fetch('/api/domain-probe/cloudflare-blocked/clear', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        setCfBlockedEntries([]);
        setNoticeBanner('Cleared domain_cloudflare_blocked.json registry.');
      }
    } catch {}
  };

  const confirmedEntries = useMemo(() => entries.filter((e) => e.hasVideo), [entries]);
  const noVideoEntries = useMemo(() => entries.filter((e) => !e.hasVideo), [entries]);

  const filteredEntries = useMemo(() => {
    const q = registrySearch.trim().toLowerCase();
    return entries.filter((item) => {
      if (registryFilter === 'yes' && !item.hasVideo) return false;
      if (registryFilter === 'no_video' && item.hasVideo) return false;
      if (!q) return true;
      return (
        item.host.toLowerCase().includes(q) ||
        item.sourcePageUrl.toLowerCase().includes(q) ||
        item.videoUrl.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q)
      );
    });
  }, [entries, registryFilter, registrySearch]);

  const filteredCfEntries = useMemo(() => {
    const q = cfSearch.trim().toLowerCase();
    if (!q) return cfBlockedEntries;
    return cfBlockedEntries.filter(
      (item) =>
        item.host.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q) ||
        item.reason.toLowerCase().includes(q)
    );
  }, [cfBlockedEntries, cfSearch]);

  const filteredTasks = useMemo(() => {
    const tasks = job?.tasks || [];
    const q = queueSearch.trim().toLowerCase();
    return tasks.filter((t) => {
      if (queueFilter === 'active') {
        if (t.status !== 'checking_direct' && t.status !== 'checking_inner_links' && t.status !== 'pending') {
          return false;
        }
      } else if (queueFilter !== 'all' && t.status !== queueFilter) {
        return false;
      }
      if (!q) return true;
      return (
        t.url.toLowerCase().includes(q) ||
        t.host.toLowerCase().includes(q) ||
        (t.videoUrl || '').toLowerCase().includes(q) ||
        (t.message || '').toLowerCase().includes(q)
      );
    });
  }, [job?.tasks, queueFilter, queueSearch]);

  const jobProgressPct = useMemo(() => {
    if (!job || job.total === 0) return 0;
    const settled = job.total - job.pending - job.checking;
    return Math.round((settled / job.total) * 100);
  }, [job]);

  const handleCopyFullJson = () => {
    const domainsObj: Record<string, DomainProbeVerifiedEntry> = {};
    for (const e of entries) {
      domainsObj[e.host] = e;
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      totalDomains: entries.length,
      confirmedVideoDomains: confirmedEntries.length,
      domains: domainsObj,
    };
    handleCopyText(JSON.stringify(payload, null, 2), 'full_json');
  };

  const handleCopyCfJson = () => {
    const domainsObj: Record<string, CloudflareBlockedEntry> = {};
    for (const e of cfBlockedEntries) {
      domainsObj[e.host] = e;
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      totalBlockedDomains: cfBlockedEntries.length,
      domains: domainsObj,
    };
    handleCopyText(JSON.stringify(payload, null, 2), 'cf_json');
  };

  const handleSendConfirmedPagesToMulti = (onlyFiltered = false) => {
    if (!onSendToMultiExtractor) return;
    const sourceList = (onlyFiltered ? filteredEntries : entries)
      .filter((e) => e.hasVideo && e.sourcePageUrl)
      .map((e) => e.sourcePageUrl);
    if (sourceList.length === 0) {
      setErrorBanner('No confirmed video pages available to send.');
      return;
    }
    onSendToMultiExtractor(sourceList, true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            Domain Video Availability Prober
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 max-w-3xl">
            Checks batches of website links with up to 50 workers without downloading video binaries. Falls back to same-website inner links when the landing page has no video, caps checks at {maxPerDomain} links per domain/subdomain, and skips domains already saved in JSON.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={fetchStatus}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <a
            href="/api/domain-probe/export.json"
            className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>Export JSON</span>
          </a>
        </div>
      </div>

      {/* Banners */}
      {errorBanner && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg flex items-center justify-between gap-3 text-xs text-rose-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button onClick={() => setErrorBanner(null)} className="text-rose-300 hover:text-white font-medium shrink-0">
            Dismiss
          </button>
        </div>
      )}
      {noticeBanner && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-center justify-between gap-3 text-xs text-emerald-300">
          <span>{noticeBanner}</span>
          <button onClick={() => setNoticeBanner(null)} className="text-emerald-300 hover:text-white font-medium shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Input & Worker Configuration Card (Single elevation) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
          {/* Left: URL Input */}
          <div className="lg:col-span-7 p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="domain-probe-urls" className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Website URLs to Probe (1 per line)
              </label>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                {parsedPreview.urlCount} URLs · {parsedPreview.uniqueHosts} hosts
                {parsedPreview.alreadyInJsonLinks > 0 ? ` · ${parsedPreview.alreadyInJsonLinks} in JSON` : ''}
                {parsedPreview.alreadyInCfJsonLinks > 0 ? ` · ${parsedPreview.alreadyInCfJsonLinks} CF-blocked` : ''}
              </div>
            </div>

            <textarea
              id="domain-probe-urls"
              value={rawUrls}
              onChange={(e) => setRawUrls(e.target.value)}
              rows={8}
              placeholder={`https://example.com/\nhttps://sub.example.com/category\nhttps://another-site.org/watch/12345\n...`}
              className="w-full flex-1 min-h-[180px] bg-slate-950 border border-slate-800 focus:border-cyan-500/60 focus:outline-none rounded-lg p-3 text-xs font-mono text-slate-200 placeholder:text-slate-600 resize-y leading-relaxed"
            />

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRawUrls(parsedPreview.urls.join('\n'))}
                  disabled={parsedPreview.urlCount === 0}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                >
                  Deduplicate Lines
                </button>
                <button
                  type="button"
                  onClick={() => setRawUrls('')}
                  disabled={!rawUrls}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Eraser className="w-3.5 h-3.5" />
                  <span>Clear Input</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                {job?.isRunning ? (
                  <button
                    type="button"
                    onClick={handleStopProbe}
                    className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop Workers ({job.activeWorkers})</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartProbe}
                    disabled={isSubmitting || parsedPreview.urlCount === 0}
                    className="px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>{isSubmitting ? 'Starting...' : `Start Probe (${concurrency} Workers)`}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Right: Worker & Probe Controls */}
          <div className="lg:col-span-5 p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Worker &amp; Domain Rules
              </span>
              <span className="text-[11px] text-slate-500">Zero video binary download</span>
            </div>

            {/* Workers (1..50) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="probe-workers" className="text-slate-300 font-medium">
                  Concurrent Workers (1–50)
                </label>
                <span className="font-mono tabular-nums text-cyan-400 font-semibold">{concurrency}x</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="grid grid-cols-4 gap-1.5 flex-1">
                  {[5, 15, 30, 50].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setConcurrency(preset)}
                      className={`py-1.5 text-xs font-mono tabular-nums rounded-lg border transition-colors ${
                        concurrency === preset
                          ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300 font-semibold'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <input
                  id="probe-workers"
                  type="number"
                  min={1}
                  max={50}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-16 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs font-mono tabular-nums text-white text-center focus:border-cyan-500/60 focus:outline-none"
                />
              </div>
            </div>

            {/* Domain limits */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="max-per-domain" className="text-xs text-slate-300 font-medium block">
                  Max Links / Domain
                </label>
                <input
                  id="max-per-domain"
                  type="number"
                  min={1}
                  max={20}
                  value={maxPerDomain}
                  onChange={(e) => setMaxPerDomain(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono tabular-nums text-white focus:border-cyan-500/60 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="max-inner-links" className="text-xs text-slate-300 font-medium block">
                  Same-Site Fallback Links
                </label>
                <input
                  id="max-inner-links"
                  type="number"
                  min={1}
                  max={15}
                  value={maxInnerLinksPerPage}
                  onChange={(e) => setMaxInnerLinksPerPage(Math.max(1, Math.min(15, Number(e.target.value) || 5)))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono tabular-nums text-white focus:border-cyan-500/60 focus:outline-none"
                />
              </div>
            </div>

            {/* Domain scope toggle */}
            <div className="space-y-1.5">
              <span className="text-xs text-slate-300 font-medium block">JSON Deduplication Scope</span>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setDomainScope('exact_host')}
                  className={`px-2.5 py-1.5 text-xs rounded-lg border text-left transition-colors ${
                    domainScope === 'exact_host'
                      ? 'bg-slate-800 border-slate-600 text-white font-medium'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Exact Subdomain
                </button>
                <button
                  type="button"
                  onClick={() => setDomainScope('root_domain')}
                  className={`px-2.5 py-1.5 text-xs rounded-lg border text-left transition-colors ${
                    domainScope === 'root_domain'
                      ? 'bg-slate-800 border-slate-600 text-white font-medium'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Root Domain
                </button>
              </div>
            </div>

            {/* Exclude URL Patterns */}
            <div className="space-y-1">
              <label htmlFor="exclude-patterns" className="text-xs text-slate-300 font-medium block">
                Exclude URL Paths / Keywords
              </label>
              <input
                id="exclude-patterns"
                type="text"
                value={excludePatternsText}
                onChange={(e) => setExcludePatternsText(e.target.value)}
                placeholder="/blog/, /tag/, /category/, /forum/"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:border-cyan-500/60 focus:outline-none"
              />
            </div>

            {/* Behavioral checkboxes */}
            <div className="space-y-2 pt-1 border-t border-slate-800 text-xs text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={verifyVideoHeaders}
                  onChange={(e) => setVerifyVideoHeaders(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                />
                <span>Verify video URL headers live (HEAD / 1KB Range)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoPassCloudflare}
                  onChange={(e) => setAutoPassCloudflare(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                />
                <span>Try Cloudflare verification pass (save failed hosts to separate JSON)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={usePlaywrightFallback}
                  onChange={(e) => setUsePlaywrightFallback(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                />
                <span>Playwright JS fallback when static HTML finds no video</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeEmbedIframes}
                  onChange={(e) => setIncludeEmbedIframes(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                />
                <span>Include embedded player iframes</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={saveNoVideoDomains}
                  onChange={(e) => setSaveNoVideoDomains(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                />
                <span>Save exhausted no-video domains in JSON (skip future runs)</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Live Job KPI Strip (shown when a batch job exists) */}
      {job && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs">
              <span className="font-semibold text-white">
                {job.isRunning ? `Probing with ${job.activeWorkers}/${job.concurrency} workers` : job.cancelled ? 'Probe Stopped' : 'Probe Complete'}
              </span>
              <span className="text-slate-400 font-mono tabular-nums">
                {jobProgressPct}% · {job.total - job.pending - job.checking}/{job.total} settled
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!job.isRunning && (
                <button
                  type="button"
                  onClick={handleClearQueueView}
                  className="px-2.5 py-1 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  Clear Queue View
                </button>
              )}
            </div>
          </div>

          <div className="w-full h-1.5 bg-slate-950 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-400 transition-all duration-300"
              style={{ width: `${jobProgressPct}%` }}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-7 gap-3 pt-1">
            <div>
              <div className="text-[11px] text-slate-400">Queued / Active</div>
              <div className="text-base font-bold font-mono tabular-nums text-white">
                {job.pending + job.checking}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Found YES (Saved)</div>
              <div className="text-base font-bold font-mono tabular-nums text-emerald-400">
                {job.foundYes}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Skipped (In JSON)</div>
              <div className="text-base font-bold font-mono tabular-nums text-cyan-400">
                {job.skippedInJson}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Skipped ({job.maxPerDomain}-Cap)</div>
              <div className="text-base font-bold font-mono tabular-nums text-amber-400">
                {job.skippedDomainLimit}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Cloudflare Blocked</div>
              <div className="text-base font-bold font-mono tabular-nums text-orange-400">
                {(job.cloudflareBlocked || 0) + (job.skippedCloudflareJson || 0)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">No Video</div>
              <div className="text-base font-bold font-mono tabular-nums text-slate-300">
                {job.noVideo}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Fetch Errors</div>
              <div className="text-base font-bold font-mono tabular-nums text-rose-400">
                {job.errors}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Results Workspace Tabs: Saved JSON Database vs Cloudflare Blocked JSON vs Live Probe Queue */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveView('registry')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'registry'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Saved JSON Database (<span className="font-mono tabular-nums">{entries.length}</span>)
            </button>
            <button
              type="button"
              onClick={() => setActiveView('cloudflare')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                activeView === 'cloudflare'
                  ? 'bg-orange-500/15 text-orange-300 border border-orange-500/40'
                  : 'text-slate-400 hover:text-orange-300'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Cloudflare Blocked JSON (<span className="font-mono tabular-nums">{cfBlockedEntries.length}</span>)</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView('queue')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'queue'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live Probe Queue (<span className="font-mono tabular-nums">{job?.tasks.length || 0}</span>)
            </button>
          </div>

          {activeView === 'registry' && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportJsonFile}
                className="hidden"
              />
              {onSendToMultiExtractor && confirmedEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleSendConfirmedPagesToMulti(false)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send {confirmedEntries.length} YES Pages to Multi-Extractor</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                title="Import & merge an existing domain_video_probe.json file"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Import JSON</span>
              </button>
              {noVideoEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() => handlePruneRegistry('no_video_only')}
                  className="px-3 py-1.5 text-xs font-medium text-amber-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  title="Remove no-video domains so they can be re-checked"
                >
                  Clear No-Video ({noVideoEntries.length})
                </button>
              )}
              {entries.length > 0 && (
                <button
                  type="button"
                  onClick={() => handlePruneRegistry('stale_days', 7)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  title="Remove entries older than 7 days for re-probing"
                >
                  Prune &gt;7d Stale
                </button>
              )}
              <button
                type="button"
                onClick={handleCopyFullJson}
                disabled={entries.length === 0}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'full_json' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedKey === 'full_json' ? 'Copied JSON' : 'Copy JSON'}</span>
              </button>
              <button
                type="button"
                onClick={handleClearEntireRegistry}
                disabled={entries.length === 0}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border disabled:opacity-40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  confirmClearRegistry
                    ? 'bg-rose-600 border-rose-500 text-white'
                    : 'bg-slate-950 border-slate-800 text-rose-400 hover:bg-rose-500/10'
                }`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{confirmClearRegistry ? 'Click Again to Confirm Clear' : 'Clear JSON'}</span>
              </button>
            </div>
          )}
          {activeView === 'cloudflare' && (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/domain-probe/cloudflare-blocked.json"
                className="px-3 py-1.5 text-xs font-medium text-orange-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download CF JSON</span>
              </a>
              <button
                type="button"
                onClick={handleCopyCfJson}
                disabled={cfBlockedEntries.length === 0}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'cf_json' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedKey === 'cf_json' ? 'Copied CF JSON' : 'Copy CF JSON'}</span>
              </button>
              <button
                type="button"
                onClick={handleClearCfRegistry}
                disabled={cfBlockedEntries.length === 0}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border disabled:opacity-40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  confirmClearCfRegistry
                    ? 'bg-rose-600 border-rose-500 text-white'
                    : 'bg-slate-950 border-slate-800 text-rose-400 hover:bg-rose-500/10'
                }`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{confirmClearCfRegistry ? 'Click Again to Confirm Clear' : 'Clear CF JSON'}</span>
              </button>
            </div>
          )}
        </div>

        {/* SAVED JSON REGISTRY VIEW */}
        {activeView === 'registry' && (
          <div>
            {/* Filter & Search Subbar */}
            <div className="px-4 sm:px-5 py-3 border-b border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                {[
                  { id: 'all', label: `All (${entries.length})` },
                  { id: 'yes', label: `YES Video (${confirmedEntries.length})` },
                  { id: 'no_video', label: `No Video (${noVideoEntries.length})` },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setRegistryFilter(f.id as any)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      registryFilter === f.id
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-72">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={registrySearch}
                  onChange={(e) => setRegistrySearch(e.target.value)}
                  placeholder="Filter domain, page URL, or video..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none"
                />
              </div>
            </div>

            {isLoadingInitial ? (
              <div className="p-10 text-center text-xs text-slate-400">
                Loading saved domain_video_probe.json...
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="p-10 text-center space-y-1.5">
                <p className="text-sm font-medium text-slate-300">
                  {entries.length === 0
                    ? 'No domains saved in domain_video_probe.json yet'
                    : 'No saved entries match this filter'}
                </p>
                <p className="text-xs text-slate-500">
                  Paste website links above and click Start Probe. Confirmed domains are saved permanently and skipped in future batches.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800">
                {filteredEntries.map((item) => (
                  <div key={item.host} className="p-4 sm:px-5 flex flex-col md:flex-row md:items-start justify-between gap-4 hover:bg-slate-950/40 transition-colors">
                    <div className="flex items-start gap-3.5 min-w-0 flex-1">
                      {/* Thumbnail preview */}
                      <div className="w-24 h-14 rounded-lg bg-slate-950 border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center">
                        {item.thumbnailUrl ? (
                          <img
                            src={item.thumbnailUrl}
                            alt={item.title || item.host}
                            loading="lazy"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <ImageIcon className="w-4 h-4 text-slate-700" />
                        )}
                      </div>

                      {/* Domain & Discovered URLs */}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                              item.hasVideo
                                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {item.hasVideo ? 'YES' : 'NO VIDEO'}
                          </span>
                          <span className="text-sm font-semibold text-white truncate">{item.host}</span>
                          <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                            {item.discoveryDepth === 1 ? 'Same-Site Inner Link' : 'Direct Page'}
                            {item.usedHomeDomainFallback ? ' · Home Fallback' : ''}
                            {item.usedPlaywright ? ' · JS Playwright' : ''}
                            {item.verifiedLive ? ' · Header Verified' : ''}
                            {` · ${item.attemptsUsed} check${item.attemptsUsed === 1 ? '' : 's'}`}
                            {item.sizeBytes ? ` · ${formatBytesShort(item.sizeBytes)}` : ''}
                          </span>
                        </div>

                        {item.title && (
                          <p className="text-xs text-slate-300 truncate">{item.title}</p>
                        )}

                        <div className="space-y-1 pt-0.5 text-[11px] font-mono">
                          <div className="flex items-center gap-1.5 text-slate-400 min-w-0">
                            <Globe className="w-3 h-3 shrink-0 text-slate-500" />
                            <a
                              href={item.sourcePageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate hover:text-cyan-300 transition-colors"
                              title={item.sourcePageUrl}
                            >
                              {item.sourcePageUrl}
                            </a>
                          </div>
                          {item.videoUrl && (
                            <div className="flex items-center gap-1.5 text-cyan-400 min-w-0">
                              <Film className="w-3 h-3 shrink-0" />
                              <span className="truncate" title={item.videoUrl}>{item.videoUrl}</span>
                            </div>
                          )}
                          {item.thumbnailUrl && (
                            <div className="flex items-center gap-1.5 text-slate-400 min-w-0">
                              <ImageIcon className="w-3 h-3 shrink-0 text-slate-500" />
                              <span className="truncate" title={item.thumbnailUrl}>{item.thumbnailUrl}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                      {/* Row Actions */}
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <a
                        href={item.sourcePageUrl || `https://${item.host}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                        title="Open link in new tab"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Open Link</span>
                      </a>
                      {item.videoUrl && (
                        <button
                          type="button"
                          onClick={() => handleCopyText(item.videoUrl, `vid_${item.host}`)}
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          {copiedKey === `vid_${item.host}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>Video Link</span>
                        </button>
                      )}
                      {item.thumbnailUrl && (
                        <button
                          type="button"
                          onClick={() => handleCopyText(item.thumbnailUrl, `thumb_${item.host}`)}
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          {copiedKey === `thumb_${item.host}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>Thumb</span>
                        </button>
                      )}
                      {onSendToMultiExtractor && item.hasVideo && (
                        <button
                          type="button"
                          onClick={() => onSendToMultiExtractor([item.sourcePageUrl], true)}
                          className="px-2.5 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                          title="Add page URL to Multi-Extractor"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>Multi-Extractor</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDeleteEntry(item.host)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 bg-slate-950 hover:bg-rose-500/10 border border-slate-800 rounded-lg transition-colors shrink-0"
                        title={`Remove ${item.host} from JSON so it can be re-probed`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CLOUDFLARE BLOCKED JSON VIEW */}
        {activeView === 'cloudflare' && (
          <div>
            <div className="px-4 sm:px-5 py-3 border-b border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-xs text-slate-400 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-orange-400 shrink-0" />
                <span>
                  Domains saved in <span className="font-mono text-orange-300">domain_cloudflare_blocked.json</span> after failing Cloudflare verification. Skipped in future runs unless deleted.
                </span>
              </div>
              <div className="relative w-full sm:w-72 shrink-0">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={cfSearch}
                  onChange={(e) => setCfSearch(e.target.value)}
                  placeholder="Filter Cloudflare-blocked domain..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none"
                />
              </div>
            </div>

            {filteredCfEntries.length === 0 ? (
              <div className="p-10 text-center space-y-1.5">
                <p className="text-sm font-medium text-slate-300">
                  {cfBlockedEntries.length === 0
                    ? 'No Cloudflare-blocked domains saved in domain_cloudflare_blocked.json'
                    : 'No Cloudflare-blocked entries match this search'}
                </p>
                <p className="text-xs text-slate-500">
                  When a site triggers Cloudflare Turnstile / verification and headless browser clearance cannot pass it, it is logged here separately.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800">
                {filteredCfEntries.map((item) => (
                  <div key={item.host} className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-950/40 transition-colors">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-orange-500/15 text-orange-300 border border-orange-500/30">
                          CLOUDFLARE BLOCKED
                        </span>
                        <span className="text-sm font-semibold text-white truncate">{item.host}</span>
                        <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                          {item.httpStatus ? `HTTP ${item.httpStatus} · ` : ''}
                          {item.playwrightAttempted ? 'Playwright Tried' : 'Challenge Detected'}
                          {` · ${new Date(item.checkedAt).toLocaleString()}`}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-slate-400 truncate" title={item.url}>
                        {item.url}
                      </div>
                      <div className="text-[11px] text-orange-300/90 truncate">{item.reason}</div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                        title="Open link manually in new tab to solve Cloudflare challenge"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Open Link</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => handleDeleteCfEntry(item.host)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 bg-slate-950 hover:bg-rose-500/10 border border-slate-800 rounded-lg transition-colors shrink-0"
                        title={`Remove ${item.host} from Cloudflare Blocked JSON so it can be retried`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* LIVE PROBE QUEUE VIEW */}
        {activeView === 'queue' && (
          <div>
            <div className="px-4 sm:px-5 py-3 border-b border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'active', label: 'Active / Pending' },
                  { id: 'found_yes', label: 'YES' },
                  { id: 'cloudflare_blocked', label: 'CF Blocked' },
                  { id: 'skipped_cloudflare_json', label: 'CF JSON Skip' },
                  { id: 'skipped_in_json', label: 'In JSON' },
                  { id: 'skipped_domain_limit', label: '5-Link Limit' },
                  { id: 'no_video', label: 'No Video' },
                  { id: 'error', label: 'Errors' },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setQueueFilter(f.id as any)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      queueFilter === f.id
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  placeholder="Search queue..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none"
                />
              </div>
            </div>

            {!job || filteredTasks.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">
                {!job ? 'No active or recent probe batch in queue.' : 'No queue items match this filter.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-800 max-h-[560px] overflow-y-auto">
                {filteredTasks.map((t) => {
                  const statusBadge = (() => {
                    switch (t.status) {
                      case 'found_yes':
                        return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
                      case 'checking_direct':
                      case 'checking_inner_links':
                        return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
                      case 'cloudflare_blocked':
                        return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
                      case 'skipped_cloudflare_json':
                        return 'bg-slate-800 text-orange-300 border-slate-700';
                      case 'skipped_in_json':
                        return 'bg-slate-800 text-cyan-300 border-slate-700';
                      case 'skipped_domain_limit':
                        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
                      case 'error':
                        return 'bg-rose-500/15 text-rose-400 border-rose-500/30';
                      case 'no_video':
                        return 'bg-slate-800 text-slate-400 border-slate-700';
                      default:
                        return 'bg-slate-950 text-slate-400 border-slate-800';
                    }
                  })();

                  const statusLabel = (() => {
                    switch (t.status) {
                      case 'found_yes':
                        return 'YES';
                      case 'checking_direct':
                        return 'CHECKING PAGE';
                      case 'checking_inner_links':
                        return 'SAME-SITE LINK';
                      case 'cloudflare_blocked':
                        return 'CF BLOCKED';
                      case 'skipped_cloudflare_json':
                        return 'CF JSON SKIP';
                      case 'skipped_in_json':
                        return 'IN JSON';
                      case 'skipped_domain_limit':
                        return '5-CAP SKIP';
                      case 'error':
                        return 'ERROR';
                      case 'no_video':
                        return 'NO VIDEO';
                      default:
                        return 'PENDING';
                    }
                  })();

                  return (
                    <div key={t.id} className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono tabular-nums text-slate-500">#{t.index}</span>
                          <span className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${statusBadge}`}>
                            {statusLabel}
                          </span>
                          {t.workerId && (
                            <span className="font-mono tabular-nums text-[11px] text-slate-400">
                              W{t.workerId}
                            </span>
                          )}
                          <span className="font-semibold text-slate-200">{t.scopeKey}</span>
                          {t.usedHomeDomainFallback && (
                            <span className="text-[11px] text-amber-300">· Home Domain</span>
                          )}
                          {t.discoveryDepth === 1 && (
                            <span className="text-[11px] text-cyan-400">· Via Same-Site Link</span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 truncate" title={t.url}>
                          {t.url}
                        </div>
                        {t.message && (
                          <div className="text-[11px] text-slate-300 truncate">{t.message}</div>
                        )}
                        {t.videoUrl && (
                          <div className="font-mono text-[11px] text-emerald-400 truncate" title={t.videoUrl}>
                            Video: {t.videoUrl}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <a
                          href={t.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1 text-[11px] font-medium text-slate-200 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                          title={`Open ${t.url} in new page`}
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>Open Link</span>
                        </a>
                        {t.matchedPageUrl && t.matchedPageUrl !== t.url && (
                          <a
                            href={t.matchedPageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1 text-[11px] font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                            title={`Open matched video page ${t.matchedPageUrl} in new page`}
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>Video Page</span>
                          </a>
                        )}
                        {t.videoUrl && (
                          <button
                            type="button"
                            onClick={() => handleCopyText(t.videoUrl!, `qvid_${t.id}`)}
                            className="px-2.5 py-1 text-[11px] font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                          >
                            {copiedKey === `qvid_${t.id}` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            <span>Copy Video</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
