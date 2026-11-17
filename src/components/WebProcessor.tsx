import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Globe,
  Search,
  ArrowRight,
  RefreshCw,
  Play,
  Film,
  Image as ImageIcon,
  Check,
  Copy,
  ExternalLink,
  Layers,
  Sparkles,
  Tag,
  Clock,
  HardDrive,
  AlertCircle,
  FolderTree,
  Code,
  CheckCheck,
  Filter,
  Eye,
  Type,
  MousePointerClick,
  FileText,
  X,
  SlidersHorizontal,
  ChevronDown,
  Info,
  UploadCloud,
  Cloud,
  CheckCircle2,
  Pause,
  RotateCcw,
  ListFilter,
  ListOrdered,
  Share2,
  Download,
  Trash2,
  ShieldCheck,
  Zap,
  Pencil,
  Plus,
  Square,
  ArrowUpRight,
  Settings2,
  Radio,
} from 'lucide-react';
import { AppTabType } from './Header';
import { getR2Headers } from '../utils/r2Service';
import { JsonObjectEditorModal } from './admin/JsonObjectEditorModal';

export interface WebProcessorBatchProgress {
  isRunning: boolean;
  isPaused: boolean;
  concurrency: number;
  completedCount: number;
  totalCount: number;
  activeWorkers: number;
}

export interface WebProcessorProps {
  onNavigateTab: (tab: AppTabType, initialData?: any) => void;
  onBatchProgressUpdate?: (progress: WebProcessorBatchProgress) => void;
  externalConcurrency?: number;
  onConcurrencyChange?: (concurrency: number) => void;
}

export interface CandidateTitle {
  source: string;
  text: string;
  rawText?: string;
  selector?: string;
}

export interface CandidateThumbnail {
  source: string;
  url: string;
  selector?: string;
  dimensions?: string;
}

export interface ProcessedWebResult {
  success: boolean;
  fromCache?: boolean;
  cachedByWebUrl?: boolean;
  registryUniqueId?: string;
  isRegisteredInCloudflare?: boolean;
  isUploadedToCloudflare?: boolean;
  videoUploadError?: string | null;
  thumbUploadError?: string | null;
  status: number;
  statusText: string;
  targetUrl: string;
  finalUrl: string;
  responseTimeMs: number;
  contentType: string;
  headers: {
    server: string | null;
    'content-type': string | null;
    'content-length': string | null;
    'cache-control': string | null;
    date: string | null;
    [key: string]: string | null;
  };
  page: {
    title: string;
    rawTitle?: string;
    description: string;
    favicon: string;
    ogImage: string;
    cloudflareThumbnailUrl?: string | null;
    thumbnailStorageSource?: 'cloudflare_r2' | 'emulator' | null;
    cloudflareVideoUrl?: string | null;
    videoStorageSource?: 'cloudflare_r2' | 'emulator' | null;
    videoUploadError?: string | null;
    thumbUploadError?: string | null;
    ogVideo: string;
    siteName: string;
    canonical?: string;
    durationSec?: number | null;
    durationFormatted?: string | null;
    videoSize?: {
      sizeBytes: number;
      sizeMb: string;
      sizeFormatted: string;
    } | null;
    videoCompression?: {
      compressed: boolean;
      quality?: VideoCompressionQuality;
      originalSizeBytes?: number;
      savedPercent?: number;
    } | null;
    removedWords?: string[];
    candidateTitles?: CandidateTitle[];
    candidateThumbnails?: CandidateThumbnail[];
  };
  media: {
    videos: Array<{
      id: number;
      url: string;
      originalVideoUrl?: string;
      cloudflareVideoUrl?: string;
      poster?: string;
      cloudflareThumbnailUrl?: string;
      title?: string;
      rawTitle?: string;
      type: string;
      filename: string;
      durationSec?: number | null;
      durationFormatted?: string | null;
      sizeBytes?: number | null;
      sizeMb?: string | null;
      sizeFormatted?: string | null;
      description?: string;
    }>;
    iframes: Array<{
      src: string;
      type: string;
      title?: string;
    }>;
    images: Array<{
      src: string;
      alt?: string;
      width?: string;
      height?: string;
    }>;
  };
  content: {
    headings: string[];
    textExcerpt: string;
    metaTags: Record<string, string>;
    jsonLd: any[];
  };
  fullHtml?: string;
  rawSnippet: string;
  htmlLength?: number;
}

export interface BatchQueueItem {
  id: string;
  url: string;
  index: number;
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
  attempts?: number;
  serverUsed?: string;
  queueId?: string;
}

export type BatchQueueStatus = 'queued' | 'running' | 'paused' | 'stopped' | 'completed';

export interface BatchQueueOptions {
  batchSkipMode: BatchSkipMode;
  wordsToRemove: string;
  uploadThumbnailToR2: boolean;
  uploadVideoToR2: boolean;
  compressVideo: boolean;
  compressionQuality: VideoCompressionQuality;
  autoRetryIncomplete: boolean;
  maxAutoRetryPasses: number;
  serverPool: string[];
}

export interface BatchQueueGroup {
  queueId: string;
  queueNumber: number;
  name: string;
  status: BatchQueueStatus;
  options: BatchQueueOptions;
  total: number;
  completed: number;
  skipped: number;
  errors: number;
  incompleteCount: number;
  activeWorkers: number;
  currentPass: number;
  statusMessage?: string;
  createdAt?: string;
  startedAt?: string;
  endTime?: string;
  lastUpdatedAt?: string;
  tasks: BatchQueueItem[];
}

// Case-insensitive title word removal and bracket/separator normalization
export function cleanTitleWithFilter(
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

// Format seconds into readable duration string
export function formatSecondsToDuration(totalSecs: number): string {
  if (!totalSecs || isNaN(totalSecs) || totalSecs <= 0) return '';
  const secs = Math.round(totalSecs);
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const remainingSecs = secs % 60;

  if (hours > 0) {
    return `${hours}h ${mins}m ${remainingSecs}s`;
  }
  if (mins > 0) {
    return `${mins} min ${remainingSecs}s`;
  }
  return `${remainingSecs}s`;
}

// Extract all HTTP/HTTPS URLs from any arbitrary text block
export function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s"',<>]+)/gi;
  const matches = text.match(urlRegex) || [];
  const cleaned = matches
    .map((u) => u.replace(/[.,;:)\]]+$/, '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
  return Array.from(new Set(cleaned));
}

export type BatchSkipMode = 'smart_cache' | 'strict_skip' | 'dont_skip';
export type VideoCompressionQuality = 'high' | 'balanced' | 'compact' | 'low';

export const COMPRESSION_QUALITY_OPTIONS: Array<{
  value: VideoCompressionQuality;
  label: string;
  shortLabel: string;
  detail: string;
}> = [
  { value: 'high', label: 'High · 1080p (CRF 22)', shortLabel: '1080p High', detail: 'Best quality · light compression' },
  { value: 'balanced', label: 'Balanced · 720p (CRF 26)', shortLabel: '720p Balanced', detail: 'Recommended · sharp & smaller' },
  { value: 'compact', label: 'Compact · 480p (CRF 29)', shortLabel: '480p Compact', detail: 'Small files · fast upload' },
  { value: 'low', label: 'Low · 360p (CRF 32)', shortLabel: '360p Low', detail: 'Ultra small · max savings' },
];

export const WebProcessor: React.FC<WebProcessorProps> = ({
  onNavigateTab,
  onBatchProgressUpdate,
  externalConcurrency,
  onConcurrencyChange,
}) => {
  // Mode: 'single' | 'batch'
  const [inputMode, setInputMode] = useState<'single' | 'batch'>('single');

  // Single URL inputs
  const [urlInput, setUrlInput] = useState('');
  const [wordsToRemove, setWordsToRemove] = useState('');
  const [autoUploadToR2, setAutoUploadToR2] = useState(true);
  const [autoUploadVideoToR2, setAutoUploadVideoToR2] = useState(true);
  const [compressVideo, setCompressVideo] = useState(false); // Default OFF
  const [compressionQuality, setCompressionQuality] = useState<VideoCompressionQuality>('balanced');
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<ProcessedWebResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Thumbnail upload to Cloudflare state
  const [isUploadingThumb, setIsUploadingThumb] = useState(false);
  const [thumbUploadSuccess, setThumbUploadSuccess] = useState<string | null>(null);

  // Video upload to Cloudflare state
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [videoUploadSuccess, setVideoUploadSuccess] = useState<string | null>(null);

  // Sub-tabs: 'media' | 'titles' | 'thumbs' | 'html-explorer' | 'page' | 'raw'
  const [activeSubTab, setActiveSubTab] = useState<'media' | 'titles' | 'thumbs' | 'html-explorer' | 'page' | 'raw'>('media');

  // Currently active selected metadata
  const [rawBaseTitle, setRawBaseTitle] = useState('');
  const [activeTitle, setActiveTitle] = useState('');
  const [activeThumbnail, setActiveThumbnail] = useState('');
  const [activeCloudflareThumbnail, setActiveCloudflareThumbnail] = useState<string | null>(null);
  const [activeStreamUrl, setActiveStreamUrl] = useState('');
  const [activeCloudflareVideo, setActiveCloudflareVideo] = useState<string | null>(null);
  const [activeDescription, setActiveDescription] = useState('');
  const [activeDurationFormatted, setActiveDurationFormatted] = useState('');
  const [activeDurationSec, setActiveDurationSec] = useState<number | null>(null);
  const [activeVideoSize, setActiveVideoSize] = useState('');
  const [activeVideoSizeBytes, setActiveVideoSizeBytes] = useState<number | null>(null);
  const [activeCompressionInfo, setActiveCompressionInfo] = useState<{
    compressed: boolean;
    quality?: VideoCompressionQuality;
    originalSizeBytes?: number;
    savedPercent?: number;
  } | null>(null);
  const [showRawComparison, setShowRawComparison] = useState(false);

  // Multi-Link Multi-Queue State & VPS Multi-Worker Concurrency (1 - 50)
  const [batchRawText, setBatchRawText] = useState('');
  const [draftQueueName, setDraftQueueName] = useState('');
  const [batchQueue, setBatchQueue] = useState<BatchQueueItem[]>([]);
  const [queues, setQueues] = useState<BatchQueueGroup[]>([]);
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [batchUploadVideoToR2, setBatchUploadVideoToR2] = useState<boolean>(true);
  const [batchUploadThumbnailToR2, setBatchUploadThumbnailToR2] = useState<boolean>(true);
  const [showQueueOptionsEditor, setShowQueueOptionsEditor] = useState<boolean>(false);
  const [isUpdatingQueueOpts, setIsUpdatingQueueOpts] = useState<boolean>(false);
  const [queueEditDraft, setQueueEditDraft] = useState<BatchQueueOptions | null>(null);
  const [concurrency, setConcurrency] = useState<number>(externalConcurrency ?? 3); // 1 - 50 workers

  // Dynamic concurrency refs for live scaling during active runs
  const concurrencyRef = useRef<number>(externalConcurrency ?? 3);
  concurrencyRef.current = concurrency;
  const isBatchRunningRef = useRef(false);
  const currentQueueRef = useRef<BatchQueueItem[]>([]);
  const nextIndexRef = useRef<number>(0);
  const runningWorkerCountRef = useRef<number>(0);
  const workerIdCounterRef = useRef<number>(0);
  const runWorkerFnRef = useRef<((id: number) => Promise<void>) | null>(null);

  const handleSetConcurrency = (num: number) => {
    const clamped = Math.max(1, Math.min(50, num));
    setConcurrency(clamped);
    concurrencyRef.current = clamped;
    if (onConcurrencyChange) {
      onConcurrencyChange(clamped);
    }

    if (isBatchRunning) {
      fetch('/api/vps-batch/concurrency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concurrency: clamped }),
      }).catch(() => {});
    }

    // Dynamic adjustment while local batch is actively running
    if (isBatchRunningRef.current && !cancelRef.current && !pauseRef.current && runWorkerFnRef.current) {
      const targetCount = Math.min(clamped, currentQueueRef.current.length);
      const deficit = targetCount - runningWorkerCountRef.current;
      if (deficit > 0 && nextIndexRef.current < currentQueueRef.current.length) {
        for (let i = 0; i < deficit; i++) {
          const newWorkerId = ++workerIdCounterRef.current;
          runWorkerFnRef.current(newWorkerId);
        }
      }
    }
  };

  // Sync external concurrency changes from the top VPS telemetry bar (up to 50 workers)
  useEffect(() => {
    if (
      externalConcurrency !== undefined &&
      externalConcurrency >= 1 &&
      externalConcurrency <= 50 &&
      externalConcurrency !== concurrency
    ) {
      handleSetConcurrency(externalConcurrency);
    }
  }, [externalConcurrency]);

  const [activeWorkers, setActiveWorkers] = useState<number>(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [isBatchPaused, setIsBatchPaused] = useState(false);
  const [activeBatchIndex, setActiveBatchIndex] = useState<number>(-1);
  const [batchSkipMode, setBatchSkipMode] = useState<BatchSkipMode>('smart_cache');
  const [autoRetryIncomplete, setAutoRetryIncomplete] = useState<boolean>(true);
  const [maxAutoRetryPasses, setMaxAutoRetryPasses] = useState<number>(3);
  const [serverPoolText, setServerPoolText] = useState<string>('');
  const [isFetchingFreeProxies, setIsFetchingFreeProxies] = useState<boolean>(false);
  const [freeProxyMessage, setFreeProxyMessage] = useState<string | null>(null);
  const [showCfRelayCode, setShowCfRelayCode] = useState<boolean>(false);
  const [serverJobPass, setServerJobPass] = useState<{
    current: number;
    max: number;
    message?: string;
    incompleteCount?: number;
    pausedForLoadCount?: number;
    activeCompressions?: number;
    currentCpuPercent?: number;
  } | null>(null);
  const [vpsScopeInfo, setVpsScopeInfo] = useState<{
    scopeId: string;
    scopeSlug: string;
    scopeLabel: string;
    d1DocId: string;
    source: string;
  } | null>(null);
  const [cloudKeepAliveActive, setCloudKeepAliveActive] = useState<boolean>(false);
  const [cloudKeepAliveMode, setCloudKeepAliveMode] = useState<'active' | 'iap_blocked' | 'no_public_url' | 'idle'>('idle');
  const [uptimeTestStatus, setUptimeTestStatus] = useState<string | null>(null);
  const [isTestingUptime, setIsTestingUptime] = useState(false);
  const uptimePingUrl = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}/api/uptime`;
    }
    return '/api/uptime';
  }, []);
  const isStudioPreviewHost =
    typeof window !== 'undefined' && /^(ais-dev|ais-pre)-/i.test(window.location.hostname || '');
  const handleTestUptimePing = async () => {
    setIsTestingUptime(true);
    try {
      const res = await fetch('/api/uptime');
      const data = await res.json();
      if (res.ok && data?.ok) {
        setUptimeTestStatus(`200 UP · ${data.queueState || 'idle'}`);
      } else {
        setUptimeTestStatus(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      setUptimeTestStatus(err?.message || 'Error');
    } finally {
      setIsTestingUptime(false);
    }
  };
  const [singleRegistryRecord, setSingleRegistryRecord] = useState<any | null>(null);
  const [editingRegistryRecord, setEditingRegistryRecord] = useState<any | null>(null);
  const pauseRef = useRef(false);
  const cancelRef = useRef(false);
  const onBatchProgressUpdateRef = useRef(onBatchProgressUpdate);
  onBatchProgressUpdateRef.current = onBatchProgressUpdate;
  const lastBroadcastRef = useRef<string>('');

  const selectedQueue = useMemo(() => {
    if (queues.length === 0) return null;
    return queues.find((q) => q.queueId === selectedQueueId) || queues[0] || null;
  }, [queues, selectedQueueId]);

  const displayedBatchTasks = useMemo(() => {
    if (selectedQueue) return selectedQueue.tasks || [];
    return batchQueue;
  }, [selectedQueue, batchQueue]);

  // Sync live queue editor draft whenever selected queue switches (unless user is actively editing)
  useEffect(() => {
    if (selectedQueue && !showQueueOptionsEditor) {
      setQueueEditDraft({ ...selectedQueue.options });
    }
  }, [selectedQueue?.queueId, showQueueOptionsEditor]);

  const applyServerBatchJob = (job: any, switchToBatchIfRunning = false, preferredSelectQueueId?: string) => {
    if (!job) {
      setQueues([]);
      setBatchQueue([]);
      setIsBatchRunning(false);
      setIsBatchPaused(false);
      setActiveWorkers(0);
      setServerJobPass(null);
      return;
    }

    const incomingQueues: BatchQueueGroup[] = Array.isArray(job.queues)
      ? job.queues
      : Array.isArray(job.tasks) && job.tasks.length > 0
      ? [
          {
            queueId: job.jobId || 'q_1',
            queueNumber: 1,
            name: 'Queue #1',
            status: job.isPaused ? 'paused' : job.isRunning ? 'running' : 'completed',
            options: {
              batchSkipMode: job.batchSkipMode || 'smart_cache',
              wordsToRemove: job.wordsToRemove || '',
              uploadThumbnailToR2: job.uploadThumbnailToR2 ?? true,
              uploadVideoToR2: job.uploadVideoToR2 ?? true,
              compressVideo: Boolean(job.compressVideo),
              compressionQuality: job.compressionQuality || 'balanced',
              autoRetryIncomplete: job.autoRetryIncomplete ?? true,
              maxAutoRetryPasses: Number(job.maxAutoRetryPasses ?? 3),
              serverPool: Array.isArray(job.serverPool) ? job.serverPool : [],
            },
            total: job.tasks.length,
            completed: Number(job.completed || 0),
            skipped: Number(job.skipped || 0),
            errors: Number(job.errors || 0),
            incompleteCount: Number(job.incompleteCount || 0),
            activeWorkers: Number(job.activeWorkers || 0),
            currentPass: Number(job.currentPass || 1),
            statusMessage: job.statusMessage || '',
            tasks: job.tasks,
          },
        ]
      : [];

    setQueues(incomingQueues);
    const activeQ =
      (preferredSelectQueueId && incomingQueues.find((q) => q.queueId === preferredSelectQueueId)) ||
      (selectedQueueId && incomingQueues.find((q) => q.queueId === selectedQueueId)) ||
      incomingQueues.find((q) => q.queueId === job.activeQueueId) ||
      incomingQueues[0] ||
      null;

    if (preferredSelectQueueId) {
      setSelectedQueueId(preferredSelectQueueId);
    } else if (activeQ && (!selectedQueueId || !incomingQueues.some((q) => q.queueId === selectedQueueId))) {
      setSelectedQueueId(activeQ.queueId);
    }

    setBatchQueue(activeQ?.tasks || (Array.isArray(job.tasks) ? job.tasks : []));
    setIsBatchRunning(Boolean(job.isRunning));
    setIsBatchPaused(Boolean(job.isPaused));
    setActiveWorkers(Number(job.activeWorkers || 0));
    setServerJobPass({
      current: Number(activeQ?.currentPass || job.currentPass || 1),
      max: 1 + Number(activeQ?.options?.maxAutoRetryPasses ?? job.maxAutoRetryPasses ?? 0),
      message: job.statusMessage || activeQ?.statusMessage || '',
      incompleteCount: Number(job.incompleteCount || 0),
      pausedForLoadCount: Number(job.pausedForLoadCount || 0),
      activeCompressions: Number(job.activeCompressions || 0),
      currentCpuPercent: typeof job.currentCpuPercent === 'number' ? job.currentCpuPercent : undefined,
    });

    if (typeof job.concurrency === 'number' && job.concurrency >= 1 && job.concurrency <= 50) {
      setConcurrency(job.concurrency);
      concurrencyRef.current = job.concurrency;
    }
    if (Array.isArray(job.serverPool) && job.serverPool.length > 0 && !serverPoolText.trim()) {
      setServerPoolText(job.serverPool.join('\n'));
    }
    if (
      switchToBatchIfRunning &&
      (job.isRunning || (Array.isArray(job.queues) && job.queues.length > 0) || (Array.isArray(job.tasks) && job.tasks.length > 0))
    ) {
      setInputMode('batch');
    }
  };

  // Restore saved/running server background job on mount, poll actively while running,
  // refresh gently when idle, and sync immediately when browser tab regains focus/visibility.
  useEffect(() => {
    let cancelled = false;
    const loadStatus = async (initial = false) => {
      try {
        const res = await fetch('/api/vps-batch/status', {
          headers: { ...getR2Headers() },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data?.vpsScope) {
          setVpsScopeInfo(data.vpsScope);
        }
        setCloudKeepAliveActive(Boolean(data?.cloudKeepAliveActive));
        if (data?.cloudKeepAliveMode) {
          setCloudKeepAliveMode(data.cloudKeepAliveMode);
        }
        if (data?.job && ((Array.isArray(data.job.queues) && data.job.queues.length > 0) || (Array.isArray(data.job.tasks) && data.job.tasks.length > 0))) {
          applyServerBatchJob(data.job, initial);
        } else if (initial && Array.isArray(data?.defaultServerPool) && data.defaultServerPool.length > 0) {
          setServerPoolText(data.defaultServerPool.join('\n'));
        }
      } catch {}
    };

    loadStatus(true);

    const intervalMs = isBatchRunning ? 2000 : 10000;
    const interval = setInterval(() => {
      loadStatus(false);
    }, intervalMs);

    const handleVisibilityOrFocus = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadStatus(false);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleVisibilityOrFocus);
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleVisibilityOrFocus);
      }
    };
  }, [isBatchRunning]);

  // Broadcast combined multi-queue background batch status so Header & VpsResourceBar stay accurate
  useEffect(() => {
    if (!onBatchProgressUpdateRef.current) return;
    const allTasks = queues.length > 0 ? queues.flatMap((q) => q.tasks || []) : batchQueue;
    const completedCount = allTasks.filter(
      (q) => q.status === 'completed' || q.status === 'skipped_in_cloudflare'
    ).length;
    const payload = {
      isRunning: isBatchRunning,
      isPaused: isBatchPaused,
      concurrency,
      completedCount,
      totalCount: allTasks.length,
      activeWorkers,
    };
    const serialized = JSON.stringify(payload);
    if (serialized !== lastBroadcastRef.current) {
      lastBroadcastRef.current = serialized;
      onBatchProgressUpdateRef.current(payload);
    }
  }, [isBatchRunning, isBatchPaused, queues, batchQueue, concurrency, activeWorkers]);

  // HTML Inspector search & filter
  const [htmlSearchTerm, setHtmlSearchTerm] = useState('');
  const [htmlFilterTag, setHtmlFilterTag] = useState<string>('all');
  const [customSelector, setCustomSelector] = useState('');
  const [selectorTestResult, setSelectorTestResult] = useState<string | null>(null);

  // Playback & Copy states
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [previewStreamUrl, setPreviewStreamUrl] = useState<string | null>(null);
  const [browserDetectedDuration, setBrowserDetectedDuration] = useState<number | null>(null);

  // Common title words chips
  const commonFilterChips = [
    '[HD]',
    '1080p',
    '720p',
    '4K',
    'Official Video',
    'Free Download',
    'Full Movie',
    'Hindi',
    'Dubbed',
    'MP4',
    'WebRip',
    'Trailer',
  ];

  // Quick preset test URLs
  const sampleUrls = [
    {
      label: 'Big Buck Bunny (Direct MP4)',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    },
    {
      label: 'Elephants Dream (Direct MP4)',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    },
    {
      label: 'Mux HLS Test Stream (.m3u8)',
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    },
    {
      label: 'Internet Archive Public Movies',
      url: 'https://archive.org/details/movies',
    },
  ];

  // Auto-extract links when user types/pastes into batchRawText
  const detectedLinksInBatch = useMemo(() => {
    return extractUrlsFromText(batchRawText);
  }, [batchRawText]);

  // Also check if single URL input contains multiple links
  const detectedMultipleInSingle = useMemo(() => {
    const urls = extractUrlsFromText(urlInput);
    return urls.length > 1 ? urls : null;
  }, [urlInput]);

  // Handle addition/toggle of filter chips
  const handleToggleChip = (chip: string) => {
    const terms = wordsToRemove
      .split(/[,|\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const existsIndex = terms.findIndex((t) => t.toLowerCase() === chip.toLowerCase());
    let nextTerms: string[];
    if (existsIndex >= 0) {
      nextTerms = terms.filter((_, i) => i !== existsIndex);
    } else {
      nextTerms = [...terms, chip];
    }
    const newWordsStr = nextTerms.join(', ');
    setWordsToRemove(newWordsStr);

    if (rawBaseTitle) {
      const res = cleanTitleWithFilter(rawBaseTitle, newWordsStr);
      setActiveTitle(res.cleaned);
    }
  };

  const handleWordsToRemoveChange = (newWords: string) => {
    setWordsToRemove(newWords);
    if (rawBaseTitle) {
      const res = cleanTitleWithFilter(rawBaseTitle, newWords);
      setActiveTitle(res.cleaned);
    }
  };

  // Upload thumbnail directly to Cloudflare R2 and retrieve permanent back link
  const handleUploadActiveThumbnailToCloudflare = async () => {
    if (!activeThumbnail) {
      setErrorMessage('No thumbnail URL available to upload to Cloudflare');
      return;
    }

    setIsUploadingThumb(true);
    setThumbUploadSuccess(null);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/upload-thumbnail-to-r2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getR2Headers(),
        },
        body: JSON.stringify({
          imageUrl: activeThumbnail,
          customFilename: activeTitle || 'thumb',
          folderPrefix: 'thumbnails',
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to upload thumbnail to Cloudflare R2');
      }

      const backLink = data.cloudflareBackLink;
      setActiveCloudflareThumbnail(backLink);
      setActiveThumbnail(backLink); // Replace active thumbnail with permanent Cloudflare link!
      setThumbUploadSuccess(backLink);

      // Persist updated Cloudflare thumbnail back link into saved registry
      const regSourceUrl = result?.targetUrl || urlInput.trim();
      if (regSourceUrl) {
        fetch('/api/registry/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceUrl: regSourceUrl,
            title: activeTitle || undefined,
            thumbnailUrl: backLink,
            cloudflareThumbnailUrl: backLink,
            thumbnailStorageSource: data.storageSource || 'cloudflare_r2',
          }),
        }).catch(() => {});
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error uploading thumbnail to Cloudflare R2');
    } finally {
      setIsUploadingThumb(false);
    }
  };

  // Upload video stream directly to Cloudflare R2 and retrieve permanent back link
  const handleUploadActiveVideoToCloudflare = async () => {
    if (!activeStreamUrl) {
      setErrorMessage('No video stream URL available to upload to Cloudflare');
      return;
    }

    setIsUploadingVideo(true);
    setVideoUploadSuccess(null);
    setErrorMessage(null);

    try {
      const originalStreamBeforeUpload = activeStreamUrl;
      const res = await fetch('/api/upload-video-to-r2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getR2Headers(),
        },
        body: JSON.stringify({
          videoUrl: originalStreamBeforeUpload,
          customFilename: activeTitle || 'video',
          folderPrefix: 'videos',
          refererUrl: result?.finalUrl || result?.targetUrl || urlInput.trim() || undefined,
          compressVideo,
          compressionQuality,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to upload video to Cloudflare R2');
      }

      const backLink = data.cloudflareVideoBackLink;
      setActiveCloudflareVideo(backLink);
      setActiveStreamUrl(backLink); // Set permanent Cloudflare video link as active stream
      if (data.sizeFormatted) {
        setActiveVideoSize(data.sizeFormatted);
      }
      if (data.sizeBytes) {
        setActiveVideoSizeBytes(Number(data.sizeBytes));
      }
      if (data.compressed) {
        setActiveCompressionInfo({
          compressed: true,
          quality: data.compressionQuality || compressionQuality,
          originalSizeBytes: data.originalSizeBytes,
          savedPercent: data.savedPercent,
        });
      }
      if (data.durationSec) {
        setActiveDurationSec(data.durationSec);
        setActiveDurationFormatted(data.durationFormatted || formatSecondsToDuration(data.durationSec));
      }
      setVideoUploadSuccess(backLink);

      // Persist updated Cloudflare video URL + verified size & duration into saved registry
      const regSourceUrl = result?.targetUrl || urlInput.trim();
      if (regSourceUrl) {
        fetch('/api/registry/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceUrl: regSourceUrl,
            title: activeTitle || undefined,
            rawTitle: rawBaseTitle || undefined,
            description: activeDescription || undefined,
            videoUrl: originalStreamBeforeUpload,
            cloudflareVideoUrl: backLink,
            videoStorageSource: data.storageSource || 'cloudflare_r2',
            cloudflareThumbnailUrl: activeCloudflareThumbnail || undefined,
            sizeBytes: data.sizeBytes ?? undefined,
            sizeMb: data.sizeMb || undefined,
            sizeFormatted: data.sizeFormatted || activeVideoSize || undefined,
            durationSec: data.durationSec ?? activeDurationSec ?? undefined,
            durationFormatted: data.durationFormatted || activeDurationFormatted || undefined,
          }),
        }).catch(() => {});
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error uploading video to Cloudflare R2');
    } finally {
      setIsUploadingVideo(false);
    }
  };

  // Process single URL (Strictly matched by Web URL with 0 duplicate copies)
  const handleProcessUrl = async (overrideUrl?: string, forceRefresh: boolean = false) => {
    const target = (overrideUrl || urlInput).trim();
    if (!target) {
      setErrorMessage('Please enter a website or media stream URL to process.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);
    setSelectorTestResult(null);
    setThumbUploadSuccess(null);
    setVideoUploadSuccess(null);
    setSingleRegistryRecord(null);

    try {
      // Step 1: Query Cloudflare Registry strictly by Web URL
      let cachedRecord: any = null;
      try {
        const checkRes = await fetch('/api/registry/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: [target], autoRegisterIfMissing: false }),
        });
        const checkData = await checkRes.json();
        const checkItem = checkData.results?.[0];
        if (checkItem?.isRegistered && checkItem.record) {
          const rec = checkItem.record;
          const hasCfVideo = Boolean(rec.cloudflareVideoUrl);
          const hasCfThumb = Boolean(rec.cloudflareThumbnailUrl);
          // Only reuse cached record if it actually holds complete Cloudflare assets matching current upload settings
          const hasProcessedAssets =
            (hasCfVideo || (rec.status === 'uploaded' && hasCfThumb && !rec.videoUrl)) &&
            (!autoUploadVideoToR2 || hasCfVideo || (rec.status === 'uploaded' && !rec.videoUrl)) &&
            (!autoUploadToR2 || hasCfThumb || !rec.thumbnailUrl);

          if (hasProcessedAssets) {
            setSingleRegistryRecord({ ...rec, isNew: false, noCopy: checkItem.noCopy, hasProcessedAssets: true });
            cachedRecord = rec;
          } else {
            // Link was not uploaded to Cloudflare R2 yet (or missing video upload) — proceed to live processing & update!
            setSingleRegistryRecord(null);
          }
        }
      } catch (e) {
        console.warn('Pre-check registry error:', e);
      }

      // Step 2: If Web URL already has full Cloudflare assets and user didn't force re-scrape, reuse directly!
      if (cachedRecord && !forceRefresh) {
        const bestTitle = cachedRecord.title || 'Archived Link';
        const bestRawTitle = cachedRecord.rawTitle || bestTitle;
        const bestThumb = cachedRecord.cloudflareThumbnailUrl || cachedRecord.thumbnailUrl || '';
        const bestStream = cachedRecord.cloudflareVideoUrl || cachedRecord.videoUrl || '';
        const bestDesc =
          cachedRecord.description ||
          (cachedRecord.destination && cachedRecord.destination !== 'none'
            ? `Saved in Cloudflare. Destination: ${cachedRecord.destination}`
            : 'Cached Cloudflare vault item');
        const bestDurationFormatted = cachedRecord.durationFormatted || '';
        const bestDurationSec = cachedRecord.durationSec ?? null;
        const bestSize = cachedRecord.sizeFormatted || '';

        setRawBaseTitle(bestRawTitle);
        setActiveTitle(bestTitle);
        setActiveThumbnail(bestThumb);
        setActiveCloudflareThumbnail(cachedRecord.cloudflareThumbnailUrl || null);
        setActiveStreamUrl(bestStream);
        setActiveCloudflareVideo(cachedRecord.cloudflareVideoUrl || null);
        setActiveDescription(bestDesc);
        setActiveDurationFormatted(bestDurationFormatted);
        setActiveDurationSec(bestDurationSec);
        setActiveVideoSize(bestSize);
        setActiveVideoSizeBytes(cachedRecord.sizeBytes ?? (cachedRecord.sizeMb ? Math.round(Number(cachedRecord.sizeMb) * 1024 * 1024) : null));

        setResult({
          success: true,
          fromCache: true,
          cachedByWebUrl: true,
          status: 200,
          statusText: 'OK (Reused from Cloudflare Vault by Web URL · 0 Copies)',
          targetUrl: target,
          finalUrl: cachedRecord.sourceUrl || target,
          registryUniqueId: cachedRecord.id,
          isRegisteredInCloudflare: true,
          isUploadedToCloudflare: Boolean(cachedRecord.cloudflareVideoUrl || cachedRecord.status === 'uploaded'),
          responseTimeMs: 0,
          contentType: 'text/html; charset=utf-8',
          headers: {
            server: 'cloudflare-r2-vault',
            'content-type': 'text/html; charset=utf-8',
            'content-length': null,
            'cache-control': 'public, max-age=86400',
            date: new Date().toUTCString(),
          },
          page: {
            title: bestTitle,
            rawTitle: bestRawTitle,
            description: bestDesc,
            favicon: '',
            ogImage: bestThumb,
            ogVideo: bestStream,
            siteName: 'Cloudflare Vault',
            cloudflareVideoUrl: cachedRecord.cloudflareVideoUrl,
            cloudflareThumbnailUrl: cachedRecord.cloudflareThumbnailUrl,
            durationFormatted: bestDurationFormatted,
            durationSec: bestDurationSec,
            videoSize:
              bestSize || cachedRecord.sizeBytes
                ? {
                    sizeBytes: cachedRecord.sizeBytes || 0,
                    sizeMb: cachedRecord.sizeMb || '0',
                    sizeFormatted: bestSize,
                  }
                : null,
          },
          media: {
            videos: [
              {
                id: 1,
                url: bestStream,
                originalVideoUrl: cachedRecord.videoUrl || bestStream,
                cloudflareVideoUrl: cachedRecord.cloudflareVideoUrl,
                poster: bestThumb,
                cloudflareThumbnailUrl: cachedRecord.cloudflareThumbnailUrl,
                type: 'video/mp4',
                filename: bestTitle,
                title: bestTitle,
                rawTitle: bestRawTitle,
                durationSec: bestDurationSec,
                durationFormatted: bestDurationFormatted,
                sizeBytes: cachedRecord.sizeBytes ?? null,
                sizeMb: cachedRecord.sizeMb ?? null,
                sizeFormatted: bestSize || null,
                description: bestDesc,
              },
            ],
            images: bestThumb ? [{ src: bestThumb, alt: bestTitle }] : [],
            iframes: [],
          },
          content: {
            headings: [bestTitle],
            textExcerpt: bestDesc || `Saved in Cloudflare registry. Registered on ${cachedRecord.firstExtractedAt || 'earlier session'}.`,
            metaTags: {},
            jsonLd: [],
          },
          fullHtml: `<!-- Cached Cloudflare Registry Entry for Web URL: ${target} -->`,
          rawSnippet: `Cached record from Cloudflare: ${bestTitle}`,
          htmlLength: 0,
        });

        if (bestStream) {
          setActiveSubTab('media');
        }
        setIsProcessing(false);
        return;
      }

      setActiveCompressionInfo(null);

      // Step 3: Fetch via /api/process-url (server will also check Web URL cache unless forceRefresh)
      const response = await fetch('/api/process-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getR2Headers(),
        },
        body: JSON.stringify({
          url: target,
          wordsToRemove: wordsToRemove.trim(),
          uploadThumbnailToR2: autoUploadToR2,
          uploadVideoToR2: autoUploadVideoToR2,
          compressVideo,
          compressionQuality,
          forceRefresh,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Failed to process URL (${response.status})`);
      }

      setResult(data);

      const bestTitle = data.page?.title || data.media?.videos?.[0]?.title || '';
      const bestRawTitle = data.page?.rawTitle || data.media?.videos?.[0]?.rawTitle || bestTitle;
      const bestThumb =
        data.page?.cloudflareThumbnailUrl ||
        data.media?.videos?.[0]?.poster ||
        data.page?.ogImage ||
        data.page?.candidateThumbnails?.[0]?.url ||
        '';
      const bestStream =
        data.page?.cloudflareVideoUrl ||
        data.media?.videos?.[0]?.cloudflareVideoUrl ||
        data.media?.videos?.[0]?.url ||
        '';
      const bestDesc = data.page?.description || data.media?.videos?.[0]?.description || '';
      const bestDurationFormatted = data.page?.durationFormatted || data.media?.videos?.[0]?.durationFormatted || '';
      const bestDurationSec = data.page?.durationSec || data.media?.videos?.[0]?.durationSec || null;
      const bestSize = data.page?.videoSize?.sizeFormatted || data.media?.videos?.[0]?.sizeFormatted || '';
      const bestSizeBytes = data.page?.videoSize?.sizeBytes ?? data.media?.videos?.[0]?.sizeBytes ?? null;

      const resolvedCfVideo = data.page?.cloudflareVideoUrl || data.media?.videos?.[0]?.cloudflareVideoUrl || null;
      const uploadErr = data.page?.videoUploadError || data.videoUploadError || null;

      setRawBaseTitle(bestRawTitle);
      setActiveTitle(bestTitle);
      setActiveThumbnail(bestThumb);
      setActiveCloudflareThumbnail(data.page?.cloudflareThumbnailUrl || null);
      setActiveStreamUrl(bestStream);
      setActiveCloudflareVideo(resolvedCfVideo);
      setActiveDescription(bestDesc);
      setActiveDurationFormatted(bestDurationFormatted);
      setActiveDurationSec(bestDurationSec);
      setActiveVideoSize(bestSize);
      setActiveVideoSizeBytes(bestSizeBytes);
      setActiveCompressionInfo(data.page?.videoCompression || null);

      if (autoUploadVideoToR2 && bestStream && !resolvedCfVideo) {
        setErrorMessage(
          uploadErr
            ? `Video link extracted, but upload to Cloudflare R2 failed: ${uploadErr}`
            : 'Video link extracted, but automatic upload to Cloudflare R2 did not complete. Click "Upload Video to Cloudflare" below to retry.'
        );
      }

      if (data.media?.videos?.length > 0) {
        setActiveSubTab('media');
      } else if (data.page?.candidateTitles?.length > 0) {
        setActiveSubTab('titles');
      } else {
        setActiveSubTab('html-explorer');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error occurred while contacting backend scraper');
      setResult(null);
    } finally {
      setIsProcessing(false);
    }
  };

  // Convert detected links in batch textarea into queue items
  const handleLoadLinksIntoQueue = () => {
    if (detectedLinksInBatch.length === 0) return;
    const items: BatchQueueItem[] = detectedLinksInBatch.map((url, index) => ({
      id: `queue_${Date.now()}_${index}`,
      url,
      index: index + 1,
      status: 'pending',
      statusMessage: 'Ready in queue',
    }));
    setBatchQueue(items);
  };

  // Process a single item within the concurrent worker pool
  const processSingleBatchItem = async (
    i: number,
    workerId: number,
    item: BatchQueueItem
  ) => {
    setActiveBatchIndex(i);

    // STEP 0: Check Cloudflare Registry according to user's batchSkipMode
    if (batchSkipMode !== 'dont_skip') {
      setBatchQueue((prev) =>
        prev.map((q, idx) =>
          idx === i
            ? {
                ...q,
                workerId,
                status: 'checking_registry',
                statusMessage: `[Worker ${workerId}] Checking Cloudflare Registry for Link ${i + 1}...`,
              }
            : q
        )
      );

      try {
        const checkRes = await fetch('/api/registry/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: [item.url], autoRegisterIfMissing: false }),
        });
        const checkData = await checkRes.json();
        const checkItem = checkData.results?.[0];

        if (checkItem?.isRegistered && checkItem.record) {
          const rec = checkItem.record;
          const hasStoredAssets = Boolean(
            rec.cloudflareVideoUrl ||
            (rec.status === 'uploaded' && rec.cloudflareThumbnailUrl && !rec.videoUrl)
          );

          if (batchSkipMode === 'strict_skip') {
            // Option B: Strict bypass ONLY if this exact Web URL already has its Cloudflare-uploaded assets
            if (hasStoredAssets) {
              setBatchQueue((prev) =>
                prev.map((q, idx) =>
                  idx === i
                    ? {
                        ...q,
                        workerId,
                        status: 'skipped_in_cloudflare',
                        statusMessage: `[Worker ${workerId}] Strict Skip: Web URL already uploaded to Cloudflare (0 duplicate copies) · Bypassed`,
                        title: rec.title,
                        rawTitle: rec.rawTitle || rec.title,
                        description: rec.description || '',
                        videoStreamUrl: rec.cloudflareVideoUrl || rec.videoUrl,
                        originalVideoUrl: rec.videoUrl,
                        cloudflareVideoUrl: rec.cloudflareVideoUrl,
                        videoStorageSource: rec.videoStorageSource || 'cloudflare_r2',
                        originalThumbnailUrl: rec.thumbnailUrl,
                        cloudflareThumbnailUrl: rec.cloudflareThumbnailUrl || rec.thumbnailUrl,
                        thumbnailStorageSource: rec.thumbnailStorageSource || (rec.cloudflareThumbnailUrl ? 'cloudflare_r2' : undefined),
                        durationFormatted: rec.durationFormatted,
                        durationSec: rec.durationSec,
                        sizeFormatted: rec.sizeFormatted,
                        isRegisteredInCloudflare: true,
                        destination: rec.destination,
                        destinationDetail: rec.destinationDetail,
                        registryUniqueId: rec.id,
                      }
                    : q
                )
              );
              // Advance to next link without re-scraping
              return;
            }
          } else if (batchSkipMode === 'smart_cache') {
            // Option A: Reuse FULL saved details from Cloudflare Vault ONLY if video is actually on Cloudflare R2
            if (hasStoredAssets) {
              setBatchQueue((prev) =>
                prev.map((q, idx) =>
                  idx === i
                    ? {
                        ...q,
                        workerId,
                        status: 'completed',
                        statusMessage: `[Worker ${workerId}] Reused from Cloudflare Vault (Web URL Match · 0 Duplicate Copies)`,
                        title: rec.title,
                        rawTitle: rec.rawTitle || rec.title,
                        description: rec.description || '',
                        videoStreamUrl: rec.cloudflareVideoUrl || rec.videoUrl,
                        originalVideoUrl: rec.videoUrl,
                        cloudflareVideoUrl: rec.cloudflareVideoUrl,
                        videoStorageSource: rec.videoStorageSource || 'cloudflare_r2',
                        originalThumbnailUrl: rec.thumbnailUrl,
                        cloudflareThumbnailUrl: rec.cloudflareThumbnailUrl || rec.thumbnailUrl,
                        thumbnailStorageSource: rec.thumbnailStorageSource || (rec.cloudflareThumbnailUrl ? 'cloudflare_r2' : undefined),
                        durationFormatted: rec.durationFormatted,
                        durationSec: rec.durationSec,
                        sizeFormatted: rec.sizeFormatted,
                        isRegisteredInCloudflare: true,
                        destination: rec.destination,
                        destinationDetail: rec.destinationDetail,
                        registryUniqueId: rec.id,
                      }
                    : q
                )
              );
              // Completed with full cached Cloudflare assets, return from worker task
              return;
            }
          }
        }
      } catch (checkErr) {
        console.warn('Registry check failed, continuing with live extraction:', checkErr);
      }
    }

    // STEP 1: Update status to Scraping
    setBatchQueue((prev) =>
      prev.map((q, idx) =>
        idx === i
          ? {
              ...q,
              workerId,
              status: 'scraping',
              statusMessage: `[Worker ${workerId}] Scraping & extracting link ${i + 1}...`,
            }
          : q
      )
    );

    try {
      // Scrape and automatically upload both thumbnail and video stream to Cloudflare R2
      const res = await fetch('/api/process-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getR2Headers() },
        body: JSON.stringify({
          url: item.url,
          wordsToRemove: wordsToRemove.trim(),
          uploadThumbnailToR2: true, // Automatically upload thumbnail to Cloudflare R2!
          uploadVideoToR2: true, // Automatically upload video stream to Cloudflare R2!
          forceRefresh: batchSkipMode === 'dont_skip',
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed with status ${res.status}`);
      }

      const primaryVideo = data.media?.videos?.[0];
      const title = data.page?.title || primaryVideo?.title || item.url.split('/').pop()?.split('?')[0] || `Video ${i + 1}`;
      const rawTitle = data.page?.rawTitle || title;
      const originalVideoUrl = primaryVideo?.originalVideoUrl || primaryVideo?.url || (data.contentType?.includes('video') ? item.url : '');
      let cloudflareVideoUrl = data.page?.cloudflareVideoUrl || primaryVideo?.cloudflareVideoUrl;
      let videoStreamUrl = cloudflareVideoUrl || originalVideoUrl;

      let cloudflareThumb = data.page?.cloudflareThumbnailUrl || primaryVideo?.cloudflareThumbnailUrl;
      const originalThumb = data.page?.ogImage || primaryVideo?.poster || data.page?.candidateThumbnails?.[0]?.url || '';
      let resolvedDurationFormatted = data.page?.durationFormatted || primaryVideo?.durationFormatted || '';
      let resolvedDurationSec = data.page?.durationSec ?? primaryVideo?.durationSec ?? null;
      let resolvedSizeFormatted = data.page?.videoSize?.sizeFormatted || primaryVideo?.sizeFormatted || '';
      let resolvedSizeBytes = data.page?.videoSize?.sizeBytes ?? primaryVideo?.sizeBytes ?? null;
      let resolvedSizeMb = data.page?.videoSize?.sizeMb || primaryVideo?.sizeMb || undefined;
      let resolvedVideoStorageSource = data.page?.videoStorageSource || (cloudflareVideoUrl ? 'cloudflare_r2' : undefined);
      let resolvedThumbStorageSource = data.page?.thumbnailStorageSource || (cloudflareThumb ? 'cloudflare_r2' : undefined);

      // If server didn't auto-upload thumbnail, trigger fallback upload now and update registry
      if (!cloudflareThumb && originalThumb && !data.fromCache) {
        setBatchQueue((prev) =>
          prev.map((q, idx) =>
            idx === i
              ? {
                  ...q,
                  workerId,
                  status: 'uploading_cloudflare',
                  statusMessage: `[Worker ${workerId}] Uploading thumbnail to Cloudflare R2 for link ${i + 1}...`,
                }
              : q
          )
        );

        try {
          const upRes = await fetch('/api/upload-thumbnail-to-r2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getR2Headers() },
            body: JSON.stringify({
              imageUrl: originalThumb,
              customFilename: title,
              folderPrefix: 'thumbnails',
              refererUrl: data.finalUrl || item.url,
            }),
          });
          const upData = await upRes.json();
          if (upRes.ok && upData.success) {
            cloudflareThumb = upData.cloudflareBackLink;
            resolvedThumbStorageSource = upData.storageSource || 'cloudflare_r2';
          }
        } catch (cfErr) {
          console.warn('Cloudflare thumbnail upload error on item', i, cfErr);
        }
      }

      // If server didn't auto-upload video, trigger fallback upload now and capture verified size/duration
      let fallbackUploaded = false;
      let videoUploadFailureMsg: string | null = data.page?.videoUploadError || data.videoUploadError || null;
      if (!cloudflareVideoUrl && originalVideoUrl && !data.fromCache) {
        setBatchQueue((prev) =>
          prev.map((q, idx) =>
            idx === i
              ? {
                  ...q,
                  workerId,
                  status: 'uploading_cloudflare',
                  statusMessage: `[Worker ${workerId}] Uploading video to Cloudflare R2 for link ${i + 1}...`,
                }
              : q
          )
        );

        try {
          const upVidRes = await fetch('/api/upload-video-to-r2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getR2Headers() },
            body: JSON.stringify({
              videoUrl: originalVideoUrl,
              customFilename: title,
              folderPrefix: 'videos',
              refererUrl: data.finalUrl || item.url,
              compressVideo,
              compressionQuality,
            }),
          });
          const upVidData = await upVidRes.json();
          if (upVidRes.ok && upVidData.success) {
            cloudflareVideoUrl = upVidData.cloudflareVideoBackLink;
            videoStreamUrl = upVidData.cloudflareVideoBackLink;
            resolvedVideoStorageSource = upVidData.storageSource || 'cloudflare_r2';
            videoUploadFailureMsg = null;
            if (upVidData.sizeFormatted) resolvedSizeFormatted = upVidData.sizeFormatted;
            if (upVidData.sizeBytes) resolvedSizeBytes = upVidData.sizeBytes;
            if (upVidData.sizeMb) resolvedSizeMb = upVidData.sizeMb;
            if (upVidData.durationSec) {
              resolvedDurationSec = upVidData.durationSec;
              resolvedDurationFormatted = upVidData.durationFormatted || formatSecondsToDuration(upVidData.durationSec);
            }
            fallbackUploaded = true;
          } else {
            videoUploadFailureMsg = upVidData?.error || `HTTP ${upVidRes.status}`;
          }
        } catch (cfVidErr: any) {
          videoUploadFailureMsg = cfVidErr?.message || 'Video upload request failed';
          console.warn('Cloudflare video upload error on item', i, cfVidErr);
        }
      }

      if (fallbackUploaded || (cloudflareThumb && !data.page?.cloudflareThumbnailUrl)) {
        fetch('/api/registry/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceUrl: item.url,
            title,
            rawTitle,
            description: data.page?.description || primaryVideo?.description || '',
            videoUrl: originalVideoUrl,
            thumbnailUrl: originalThumb,
            cloudflareVideoUrl: cloudflareVideoUrl || undefined,
            cloudflareThumbnailUrl: cloudflareThumb || undefined,
            thumbnailStorageSource: resolvedThumbStorageSource || null,
            videoStorageSource: resolvedVideoStorageSource || null,
            durationSec: resolvedDurationSec,
            durationFormatted: resolvedDurationFormatted,
            sizeBytes: resolvedSizeBytes,
            sizeMb: resolvedSizeMb,
            sizeFormatted: resolvedSizeFormatted,
          }),
        }).catch(() => {});
      }

      // STEP 2: Mark Completed or Failed with verified Cloudflare status
      const isFromWebUrlCache = Boolean(data.fromCache || data.cachedByWebUrl);
      const uploadFailed = Boolean(originalVideoUrl && !cloudflareVideoUrl && !isFromWebUrlCache);
      setBatchQueue((prev) =>
        prev.map((q, idx) =>
          idx === i
            ? {
                ...q,
                workerId,
                status: uploadFailed ? 'error' : 'completed',
                error: uploadFailed
                  ? `Video link found, but upload failed: ${videoUploadFailureMsg || 'Cloudflare R2 upload incomplete'}`
                  : undefined,
                statusMessage: isFromWebUrlCache
                  ? `[Worker ${workerId}] Reused from Cloudflare Vault (Web URL Match · 0 Duplicate Copies)`
                  : cloudflareVideoUrl
                  ? `[Worker ${workerId}] Completed: Video & Thumbnail on Cloudflare R2`
                  : `[Worker ${workerId}] Video link extracted, but upload failed: ${videoUploadFailureMsg || 'Upload incomplete'}`,
                title,
                rawTitle,
                videoStreamUrl,
                originalVideoUrl,
                cloudflareVideoUrl: cloudflareVideoUrl || undefined,
                videoStorageSource: resolvedVideoStorageSource,
                originalThumbnailUrl: originalThumb,
                cloudflareThumbnailUrl: cloudflareThumb || originalThumb,
                thumbnailStorageSource: resolvedThumbStorageSource,
                durationFormatted: resolvedDurationFormatted,
                durationSec: resolvedDurationSec,
                sizeFormatted: resolvedSizeFormatted,
                sizeBytes: resolvedSizeBytes,
                sizeKb: resolvedSizeBytes ? Math.round(resolvedSizeBytes / 1024) : null,
                description: data.page?.description || primaryVideo?.description || '',
                isRegisteredInCloudflare: !uploadFailed,
                registryUniqueId: data.registryUniqueId || data.registryRecord?.id,
              }
            : q
        )
      );
    } catch (itemErr: any) {
      setBatchQueue((prev) =>
        prev.map((q, idx) =>
          idx === i
            ? {
                ...q,
                workerId,
                status: 'error',
                statusMessage: `[Worker ${workerId}] Failed: ${itemErr.message || 'Scrape failed'}`,
                error: itemErr.message || 'Scraping failed',
              }
            : q
        )
      );
    }
  };

  // Persistent Multi-Queue Background Runner (add Queue #1, #2, #3, #4 anytime!)
  const handleAddOrStartQueue = async (switchImmediately = false) => {
    const urlsToProcess =
      detectedLinksInBatch.length > 0
        ? detectedLinksInBatch
        : queues.length === 0
        ? batchQueue.map((q) => q.url).filter(Boolean)
        : [];

    if (urlsToProcess.length === 0) {
      setErrorMessage('Please paste at least one video link in the box above to add a queue.');
      return;
    }

    setErrorMessage(null);
    const serverPool = serverPoolText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s));

    try {
      const res = await fetch('/api/vps-batch/queues', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getR2Headers(),
        },
        body: JSON.stringify({
          urls: urlsToProcess,
          name: draftQueueName.trim() || undefined,
          wordsToRemove: wordsToRemove.trim(),
          concurrency,
          batchSkipMode,
          uploadThumbnailToR2: batchUploadThumbnailToR2,
          uploadVideoToR2: batchUploadVideoToR2,
          compressVideo,
          compressionQuality,
          autoRetryIncomplete,
          maxAutoRetryPasses,
          serverPool,
          switchImmediately,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to add queue to background pipeline');
      }
      if (data.vpsScope) {
        setVpsScopeInfo(data.vpsScope);
      }
      if (data.job) {
        const addedId = data.addedQueue?.queueId;
        applyServerBatchJob(data.job, false, addedId);
        // Clear draft text & custom name so user can immediately paste Queue #2, #3, #4!
        setBatchRawText('');
        setDraftQueueName('');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to add queue to server pipeline');
    }
  };

  const handlePauseQueue = async (queueId: string) => {
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}/pause`, { method: 'POST' });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job);
    } catch {}
  };

  const handleStopQueue = async (queueId: string) => {
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}/stop`, { method: 'POST' });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job);
    } catch {}
  };

  const handleResumeQueue = async (queueId: string) => {
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}/resume`, {
        method: 'POST',
        headers: { ...getR2Headers() },
      });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job);
    } catch {}
  };

  const handleSwitchToQueue = async (queueId: string, stopOthers = true) => {
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getR2Headers() },
        body: JSON.stringify({ stopOthers }),
      });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job, false, queueId);
    } catch {}
  };

  const handleUpdateQueueOptions = async (queueId: string, opts: BatchQueueOptions) => {
    setIsUpdatingQueueOpts(true);
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}/options`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getR2Headers() },
        body: JSON.stringify(opts),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to update queue options');
      }
      if (data.job) applyServerBatchJob(data.job, false, queueId);
      setShowQueueOptionsEditor(false);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to save queue options');
    } finally {
      setIsUpdatingQueueOpts(false);
    }
  };

  const handleRetryQueueIncomplete = async (queueId: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}/retry-incomplete`, {
        method: 'POST',
        headers: { ...getR2Headers() },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to restart incomplete links in queue');
      }
      if (data.job) applyServerBatchJob(data.job, false, queueId);
    } catch (err: any) {
      setErrorMessage(err.message || 'Could not restart incomplete websites');
    }
  };

  const handleDeleteQueue = async (queueId: string) => {
    try {
      const res = await fetch(`/api/vps-batch/queues/${encodeURIComponent(queueId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.job) {
        applyServerBatchJob(data.job);
      } else {
        setQueues([]);
        setBatchQueue([]);
        setIsBatchRunning(false);
        setIsBatchPaused(false);
        setActiveWorkers(0);
        setServerJobPass(null);
      }
    } catch {}
  };

  const handlePauseBatch = async () => {
    pauseRef.current = true;
    setIsBatchPaused(true);
    try {
      const res = await fetch('/api/vps-batch/pause', { method: 'POST' });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job);
    } catch {}
  };

  const handleResumeBatch = async () => {
    pauseRef.current = false;
    setIsBatchPaused(false);
    try {
      const res = await fetch('/api/vps-batch/resume', {
        method: 'POST',
        headers: { ...getR2Headers() },
      });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job);
    } catch {}
  };

  const handleCancelBatch = async () => {
    cancelRef.current = true;
    isBatchRunningRef.current = false;
    setIsBatchRunning(false);
    setIsBatchPaused(false);
    setActiveWorkers(0);
    setActiveBatchIndex(-1);
    try {
      const res = await fetch('/api/vps-batch/cancel', { method: 'POST' });
      const data = await res.json();
      if (data.job) applyServerBatchJob(data.job);
    } catch {}
  };

  const handleRetryIncompleteBatch = async () => {
    setErrorMessage(null);
    try {
      const res = await fetch('/api/vps-batch/retry-incomplete', {
        method: 'POST',
        headers: { ...getR2Headers() },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to restart incomplete links');
      }
      if (data.job) applyServerBatchJob(data.job);
    } catch (err: any) {
      setErrorMessage(err.message || 'Could not restart incomplete websites');
    }
  };

  const handleFetchFreeProxies = async () => {
    if (isFetchingFreeProxies) return;
    setIsFetchingFreeProxies(true);
    setFreeProxyMessage('Fetching public proxy lists & running live 3s HTTPS checks...');
    try {
      const res = await fetch('/api/proxies/fetch-free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 8 }),
      });
      const data = await res.json();
      if (Array.isArray(data.proxies) && data.proxies.length > 0) {
        const existing = serverPoolText
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const merged = Array.from(new Set([...existing, ...data.proxies]));
        setServerPoolText(merged.join('\n'));
      }
      setFreeProxyMessage(data.message || `Found ${data.workingCount || 0} working proxies.`);
    } catch (err: any) {
      setFreeProxyMessage(err?.message || 'Failed to test public free proxies.');
    } finally {
      setIsFetchingFreeProxies(false);
    }
  };

  const handleClearBatchQueue = async () => {
    setQueues([]);
    setSelectedQueueId(null);
    setBatchQueue([]);
    setIsBatchRunning(false);
    setIsBatchPaused(false);
    setActiveWorkers(0);
    setServerJobPass(null);
    try {
      await fetch('/api/vps-batch/clear', { method: 'POST' });
    } catch {}
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSelectCandidateTitle = (cand: CandidateTitle) => {
    const raw = cand.rawText || cand.text;
    setRawBaseTitle(raw);
    const cleaned = cleanTitleWithFilter(raw, wordsToRemove);
    setActiveTitle(cleaned.cleaned);
  };

  const handleTestCustomSelector = () => {
    if (!customSelector.trim() || !result?.fullHtml) return;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(result.fullHtml, 'text/html');
      const el = doc.querySelector(customSelector.trim());
      if (el) {
        const val =
          el.getAttribute('content') ||
          el.getAttribute('src') ||
          el.getAttribute('poster') ||
          el.getAttribute('href') ||
          el.textContent?.trim() ||
          el.innerHTML.trim();
        setSelectorTestResult(val || '(Element matched but has no text/attribute content)');
      } else {
        setSelectorTestResult('No elements matched this selector.');
      }
    } catch (e: any) {
      setSelectorTestResult(`Invalid selector error: ${e.message}`);
    }
  };

  const filteredHtmlLines = useMemo(() => {
    if (!result?.fullHtml) return [];
    const rawLines = result.fullHtml.split('\n');
    const term = htmlSearchTerm.toLowerCase().trim();

    return rawLines
      .map((line, index) => ({ lineNum: index + 1, content: line }))
      .filter(({ content }) => {
        if (htmlFilterTag !== 'all') {
          const matchTag =
            new RegExp(`<${htmlFilterTag}[\\s>]`, 'i').test(content) ||
            (htmlFilterTag === 'poster' && /poster\s*=/i.test(content)) ||
            (htmlFilterTag === 'og' && /og:/i.test(content)) ||
            (htmlFilterTag === 'meta' && /<meta/i.test(content));
          if (!matchTag) return false;
        }

        if (term) {
          return content.toLowerCase().includes(term);
        }

        return true;
      });
  }, [result?.fullHtml, htmlSearchTerm, htmlFilterTag]);

  const liveFilterStats = useMemo(() => {
    if (!rawBaseTitle) return { removedTerms: [] };
    return cleanTitleWithFilter(rawBaseTitle, wordsToRemove);
  }, [rawBaseTitle, wordsToRemove]);

  // Completed items in currently viewed queue
  const completedBatchItems = useMemo(() => {
    return displayedBatchTasks.filter((item) => item.status === 'completed');
  }, [displayedBatchTasks]);

  const totalTasksAcrossAllQueues = useMemo(() => {
    if (queues.length > 0) return queues.reduce((sum, q) => sum + (q.tasks?.length || q.total || 0), 0);
    return batchQueue.length;
  }, [queues, batchQueue]);

  const nextQueueNum = useMemo(() => {
    if (queues.length === 0) return 1;
    return queues.reduce((m, q) => Math.max(m, q.queueNumber || 1), 0) + 1;
  }, [queues]);

  return (
    <div className="space-y-6">
      {/* Hero Header */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                <Globe className="w-5 h-5" />
              </span>
              <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                Web URL Processor &amp; Cloudflare Thumbnail Vault
              </h1>
            </div>
            <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
              Process a single website or paste text with multiple links. Crawls video streams, strips unwanted title words (case-insensitive), uploads thumbnails directly to Cloudflare R2, and returns permanent back links.
            </p>
            {vpsScopeInfo && (
              <div className="flex items-center gap-2 flex-wrap pt-0.5 text-[11px] font-mono">
                <span
                  className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/25"
                  title={`Queue storage key: ${vpsScopeInfo.d1DocId} (isolated per VPS) · Registry table: links_registry (shared across all VPS)`}
                >
                  Isolated VPS Queue: {vpsScopeInfo.scopeLabel}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-500/25">
                  Shared D1 Link Registry: Pre-Check Dedup ON
                </span>
              </div>
            )}
          </div>

          {/* Mode Switch: Single URL vs Multi-Link Batch Queue */}
          <div className="flex items-center p-1 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold shrink-0">
            <button
              type="button"
              onClick={() => setInputMode('single')}
              className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                inputMode === 'single'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Single URL</span>
            </button>
            <button
              type="button"
              onClick={() => setInputMode('batch')}
              className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                inputMode === 'batch'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <ListOrdered className="w-3.5 h-3.5" />
              <span>Multi-Link Queue</span>
              {totalTasksAcrossAllQueues > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-slate-900 text-[10px]">
                  {queues.length > 1 ? `${queues.length}Q · ${totalTasksAcrossAllQueues}` : totalTasksAcrossAllQueues}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ============================================================== */}
        {/* MODE 1: SINGLE URL PROCESSING                                  */}
        {/* ============================================================== */}
        {inputMode === 'single' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleProcessUrl();
            }}
            className="space-y-3 pt-2"
          >
            {/* Multi-link alert if user pasted text with > 1 link */}
            {detectedMultipleInSingle && (
              <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-xl flex items-center justify-between gap-3 text-xs text-cyan-300 animate-fadeIn">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>
                    Detected <strong>{detectedMultipleInSingle.length} URLs</strong> inside your input text!
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setBatchRawText(urlInput);
                    setInputMode('batch');
                  }}
                  className="px-3 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-lg text-xs transition-colors shrink-0"
                >
                  Switch to Multi-Link Queue
                </button>
              </div>
            )}

            <div className="flex flex-col lg:flex-row items-stretch gap-2.5">
              {/* Website URL Input */}
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                  <Globe className="w-4 h-4 text-cyan-400" />
                </div>
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="Enter or paste any website URL (e.g. https://example.com/watch/video-123)..."
                  className="w-full pl-10 pr-20 py-3 bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl text-slate-100 text-xs sm:text-sm outline-none transition-colors font-mono"
                />
                {urlInput && (
                  <button
                    type="button"
                    onClick={() => setUrlInput('')}
                    className="absolute inset-y-0 right-2 px-2 text-xs text-slate-500 hover:text-slate-300"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Words to Remove Input (Case-Insensitive filter) */}
              <div className="relative w-full lg:w-96">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                  <Filter className="w-4 h-4 text-amber-400" />
                </div>
                <input
                  type="text"
                  value={wordsToRemove}
                  onChange={(e) => handleWordsToRemoveChange(e.target.value)}
                  placeholder="Words to remove (e.g. 1080p, [HD], Free, Hindi)..."
                  className="w-full pl-10 pr-20 py-3 bg-slate-950 border border-slate-800 focus:border-amber-500 rounded-xl text-slate-100 text-xs sm:text-sm outline-none transition-colors font-medium placeholder:text-slate-500"
                />
                {wordsToRemove && (
                  <button
                    type="button"
                    onClick={() => handleWordsToRemoveChange('')}
                    className="absolute inset-y-0 right-2 px-2 text-xs text-amber-400/80 hover:text-amber-300"
                  >
                    Reset
                  </button>
                )}
              </div>

              {/* Action Button */}
              <button
                type="submit"
                disabled={isProcessing || !urlInput.trim()}
                className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-xs sm:text-sm shrink-0"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <span>Process Website</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>

            {/* Options Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer text-slate-300 select-none">
                  <input
                    type="checkbox"
                    checked={autoUploadVideoToR2}
                    onChange={(e) => setAutoUploadVideoToR2(e.target.checked)}
                    className="rounded border-slate-700 text-cyan-500 focus:ring-0 bg-slate-950"
                  />
                  <span className="flex items-center gap-1.5 font-medium">
                    <Film className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Auto-upload Video to Cloudflare R2</span>
                  </span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-slate-300 select-none">
                  <input
                    type="checkbox"
                    checked={autoUploadToR2}
                    onChange={(e) => setAutoUploadToR2(e.target.checked)}
                    className="rounded border-slate-700 text-cyan-500 focus:ring-0 bg-slate-950"
                  />
                  <span className="flex items-center gap-1.5 font-medium">
                    <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Auto-upload Thumbnail to Cloudflare R2</span>
                  </span>
                </label>

                <div className="flex items-center gap-2 flex-wrap px-2.5 py-1 rounded-lg bg-slate-950/90 border border-slate-800">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 select-none">
                    <input
                      type="checkbox"
                      checked={compressVideo}
                      onChange={(e) => setCompressVideo(e.target.checked)}
                      className="rounded border-slate-700 text-indigo-500 focus:ring-0 bg-slate-900"
                    />
                    <span className="font-medium text-xs">
                      Compress Before Upload
                    </span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                        compressVideo ? 'bg-indigo-500/20 text-indigo-300 font-bold' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {compressVideo ? 'ON' : 'OFF'}
                    </span>
                  </label>

                  <select
                    value={compressionQuality}
                    onChange={(e) => setCompressionQuality(e.target.value as VideoCompressionQuality)}
                    disabled={!compressVideo}
                    aria-label="Compression Quality"
                    className="bg-slate-900 border border-slate-700 rounded-md px-2 py-0.5 text-[11px] text-slate-200 outline-none focus:border-indigo-400 disabled:opacity-45 cursor-pointer"
                  >
                    {COMPRESSION_QUALITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Quick Filter Chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-amber-400 font-semibold text-[11px] flex items-center gap-1">
                  <SlidersHorizontal className="w-3 h-3" />
                  <span>Title Filter Words:</span>
                </span>
                {commonFilterChips.slice(0, 8).map((chip) => {
                  const isSelected = wordsToRemove.toLowerCase().includes(chip.toLowerCase());
                  return (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => handleToggleChip(chip)}
                      className={`px-2 py-0.5 rounded-lg border text-[11px] font-mono transition-colors ${
                        isSelected
                          ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                          : 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {chip}
                    </button>
                  );
                })}
              </div>
            </div>
          </form>
        )}

        {/* ============================================================== */}
        {/* MODE 2: MULTI-LINK MULTI-QUEUE WORKER PIPELINE                 */}
        {/* ============================================================== */}
        {inputMode === 'batch' && (
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <label className="text-slate-300 font-semibold flex items-center gap-1.5">
                  <ListOrdered className="w-4 h-4 text-cyan-400" />
                  <span>
                    {queues.length > 0
                      ? `Draft Queue #${nextQueueNum} (Add even while Queue #${queues[0]?.queueNumber || 1} is running)`
                      : 'Paste Text Containing Multiple Video Links or List of URLs'}
                  </span>
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    value={draftQueueName}
                    onChange={(e) => setDraftQueueName(e.target.value)}
                    placeholder={`Name (optional, e.g. Queue #${nextQueueNum})`}
                    className="px-2.5 py-1 bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg text-[11px] text-slate-200 outline-none w-48"
                  />
                  <span className="px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 font-mono text-[11px] font-bold border border-cyan-500/20">
                    {detectedLinksInBatch.length} links detected
                  </span>
                  {batchRawText && (
                    <button
                      type="button"
                      onClick={() => setBatchRawText('')}
                      className="text-slate-500 hover:text-slate-300 text-xs"
                    >
                      Clear Text
                    </button>
                  )}
                </div>
              </div>

              <textarea
                value={batchRawText}
                onChange={(e) => setBatchRawText(e.target.value)}
                placeholder="Paste URLs for Queue #1, #2, #3... (starts automatically as soon as workers become free)&#10;e.g.:&#10;https://example.com/video-1&#10;https://example.com/video-2&#10;https://example.com/video-3"
                rows={4}
                className="w-full p-3 bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl text-slate-200 font-mono text-xs outline-none transition-colors leading-relaxed"
              />
            </div>

            {/* Filter Words + Per-Queue Action Buttons */}
            <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2.5">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Filter className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <input
                  type="text"
                  value={wordsToRemove}
                  onChange={(e) => setWordsToRemove(e.target.value)}
                  placeholder="Words to filter from titles for this queue (e.g. 1080p, [HD], Free, Hindi)..."
                  className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-amber-500"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {queues.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => handleAddOrStartQueue(false)}
                    disabled={detectedLinksInBatch.length === 0 && batchQueue.length === 0}
                    className="px-5 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>
                      Start Queue #1 ({concurrency === 1 ? '1x Worker' : `${concurrency}x Workers`})
                    </span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => handleAddOrStartQueue(false)}
                      disabled={detectedLinksInBatch.length === 0}
                      className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50 flex items-center gap-1.5"
                      title="Appends as next queue and starts immediately as workers become free"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>
                        Add as Queue #{nextQueueNum} ({detectedLinksInBatch.length})
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleAddOrStartQueue(true)}
                      disabled={detectedLinksInBatch.length === 0}
                      className="px-3.5 py-2 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 font-bold rounded-xl text-xs transition-all disabled:opacity-50 flex items-center gap-1.5"
                      title="Stops active queue and switches workers immediately to this new queue"
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" />
                      <span>Add &amp; Switch Now</span>
                    </button>
                  </>
                )}

                {isBatchRunning && (
                  <div className="flex items-center gap-1.5">
                    {isBatchPaused ? (
                      <button
                        type="button"
                        onClick={handleResumeBatch}
                        className="px-3.5 py-2 bg-emerald-500 text-slate-950 font-bold rounded-xl text-xs"
                      >
                        Resume All
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handlePauseBatch}
                        className="px-3.5 py-2 bg-amber-500 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>Pause All</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleCancelBatch}
                      className="px-3 py-2 bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-xl text-xs font-semibold"
                    >
                      Stop All
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Per-Queue Upload / Action Checkboxes ("what to do, what not" for this queue) */}
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-slate-950/80 border border-slate-800 rounded-xl text-xs">
              <span className="text-[11px] font-bold text-slate-400">
                Options for {queues.length > 0 ? `Queue #${nextQueueNum}` : 'Queue #1'}:
              </span>
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 select-none">
                <input
                  type="checkbox"
                  checked={batchUploadVideoToR2}
                  onChange={(e) => setBatchUploadVideoToR2(e.target.checked)}
                  className="accent-cyan-500 w-3.5 h-3.5 rounded"
                />
                <Film className="w-3.5 h-3.5 text-cyan-400" />
                <span>Download &amp; Upload Video to R2</span>
              </label>

              <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 select-none">
                <input
                  type="checkbox"
                  checked={batchUploadThumbnailToR2}
                  onChange={(e) => setBatchUploadThumbnailToR2(e.target.checked)}
                  className="accent-emerald-500 w-3.5 h-3.5 rounded"
                />
                <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                <span>Upload Thumbnail to R2</span>
              </label>
            </div>

            {/* VPS Multi-Worker Concurrency Bar (1 - 50 Parallel Workers) */}
            <div className="p-3 bg-gradient-to-r from-cyan-950/40 via-slate-950 to-slate-950 border border-cyan-500/30 rounded-xl space-y-2.5 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Zap className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold text-white text-xs">VPS Multi-Worker Concurrency (1 - 50 at a time)</span>
                  <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-mono text-[10px] font-bold border border-cyan-500/30">
                    {concurrency}x Parallel {concurrency === 1 ? 'Worker' : 'Workers'}
                  </span>
                  {activeWorkers > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-bold border border-emerald-500/30 animate-pulse">
                      {activeWorkers} Active Now
                    </span>
                  )}
                  {isBatchRunning && (
                    <span className="px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 text-[10px] font-semibold border border-indigo-500/30">
                      Live Dynamic Scaling Active
                    </span>
                  )}
                </div>

                {/* Quick Presets: 1x, 3x, 5x, 10x, 15x, 25x, 35x, 50x */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] text-slate-400 mr-0.5">Presets:</span>
                  {[1, 3, 5, 10, 15, 25, 35, 50].map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => handleSetConcurrency(num)}
                      className={`px-2 py-0.5 rounded-lg border text-[11px] font-mono font-bold transition-all ${
                        concurrency === num
                          ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-sm'
                          : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {num}x{num === 1 ? ' (Seq)' : num === 25 ? ' (High)' : num === 50 ? ' (Max)' : ''}
                    </button>
                  ))}
                </div>
              </div>

              {/* Slider for smooth 1 - 50 selection */}
              <div className="flex items-center gap-3 pt-0.5">
                <span className="text-[11px] text-slate-400 font-mono w-16">1 Worker</span>
                <input
                  type="range"
                  min={1}
                  max={50}
                  step={1}
                  value={concurrency}
                  onChange={(e) => handleSetConcurrency(Number(e.target.value))}
                  className="flex-1 accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                />
                <span className="text-[11px] text-cyan-400 font-mono font-bold w-28 text-right">
                  50 Workers (Max)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-tight">
                Live adjustable: Increase workers anytime to immediately launch parallel scraping threads. Decrease workers anytime and active threads will gracefully finish their current video before scaling down.
              </p>
            </div>

            {/* External UptimeRobot Keep-Alive URL (Double Protection) */}
            <div className="p-3 bg-slate-950/90 border border-emerald-500/30 rounded-xl space-y-2 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Radio className="w-4 h-4 text-emerald-400" />
                  <span className="font-bold text-slate-200">
                    Double Keep-Alive URL (For UptimeRobot HTTP Monitor)
                  </span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[10px]">
                    GET · HTTP 200
                  </span>
                  {uptimeTestStatus && (
                    <span className="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px]">
                      {uptimeTestStatus}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-400">
                  Every ping wakes &amp; auto-resumes queues
                </span>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={uptimePingUrl}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 px-3 py-2 bg-slate-900 border border-slate-700/80 rounded-lg font-mono text-xs text-emerald-300 select-all outline-none focus:border-emerald-500"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(uptimePingUrl, 'uptimerobot_url')}
                    className="px-3.5 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded-lg font-bold text-xs flex items-center gap-1.5 transition-colors"
                  >
                    {copiedKey === 'uptimerobot_url' ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedKey === 'uptimerobot_url' ? 'Copied URL' : 'Copy Uptime URL'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleTestUptimePing}
                    disabled={isTestingUptime}
                    className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-lg font-semibold text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isTestingUptime ? 'animate-spin' : ''}`} />
                    <span>Test Ping</span>
                  </button>
                </div>
              </div>

              {isStudioPreviewHost ? (
                <p className="text-[11px] text-amber-300/90 leading-snug">
                  Note: AI Studio editor previews (<code className="font-mono">ais-dev-*</code>) require Google login. Open your deployed public <code className="font-mono">*.run.app</code> site and copy this URL from there to paste into UptimeRobot.
                </p>
              ) : (
                <p className="text-[11px] text-slate-400 leading-snug">
                  Paste this URL into <strong>UptimeRobot → Add New Monitor → HTTP(s)</strong> (5 min interval). Together with internal Cloud Keep-Alive, your container stays awake and auto-resumes paused/evicted queues.
                </p>
              )}
            </div>

            {/* Cloudflare Deduplication & Multi-Option Skip Selector */}
            <div className="p-3 bg-slate-950/90 border border-slate-800 rounded-xl space-y-2.5 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span className="font-bold text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Cloudflare Deduplication &amp; Skip Strategy</span>
                </span>
                <button
                  type="button"
                  onClick={() => onNavigateTab('linkextractor')}
                  className="text-xs text-orange-400 hover:text-orange-300 font-semibold flex items-center gap-1 self-start sm:self-auto"
                >
                  <span>Extract Links from Page ➔</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {/* Option 1: Smart Cache */}
                <button
                  type="button"
                  onClick={() => setBatchSkipMode('smart_cache')}
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    batchSkipMode === 'smart_cache'
                      ? 'bg-cyan-500/15 border-cyan-500 text-cyan-200 shadow-sm'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full border flex items-center justify-center shrink-0 ${
                      batchSkipMode === 'smart_cache' ? 'border-cyan-400 bg-cyan-400' : 'border-slate-600'
                    }`} />
                    <span className="font-bold text-xs text-white">Skip &amp; Get from Cloudflare</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-5 leading-tight">
                    Skip download, retrieve cached R2 video &amp; thumb instantly (0 bandwidth/overhead).
                  </p>
                </button>

                {/* Option 2: Strict Skip */}
                <button
                  type="button"
                  onClick={() => setBatchSkipMode('strict_skip')}
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    batchSkipMode === 'strict_skip'
                      ? 'bg-amber-500/15 border-amber-500 text-amber-200 shadow-sm'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full border flex items-center justify-center shrink-0 ${
                      batchSkipMode === 'strict_skip' ? 'border-amber-400 bg-amber-400' : 'border-slate-600'
                    }`} />
                    <span className="font-bold text-xs text-white">Skip from Both</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-5 leading-tight">
                    Strict bypass: ignores any URL that is already registered or in Cloudflare vault.
                  </p>
                </button>

                {/* Option 3: Don't Skip */}
                <button
                  type="button"
                  onClick={() => setBatchSkipMode('dont_skip')}
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    batchSkipMode === 'dont_skip'
                      ? 'bg-purple-500/15 border-purple-500 text-purple-200 shadow-sm'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full border flex items-center justify-center shrink-0 ${
                      batchSkipMode === 'dont_skip' ? 'border-purple-400 bg-purple-400' : 'border-slate-600'
                    }`} />
                    <span className="font-bold text-xs text-white">Don&apos;t Skip (Force Done Again)</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-5 leading-tight">
                    Bypass cache check and force live live re-scrape and re-upload to Cloudflare.
                  </p>
                </button>
              </div>
            </div>

            {/* Video Compression & Output Quality Before R2 Upload (Default OFF) */}
            <div className="p-3 bg-slate-950/90 border border-slate-800 rounded-xl space-y-2 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="flex items-center gap-2 cursor-pointer text-slate-200 font-semibold select-none">
                  <input
                    type="checkbox"
                    checked={compressVideo}
                    onChange={(e) => setCompressVideo(e.target.checked)}
                    className="accent-indigo-500 w-3.5 h-3.5 rounded"
                  />
                  <span>Compress Videos Before Uploading to Cloudflare R2 (FFmpeg)</span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                      compressVideo
                        ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}
                  >
                    {compressVideo ? 'ON' : 'OFF (Default)'}
                  </span>
                </label>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] text-slate-400">Quality:</span>
                  {COMPRESSION_QUALITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={!compressVideo}
                      onClick={() => setCompressionQuality(opt.value)}
                      title={opt.detail}
                      className={`px-2 py-0.5 rounded border text-[11px] font-mono font-bold transition-all disabled:opacity-40 ${
                        compressionQuality === opt.value
                          ? 'bg-indigo-500 text-white border-indigo-400'
                          : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {opt.shortLabel}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-tight">
                {compressVideo
                  ? `Active (${COMPRESSION_QUALITY_OPTIONS.find((o) => o.value === compressionQuality)?.label}): Videos transcode to H.264/AAC MP4 before R2 upload. When CPU load hits >= 80% or FFmpeg slots fill up, other workers automatically pause for cool-off until load drops (< 72%).`
                  : 'Off by default for maximum speed: Original video stream uploads directly to R2 with zero re-encoding. Enable to shrink large videos before upload.'}
              </p>
            </div>

            {/* Persistent Background Auto-Retry & Multi-Server Anti-Rate-Limit Panel */}
            <div className="p-3 bg-slate-950/90 border border-slate-800 rounded-xl space-y-3 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="flex items-center gap-2 cursor-pointer text-slate-200 font-semibold">
                  <input
                    type="checkbox"
                    checked={autoRetryIncomplete}
                    onChange={(e) => setAutoRetryIncomplete(e.target.checked)}
                    className="accent-emerald-500 w-3.5 h-3.5 rounded"
                  />
                  <span>Auto-Restart Failed &amp; Incomplete Websites When Queue Ends</span>
                </label>

                {autoRetryIncomplete && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">Max Retry Passes:</span>
                    {[1, 2, 3, 5].map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setMaxAutoRetryPasses(p)}
                        className={`px-2 py-0.5 rounded border text-[11px] font-mono font-bold ${
                          maxAutoRetryPasses === p
                            ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                            : 'bg-slate-900 border-slate-700 text-slate-300'
                        }`}
                      >
                        {p}x
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold text-cyan-300">
                    Multi-Server Relay / Proxy Pool (Anti-Rate-Limit · Optional)
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={handleFetchFreeProxies}
                      disabled={isFetchingFreeProxies}
                      className="px-2 py-0.5 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-[10px] font-semibold transition-colors disabled:opacity-50"
                    >
                      {isFetchingFreeProxies ? 'Testing Free Proxies...' : 'Auto-Test Free Proxies'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCfRelayCode((v) => !v)}
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[10px] font-semibold transition-colors"
                    >
                      {showCfRelayCode ? 'Hide Free CF Relay Code' : 'Free CF Worker Relay (100k/day)'}
                    </button>
                  </div>
                </div>
                {freeProxyMessage && (
                  <p className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                    {freeProxyMessage}
                  </p>
                )}
                {showCfRelayCode && (
                  <pre className="p-2 bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-mono text-emerald-300 overflow-x-auto select-all">{`// Deploy free on workers.cloudflare.com (100,000 req/day FREE), then paste its URL below:
export default {
  async fetch(req) {
    const target = new URL(req.url).searchParams.get("url");
    if (!target) return new Response("Missing ?url=", { status: 400 });
    return fetch(target, { headers: { "User-Agent": req.headers.get("User-Agent") || "Mozilla/5.0" } });
  }
};`}</pre>
                )}
                <textarea
                  value={serverPoolText}
                  onChange={(e) => setServerPoolText(e.target.value)}
                  rows={2}
                  placeholder="Optional extra fetch servers or HTTP proxies (one per line):&#10;https://my-relay-worker.workers.dev/?url=&#10;http://ip:port"
                  className="w-full p-2 bg-slate-900/90 border border-slate-800 focus:border-cyan-500 rounded-lg text-[11px] font-mono text-slate-300 outline-none"
                />
              </div>
            </div>

            {/* Quick Filter chips for batch */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs pt-0.5">
              <span className="text-amber-400 font-semibold text-[11px]">Filter Words:</span>
              {commonFilterChips.slice(0, 7).map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => handleToggleChip(chip)}
                  className={`px-2 py-0.5 rounded-lg border text-[10px] font-mono transition-colors ${
                    wordsToRemove.toLowerCase().includes(chip.toLowerCase())
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                      : 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-400'
                  }`}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error Notice */}
      {errorMessage && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-start gap-3 text-xs text-rose-300 animate-fadeIn">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5 flex-1">
            <p className="font-bold">Notice</p>
            <p className="text-rose-400/90">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-slate-400 hover:text-white text-xs px-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Cloudflare Thumbnail Upload Success Banner */}
      {thumbUploadSuccess && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-start justify-between gap-3 text-xs text-emerald-300 animate-fadeIn">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-white">Thumbnail Successfully Uploaded to Cloudflare R2!</p>
              <p className="font-mono text-emerald-300 text-[11px] break-all select-all">
                {thumbUploadSuccess}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => copyToClipboard(thumbUploadSuccess, 'cf_thumb_success')}
              className="px-2.5 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 rounded font-semibold text-[11px] flex items-center gap-1"
            >
              {copiedKey === 'cf_thumb_success' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span>{copiedKey === 'cf_thumb_success' ? 'Copied' : 'Copy Link'}</span>
            </button>
            <button
              onClick={() => setThumbUploadSuccess(null)}
              className="text-slate-400 hover:text-white text-xs px-1"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Cloudflare Registry Match Banner: Already Extracted / Uploaded in Cloudflare */}
      {singleRegistryRecord && (
        <div className="p-4 bg-gradient-to-r from-amber-500/10 via-yellow-500/10 to-amber-500/5 border border-amber-500/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs animate-fadeIn">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-amber-300 text-sm">
                  {singleRegistryRecord.isNew
                    ? 'Added as New Link to Cloudflare Registry'
                    : 'Found in Cloudflare Registry (Cached · 0 Duplicate Copies)'}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-[10px] text-slate-300">
                  ID: {singleRegistryRecord.id}
                </span>
                {singleRegistryRecord.destination && singleRegistryRecord.destination !== 'none' && (
                  <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 text-[10px] font-bold">
                    Forwarded to: {singleRegistryRecord.destination}
                  </span>
                )}
              </div>
              <p className="text-slate-300">
                {singleRegistryRecord.isNew
                  ? `This link was automatically registered into your Cloudflare vault. Future requests will instantly reuse it without duplicate copies.`
                  : `This URL was already tracked in Cloudflare on ${new Date(singleRegistryRecord.firstExtractedAt).toLocaleDateString()}. Reused directly with zero duplicate copies.`}
              </p>
              {singleRegistryRecord.cloudflareVideoUrl && (
                <p className="text-slate-400 font-mono text-[11px] truncate max-w-xl">
                  Video: {singleRegistryRecord.cloudflareVideoUrl}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (singleRegistryRecord.title) setActiveTitle(singleRegistryRecord.title);
                if (singleRegistryRecord.rawTitle) setRawBaseTitle(singleRegistryRecord.rawTitle);
                if (singleRegistryRecord.cloudflareVideoUrl) {
                  setActiveStreamUrl(singleRegistryRecord.cloudflareVideoUrl);
                  setActiveCloudflareVideo(singleRegistryRecord.cloudflareVideoUrl);
                } else if (singleRegistryRecord.videoUrl) {
                  setActiveStreamUrl(singleRegistryRecord.videoUrl);
                }
                if (singleRegistryRecord.cloudflareThumbnailUrl) {
                  setActiveThumbnail(singleRegistryRecord.cloudflareThumbnailUrl);
                  setActiveCloudflareThumbnail(singleRegistryRecord.cloudflareThumbnailUrl);
                } else if (singleRegistryRecord.thumbnailUrl) {
                  setActiveThumbnail(singleRegistryRecord.thumbnailUrl);
                }
                if (singleRegistryRecord.durationFormatted) setActiveDurationFormatted(singleRegistryRecord.durationFormatted);
                if (singleRegistryRecord.durationSec) setActiveDurationSec(singleRegistryRecord.durationSec);
                if (singleRegistryRecord.sizeFormatted) setActiveVideoSize(singleRegistryRecord.sizeFormatted);
              }}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition-colors flex items-center gap-1 shadow-sm"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Get Details from Cloudflare</span>
            </button>

            {!singleRegistryRecord.isNew && (
              <button
                type="button"
                onClick={() => handleProcessUrl(undefined, true)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30 font-semibold rounded-lg text-xs transition-colors flex items-center gap-1"
                title="Force re-fetch and re-extract webpage from live source (bypassing Web URL cache)"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Force Live Re-Scrape</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                const linkToCopy = singleRegistryRecord.cloudflareVideoUrl || singleRegistryRecord.sourceUrl;
                copyToClipboard(linkToCopy, 'reg_link_copied');
              }}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1"
            >
              {copiedKey === 'reg_link_copied' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedKey === 'reg_link_copied' ? 'Copied' : 'Copy Stored Link'}</span>
            </button>

            <button
              type="button"
              onClick={() => setEditingRegistryRecord(singleRegistryRecord)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 font-semibold rounded-lg text-xs transition-colors flex items-center gap-1"
              title="Edit this links_registry database object"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>Edit Object</span>
            </button>

            <button
              type="button"
              onClick={() => setSingleRegistryRecord(null)}
              className="px-2.5 py-1.5 text-slate-400 hover:text-white rounded-lg bg-slate-800 text-xs"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* Cloudflare Video Upload Success Banner */}
      {videoUploadSuccess && (
        <div className="p-4 bg-cyan-500/10 border border-cyan-500/30 rounded-xl flex items-start justify-between gap-3 text-xs text-cyan-300 animate-fadeIn">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-white">Video Stream Successfully Uploaded to Cloudflare R2!</p>
              <p className="font-mono text-cyan-300 text-[11px] break-all select-all">
                {videoUploadSuccess}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => copyToClipboard(videoUploadSuccess, 'cf_video_success')}
              className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded font-semibold text-[11px] flex items-center gap-1"
            >
              {copiedKey === 'cf_video_success' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span>{copiedKey === 'cf_video_success' ? 'Copied' : 'Copy Link'}</span>
            </button>
            <button
              onClick={() => setVideoUploadSuccess(null)}
              className="text-slate-400 hover:text-white text-xs px-1"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* MULTI-QUEUE MANAGER, QUEUE SWITCHER & LIVE WORKER CARDS        */}
      {/* ============================================================== */}
      {(queues.length > 0 || batchQueue.length > 0) && inputMode === 'batch' && (
        <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-5 animate-fadeIn">
          {/* Global Pipeline Summary & Multi-Queue Switcher Strip */}
          {queues.length > 0 && (
            <div className="space-y-3 pb-4 border-b border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="p-1.5 rounded-lg bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
                    <Layers className="w-4 h-4" />
                  </span>
                  <h3 className="font-bold text-white text-sm">
                    Active Queues ({queues.length}) · Auto-Rollover &amp; Instant Retry Pool
                  </h3>
                  {vpsScopeInfo && (
                    <span
                      className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 font-mono text-[10px]"
                      title={`Queue State Key: ${vpsScopeInfo.d1DocId} (isolated to this VPS) · Shared D1 Link Registry active`}
                    >
                      VPS Queue: {vpsScopeInfo.scopeLabel} · Shared D1 Dedup ON
                    </span>
                  )}
                  {isBatchRunning && cloudKeepAliveMode === 'active' && (
                    <span
                      className="px-2 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px] font-bold"
                      title="Active rolling 45s ingress stream holds free Cloud Run CPU allocated continuously even after closing Chrome"
                    >
                      Cloud Keep-Alive ON
                    </span>
                  )}
                  {isBatchRunning && cloudKeepAliveMode === 'iap_blocked' && (
                    <span
                      className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono text-[10px] font-bold"
                      title="AI Studio Dev Preview sits behind Google login. For background running after closing Chrome, run the queue on your public deployed URL (*.run.app)"
                    >
                      Preview Auth (Keep Tab Open or Use Deployed URL)
                    </span>
                  )}
                  {cloudKeepAliveActive && cloudKeepAliveMode !== 'active' && cloudKeepAliveMode !== 'iap_blocked' && isBatchRunning && (
                    <span className="px-2 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px] font-bold">
                      Cloud Keep-Alive ON
                    </span>
                  )}
                  {Boolean(serverJobPass?.activeCompressions || serverJobPass?.pausedForLoadCount) && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono text-[10px] font-bold">
                      FFmpeg: {serverJobPass?.activeCompressions || 0} active
                      {serverJobPass?.pausedForLoadCount ? ` · ${serverJobPass.pausedForLoadCount} paused (CPU ${serverJobPass.currentCpuPercent ?? 0}%)` : ''}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {queues.some((q) => q.incompleteCount > 0 && q.status !== 'stopped') && (
                    <button
                      type="button"
                      onClick={handleRetryIncompleteBatch}
                      className="px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 rounded-lg text-[11px] font-semibold flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Restart All Failed</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleClearBatchQueue}
                    className="px-2.5 py-1.5 text-slate-400 hover:text-rose-300 bg-slate-950 border border-slate-800 hover:border-rose-500/30 rounded-lg text-[11px] font-semibold flex items-center gap-1"
                    title="Clear all saved queues"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear All</span>
                  </button>
                </div>
              </div>

              {serverJobPass?.message && (
                <p className="text-xs text-slate-400">{serverJobPass.message}</p>
              )}

              {/* Queue Cards Grid (Queue #1, Queue #2, Queue #3...) */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {queues.map((q) => {
                  const isSelected = selectedQueue?.queueId === q.queueId;
                  const doneCount = q.completed + q.skipped;
                  const pct = q.total > 0 ? Math.round((doneCount / q.total) * 100) : 0;
                  const skipLabel =
                    q.options.batchSkipMode === 'strict_skip'
                      ? 'Strict Skip'
                      : q.options.batchSkipMode === 'dont_skip'
                      ? 'Force All'
                      : 'Smart Cache';

                  return (
                    <div
                      key={q.queueId}
                      onClick={() => {
                        setSelectedQueueId(q.queueId);
                        setShowQueueOptionsEditor(false);
                      }}
                      className={`p-3 rounded-xl border cursor-pointer transition-all space-y-2 ${
                        isSelected
                          ? 'bg-cyan-500/10 border-cyan-500/60 ring-1 ring-cyan-500/30'
                          : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-bold text-white text-xs truncate">{q.name}</span>
                          {q.activeWorkers > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono text-[10px] font-bold animate-pulse">
                              {q.activeWorkers}w
                            </span>
                          )}
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            q.status === 'running'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : q.status === 'queued'
                              ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                              : q.status === 'paused'
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              : q.status === 'stopped'
                              ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                              : 'bg-slate-800 text-slate-300 border-slate-700'
                          }`}
                        >
                          {q.status === 'running'
                            ? 'Running'
                            : q.status === 'queued'
                            ? 'Next / Queued'
                            : q.status === 'paused'
                            ? 'Paused'
                            : q.status === 'stopped'
                            ? 'Stopped'
                            : 'Completed'}
                        </span>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                          <span>
                            {doneCount}/{q.total} done{q.errors > 0 ? ` · ${q.errors} failed` : ''}
                          </span>
                          <span>{pct}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                          <div
                            className={`h-1.5 transition-all ${
                              q.status === 'stopped'
                                ? 'bg-rose-500/70'
                                : q.status === 'paused'
                                ? 'bg-amber-400'
                                : 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>

                      {/* Compact per-queue options summary */}
                      <div className="flex flex-wrap items-center gap-1 text-[9px] font-mono">
                        <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">
                          {skipLabel}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded border ${
                            q.options.uploadVideoToR2
                              ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-300'
                              : 'bg-slate-900 border-slate-800 text-slate-500'
                          }`}
                        >
                          {q.options.uploadVideoToR2 ? 'R2 Vid' : 'Skip Vid R2'}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded border ${
                            q.options.uploadThumbnailToR2
                              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                              : 'bg-slate-900 border-slate-800 text-slate-500'
                          }`}
                        >
                          {q.options.uploadThumbnailToR2 ? 'R2 Thumb' : 'Skip Thumb'}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded border ${
                            q.options.compressVideo
                              ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                              : 'bg-slate-900 border-slate-800 text-slate-500'
                          }`}
                        >
                          {q.options.compressVideo ? `Comp: ${q.options.compressionQuality}` : 'No Compress'}
                        </span>
                      </div>

                      {/* Quick Queue Controls */}
                      <div
                        className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-800/80"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {queues.length > 1 && (q.status === 'queued' || q.status === 'paused' || q.status === 'stopped') && (
                          <button
                            type="button"
                            onClick={() => handleSwitchToQueue(q.queueId, true)}
                            className="px-2 py-1 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold flex items-center gap-1"
                            title="Stop current active queue and switch all workers to this queue"
                          >
                            <ArrowUpRight className="w-3 h-3" />
                            <span>Switch Here</span>
                          </button>
                        )}
                        {q.status === 'running' || q.status === 'queued' ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handlePauseQueue(q.queueId)}
                              className="px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[10px] font-semibold flex items-center gap-1"
                            >
                              <Pause className="w-2.5 h-2.5" />
                              <span>Pause</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStopQueue(q.queueId)}
                              className="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-[10px] font-semibold flex items-center gap-1"
                            >
                              <Square className="w-2.5 h-2.5" />
                              <span>Stop</span>
                            </button>
                          </>
                        ) : q.status === 'paused' || q.status === 'stopped' ? (
                          <button
                            type="button"
                            onClick={() => handleResumeQueue(q.queueId)}
                            className="px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold flex items-center gap-1"
                          >
                            <Play className="w-2.5 h-2.5" />
                            <span>Resume</span>
                          </button>
                        ) : null}

                        {q.incompleteCount > 0 && (
                          <button
                            type="button"
                            onClick={() => handleRetryQueueIncomplete(q.queueId)}
                            className="px-2 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-semibold flex items-center gap-1"
                          >
                            <RotateCcw className="w-2.5 h-2.5" />
                            <span>Retry Failed</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleDeleteQueue(q.queueId)}
                          className="ml-auto p-1 text-slate-500 hover:text-rose-400 rounded"
                          title={`Remove ${q.name}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Selected Queue Header & Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="p-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <Cloud className="w-4 h-4" />
                </span>
                <h3 className="font-bold text-white text-sm">
                  {selectedQueue ? `${selectedQueue.name} · Tasks & Settings` : 'Server Background Queue (Safe to Close Browser)'}
                </h3>
                {selectedQueue && (
                  <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px] font-bold">
                    Pass {selectedQueue.currentPass} / {1 + selectedQueue.options.maxAutoRetryPasses}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                {selectedQueue?.statusMessage ||
                  serverJobPass?.message ||
                  'Persisted on server & ott-database D1. Runs in background even after closing browser.'}
              </p>
            </div>

            {/* Selected Queue Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {selectedQueue && (
                <button
                  type="button"
                  onClick={() => {
                    setQueueEditDraft({ ...selectedQueue.options });
                    setShowQueueOptionsEditor((v) => !v);
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
                    showQueueOptionsEditor
                      ? 'bg-indigo-500/20 text-indigo-200 border-indigo-500/50'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  <span>{showQueueOptionsEditor ? 'Close Queue Options' : 'Edit Queue Options'}</span>
                </button>
              )}

              {selectedQueue &&
                displayedBatchTasks.some(
                  (q) =>
                    q.status === 'error' ||
                    (q.status === 'completed' && selectedQueue.options.uploadVideoToR2 && !q.cloudflareVideoUrl) ||
                    q.status === 'pending'
                ) && (
                  <button
                    type="button"
                    onClick={() => handleRetryQueueIncomplete(selectedQueue.queueId)}
                    className="px-3.5 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restart Failed in {selectedQueue.name}</span>
                  </button>
                )}

              {completedBatchItems.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      onNavigateTab(
                        'categories',
                        completedBatchItems.map((item) => ({
                          title: item.title || 'Processed Video',
                          description: item.description || '',
                          imageUrl: item.cloudflareThumbnailUrl || item.originalThumbnailUrl || '',
                          reelsUrl: item.cloudflareVideoUrl || item.videoStreamUrl || '',
                          isPremium: false,
                          rating: 4.8,
                          likesCount: '12k',
                          durationSec: item.durationSec ?? 0,
                          sizeKb: item.sizeKb ?? undefined,
                          sizeBytes: item.sizeBytes ?? undefined,
                          sizeFormatted: item.sizeFormatted || undefined,
                        }))
                      )
                    }
                    className="px-3.5 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    <FolderTree className="w-3.5 h-3.5" />
                    <span>Send {completedBatchItems.length} Videos to Category</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const allVideoLinks = completedBatchItems
                        .map((c) => c.cloudflareVideoUrl || c.videoStreamUrl)
                        .filter(Boolean)
                        .join('\n');
                      copyToClipboard(allVideoLinks, 'all_cf_videos');
                    }}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-xl text-xs font-semibold flex items-center gap-1 transition-colors"
                  >
                    {copiedKey === 'all_cf_videos' ? <Check className="w-3 h-3 text-cyan-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'all_cf_videos' ? 'Copied' : 'Copy All Videos'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const allLinks = completedBatchItems
                        .map((c) => c.cloudflareThumbnailUrl || c.originalThumbnailUrl)
                        .filter(Boolean)
                        .join('\n');
                      copyToClipboard(allLinks, 'all_cf_thumbs');
                    }}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold flex items-center gap-1 transition-colors"
                  >
                    {copiedKey === 'all_cf_thumbs' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'all_cf_thumbs' ? 'Copied' : 'Copy All Thumbs'}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Per-Queue Live Option Editor */}
          {selectedQueue && showQueueOptionsEditor && queueEditDraft && (
            <div className="p-4 bg-slate-950 border border-indigo-500/40 rounded-xl space-y-3 text-xs animate-fadeIn">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-indigo-300 flex items-center gap-1.5">
                  <Settings2 className="w-4 h-4" />
                  <span>Customize Options for {selectedQueue.name} (Takes effect immediately on next task)</span>
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-400">Skip Strategy</label>
                  <select
                    value={queueEditDraft.batchSkipMode}
                    onChange={(e) =>
                      setQueueEditDraft({ ...queueEditDraft, batchSkipMode: e.target.value as BatchSkipMode })
                    }
                    className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white outline-none"
                  >
                    <option value="smart_cache">Skip &amp; Get from Cloudflare</option>
                    <option value="strict_skip">Skip from Both (Strict Bypass)</option>
                    <option value="dont_skip">Don&apos;t Skip (Force Live Again)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-400">Filter Words in Titles</label>
                  <input
                    type="text"
                    value={queueEditDraft.wordsToRemove}
                    onChange={(e) => setQueueEditDraft({ ...queueEditDraft, wordsToRemove: e.target.value })}
                    placeholder="1080p, [HD], Free..."
                    className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-400">Compression Quality</label>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-200">
                      <input
                        type="checkbox"
                        checked={queueEditDraft.compressVideo}
                        onChange={(e) =>
                          setQueueEditDraft({ ...queueEditDraft, compressVideo: e.target.checked })
                        }
                        className="accent-indigo-500"
                      />
                      <span>Compress</span>
                    </label>
                    <select
                      value={queueEditDraft.compressionQuality}
                      disabled={!queueEditDraft.compressVideo}
                      onChange={(e) =>
                        setQueueEditDraft({
                          ...queueEditDraft,
                          compressionQuality: e.target.value as VideoCompressionQuality,
                        })
                      }
                      className="flex-1 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white disabled:opacity-45"
                    >
                      {COMPRESSION_QUALITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-200">
                    <input
                      type="checkbox"
                      checked={queueEditDraft.uploadVideoToR2}
                      onChange={(e) =>
                        setQueueEditDraft({ ...queueEditDraft, uploadVideoToR2: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    <span>Upload Video to R2</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-200">
                    <input
                      type="checkbox"
                      checked={queueEditDraft.uploadThumbnailToR2}
                      onChange={(e) =>
                        setQueueEditDraft({ ...queueEditDraft, uploadThumbnailToR2: e.target.checked })
                      }
                      className="accent-emerald-500"
                    />
                    <span>Upload Thumbnail to R2</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-200">
                    <input
                      type="checkbox"
                      checked={queueEditDraft.autoRetryIncomplete}
                      onChange={(e) =>
                        setQueueEditDraft({ ...queueEditDraft, autoRetryIncomplete: e.target.checked })
                      }
                      className="accent-emerald-500"
                    />
                    <span>Auto-Retry Failed</span>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowQueueOptionsEditor(false)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isUpdatingQueueOpts}
                    onClick={() => handleUpdateQueueOptions(selectedQueue.queueId, queueEditDraft)}
                    className="px-4 py-1.5 bg-indigo-500 hover:bg-indigo-400 text-white font-bold rounded-lg text-xs disabled:opacity-50"
                  >
                    {isUpdatingQueueOpts ? 'Saving...' : 'Save Queue Options'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Progress Bar Strip for Selected Queue */}
          {displayedBatchTasks.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">
                  {selectedQueue ? `${selectedQueue.name} Progress:` : 'Progress:'} {completedBatchItems.length} / {displayedBatchTasks.length} Completed
                </span>
                <span className="text-cyan-400 font-bold">
                  {Math.round((completedBatchItems.length / displayedBatchTasks.length) * 100)}%
                </span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                <div
                  className="bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400 h-2 transition-all duration-300"
                  style={{
                    width: `${(completedBatchItems.length / displayedBatchTasks.length) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Selected Queue Items List */}
          <div className="space-y-3">
            {displayedBatchTasks.map((item, idx) => {
              const isCurrent = activeBatchIndex === idx;
              const isDone = item.status === 'completed';
              const isErr = item.status === 'error';
              const isWaitingD1 = item.status === 'waiting_d1';
              const isWorking =
                item.status === 'scraping' ||
                item.status === 'downloading_video' ||
                item.status === 'compressing_video' ||
                item.status === 'uploading_cloudflare' ||
                item.status === 'checking_registry' ||
                isWaitingD1;

              const stageBadge = (() => {
                switch (item.status) {
                  case 'checking_registry':
                    return {
                      label: 'Checking D1',
                      cls: 'bg-slate-500/20 text-slate-200 border-slate-400/30',
                    };
                  case 'waiting_d1':
                    return {
                      label: 'Waiting D1 Reuse',
                      cls: 'bg-amber-500/20 text-amber-300 border-amber-400/40',
                    };
                  case 'scraping':
                    return {
                      label: 'Scraping Web',
                      cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/40',
                    };
                  case 'downloading_video':
                    return {
                      label: 'Downloading Video',
                      cls: 'bg-sky-500/20 text-sky-300 border-sky-400/40',
                    };
                  case 'compressing_video':
                    return {
                      label: 'Compressing',
                      cls: 'bg-amber-500/20 text-amber-300 border-amber-400/40',
                    };
                  case 'uploading_cloudflare':
                    return {
                      label: 'Uploading R2',
                      cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
                    };
                  default:
                    return null;
                }
              })();

              return (
                <div
                  key={item.id}
                  className={`p-4 rounded-xl border text-xs transition-all ${
                    isWaitingD1
                      ? 'bg-amber-500/10 border-amber-500/35 ring-1 ring-amber-500/20'
                      : isWorking || isCurrent
                      ? 'bg-cyan-500/10 border-cyan-500/40 ring-1 ring-cyan-500/30'
                      : isDone
                      ? 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                      : isErr
                      ? 'bg-rose-500/10 border-rose-500/30'
                      : 'bg-slate-950/50 border-slate-900 opacity-80'
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {/* Thumbnail preview if completed */}
                      {item.cloudflareThumbnailUrl ? (
                        <div className="w-24 h-16 rounded-lg overflow-hidden bg-slate-900 shrink-0 border border-slate-800 relative group">
                          <img
                            src={item.cloudflareThumbnailUrl}
                            alt={item.title || 'Thumbnail'}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                          <div className="absolute top-0.5 right-0.5 px-1 py-0.2 rounded bg-emerald-500 text-slate-950 font-bold text-[8px]">
                            CF R2
                          </div>
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center font-bold text-slate-400 shrink-0 font-mono">
                          #{item.index}
                        </div>
                      )}

                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-white text-sm truncate">
                            {item.title || `Link ${item.index}`}
                          </span>

                          {/* Parallel Worker ID Tag */}
                          {item.workerId && isWorking && (
                            <span className="px-1.5 py-0.5 rounded bg-cyan-400 text-slate-950 font-bold font-mono text-[9px] shadow-sm animate-pulse">
                              Worker #{item.workerId}
                            </span>
                          )}

                          {/* Active Stage Pill + Live Step Message */}
                          {isWorking && stageBadge && (
                            <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] flex items-center gap-1 border ${stageBadge.cls}`}>
                              <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                              <span>{stageBadge.label}</span>
                            </span>
                          )}
                          {isWorking && item.statusMessage && (
                            <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 font-semibold text-[10px] border border-cyan-500/30">
                              {item.statusMessage}
                            </span>
                          )}

                          {isDone && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-bold text-[10px] flex items-center gap-1 border border-emerald-500/30">
                              <Check className="w-2.5 h-2.5" />
                              <span>Cloudflare R2 Ready</span>
                            </span>
                          )}

                          {item.status === 'skipped_in_cloudflare' && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-bold text-[10px] flex items-center gap-1 border border-amber-500/30">
                              <ShieldCheck className="w-2.5 h-2.5" />
                              <span>Skipped (Already in Cloudflare)</span>
                            </span>
                          )}

                          {isErr && (
                            <span className="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 font-bold text-[10px] flex items-center gap-1 border border-rose-500/30">
                              <AlertCircle className="w-2.5 h-2.5" />
                              <span>Failed</span>
                            </span>
                          )}

                          {item.destination && item.destination !== 'none' && (
                            <span className="px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 font-mono text-[9px] border border-yellow-500/20">
                              Target: {item.destination}
                            </span>
                          )}

                          {item.durationFormatted && (
                            <span className="px-1.5 py-0.2 rounded bg-purple-500/10 text-purple-400 font-mono text-[10px] border border-purple-500/20 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" />
                              <span>{item.durationFormatted}</span>
                            </span>
                          )}

                          {item.sizeFormatted && (
                            <span className="px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 font-mono text-[10px] border border-emerald-500/20 flex items-center gap-1">
                              <HardDrive className="w-2.5 h-2.5" />
                              <span>{item.sizeFormatted}</span>
                            </span>
                          )}
                        </div>

                        <p className="font-mono text-slate-500 text-[11px] truncate">{item.url}</p>

                        {isErr && (item.error || item.statusMessage) && (
                          <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-[11px] text-rose-300 space-y-0.5">
                            <p className="font-semibold break-words">{item.error || item.statusMessage}</p>
                            {item.originalVideoUrl && (
                              <p className="font-mono text-[10px] text-rose-200/80 truncate" title={item.originalVideoUrl}>
                                Extracted Video Link: {item.originalVideoUrl}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Permanent Cloudflare Back Links (Both Video and Thumbnail) */}
                        <div className="pt-1 space-y-1">
                          {item.cloudflareVideoUrl && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-cyan-400 font-bold flex items-center gap-1 shrink-0">
                                <Film className="w-3 h-3" />
                                <span>CF Video Link:</span>
                              </span>
                              <span className="font-mono text-[10px] text-slate-300 truncate max-w-sm">
                                {item.cloudflareVideoUrl}
                              </span>
                            </div>
                          )}

                          {item.cloudflareThumbnailUrl && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1 shrink-0">
                                <Cloud className="w-3 h-3" />
                                <span>CF Thumb Link:</span>
                              </span>
                              <span className="font-mono text-[10px] text-slate-300 truncate max-w-sm">
                                {item.cloudflareThumbnailUrl}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Per-Item Actions */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {item.url && (
                        <button
                          type="button"
                          onClick={() => copyToClipboard(item.url, `item_main_url_${idx}`)}
                          className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg font-semibold text-xs flex items-center gap-1"
                          title="Copy main website URL to verify video, title, and thumbnail"
                        >
                          {copiedKey === `item_main_url_${idx}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                          )}
                          <span>{copiedKey === `item_main_url_${idx}` ? 'Copied' : 'Copy Main URL'}</span>
                        </button>
                      )}

                      {item.cloudflareVideoUrl && (
                        <button
                          type="button"
                          onClick={() => copyToClipboard(item.cloudflareVideoUrl!, `item_cf_vid_${idx}`)}
                          className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-lg font-semibold text-xs flex items-center gap-1"
                          title="Copy Cloudflare permanent video stream link"
                        >
                          {copiedKey === `item_cf_vid_${idx}` ? <Check className="w-3.5 h-3.5 text-cyan-400" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedKey === `item_cf_vid_${idx}` ? 'Copied' : 'Copy Video'}</span>
                        </button>
                      )}

                      {item.cloudflareThumbnailUrl && (
                        <button
                          type="button"
                          onClick={() => copyToClipboard(item.cloudflareThumbnailUrl!, `item_cf_${idx}`)}
                          className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded-lg font-semibold text-xs flex items-center gap-1"
                          title="Copy Cloudflare thumbnail link"
                        >
                          {copiedKey === `item_cf_${idx}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedKey === `item_cf_${idx}` ? 'Copied' : 'Copy Thumb'}</span>
                        </button>
                      )}

                      {item.videoStreamUrl && (
                        <button
                          type="button"
                          onClick={() => setPreviewStreamUrl(item.cloudflareVideoUrl || item.videoStreamUrl!)}
                          className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-semibold text-xs flex items-center gap-1"
                        >
                          <Play className="w-3.5 h-3.5 text-cyan-400 fill-current" />
                          <span>Play</span>
                        </button>
                      )}

                      {item.videoStreamUrl && (
                        <button
                          type="button"
                          onClick={() =>
                            onNavigateTab('categories', {
                              title: item.title,
                              reelsUrl: item.cloudflareVideoUrl || item.videoStreamUrl,
                              imageUrl: item.cloudflareThumbnailUrl,
                              description: item.description,
                              rating: 4.8,
                              likesCount: '15k',
                              durationSec: item.durationSec ?? 0,
                              sizeKb: item.sizeKb ?? undefined,
                              sizeBytes: item.sizeBytes ?? undefined,
                              sizeFormatted: item.sizeFormatted || undefined,
                            })
                          }
                          className="p-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 rounded-lg"
                          title="Send to Category Manager"
                        >
                          <FolderTree className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {(item.registryUniqueId || item.status === 'skipped_in_cloudflare' || item.status === 'completed') && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const q = encodeURIComponent(item.url);
                              const res = await fetch(`/api/registry/item?url=${q}`);
                              const data = await res.json().catch(() => null);
                              if (res.ok && data?.record) {
                                setEditingRegistryRecord(data.record);
                                return;
                              }
                            } catch {
                              // Fallback to opening item fields
                            }
                            setEditingRegistryRecord({
                              id: item.registryUniqueId || `url_${Date.now()}`,
                              sourceUrl: item.url,
                              title: item.title || '',
                              description: item.description || '',
                              videoUrl: item.videoStreamUrl || '',
                              thumbnailUrl: item.originalThumbnailUrl || item.cloudflareThumbnailUrl || '',
                              cloudflareVideoUrl: item.cloudflareVideoUrl || '',
                              cloudflareThumbnailUrl: item.cloudflareThumbnailUrl || '',
                              durationFormatted: item.durationFormatted || '',
                              durationSec: item.durationSec ?? null,
                              sizeFormatted: item.sizeFormatted || '',
                            });
                          }}
                          className="p-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-lg flex items-center gap-1 text-[11px] font-semibold"
                          title="Edit registry database object in Cloudflare D1"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Processing Loader for Single URL */}
      {isProcessing && inputMode === 'single' && (
        <div className="p-12 bg-slate-900/60 border border-slate-800 rounded-2xl text-center space-y-4">
          <div className="w-12 h-12 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin mx-auto" />
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-white">Crawling Target Website &amp; Extracting Media...</h3>
            <p className="text-xs text-slate-400">
              Retrieving HTML, inspecting video streams, uploading thumbnail to Cloudflare R2, and detecting length/size...
            </p>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SINGLE URL RESULT DISPLAY                                      */}
      {/* ============================================================== */}
      {result && !isProcessing && inputMode === 'single' && (
        <div className="space-y-6 animate-fadeIn">
          {/* Active Configured Metadata Toolbar Card */}
          <div className="p-5 bg-gradient-to-r from-slate-900 via-slate-900/95 to-slate-950 border border-cyan-500/30 rounded-2xl shadow-xl space-y-5">
            {/* Header Strip with Publishing Actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="p-1.5 rounded-lg bg-cyan-500 text-slate-950 font-bold">
                  <Sparkles className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white">
                    Extracted Video Metadata &amp; Cloudflare Thumbnail
                  </h3>
                  <p className="text-xs text-slate-400">
                    Direct stream link, verified Cloudflare R2 thumbnail back link, duration, and synopsis.
                  </p>
                  {result.targetUrl && (
                    <p className="text-[11px] font-mono text-slate-500 truncate max-w-xl mt-0.5">
                      Main URL: {result.targetUrl}
                    </p>
                  )}
                </div>
              </div>

              {/* Action Buttons to copy main URL or forward to Categories, Series, Reels */}
              <div className="flex flex-wrap items-center gap-2">
                {result.targetUrl && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(result.targetUrl, 'single_main_url')}
                    className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                    title={`Copy main website URL: ${result.targetUrl}`}
                  >
                    {copiedKey === 'single_main_url' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-slate-400" />
                    )}
                    <span>{copiedKey === 'single_main_url' ? 'Copied Main URL' : 'Copy Main URL'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={async () => {
                    // Update destination in Cloudflare Registry
                    fetch('/api/registry/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        sourceUrl: result.targetUrl,
                        title: activeTitle,
                        videoUrl: activeStreamUrl,
                        cloudflareVideoUrl: activeCloudflareVideo || undefined,
                        cloudflareThumbnailUrl: activeCloudflareThumbnail || undefined,
                        destination: 'categories',
                        destinationDetail: 'Video Categories Manager',
                      }),
                    }).catch(() => {});

                    onNavigateTab('categories', {
                      title: activeTitle,
                      reelsUrl: activeStreamUrl,
                      imageUrl: activeCloudflareThumbnail || activeThumbnail,
                      description: activeDescription,
                      rating: 4.8,
                      likesCount: '15k',
                      durationSec: activeDurationSec ?? 0,
                      sizeBytes: activeVideoSizeBytes ?? undefined,
                      sizeFormatted: activeVideoSize || undefined,
                    });
                  }}
                  className="px-3.5 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  title="Forward this video into Category &amp; Video Manager"
                >
                  <FolderTree className="w-3.5 h-3.5" />
                  <span>Send to Category</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    fetch('/api/registry/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        sourceUrl: result.targetUrl,
                        title: activeTitle,
                        videoUrl: activeStreamUrl,
                        cloudflareVideoUrl: activeCloudflareVideo || undefined,
                        cloudflareThumbnailUrl: activeCloudflareThumbnail || undefined,
                        destination: 'batchvideo',
                        destinationDetail: 'Batch Video Series',
                      }),
                    }).catch(() => {});

                    onNavigateTab('batchvideo', {
                      title: activeTitle,
                      videoUrl: activeStreamUrl,
                      imageUrl: activeCloudflareThumbnail || activeThumbnail,
                      duration: activeDurationSec || 0,
                    });
                  }}
                  className="px-3.5 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  title="Forward into Batch Web Series"
                >
                  <Film className="w-3.5 h-3.5" />
                  <span>Send to Series</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    fetch('/api/registry/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        sourceUrl: result.targetUrl,
                        title: activeTitle,
                        videoUrl: activeStreamUrl,
                        cloudflareVideoUrl: activeCloudflareVideo || undefined,
                        cloudflareThumbnailUrl: activeCloudflareThumbnail || undefined,
                        destination: 'reels',
                        destinationDetail: 'Short Reels',
                      }),
                    }).catch(() => {});

                    onNavigateTab('reels', {
                      title: activeTitle,
                      videoUrl: activeStreamUrl,
                      imageUrl: activeCloudflareThumbnail || activeThumbnail,
                    });
                  }}
                  className="px-3.5 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  title="Forward into Short Reels"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Send to Reels</span>
                </button>
              </div>
            </div>

            {/* Video Metric Badges Strip (Size, Length, Filter Status, Cloudflare Status) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              {/* Metric 1: Title Filter Status */}
              <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
                <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                  <Filter className="w-3.5 h-3.5 text-amber-400" />
                  <span>Title Filtering</span>
                </span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {liveFilterStats.removedTerms.length > 0 ? (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold">
                      {liveFilterStats.removedTerms.length} word(s) filtered
                    </span>
                  ) : (
                    <span className="text-slate-400 text-xs">No words removed</span>
                  )}
                </div>
              </div>

              {/* Metric 2: Video Length / Duration */}
              <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
                <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Video Length</span>
                </span>
                <p className="font-bold text-white text-sm">
                  {activeDurationFormatted ||
                    (activeDurationSec ? formatSecondsToDuration(activeDurationSec) : 'Not specified')}
                </p>
                {activeDurationSec && (
                  <span className="text-[10px] font-mono text-slate-500">
                    ({activeDurationSec} seconds)
                  </span>
                )}
              </div>

              {/* Metric 3: Video File Size */}
              <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
                <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Video File Size</span>
                </span>
                <p className="font-bold text-white text-sm">
                  {activeVideoSize || 'Adaptive / Unknown'}
                </p>
                <span className="text-[10px] text-slate-500 block">
                  {activeStreamUrl?.includes('.m3u8') ? 'HLS Adaptive' : 'HTTP Content-Length'}
                </span>
                {activeCompressionInfo?.compressed && (
                  <span className="inline-block text-[10px] font-semibold text-indigo-300 bg-indigo-500/15 border border-indigo-500/30 rounded px-1.5 py-0.5">
                    Compressed {activeCompressionInfo.quality} (-{activeCompressionInfo.savedPercent}%)
                  </span>
                )}
              </div>

              {/* Metric 4: Cloudflare Vault Status (Both Video & Thumb) */}
              <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
                <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                  <Cloud className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Cloudflare R2 Vault</span>
                </span>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${activeCloudflareVideo ? 'bg-cyan-400' : 'bg-slate-600'}`} />
                    <span className="text-[10px] text-slate-300">
                      Video: {activeCloudflareVideo ? 'Uploaded' : 'External'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${activeCloudflareThumbnail ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    <span className="text-[10px] text-slate-300">
                      Thumb: {activeCloudflareThumbnail ? 'Uploaded' : 'External'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Title Section with Before/After Comparison */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-semibold text-xs flex items-center gap-1.5">
                  <Type className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Active Cleaned Title</span>
                  {liveFilterStats.removedTerms.length > 0 && (
                    <span className="text-[10px] font-normal text-amber-400">
                      (Filtered terms: {liveFilterStats.removedTerms.map((t) => `"${t}"`).join(', ')})
                    </span>
                  )}
                </label>
                {rawBaseTitle && rawBaseTitle !== activeTitle && (
                  <button
                    type="button"
                    onClick={() => setShowRawComparison(!showRawComparison)}
                    className="text-xs text-cyan-400 hover:text-cyan-300 underline flex items-center gap-1"
                  >
                    <span>{showRawComparison ? 'Hide Original Comparison' : 'Compare with Original Title'}</span>
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <input
                  type="text"
                  value={activeTitle}
                  onChange={(e) => setActiveTitle(e.target.value)}
                  placeholder="Processed video title..."
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl text-white font-bold text-sm outline-none transition-colors"
                />

                {showRawComparison && rawBaseTitle && (
                  <div className="p-3 bg-slate-950/90 border border-slate-800 rounded-xl space-y-1 text-xs">
                    <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">
                      Original Raw Title from Website:
                    </span>
                    <p className="text-slate-400 line-through select-all">{rawBaseTitle}</p>
                    <div className="pt-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveTitle(rawBaseTitle)}
                        className="text-[10px] text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800"
                      >
                        Revert to Original
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Stream URL & Thumbnail URL Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-slate-400 font-semibold flex items-center gap-1.5">
                    <Film className="w-3.5 h-3.5 text-orange-400" />
                    <span>Active Stream URL</span>
                    {activeCloudflareVideo && (
                      <span className="text-[10px] text-cyan-400 font-mono font-bold">
                        (Cloudflare R2 Video)
                      </span>
                    )}
                  </label>

                  {/* Manual Cloudflare Video Upload Trigger Button */}
                  <button
                    type="button"
                    onClick={handleUploadActiveVideoToCloudflare}
                    disabled={isUploadingVideo || !activeStreamUrl}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 disabled:opacity-50"
                  >
                    {isUploadingVideo ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        <span>Uploading Video...</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud className="w-3 h-3" />
                        <span>Upload Video to Cloudflare</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="relative">
                  <input
                    type="url"
                    value={activeStreamUrl}
                    onChange={(e) => setActiveStreamUrl(e.target.value)}
                    placeholder="MP4 or HLS .m3u8 link..."
                    className="w-full pl-3 pr-28 py-2 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono text-xs outline-none focus:border-cyan-500 truncate"
                  />
                  <div className="absolute inset-y-1 right-1 flex items-center gap-1">
                    {activeStreamUrl && (
                      <button
                        type="button"
                        onClick={() => copyToClipboard(activeStreamUrl, 'active_stream_copy')}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs font-semibold flex items-center gap-1"
                        title="Copy video link"
                      >
                        {copiedKey === 'active_stream_copy' ? <Check className="w-3 h-3 text-cyan-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    )}
                    {activeStreamUrl && (
                      <button
                        type="button"
                        onClick={() => setPreviewStreamUrl(activeStreamUrl)}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded text-xs font-semibold flex items-center gap-1"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>Test</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Active Thumbnail with Cloudflare Upload Button */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-slate-400 font-semibold flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Thumbnail URL</span>
                    {activeCloudflareThumbnail && (
                      <span className="text-[10px] text-emerald-400 font-mono font-bold">
                        (Cloudflare R2 Thumbnail)
                      </span>
                    )}
                  </label>

                  {/* Manual Cloudflare R2 Upload Trigger Button */}
                  <button
                    type="button"
                    onClick={handleUploadActiveThumbnailToCloudflare}
                    disabled={isUploadingThumb || !activeThumbnail}
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1 disabled:opacity-50"
                  >
                    {isUploadingThumb ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        <span>Uploading Thumb...</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud className="w-3 h-3" />
                        <span>Upload Thumb to Cloudflare</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="relative">
                  <input
                    type="url"
                    value={activeThumbnail}
                    onChange={(e) => setActiveThumbnail(e.target.value)}
                    placeholder="Cover / Poster URL..."
                    className="w-full pl-3 pr-20 py-2 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono text-xs outline-none focus:border-cyan-500 truncate"
                  />
                  {activeThumbnail && (
                    <button
                      type="button"
                      onClick={() => copyToClipboard(activeThumbnail, 'active_thumb_copy')}
                      className="absolute inset-y-1 right-1 px-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs font-semibold flex items-center gap-1"
                    >
                      {copiedKey === 'active_thumb_copy' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'active_thumb_copy' ? 'Copied' : 'Copy'}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Video Description & Synopsis */}
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <label className="text-slate-400 font-semibold flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-purple-400" />
                  <span>Extracted Video Description &amp; Synopsis</span>
                </label>
                <span className="text-[11px] text-slate-500">
                  {activeDescription ? `${activeDescription.length} characters` : 'No synopsis provided'}
                </span>
              </div>
              <textarea
                value={activeDescription}
                onChange={(e) => setActiveDescription(e.target.value)}
                placeholder="Video description, synopsis, or plot summary..."
                rows={2}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 text-xs outline-none focus:border-cyan-500 resize-y leading-relaxed"
              />
            </div>
          </div>

          {/* Navigation Sub-Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2 text-xs font-semibold overflow-x-auto">
            <button
              onClick={() => setActiveSubTab('media')}
              className={`px-4 py-2 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap ${
                activeSubTab === 'media'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white bg-slate-900 border border-slate-800'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              <span>
                Detected Videos ({result.media.videos.length})
              </span>
            </button>

            <button
              onClick={() => setActiveSubTab('titles')}
              className={`px-4 py-2 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap ${
                activeSubTab === 'titles'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white bg-slate-900 border border-slate-800'
              }`}
            >
              <Type className="w-3.5 h-3.5" />
              <span>
                Candidate Titles ({result.page.candidateTitles?.length || 0})
              </span>
            </button>

            <button
              onClick={() => setActiveSubTab('thumbs')}
              className={`px-4 py-2 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap ${
                activeSubTab === 'thumbs'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white bg-slate-900 border border-slate-800'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              <span>
                Candidate Thumbnails ({result.page.candidateThumbnails?.length || 0})
              </span>
            </button>

            <button
              onClick={() => setActiveSubTab('html-explorer')}
              className={`px-4 py-2 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap ${
                activeSubTab === 'html-explorer'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white bg-slate-900 border border-slate-800'
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              <span>HTML Source &amp; Tag Explorer</span>
            </button>

            <button
              onClick={() => setActiveSubTab('page')}
              className={`px-4 py-2 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap ${
                activeSubTab === 'page'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white bg-slate-900 border border-slate-800'
              }`}
            >
              <Tag className="w-3.5 h-3.5" />
              <span>Meta Tags &amp; Headers</span>
            </button>

            <button
              onClick={() => setActiveSubTab('raw')}
              className={`px-4 py-2 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap ${
                activeSubTab === 'raw'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white bg-slate-900 border border-slate-800'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Complete JSON Payload</span>
            </button>
          </div>

          {/* ============================================================== */}
          {/* TAB 1: DETECTED VIDEOS & STREAMS                               */}
          {/* ============================================================== */}
          {activeSubTab === 'media' && (
            <div className="space-y-6">
              <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <Film className="w-4 h-4 text-cyan-400" />
                    <h3 className="font-bold text-white text-sm">
                      Direct Video &amp; Stream URLs ({result.media.videos.length})
                    </h3>
                  </div>
                  <span className="text-xs text-slate-500">
                    Inspected streams with verified HTTP size &amp; length
                  </span>
                </div>

                {result.media.videos.length > 0 ? (
                  <div className="space-y-3">
                    {result.media.videos.map((vid) => (
                      <div
                        key={vid.id}
                        className="p-4 bg-slate-950 border border-slate-800 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs"
                      >
                        {vid.poster && (
                          <div className="w-28 h-18 rounded-lg overflow-hidden bg-slate-900 shrink-0 border border-slate-800 relative group">
                            <img
                              src={vid.poster}
                              alt={vid.title || 'Video poster'}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                            <div className="absolute inset-0 bg-slate-950/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                              <span className="text-[9px] text-cyan-300 font-bold bg-slate-950/80 px-1 py-0.5 rounded">
                                Poster
                              </span>
                            </div>
                          </div>
                        )}

                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-bold font-mono text-[10px] border border-cyan-500/20">
                              {vid.type}
                            </span>

                            {vid.sizeFormatted && (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-bold font-mono text-[10px] border border-emerald-500/20 flex items-center gap-1">
                                <HardDrive className="w-2.5 h-2.5" />
                                <span>{vid.sizeFormatted}</span>
                              </span>
                            )}

                            {vid.durationFormatted && (
                              <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 font-bold font-mono text-[10px] border border-purple-500/20 flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5" />
                                <span>{vid.durationFormatted}</span>
                              </span>
                            )}

                            <span className="font-bold text-slate-200 text-sm truncate">
                              {vid.title || activeTitle || vid.filename}
                            </span>
                          </div>

                          <p className="font-mono text-slate-400 text-[11px] truncate">{vid.url}</p>

                          {vid.description && (
                            <p className="text-slate-400 text-[11px] line-clamp-1 italic">
                              {vid.description}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            onClick={() => {
                              setActiveStreamUrl(vid.url);
                              if (vid.rawTitle) setRawBaseTitle(vid.rawTitle);
                              if (vid.title) setActiveTitle(vid.title);
                              if (vid.poster) setActiveThumbnail(vid.poster);
                              if (vid.description) setActiveDescription(vid.description);
                              if (vid.durationFormatted) setActiveDurationFormatted(vid.durationFormatted);
                              if (vid.durationSec) setActiveDurationSec(vid.durationSec);
                              if (vid.sizeFormatted) setActiveVideoSize(vid.sizeFormatted);
                              if (vid.sizeBytes) setActiveVideoSizeBytes(vid.sizeBytes);
                            }}
                            className="px-2.5 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-lg transition-colors flex items-center gap-1 font-semibold"
                            title="Set as active video in the publish bar"
                          >
                            <CheckCheck className="w-3.5 h-3.5" />
                            <span>Select Video</span>
                          </button>

                          <button
                            onClick={() => setPreviewStreamUrl(vid.url)}
                            className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors flex items-center gap-1 font-semibold"
                          >
                            <Play className="w-3.5 h-3.5 text-cyan-400 fill-current" />
                            <span>Play</span>
                          </button>

                          <button
                            onClick={() => copyToClipboard(vid.url, `vid_${vid.id}`)}
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
                            title="Copy video link"
                          >
                            {copiedKey === `vid_${vid.id}` ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 border border-dashed border-slate-800 rounded-xl text-center space-y-2 text-xs">
                    <p className="text-slate-400">
                      No direct .mp4 or .m3u8 video streams detected in initial HTML tags.
                    </p>
                    <p className="text-slate-500 text-[11px]">
                      Check the <strong>Candidate Titles</strong> or <strong>HTML Source &amp; Tag Explorer</strong> tab to inspect the page DOM directly.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 2: CANDIDATE TITLES (WITH REAL-TIME FILTERING)              */}
          {/* ============================================================== */}
          {activeSubTab === 'titles' && (
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4 text-xs">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="space-y-0.5">
                  <h3 className="font-bold text-white text-sm flex items-center gap-2">
                    <Type className="w-4 h-4 text-cyan-400" />
                    Discovered Candidate Titles ({result.page.candidateTitles?.length || 0})
                  </h3>
                  <p className="text-slate-400 text-[11px]">
                    Extracted from OpenGraph, &lt;title&gt;, headings (&lt;h1&gt;, &lt;h2&gt;), title classes, and JSON-LD schemas. Filter words are applied automatically.
                  </p>
                </div>
              </div>

              {result.page.candidateTitles && result.page.candidateTitles.length > 0 ? (
                <div className="space-y-3">
                  {result.page.candidateTitles.map((cand, idx) => {
                    const cleanObj = cleanTitleWithFilter(cand.rawText || cand.text, wordsToRemove);
                    const isSelected = activeTitle === cleanObj.cleaned;

                    return (
                      <div
                        key={idx}
                        className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                          isSelected
                            ? 'bg-cyan-500/10 border-cyan-500/40 ring-1 ring-cyan-500/30'
                            : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-cyan-400 font-mono text-[10px]">
                              {cand.source}
                            </span>
                            {cand.selector && (
                              <code className="text-slate-500 text-[10px] font-mono">{cand.selector}</code>
                            )}
                            {cleanObj.removedTerms.length > 0 && (
                              <span className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 text-[9px] border border-amber-500/20">
                                Filtered: {cleanObj.removedTerms.join(', ')}
                              </span>
                            )}
                          </div>
                          <p className="font-bold text-white text-sm select-all">{cleanObj.cleaned}</p>
                          {cleanObj.rawTitle !== cleanObj.cleaned && (
                            <p className="text-slate-500 text-[11px] line-through">
                              Original: {cleanObj.rawTitle}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleSelectCandidateTitle(cand)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                              isSelected
                                ? 'bg-cyan-500 text-slate-950 font-bold'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                            }`}
                          >
                            {isSelected ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span>Active Title</span>
                              </>
                            ) : (
                              <>
                                <MousePointerClick className="w-3.5 h-3.5" />
                                <span>Use as Title</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => copyToClipboard(cleanObj.cleaned, `cand_title_${idx}`)}
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
                            title="Copy text"
                          >
                            {copiedKey === `cand_title_${idx}` ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-slate-500 italic py-4">No title tags could be extracted automatically.</p>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 3: CANDIDATE THUMBNAILS (POSTERS, COVERS, OG:IMAGE)        */}
          {/* ============================================================== */}
          {activeSubTab === 'thumbs' && (
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4 text-xs">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="space-y-0.5">
                  <h3 className="font-bold text-white text-sm flex items-center gap-2">
                    <ImageIcon className="w-4 h-4 text-emerald-400" />
                    All Discovered Candidate Thumbnails ({result.page.candidateThumbnails?.length || 0})
                  </h3>
                  <p className="text-slate-400 text-[11px]">
                    Extracted from &lt;video poster&gt;, OpenGraph, Twitter, meta[name="thumbnail"], and cover images.
                  </p>
                </div>
              </div>

              {result.page.candidateThumbnails && result.page.candidateThumbnails.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {result.page.candidateThumbnails.map((thumb, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl border flex flex-col justify-between space-y-3 transition-colors ${
                        activeThumbnail === thumb.url
                          ? 'bg-emerald-500/10 border-emerald-500/50 ring-1 ring-emerald-500/30'
                          : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="aspect-video bg-slate-900 rounded-lg overflow-hidden relative group">
                          <img
                            src={thumb.url}
                            alt={thumb.source}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        </div>

                        <div className="space-y-1">
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono text-[10px] block truncate">
                            {thumb.source}
                          </span>
                          <p className="font-mono text-slate-400 text-[10px] truncate" title={thumb.url}>
                            {thumb.url}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-900 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveThumbnail(thumb.url);
                            setActiveCloudflareThumbnail(null);
                          }}
                          className={`w-full py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                            activeThumbnail === thumb.url
                              ? 'bg-emerald-500 text-slate-950 font-bold'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                          }`}
                        >
                          {activeThumbnail === thumb.url ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>Active Thumbnail</span>
                            </>
                          ) : (
                            <>
                              <MousePointerClick className="w-3.5 h-3.5" />
                              <span>Use Thumbnail</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => copyToClipboard(thumb.url, `cand_thumb_${idx}`)}
                          className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg shrink-0"
                          title="Copy image link"
                        >
                          {copiedKey === `cand_thumb_${idx}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-slate-500 italic py-4">No thumbnail candidates detected.</p>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 4: VISUAL HTML SOURCE & TAG EXPLORER                       */}
          {/* ============================================================== */}
          {activeSubTab === 'html-explorer' && (
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div className="space-y-0.5">
                  <h3 className="font-bold text-white text-sm flex items-center gap-2">
                    <Code className="w-4 h-4 text-cyan-400" />
                    Interactive HTML Source &amp; Tag Explorer
                  </h3>
                  <p className="text-slate-400 text-[11px]">
                    Inspect the exact HTML returned by the website, search for any tag, and test custom CSS selectors.
                  </p>
                </div>

                <div className="text-xs font-mono text-slate-500">
                  {result.htmlLength?.toLocaleString()} bytes of HTML retrieved
                </div>
              </div>

              {/* Custom Selector Tester Box */}
              <div className="p-4 bg-slate-950 border border-cyan-500/30 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                    Test Any Tag or CSS Selector:
                  </span>
                  <span className="text-[11px] text-slate-400">
                    e.g. <code className="text-cyan-300">h1.title</code>, <code className="text-cyan-300">video[poster]</code>, <code className="text-cyan-300">.video-player</code>
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch gap-2">
                  <input
                    type="text"
                    value={customSelector}
                    onChange={(e) => setCustomSelector(e.target.value)}
                    placeholder="Type CSS selector (e.g. h1.entry-title or div.poster > img)..."
                    className="flex-1 px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-white font-mono text-xs outline-none focus:border-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={handleTestCustomSelector}
                    className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-lg text-xs transition-colors shrink-0"
                  >
                    Test Selector
                  </button>
                </div>

                {selectorTestResult !== null && (
                  <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-400">Extracted Selector Content:</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setRawBaseTitle(selectorTestResult);
                            const cleaned = cleanTitleWithFilter(selectorTestResult, wordsToRemove);
                            setActiveTitle(cleaned.cleaned);
                          }}
                          className="px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 text-[10px] font-semibold"
                        >
                          Use as Title
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveThumbnail(selectorTestResult);
                            setActiveCloudflareThumbnail(null);
                          }}
                          className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-semibold"
                        >
                          Use as Thumbnail
                        </button>
                      </div>
                    </div>
                    <p className="font-mono text-cyan-300 text-xs break-all select-all">
                      {selectorTestResult}
                    </p>
                  </div>
                )}
              </div>

              {/* HTML Line Search & Quick Filter Chips */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={htmlSearchTerm}
                    onChange={(e) => setHtmlSearchTerm(e.target.value)}
                    placeholder="Search inside HTML (e.g. title, poster, mp4, duration)..."
                    className="w-full pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono text-xs outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">Quick Filters:</span>
                  {['all', 'title', 'h1', 'video', 'poster', 'og', 'meta'].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setHtmlFilterTag(tag)}
                      className={`px-2 py-0.5 rounded-md font-mono text-[10px] transition-colors ${
                        htmlFilterTag === tag
                          ? 'bg-cyan-500 text-slate-950 font-bold'
                          : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>

              {/* HTML Code Box */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden font-mono text-[11px] leading-relaxed max-h-[500px] flex flex-col">
                <div className="p-2 border-b border-slate-900 bg-slate-900/60 flex items-center justify-between text-slate-400 text-[10px]">
                  <span>Showing {filteredHtmlLines.length} matched lines</span>
                  <button
                    onClick={() => copyToClipboard(result.fullHtml || '', 'all_html')}
                    className="hover:text-white flex items-center gap-1"
                  >
                    {copiedKey === 'all_html' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'all_html' ? 'Copied' : 'Copy All HTML'}</span>
                  </button>
                </div>

                <div className="overflow-y-auto p-3 space-y-0.5 flex-1 select-text">
                  {filteredHtmlLines.slice(0, 1000).map(({ lineNum, content }) => (
                    <div key={lineNum} className="flex hover:bg-slate-900/50 py-0.5 rounded px-1 group">
                      <span className="w-12 text-slate-600 select-none shrink-0 text-right pr-3">
                        {lineNum}
                      </span>
                      <span className="text-slate-300 break-all flex-1">
                        {content}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 5: META TAGS & HEADERS                                     */}
          {/* ============================================================== */}
          {activeSubTab === 'page' && (
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-6 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                  <span className="text-slate-400 font-semibold block">Discovered Title</span>
                  <p className="text-sm font-bold text-white">{result.page.title || '(No title tag)'}</p>
                </div>

                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                  <span className="text-slate-400 font-semibold block">Site Name / Domain</span>
                  <p className="text-sm font-bold text-white">{result.page.siteName || '(Not detected)'}</p>
                </div>

                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                  <span className="text-slate-400 font-semibold block">Detected Duration</span>
                  <p className="text-sm font-bold text-white">
                    {result.page.durationFormatted || 'Not in meta tags'}
                  </p>
                </div>

                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                  <span className="text-slate-400 font-semibold block">Detected File Size</span>
                  <p className="text-sm font-bold text-white">
                    {result.page.videoSize?.sizeFormatted || 'Adaptive / Unknown'}
                  </p>
                </div>

                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2 md:col-span-2">
                  <span className="text-slate-400 font-semibold block">Meta Description</span>
                  <p className="text-slate-200 leading-relaxed">
                    {result.page.description || '(No meta description found)'}
                  </p>
                </div>
              </div>

              {/* All Meta Tags Table */}
              <div className="space-y-2">
                <h4 className="font-bold text-white text-xs uppercase tracking-wider">
                  All Discovered Meta Tags ({Object.keys(result.content.metaTags).length})
                </h4>
                <div className="max-h-60 overflow-y-auto bg-slate-950 border border-slate-800 rounded-xl p-2 font-mono text-[11px]">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-900">
                        <th className="p-1.5">Property / Name</th>
                        <th className="p-1.5">Content</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-900">
                      {Object.entries(result.content.metaTags).map(([name, val], i) => (
                        <tr key={i} className="hover:bg-slate-900/40">
                          <td className="p-1.5 text-cyan-400 align-top">{name}</td>
                          <td className="p-1.5 text-slate-300 break-all">{val}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 6: FULL JSON PAYLOAD                                       */}
          {/* ============================================================== */}
          {activeSubTab === 'raw' && (
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-white text-xs uppercase tracking-wider">
                  Complete Processed JSON Payload
                </h4>
                <button
                  onClick={() => copyToClipboard(JSON.stringify(result, null, 2), 'full_json')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors flex items-center gap-1 font-semibold"
                >
                  {copiedKey === 'full_json' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedKey === 'full_json' ? 'Copied' : 'Copy Full JSON'}</span>
                </button>
              </div>
              <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl text-cyan-300 font-mono text-[11px] overflow-x-auto max-h-[500px]">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Stream Playback Tester Modal with Browser Metadata Duration Auto-Capture */}
      {previewStreamUrl && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl">
            <div className="p-3.5 border-b border-slate-800 flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5 text-cyan-400 fill-current" />
                Live Video Stream Tester
              </span>
              <button
                onClick={() => setPreviewStreamUrl(null)}
                className="text-slate-400 hover:text-white px-2 py-0.5"
              >
                ✕
              </button>
            </div>
            <div className="bg-black aspect-video flex items-center justify-center relative">
              <video
                src={previewStreamUrl}
                controls
                autoPlay
                onLoadedMetadata={(e) => {
                  const dur = e.currentTarget.duration;
                  if (dur && !isNaN(dur) && isFinite(dur)) {
                    setBrowserDetectedDuration(dur);
                    if (!activeDurationSec) {
                      setActiveDurationSec(Math.round(dur));
                      setActiveDurationFormatted(formatSecondsToDuration(dur));
                    }
                  }
                }}
                className="w-full h-full max-h-[60vh] object-contain"
              />
            </div>
            <div className="p-3 bg-slate-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono text-slate-400">
              <div className="space-y-0.5 min-w-0">
                <span className="truncate block max-w-md">{previewStreamUrl}</span>
                {browserDetectedDuration && (
                  <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    <span>
                      Stream Loaded Duration: {formatSecondsToDuration(browserDetectedDuration)} ({Math.round(browserDetectedDuration)}s)
                    </span>
                  </span>
                )}
              </div>
              <button
                onClick={() => setPreviewStreamUrl(null)}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg shrink-0"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Registry Database Object Editor Modal */}
      {editingRegistryRecord && (
        <JsonObjectEditorModal
          isOpen={true}
          title={`Edit Cloudflare Registry Record: ${editingRegistryRecord.title || editingRegistryRecord.id}`}
          subtitle={`PATCH /api/registry/item/${editingRegistryRecord.id} · Collection: links_registry`}
          initialData={editingRegistryRecord}
          accentColor="amber"
          saveLabel="Save to links_registry (D1)"
          deleteLabel="Delete from Registry"
          onClose={() => setEditingRegistryRecord(null)}
          onSave={async (updatedObj) => {
            const res = await fetch(
              `/api/registry/item/${encodeURIComponent(editingRegistryRecord.id)}`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  ...getR2Headers(),
                },
                body: JSON.stringify(updatedObj),
              }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.success) {
              throw new Error(data?.error || `HTTP ${res.status}: Failed to update registry item`);
            }
            const savedRecord = data.record || updatedObj;
            setSingleRegistryRecord(savedRecord);
            setEditingRegistryRecord(savedRecord);
            if (savedRecord.title) setActiveTitle(savedRecord.title);
            if (savedRecord.cloudflareVideoUrl) {
              setActiveStreamUrl(savedRecord.cloudflareVideoUrl);
              setActiveCloudflareVideo(savedRecord.cloudflareVideoUrl);
            }
            if (savedRecord.cloudflareThumbnailUrl) {
              setActiveThumbnail(savedRecord.cloudflareThumbnailUrl);
              setActiveCloudflareThumbnail(savedRecord.cloudflareThumbnailUrl);
            }
          }}
          onDelete={async () => {
            const res = await fetch(
              `/api/registry/item/${encodeURIComponent(editingRegistryRecord.id)}`,
              {
                method: 'DELETE',
                headers: getR2Headers(),
              }
            );
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData?.error || 'Failed to delete registry record');
            }
            setSingleRegistryRecord(null);
          }}
        />
      )}
    </div>
  );
};
