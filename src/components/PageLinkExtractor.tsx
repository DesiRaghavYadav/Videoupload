import React, { useState, useEffect, useMemo } from 'react';
import {
  Link2,
  Globe,
  Search,
  Filter,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  FolderTree,
  Film,
  PlaySquare,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Tag,
  AlertCircle,
  Database,
  ArrowRight,
  ListFilter,
  CheckSquare,
  Square,
  Download,
  Share2,
  Sparkles,
  Layers,
  ChevronRight,
  Trash2,
  Plus,
  FileText,
  Code,
  Square as StopSquare,
  ListOrdered,
  Ban,
  Radar,
} from 'lucide-react';
import { AppTabType } from './Header';

interface PageLinkExtractorProps {
  onNavigateTab: (tab: AppTabType, initialData?: any) => void;
  onAddToMultiExtractor?: (urls: string[], openTab?: boolean) => void;
  onAddToDomainProber?: (urls: string[], openTab?: boolean) => void;
  multiExtractorLinkCount?: number;
}

export interface ExtractedPageLink {
  url: string;
  normalizedUrl: string;
  text: string;
  type: 'video_media' | 'page_article' | 'image' | 'external';
  isRegisteredInCloudflare: boolean;
  isNewInCloudflare?: boolean;
  cloudflareRecord?: {
    id: string;
    title: string;
    destination?: string;
    destinationDetail?: string;
    videoUrl?: string;
    cloudflareVideoUrl?: string;
    cloudflareThumbnailUrl?: string;
    status: 'extracted' | 'processing' | 'uploaded' | 'forwarded';
  } | null;
}

export const PageLinkExtractor: React.FC<PageLinkExtractorProps> = ({
  onNavigateTab,
  onAddToMultiExtractor,
  onAddToDomainProber,
  multiExtractorLinkCount = 0,
}) => {
  const [sourceUrl, setSourceUrl] = useState('');
  const [filterKeywords, setFilterKeywords] = useState('');
  const [excludeKeywords, setExcludeKeywords] = useState('');
  const [sameDomainOnly, setSameDomainOnly] = useState(false);
  const [webpagesOnly, setWebpagesOnly] = useState(true);
  const [urlFormat, setUrlFormat] = useState('');
  const [autoRegisterNew, setAutoRegisterNew] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [scrollCount, setScrollCount] = useState<number>(8);
  const [clickLoadMore, setClickLoadMore] = useState(true);
  const [scrollEngine, setScrollEngine] = useState<'auto' | 'browser' | 'http'>('auto');
  const [skipLongUrls, setSkipLongUrls] = useState(true);
  const [maxUrlLength, setMaxUrlLength] = useState<number>(250);

  // Paginated Start -> End Sequence (/1, /2 ... /N) & Append Mode
  const [enablePageRange, setEnablePageRange] = useState(false);
  const [startPage, setStartPage] = useState<number>(1);
  const [endPage, setEndPage] = useState<number>(5);
  const [pageUrlPattern, setPageUrlPattern] = useState<
    'slash' | 'slash_trailing' | 'page_slash' | 'query_page' | 'replace_last_num'
  >('slash');
  const [appendToExistingResults, setAppendToExistingResults] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [multiAppendToast, setMultiAppendToast] = useState<string | null>(null);

  const stopPaginationRef = React.useRef(false);
  const activeAbortControllerRef = React.useRef<AbortController | null>(null);
  const [paginationProgress, setPaginationProgress] = useState<{
    active: boolean;
    currentIndex: number;
    totalPages: number;
    currentPageNumber: number;
    currentPageUrl: string;
    completedPages: number;
    failedPages: Array<{ page: number; url: string; error: string }>;
    totalLinksCollected: number;
    stoppedEarly: boolean;
  } | null>(null);

  // Extracted response data
  const [pageTitle, setPageTitle] = useState('');
  const [linksList, setLinksList] = useState<ExtractedPageLink[]>([]);
  const [scrollStats, setScrollStats] = useState<{
    scrollUsed?: boolean;
    scrollEngine?: string;
    scrollStepsCompleted?: number;
    pagesVisited?: number;
    loadMoreClicks?: number;
    xhrResponsesCaptured?: number;
    scrollNote?: string;
    skippedLongUrlCount?: number;
    maxUrlLength?: number;
  } | null>(null);
  const [activeTypeFilter, setActiveTypeFilter] = useState<'all' | 'video_media' | 'page_article' | 'registered' | 'unregistered'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Selected checkboxes
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Domain Filter Rules (Whitelist & Blacklist synced with Cloudflare R2)
  const [domainRules, setDomainRules] = useState<{ whitelist: string[]; blacklist: string[] }>({
    whitelist: [],
    blacklist: [],
  });
  const [showDomainFilterPanel, setShowDomainFilterPanel] = useState(false);
  const [newWhitelistTag, setNewWhitelistTag] = useState('');
  const [newBlacklistTag, setNewBlacklistTag] = useState('');
  const [isSyncingRules, setIsSyncingRules] = useState(false);
  const [rulesSyncSuccess, setRulesSyncSuccess] = useState<string | null>(null);

  // Load domain filter rules on mount from backend/Cloudflare
  const loadDomainRules = async () => {
    try {
      const res = await fetch('/api/registry/domain-rules');
      const data = await res.json();
      if (data.success && data.rules) {
        setDomainRules({
          whitelist: Array.isArray(data.rules.whitelist) ? data.rules.whitelist : [],
          blacklist: Array.isArray(data.rules.blacklist) ? data.rules.blacklist : [],
        });
      }
    } catch (err) {
      console.warn('Failed to load domain rules:', err);
    }
  };

  useEffect(() => {
    loadDomainRules();
  }, []);

  const handleSyncDomainRules = async () => {
    setIsSyncingRules(true);
    setRulesSyncSuccess(null);
    try {
      const res = await fetch('/api/registry/domain-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(domainRules),
      });
      const data = await res.json();
      if (data.success) {
        setRulesSyncSuccess('Domain rules synced and persisted to Cloudflare R2!');
        setTimeout(() => setRulesSyncSuccess(null), 3500);
      }
    } catch (err: any) {
      alert(`Failed to sync domain rules: ${err.message}`);
    } finally {
      setIsSyncingRules(false);
    }
  };

  const handleAddWhitelistTag = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const tag = newWhitelistTag.trim().toLowerCase();
    if (!tag) return;
    if (!domainRules.whitelist.includes(tag)) {
      setDomainRules((prev) => ({ ...prev, whitelist: [...prev.whitelist, tag] }));
    }
    setNewWhitelistTag('');
  };

  const handleRemoveWhitelistTag = (tag: string) => {
    setDomainRules((prev) => ({
      ...prev,
      whitelist: prev.whitelist.filter((t) => t !== tag),
    }));
  };

  const handleAddBlacklistTag = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const tag = newBlacklistTag.trim().toLowerCase();
    if (!tag) return;
    if (!domainRules.blacklist.includes(tag)) {
      setDomainRules((prev) => ({ ...prev, blacklist: [...prev.blacklist, tag] }));
    }
    setNewBlacklistTag('');
  };

  const handleRemoveBlacklistTag = (tag: string) => {
    setDomainRules((prev) => ({
      ...prev,
      blacklist: prev.blacklist.filter((t) => t !== tag),
    }));
  };

  // Sample sites for testing
  const sampleSites = [
    { label: 'Internet Archive Public Movies', url: 'https://archive.org/details/movies' },
    { label: 'NASA Video Gallery', url: 'https://images.nasa.gov' },
    { label: 'Sample Video Bucket', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  ];

  // Build paginated URL for a given page number
  const buildPaginatedPageUrl = (
    rawBase: string,
    pageNum: number,
    pattern: 'slash' | 'slash_trailing' | 'page_slash' | 'query_page' | 'replace_last_num'
  ): string => {
    let base = rawBase.trim();
    if (!base) return '';
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    if (/\{page\}/i.test(base)) {
      return base.replace(/\{page\}/gi, String(pageNum));
    }
    if (pattern === 'query_page') {
      if (/([?&]page=)\d*/i.test(base)) {
        return base.replace(/([?&]page=)\d*/i, `$1${pageNum}`);
      }
      return `${base}${base.includes('?') ? '&' : '?'}page=${pageNum}`;
    }
    if (pattern === 'replace_last_num') {
      if (/(\d+)(\/?(?:\?.*)?)$/.test(base)) {
        return base.replace(/(\d+)(\/?(?:\?.*)?)$/, `${pageNum}$2`);
      }
      return `${base.replace(/\/+$/, '')}/${pageNum}`;
    }
    if (pattern === 'page_slash') {
      return `${base.replace(/\/+$/, '')}/page/${pageNum}`;
    }
    if (pattern === 'slash_trailing') {
      return `${base.replace(/\/+$/, '')}/${pageNum}/`;
    }
    // Default 'slash': /1, /2 ... (or append directly if URL already ends with '=' like ?page=)
    if (base.endsWith('=')) {
      return `${base}${pageNum}`;
    }
    return `${base.replace(/\/+$/, '')}/${pageNum}`;
  };

  const paginatedPreview = useMemo(() => {
    if (!enablePageRange || !sourceUrl.trim()) return null;
    const safeStart = Math.max(0, Math.min(99999, Math.floor(Number(startPage) || 0)));
    const safeEnd = Math.max(safeStart, Math.min(safeStart + 199, Math.floor(Number(endPage) || safeStart)));
    return {
      safeStart,
      safeEnd,
      count: safeEnd - safeStart + 1,
      firstUrl: buildPaginatedPageUrl(sourceUrl, safeStart, pageUrlPattern),
      lastUrl: buildPaginatedPageUrl(sourceUrl, safeEnd, pageUrlPattern),
    };
  }, [enablePageRange, sourceUrl, startPage, endPage, pageUrlPattern]);

  const mergeExtractedLinks = (
    targetMap: Map<string, ExtractedPageLink>,
    incoming: ExtractedPageLink[]
  ) => {
    for (const item of incoming) {
      const key = item.normalizedUrl || item.url;
      const existing = targetMap.get(key);
      if (!existing) {
        targetMap.set(key, item);
      } else if (
        (!existing.text || existing.text === 'Discovered in text/script source') &&
        item.text
      ) {
        targetMap.set(key, {
          ...existing,
          text: item.text,
          cloudflareRecord: existing.cloudflareRecord || item.cloudflareRecord,
          isRegisteredInCloudflare: existing.isRegisteredInCloudflare || item.isRegisteredInCloudflare,
        });
      }
    }
  };

  const handleStopPagination = () => {
    stopPaginationRef.current = true;
    try {
      activeAbortControllerRef.current?.abort();
    } catch {}
  };

  const handleExtractLinks = async (targetOverride?: string, scrollCountOverride?: number) => {
    const target = (targetOverride || sourceUrl).trim();
    if (!target) {
      setErrorMsg('Please enter a website URL to extract all links from.');
      return;
    }

    const effectiveScrolls = scrollCountOverride ?? scrollCount;
    setIsLoading(true);
    setErrorMsg(null);
    stopPaginationRef.current = false;
    if (scrollCountOverride === undefined && !appendToExistingResults) {
      setSelectedUrls(new Set());
    }

    const isSequentialRangeRun = Boolean(enablePageRange && !targetOverride);

    if (isSequentialRangeRun) {
      const safeStart = Math.max(0, Math.min(99999, Math.floor(Number(startPage) || 0)));
      const safeEnd = Math.max(safeStart, Math.min(safeStart + 199, Math.floor(Number(endPage) || safeStart)));
      const totalPages = safeEnd - safeStart + 1;

      const mergedMap = new Map<string, ExtractedPageLink>();
      if (appendToExistingResults && linksList.length > 0) {
        mergeExtractedLinks(mergedMap, linksList);
      } else {
        setLinksList([]);
      }

      const failedPages: Array<{ page: number; url: string; error: string }> = [];
      let completedPages = 0;
      let totalSkippedLong = 0;
      let firstTitle = appendToExistingResults ? pageTitle : '';

      for (let idx = 0; idx < totalPages; idx++) {
        if (stopPaginationRef.current) {
          setPaginationProgress((prev) =>
            prev ? { ...prev, active: false, stoppedEarly: true } : null
          );
          break;
        }

        const pageNum = safeStart + idx;
        const pageUrl = buildPaginatedPageUrl(target, pageNum, pageUrlPattern);

        setPaginationProgress({
          active: true,
          currentIndex: idx + 1,
          totalPages,
          currentPageNumber: pageNum,
          currentPageUrl: pageUrl,
          completedPages,
          failedPages: [...failedPages],
          totalLinksCollected: mergedMap.size,
          stoppedEarly: false,
        });

        const controller = new AbortController();
        activeAbortControllerRef.current = controller;

        try {
          const res = await fetch('/api/extract-page-links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              url: pageUrl,
              filterKeywords: filterKeywords.trim(),
              sameDomainOnly,
              webpagesOnly,
              urlFormat: urlFormat.trim(),
              autoRegisterNew,
              autoScroll,
              scrollCount: effectiveScrolls,
              clickLoadMore,
              scrollEngine,
              skipLongUrls,
              maxUrlLength,
              singlePageOnly: true,
            }),
          });

          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || `HTTP ${res.status}`);
          }

          if (!firstTitle && data.pageTitle) {
            firstTitle = data.pageTitle;
            setPageTitle(data.pageTitle);
          }
          totalSkippedLong += Number(data.skippedLongUrlCount || 0);
          mergeExtractedLinks(mergedMap, data.links || []);
          completedPages++;

          const combined = Array.from(mergedMap.values());
          setLinksList(combined);
          setScrollStats({
            scrollUsed: true,
            scrollEngine: 'page_sequence',
            pagesVisited: completedPages,
            scrollStepsCompleted: completedPages,
            skippedLongUrlCount: totalSkippedLong,
            maxUrlLength,
            scrollNote: `Sequentially extracted ${completedPages}/${totalPages} pages (${safeStart} → ${safeEnd})`,
          });

          setPaginationProgress({
            active: idx + 1 < totalPages && !stopPaginationRef.current,
            currentIndex: idx + 1,
            totalPages,
            currentPageNumber: pageNum,
            currentPageUrl: pageUrl,
            completedPages,
            failedPages: [...failedPages],
            totalLinksCollected: combined.length,
            stoppedEarly: stopPaginationRef.current,
          });
        } catch (err: any) {
          if (err?.name === 'AbortError' || stopPaginationRef.current) {
            setPaginationProgress((prev) =>
              prev ? { ...prev, active: false, stoppedEarly: true } : null
            );
            break;
          }
          failedPages.push({
            page: pageNum,
            url: pageUrl,
            error: err?.message || 'Failed to load page',
          });
          setPaginationProgress({
            active: idx + 1 < totalPages,
            currentIndex: idx + 1,
            totalPages,
            currentPageNumber: pageNum,
            currentPageUrl: pageUrl,
            completedPages,
            failedPages: [...failedPages],
            totalLinksCollected: mergedMap.size,
            stoppedEarly: false,
          });
        } finally {
          activeAbortControllerRef.current = null;
        }
      }

      if (failedPages.length > 0 && completedPages === 0) {
        setErrorMsg(
          `Could not extract pages ${safeStart}–${safeEnd}: ${failedPages[0].error}`
        );
      }
      setIsLoading(false);
      return;
    }

    setPaginationProgress(null);
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;

    try {
      const res = await fetch('/api/extract-page-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          url: target,
          filterKeywords: filterKeywords.trim(),
          sameDomainOnly,
          webpagesOnly,
          urlFormat: urlFormat.trim(),
          autoRegisterNew,
          autoScroll,
          scrollCount: effectiveScrolls,
          clickLoadMore,
          scrollEngine,
          skipLongUrls,
          maxUrlLength,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to extract links from website');
      }

      if (appendToExistingResults && linksList.length > 0) {
        const mergedMap = new Map<string, ExtractedPageLink>();
        mergeExtractedLinks(mergedMap, linksList);
        mergeExtractedLinks(mergedMap, data.links || []);
        setLinksList(Array.from(mergedMap.values()));
        if (!pageTitle && data.pageTitle) setPageTitle(data.pageTitle);
      } else {
        setPageTitle(data.pageTitle || '');
        setLinksList(data.links || []);
      }

      setScrollStats({
        scrollUsed: data.scrollUsed,
        scrollEngine: data.scrollEngine,
        scrollStepsCompleted: data.scrollStepsCompleted,
        pagesVisited: data.pagesVisited,
        loadMoreClicks: data.loadMoreClicks,
        xhrResponsesCaptured: data.xhrResponsesCaptured,
        scrollNote: data.scrollNote,
        skippedLongUrlCount: data.skippedLongUrlCount,
        maxUrlLength: data.maxUrlLength,
      });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setErrorMsg(err.message || 'Error communicating with link extraction server');
      }
    } finally {
      activeAbortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  // Helper: Client-side URL format matcher
  const matchesFormatClient = (testUrl: string, format: string, srcUrl: string): boolean => {
    if (!format || !format.trim()) return true;
    let targetDomain = '';
    try {
      if (srcUrl) {
        const fullSrc = /^https?:\/\//i.test(srcUrl) ? srcUrl : `https://${srcUrl}`;
        targetDomain = new URL(fullSrc).hostname.toLowerCase();
      }
    } catch {}

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

        if (targetDomain) {
          p = p.replace(/^\{?domain\}?\//i, `${targetDomain}/`);
        }
        p = p.replace(/^https?:\/\//i, '');

        if (p.includes('*')) {
          const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          const regex = new RegExp(escaped, 'i');
          return regex.test(testUrl) || regex.test(hostAndPath) || regex.test(fullPath);
        }

        if (p.startsWith('/')) {
          return fullPath.toLowerCase().includes(p.toLowerCase());
        }

        if (targetDomain && p.toLowerCase().startsWith(targetDomain)) {
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

  // Filtered links
  const filteredLinks = useMemo(() => {
    let result = linksList;

    // Webpages Only filter: skips direct video and image extensions
    if (webpagesOnly) {
      result = result.filter(
        (l) =>
          l.type !== 'video_media' &&
          l.type !== 'image' &&
          !/\.(mp4|m3u8|webm|mov|mkv|avi|ts|mpd|flv|wmv|ogg)(\?.*)?$/i.test(l.url) &&
          !/\.(jpg|jpeg|png|webp|avif|gif|svg|ico|bmp|tiff)(\?.*)?$/i.test(l.url)
      );
    }

    // Skip overly long tracking / token / CDN URLs
    if (skipLongUrls && maxUrlLength > 0) {
      result = result.filter((l) => l.url.length <= maxUrlLength);
    }

    // URL path format filter (e.g. domain/xyz/ or /xyz/)
    if (urlFormat.trim()) {
      result = result.filter((l) => matchesFormatClient(l.url, urlFormat, sourceUrl));
    }

    if (activeTypeFilter === 'video_media') {
      result = result.filter((l) => l.type === 'video_media');
    } else if (activeTypeFilter === 'page_article') {
      result = result.filter((l) => l.type === 'page_article');
    } else if (activeTypeFilter === 'registered') {
      result = result.filter((l) => l.isRegisteredInCloudflare);
    } else if (activeTypeFilter === 'unregistered') {
      result = result.filter((l) => !l.isRegisteredInCloudflare);
    }

    // Include keywords filter (live refinement after extraction as well)
    if (filterKeywords.trim()) {
      const includeTerms = filterKeywords
        .toLowerCase()
        .split(/[,|\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (includeTerms.length > 0) {
        result = result.filter((l) =>
          includeTerms.some(
            (term) => l.url.toLowerCase().includes(term) || l.text.toLowerCase().includes(term)
          )
        );
      }
    }

    // Exclude keywords filter (post-extraction live removal of unwanted links)
    if (excludeKeywords.trim()) {
      const excludeTerms = excludeKeywords
        .toLowerCase()
        .split(/[,|\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (excludeTerms.length > 0) {
        result = result.filter(
          (l) =>
            !excludeTerms.some(
              (term) => l.url.toLowerCase().includes(term) || l.text.toLowerCase().includes(term)
            )
        );
      }
    }

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      result = result.filter((l) => l.url.toLowerCase().includes(q) || l.text.toLowerCase().includes(q));
    }

    return result;
  }, [
    linksList,
    webpagesOnly,
    skipLongUrls,
    maxUrlLength,
    urlFormat,
    sourceUrl,
    activeTypeFilter,
    filterKeywords,
    excludeKeywords,
    searchTerm,
  ]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleToggleSelect = (url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const selectedFilteredUrls = useMemo(
    () => filteredLinks.filter((l) => selectedUrls.has(l.url)).map((l) => l.url),
    [filteredLinks, selectedUrls]
  );

  const handleSelectAllFiltered = () => {
    if (selectedFilteredUrls.length === filteredLinks.length && filteredLinks.length > 0) {
      setSelectedUrls((prev) => {
        const next = new Set(prev);
        for (const l of filteredLinks) next.delete(l.url);
        return next;
      });
    } else {
      setSelectedUrls((prev) => {
        const next = new Set(prev);
        for (const l of filteredLinks) next.add(l.url);
        return next;
      });
    }
  };

  // Copy selected URLs or all filtered URLs
  const handleCopyUrls = (onlySelected: boolean) => {
    const urlsToCopy = onlySelected
      ? selectedFilteredUrls
      : filteredLinks.map((l) => l.url);

    if (urlsToCopy.length === 0) return;
    copyToClipboard(urlsToCopy.join('\n'), 'copy_bulk_urls');
  };

  // Add / Append filtered or selected URLs directly into Multi-Extractor (WebProcessor Multi-Link Queue)
  const handleForwardToWebProcessor = (onlySelected: boolean, openTab = true) => {
    const urlsToSend = onlySelected
      ? selectedFilteredUrls
      : filteredLinks.map((l) => l.url);

    if (urlsToSend.length === 0) return;

    if (onAddToMultiExtractor) {
      onAddToMultiExtractor(urlsToSend, openTab);
      if (!openTab) {
        setMultiAppendToast(
          `Appended ${urlsToSend.length} link${urlsToSend.length === 1 ? '' : 's'} to Multi-Extractor!`
        );
        setTimeout(() => setMultiAppendToast(null), 3500);
      }
      return;
    }

    onNavigateTab(
      'webprocessor',
      urlsToSend.map((url) => ({
        title: 'Extracted Link',
        reelsUrl: url,
        videoUrl: url,
      }))
    );
  };

  const handleSendToDomainProber = (onlySelected: boolean) => {
    if (!onAddToDomainProber) return;
    const urlsToSend = onlySelected ? selectedFilteredUrls : filteredLinks.map((l) => l.url);
    if (urlsToSend.length === 0) return;
    onAddToDomainProber(urlsToSend, true);
  };

  return (
    <div className="space-y-6">
      {/* Hero Header */}
      <div className="p-6 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-orange-500/10 text-orange-400 border border-orange-500/20">
                <Link2 className="w-5 h-5" />
              </span>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
                  Dedicated Webpage URL &amp; Deep Link Extractor
                </h1>
                <p className="text-xs text-slate-400">
                  Scrape any website to harvest all child links, video streams, and article URLs. Tracks against Cloudflare Registry so you never double-extract or duplicate uploads.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleExtractLinks();
          }}
          className="space-y-3 pt-2"
        >
          <div className="flex flex-col lg:flex-row items-stretch gap-2.5">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                <Globe className="w-4 h-4 text-orange-400" />
              </div>
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="Enter website URL to extract all child links from (e.g. https://example.com/videos)..."
                className="w-full pl-10 pr-20 py-3 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-xl text-slate-100 text-xs sm:text-sm outline-none transition-colors font-mono"
              />
              {sourceUrl && (
                <button
                  type="button"
                  onClick={() => setSourceUrl('')}
                  className="absolute inset-y-0 right-2 px-2 text-xs text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Keyword Filter */}
            <div className="relative w-full lg:w-72">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                <Filter className="w-4 h-4 text-amber-400" />
              </div>
              <input
                type="text"
                value={filterKeywords}
                onChange={(e) => setFilterKeywords(e.target.value)}
                placeholder="Keywords filter (e.g. video, watch, movie)..."
                className="w-full pl-10 pr-3 py-3 bg-slate-950 border border-slate-800 focus:border-amber-500 rounded-xl text-slate-100 text-xs sm:text-sm outline-none transition-colors"
              />
            </div>

            {/* Action Button(s) */}
            {isLoading && enablePageRange ? (
              <button
                type="button"
                onClick={handleStopPagination}
                className="px-6 py-3 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 font-bold rounded-xl transition-all flex items-center justify-center gap-2 text-xs sm:text-sm shrink-0"
              >
                <StopSquare className="w-4 h-4 fill-current" />
                <span>
                  Stop ({paginationProgress?.completedPages || 0}/{paginationProgress?.totalPages || 0} Done)
                </span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={isLoading || !sourceUrl.trim()}
                className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-400 hover:to-amber-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-orange-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-xs sm:text-sm shrink-0"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>{autoScroll ? `Scrolling (${scrollCount}x) & Harvesting...` : 'Harvesting Links...'}</span>
                  </>
                ) : enablePageRange && paginatedPreview ? (
                  <>
                    <ListOrdered className="w-4 h-4" />
                    <span>
                      Extract Pages {paginatedPreview.safeStart}–{paginatedPreview.safeEnd} ({paginatedPreview.count})
                    </span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                ) : (
                  <>
                    <span>Extract All Links</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            )}
          </div>

          {/* Multi-Page Sequence (/1, /2 ... Start to End) & Append Accumulation Bar */}
          <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="flex items-center gap-2 cursor-pointer font-bold select-none bg-violet-500/10 border border-violet-500/30 text-violet-300 px-3 py-1.5 rounded-xl transition-colors hover:bg-violet-500/20">
                  <input
                    type="checkbox"
                    checked={enablePageRange}
                    onChange={(e) => setEnablePageRange(e.target.checked)}
                    className="rounded border-slate-700 text-violet-500 focus:ring-0 bg-slate-950"
                  />
                  <span className="flex items-center gap-1.5">
                    <ListOrdered className="w-3.5 h-3.5 text-violet-400" />
                    <span>Paginated Range (/1, /2 ... Start → End)</span>
                  </span>
                </label>

                <label
                  className="flex items-center gap-2 cursor-pointer font-semibold select-none bg-slate-900 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-xl hover:border-slate-700 transition-colors"
                  title="Keep previously extracted links and add new ones into the same list"
                >
                  <input
                    type="checkbox"
                    checked={appendToExistingResults}
                    onChange={(e) => setAppendToExistingResults(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-0 bg-slate-950"
                  />
                  <span>Keep &amp; Append to Current Results</span>
                </label>
              </div>

              {multiExtractorLinkCount > 0 && (
                <button
                  type="button"
                  onClick={() => onNavigateTab('webprocessor')}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                  title="Open Multi-Link Extractor queue box"
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>Multi-Extractor Box: {multiExtractorLinkCount} link{multiExtractorLinkCount === 1 ? '' : 's'}</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </div>

            {enablePageRange && (
              <div className="p-2.5 bg-slate-900/70 border border-violet-500/20 rounded-lg space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400 font-semibold">Start Page:</span>
                    <input
                      type="number"
                      min={0}
                      max={99999}
                      value={startPage}
                      onChange={(e) => setStartPage(Math.max(0, Number(e.target.value) || 0))}
                      className="w-20 px-2.5 py-1 bg-slate-950 border border-slate-700 focus:border-violet-400 rounded-lg text-white font-mono text-xs outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400 font-semibold">End Page:</span>
                    <input
                      type="number"
                      min={startPage}
                      max={startPage + 199}
                      value={endPage}
                      onChange={(e) => setEndPage(Math.max(startPage, Number(e.target.value) || startPage))}
                      className="w-20 px-2.5 py-1 bg-slate-950 border border-slate-700 focus:border-violet-400 rounded-lg text-white font-mono text-xs outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400 font-semibold">Page URL Format:</span>
                    <select
                      value={pageUrlPattern}
                      onChange={(e) => setPageUrlPattern(e.target.value as any)}
                      className="px-2.5 py-1 bg-slate-950 border border-slate-700 focus:border-violet-400 rounded-lg text-slate-200 text-xs outline-none"
                    >
                      <option value="slash">Append /1, /2 ... (or {`{page}`})</option>
                      <option value="slash_trailing">Append /1/, /2/ ...</option>
                      <option value="page_slash">Append /page/1, /page/2 ...</option>
                      <option value="query_page">Query ?page=1, ?page=2 ...</option>
                      <option value="replace_last_num">Replace number in URL</option>
                    </select>
                  </div>
                </div>

                {paginatedPreview ? (
                  <div className="text-[11px] font-mono text-violet-200/90 flex flex-wrap items-center gap-1.5 break-all">
                    <span className="text-slate-400 font-sans">Will extract one-by-one ({paginatedPreview.count} pages) into 1 list:</span>
                    <span className="px-1.5 py-0.5 bg-slate-950 rounded border border-slate-800 text-cyan-300">
                      {paginatedPreview.firstUrl}
                    </span>
                    <span className="text-slate-500">→</span>
                    <span className="px-1.5 py-0.5 bg-slate-950 rounded border border-slate-800 text-cyan-300">
                      {paginatedPreview.lastUrl}
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400">
                    Enter your base URL above (e.g. <code className="text-violet-300">https://site.com/videos</code> or use <code className="text-violet-300">{`{page}`}</code>). Pages from Start to End are extracted 1-by-1 and combined in one place for filtering.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Dedicated URL Path Format / Pattern Specification Row */}
          <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <label className="text-slate-200 font-bold flex items-center gap-1.5">
                <Code className="w-4 h-4 text-cyan-400" />
                <span>Link Path Format / Pattern Filter</span>
                <span className="text-slate-500 font-normal text-[11px]">(e.g. domain/xyz/, /xyz/, watch?v=)</span>
              </label>

              {/* Quick Format Presets */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-slate-400 text-[11px]">Quick Presets:</span>
                <button
                  type="button"
                  onClick={() => setUrlFormat('domain/xyz/')}
                  className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-cyan-500/30 text-cyan-300 font-mono text-[10px] transition-colors"
                  title="Only match links following domain/xyz/ format"
                >
                  domain/xyz/
                </button>
                <button
                  type="button"
                  onClick={() => setUrlFormat('/xyz/')}
                  className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-cyan-500/30 text-cyan-300 font-mono text-[10px] transition-colors"
                  title="Only match links whose path contains /xyz/"
                >
                  /xyz/
                </button>
                <button
                  type="button"
                  onClick={() => setUrlFormat('/watch/')}
                  className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[10px] transition-colors"
                >
                  /watch/
                </button>
                <button
                  type="button"
                  onClick={() => setUrlFormat('/video/')}
                  className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[10px] transition-colors"
                >
                  /video/
                </button>
                <button
                  type="button"
                  onClick={() => setUrlFormat('/movie/')}
                  className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[10px] transition-colors"
                >
                  /movie/
                </button>
              </div>
            </div>

            <div className="relative">
              <input
                type="text"
                value={urlFormat}
                onChange={(e) => setUrlFormat(e.target.value)}
                placeholder="Enter path format to strictly enforce (e.g. domain/xyz/ or /xyz/ or watch?v=)..."
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 focus:border-cyan-500 rounded-lg text-slate-100 font-mono text-xs outline-none transition-colors"
              />
              {urlFormat && (
                <button
                  type="button"
                  onClick={() => setUrlFormat('')}
                  className="absolute inset-y-0 right-2 px-2 text-xs text-slate-500 hover:text-slate-300"
                >
                  ✕ Clear
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400">
              When specified, only URLs following this format are harvested. If using <code className="text-cyan-300 font-mono">domain/xyz/</code>, <code className="text-slate-300">domain</code> is automatically bound to the website&apos;s current host.
            </p>
          </div>

          {/* Auto-Scroll & Infinite Feed Harvesting Panel */}
          <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer font-bold select-none bg-orange-500/10 border border-orange-500/30 text-orange-300 px-3 py-1.5 rounded-xl transition-colors hover:bg-orange-500/20">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded border-slate-700 text-orange-500 focus:ring-0 bg-slate-950"
                />
                <span className="flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-orange-400" />
                  <span>Auto-Scroll Page (Load Infinite Feed Like Chrome)</span>
                </span>
              </label>

              {autoScroll && (
                <>
                  <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1">
                    <span className="text-slate-400 text-[11px]">Scrolls:</span>
                    {[3, 8, 15, 25, 40].map((val) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setScrollCount(val)}
                        className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold transition-colors ${
                          scrollCount === val
                            ? 'bg-orange-500 text-slate-950'
                            : 'bg-slate-950 text-slate-400 hover:text-white'
                        }`}
                      >
                        {val}x
                      </button>
                    ))}
                  </div>

                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 select-none">
                    <input
                      type="checkbox"
                      checked={clickLoadMore}
                      onChange={(e) => setClickLoadMore(e.target.checked)}
                      className="rounded border-slate-700 text-orange-500 focus:ring-0 bg-slate-950"
                    />
                    <span>Click &quot;Load More&quot; buttons</span>
                  </label>

                  <select
                    value={scrollEngine}
                    onChange={(e) => setScrollEngine(e.target.value as 'auto' | 'browser' | 'http')}
                    className="px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-slate-300 text-[11px] outline-none focus:border-orange-500"
                    title="Choose scrolling strategy"
                  >
                    <option value="auto">Engine: Auto (Chrome Scroll + Pagination)</option>
                    <option value="browser">Engine: Headless Chrome Scroll</option>
                    <option value="http">Engine: Fast HTTP Pagination</option>
                  </select>
                </>
              )}
            </div>
          </div>

          {/* Options & Sample Sites */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs pt-1">
            <div className="flex flex-wrap items-center gap-3">
              {/* Webpages Only Filter (Skips direct video and image links) */}
              <label className="flex items-center gap-2 cursor-pointer font-bold select-none bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 px-3 py-1.5 rounded-xl transition-colors hover:bg-cyan-500/20">
                <input
                  type="checkbox"
                  checked={webpagesOnly}
                  onChange={(e) => setWebpagesOnly(e.target.checked)}
                  className="rounded border-slate-700 text-cyan-500 focus:ring-0 bg-slate-950"
                />
                <span className="flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Webpages Only (Skip Direct Video &amp; Image Links)</span>
                </span>
              </label>

              {/* Skip Too Long URLs Toggle & Max Length */}
              <div className="flex flex-wrap items-center gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 px-3 py-1.5 rounded-xl">
                <label className="flex items-center gap-2 cursor-pointer font-bold select-none">
                  <input
                    type="checkbox"
                    checked={skipLongUrls}
                    onChange={(e) => setSkipLongUrls(e.target.checked)}
                    className="rounded border-slate-700 text-amber-500 focus:ring-0 bg-slate-950"
                  />
                  <span>Skip Too Long URLs</span>
                </label>

                {skipLongUrls && (
                  <div className="flex items-center gap-1 pl-1 border-l border-amber-500/30">
                    <span className="text-[11px] text-amber-200/80">Max:</span>
                    {[120, 200, 250, 400].map((len) => (
                      <button
                        key={len}
                        type="button"
                        onClick={() => setMaxUrlLength(len)}
                        className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold transition-colors ${
                          maxUrlLength === len
                            ? 'bg-amber-400 text-slate-950'
                            : 'bg-slate-950/70 text-amber-200 hover:bg-slate-900'
                        }`}
                      >
                        {len}
                      </button>
                    ))}
                    <input
                      type="number"
                      min={40}
                      max={4000}
                      value={maxUrlLength}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (!Number.isNaN(val)) setMaxUrlLength(Math.max(40, Math.min(4000, val)));
                      }}
                      className="w-14 px-1.5 py-0.5 bg-slate-950 border border-amber-500/30 rounded text-amber-200 font-mono text-[11px] outline-none focus:border-amber-400"
                      title="Maximum URL character length"
                    />
                    <span className="text-[10px] text-amber-200/70">chars</span>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-slate-300 select-none">
                <input
                  type="checkbox"
                  checked={sameDomainOnly}
                  onChange={(e) => setSameDomainOnly(e.target.checked)}
                  className="rounded border-slate-700 text-orange-500 focus:ring-0 bg-slate-950"
                />
                <span>Only same domain</span>
              </label>

              {/* Cloudflare Auto-Registration Toggle (No Duplicates · Auto-Add New) */}
              <label className="flex items-center gap-2 cursor-pointer font-bold select-none bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 rounded-xl transition-colors hover:bg-emerald-500/20">
                <input
                  type="checkbox"
                  checked={autoRegisterNew}
                  onChange={(e) => setAutoRegisterNew(e.target.checked)}
                  className="rounded border-slate-700 text-emerald-500 focus:ring-0 bg-slate-950"
                />
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Cloudflare Auto-Sync (No Copy on Match · Auto-Add New)</span>
                </span>
              </label>

              <button
                type="button"
                onClick={() => setShowDomainFilterPanel(!showDomainFilterPanel)}
                className={`px-3 py-1 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-all ${
                  showDomainFilterPanel
                    ? 'bg-orange-500/20 border-orange-500 text-orange-300 shadow-sm'
                    : 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-orange-400" />
                <span>Domain Whitelist &amp; Blacklist ({domainRules.blacklist.length} filters)</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
              <span>Sample:</span>
              {sampleSites.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => {
                    setSourceUrl(s.url);
                    handleExtractLinks(s.url);
                  }}
                  className="px-2 py-0.5 rounded-md bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Domain Whitelist & Blacklist Expandable Panel */}
          {showDomainFilterPanel && (
            <div className="mt-3 p-4 bg-slate-950/95 border border-orange-500/30 rounded-xl space-y-4 animate-fadeIn">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-orange-400" />
                    <h3 className="font-bold text-white text-xs sm:text-sm">
                      Domain-Specific URL Whitelisting &amp; Blacklisting
                    </h3>
                    <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded font-mono text-[10px]">
                      Cloudflare R2 Synced
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Automatically filter out ad networks, tracking scripts, and non-video redirects before extracting links. Rules persist in Cloudflare R2 (<code className="text-slate-300 font-mono">registry/domain_filter_rules.json</code>).
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleSyncDomainRules}
                  disabled={isSyncingRules}
                  className="px-3.5 py-1.5 bg-orange-500 hover:bg-orange-400 text-slate-950 font-bold rounded-lg text-xs transition-colors flex items-center gap-1.5 shrink-0 shadow-md shadow-orange-500/20 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncingRules ? 'animate-spin' : ''}`} />
                  <span>{isSyncingRules ? 'Syncing...' : 'Sync Rules to Cloudflare'}</span>
                </button>
              </div>

              {rulesSyncSuccess && (
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{rulesSyncSuccess}</span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Blacklist Section */}
                <div className="space-y-2 p-3 bg-slate-900/60 border border-slate-800 rounded-xl text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-rose-300 flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                      <span>Blacklist (Ignore Ads &amp; Tracking)</span>
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">{domainRules.blacklist.length} rules</span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    URLs containing any of these keywords or domains will be immediately ignored during extraction.
                  </p>

                  {/* Add Tag */}
                  <form onSubmit={handleAddBlacklistTag} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={newBlacklistTag}
                      onChange={(e) => setNewBlacklistTag(e.target.value)}
                      placeholder="Add pattern (e.g. adserver, tracker)..."
                      className="flex-1 px-2.5 py-1.5 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-200 text-xs outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!newBlacklistTag.trim()}
                      className="px-2.5 py-1.5 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 rounded-lg font-semibold text-xs disabled:opacity-50 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add</span>
                    </button>
                  </form>

                  {/* Tag Chips */}
                  <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pt-1">
                    {domainRules.blacklist.map((item) => (
                      <span
                        key={item}
                        className="px-2 py-0.5 bg-rose-500/10 text-rose-300 border border-rose-500/20 rounded-md font-mono text-[11px] flex items-center gap-1"
                      >
                        <span>{item}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveBlacklistTag(item)}
                          className="hover:text-rose-100 hover:bg-rose-500/30 rounded px-1 transition-colors"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Whitelist Section */}
                <div className="space-y-2 p-3 bg-slate-900/60 border border-slate-800 rounded-xl text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-emerald-300 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Whitelist (Strict Allowed Domains)</span>
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">{domainRules.whitelist.length} rules</span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    If populated, only URLs matching these domains/keywords will be saved. (Leave empty to allow all non-blacklisted).
                  </p>

                  {/* Add Tag */}
                  <form onSubmit={handleAddWhitelistTag} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={newWhitelistTag}
                      onChange={(e) => setNewWhitelistTag(e.target.value)}
                      placeholder="Add domain (e.g. archive.org, cdn)..."
                      className="flex-1 px-2.5 py-1.5 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-200 text-xs outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!newWhitelistTag.trim()}
                      className="px-2.5 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded-lg font-semibold text-xs disabled:opacity-50 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add</span>
                    </button>
                  </form>

                  {/* Tag Chips */}
                  <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pt-1">
                    {domainRules.whitelist.length === 0 ? (
                      <span className="text-slate-500 italic text-[11px]">
                        No whitelist active — all non-blacklisted links permitted.
                      </span>
                    ) : (
                      domainRules.whitelist.map((item) => (
                        <span
                          key={item}
                          className="px-2 py-0.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 rounded-md font-mono text-[11px] flex items-center gap-1"
                        >
                          <span>{item}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveWhitelistTag(item)}
                            className="hover:text-emerald-100 hover:bg-emerald-500/30 rounded px-1 transition-colors"
                          >
                            ✕
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </form>
      </div>

      {/* Error Message */}
      {errorMsg && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-start gap-3 text-xs text-rose-300 animate-fadeIn">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5 flex-1">
            <p className="font-bold">Extraction Notice</p>
            <p className="text-rose-400/90">{errorMsg}</p>
          </div>
          <button onClick={() => setErrorMsg(null)} className="text-slate-400 hover:text-white text-xs px-2">
            ✕
          </button>
        </div>
      )}

      {/* Sequential Page Extraction Progress */}
      {paginationProgress && (
        <div className="p-4 bg-slate-900/90 border border-violet-500/30 rounded-xl space-y-2 text-xs animate-fadeIn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {paginationProgress.active ? (
                <RefreshCw className="w-4 h-4 text-violet-400 animate-spin shrink-0" />
              ) : (
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span className="font-bold text-white">
                {paginationProgress.active
                  ? `Extracting Page ${paginationProgress.currentIndex} of ${paginationProgress.totalPages} (Page #${paginationProgress.currentPageNumber})`
                  : paginationProgress.stoppedEarly
                  ? `Stopped Early — Saved ${paginationProgress.totalLinksCollected} links from ${paginationProgress.completedPages}/${paginationProgress.totalPages} pages`
                  : `Completed ${paginationProgress.completedPages}/${paginationProgress.totalPages} pages — ${paginationProgress.totalLinksCollected} unique links combined`}
              </span>
            </div>
            <span className="px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 font-mono font-bold">
              {paginationProgress.totalLinksCollected} links collected
            </span>
          </div>

          <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-300"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(
                    ((paginationProgress.active
                      ? paginationProgress.completedPages + 0.3
                      : paginationProgress.completedPages) /
                      Math.max(1, paginationProgress.totalPages)) *
                      100
                  )
                )}%`,
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="font-mono truncate max-w-xl">
              {paginationProgress.active ? `Fetching: ${paginationProgress.currentPageUrl}` : 'All collected links are combined below for 1-click filtering.'}
            </span>
            {paginationProgress.failedPages.length > 0 && (
              <span className="text-amber-300 font-semibold">
                {paginationProgress.failedPages.length} page{paginationProgress.failedPages.length === 1 ? '' : 's'} skipped ({paginationProgress.failedPages.map((f) => `#${f.page}`).join(', ')})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Appended Confirmation Toast */}
      {multiAppendToast && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-between gap-3 text-xs text-emerald-300 animate-fadeIn">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="font-semibold">{multiAppendToast}</span>
            {multiExtractorLinkCount > 0 && (
              <span className="text-emerald-200/80">
                (Multi-Extractor now holds {multiExtractorLinkCount} link{multiExtractorLinkCount === 1 ? '' : 's'})
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('webprocessor')}
            className="px-3 py-1 bg-emerald-500 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1"
          >
            <span>Open Multi-Extractor</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Results Workspace */}
      {linksList.length > 0 && (
        <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-5 animate-fadeIn">
          {/* Header & Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-white text-base">
                  Discovered {filteredLinks.length} {webpagesOnly ? 'Webpage' : ''} URLs
                </span>
                {webpagesOnly && (
                  <span className="px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 font-medium text-[11px] flex items-center gap-1">
                    <FileText className="w-3 h-3" />
                    Webpages Only (Skipped Media Files)
                  </span>
                )}
                {urlFormat.trim() && (
                  <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 font-mono text-[11px] flex items-center gap-1">
                    <Code className="w-3 h-3" />
                    Format: {urlFormat} ({filteredLinks.length} matched)
                  </span>
                )}
                {scrollStats?.scrollUsed && (
                  <span
                    className="px-2 py-0.5 rounded bg-orange-500/15 border border-orange-500/30 text-orange-300 font-mono text-[11px] flex items-center gap-1"
                    title={scrollStats.scrollNote || undefined}
                  >
                    <Layers className="w-3 h-3" />
                    {scrollStats.scrollEngine === 'chromium_browser'
                      ? `Chrome Scrolled ${scrollStats.scrollStepsCompleted || 0}x${
                          scrollStats.loadMoreClicks ? ` · ${scrollStats.loadMoreClicks} Load More` : ''
                        }${scrollStats.xhrResponsesCaptured ? ` · ${scrollStats.xhrResponsesCaptured} XHR` : ''}`
                      : `Crawled ${scrollStats.pagesVisited || 1} Page(s)`}
                  </span>
                )}
                {scrollStats?.scrollNote && scrollStats.scrollEngine !== 'chromium_browser' && (
                  <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700 text-slate-400 text-[10px]">
                    {scrollStats.scrollNote}
                  </span>
                )}
                {(scrollStats?.skippedLongUrlCount ?? 0) > 0 && (
                  <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-[11px]">
                    Skipped {scrollStats?.skippedLongUrlCount} Long URL{scrollStats?.skippedLongUrlCount === 1 ? '' : 's'} (&gt;{scrollStats?.maxUrlLength || maxUrlLength} chars)
                  </span>
                )}
                {pageTitle && (
                  <span className="text-xs text-slate-400 truncate max-w-md font-mono">
                    ({pageTitle})
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                Green badges denote URLs already in your Cloudflare registry with saved video/thumbnail destinations.
              </p>
            </div>

            {/* Bulk Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {autoScroll && scrollCount < 40 && !enablePageRange && (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    const nextScrolls = Math.min(40, scrollCount + 10);
                    setScrollCount(nextScrolls);
                    handleExtractLinks(undefined, nextScrolls);
                  }}
                  className="px-3 py-1.5 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  title="Re-scroll deeper (+10 scroll steps) to harvest even more links"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Scroll Deeper ({Math.min(40, scrollCount + 10)}x)</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setLinksList([]);
                  setSelectedUrls(new Set());
                  setPaginationProgress(null);
                }}
                disabled={isLoading}
                className="px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-rose-300 rounded-xl text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-50"
                title="Clear extracted links table"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>

              <button
                type="button"
                onClick={() => handleCopyUrls(selectedFilteredUrls.length > 0)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                {copiedKey === 'copy_bulk_urls' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>
                  {copiedKey === 'copy_bulk_urls'
                    ? 'Copied to Clipboard'
                    : selectedFilteredUrls.length > 0
                    ? `Copy Selected (${selectedFilteredUrls.length})`
                    : `Copy All (${filteredLinks.length})`}
                </span>
              </button>

              <button
                type="button"
                disabled={filteredLinks.length === 0}
                onClick={() => handleForwardToWebProcessor(selectedFilteredUrls.length > 0, false)}
                className="px-3 py-1.5 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 text-cyan-300 font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors disabled:opacity-40"
                title="Append links into Multi-Extractor without leaving this page"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>
                  {selectedFilteredUrls.length > 0
                    ? `Append (${selectedFilteredUrls.length}) & Stay`
                    : `Append (${filteredLinks.length}) & Stay`}
                </span>
              </button>

              {onAddToDomainProber && (
                <button
                  type="button"
                  disabled={filteredLinks.length === 0}
                  onClick={() => handleSendToDomainProber(selectedFilteredUrls.length > 0)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors disabled:opacity-40"
                  title="Send extracted URLs to Domain Prober to check which domains/subdomains have video (max 5 links/domain)"
                >
                  <Radar className="w-3.5 h-3.5" />
                  <span>
                    {selectedFilteredUrls.length > 0
                      ? `Probe Domains (${selectedFilteredUrls.length})`
                      : `Probe Domains (${filteredLinks.length})`}
                  </span>
                </button>
              )}

              <button
                type="button"
                disabled={filteredLinks.length === 0}
                onClick={() => handleForwardToWebProcessor(selectedFilteredUrls.length > 0, true)}
                className="px-3.5 py-1.5 bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-400 hover:to-amber-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-orange-500/20 transition-all disabled:opacity-40"
                title="Append links to Multi-Extractor (keeps any existing links) and open Multi-Extractor"
              >
                <Globe className="w-3.5 h-3.5" />
                <span>
                  {selectedFilteredUrls.length > 0
                    ? `Add Selected (${selectedFilteredUrls.length}) to Multi-Extractor`
                    : `Add Filtered (${filteredLinks.length}) to Multi-Extractor`}
                </span>
              </button>
            </div>
          </div>

          {/* Filter Bar & Search */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 text-xs">
            {/* Filter Tabs */}
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl">
              <button
                type="button"
                onClick={() => setActiveTypeFilter('all')}
                className={`px-3 py-1 rounded-lg font-semibold transition-colors ${
                  activeTypeFilter === 'all' ? 'bg-orange-500 text-white font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                All ({linksList.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTypeFilter('video_media')}
                className={`px-3 py-1 rounded-lg font-semibold transition-colors flex items-center gap-1 ${
                  activeTypeFilter === 'video_media'
                    ? 'bg-orange-500 text-white font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Film className="w-3 h-3 text-cyan-400" />
                <span>Direct Media ({linksList.filter((l) => l.type === 'video_media').length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTypeFilter('page_article')}
                className={`px-3 py-1 rounded-lg font-semibold transition-colors ${
                  activeTypeFilter === 'page_article'
                    ? 'bg-orange-500 text-white font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Webpages ({linksList.filter((l) => l.type === 'page_article').length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTypeFilter('registered')}
                className={`px-3 py-1 rounded-lg font-semibold transition-colors flex items-center gap-1 ${
                  activeTypeFilter === 'registered'
                    ? 'bg-orange-500 text-white font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span>In Cloudflare ({linksList.filter((l) => l.isRegisteredInCloudflare).length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTypeFilter('unregistered')}
                className={`px-3 py-1 rounded-lg font-semibold transition-colors ${
                  activeTypeFilter === 'unregistered'
                    ? 'bg-orange-500 text-white font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                New / Unregistered ({linksList.filter((l) => !l.isRegisteredInCloudflare).length})
              </button>
            </div>

            {/* Quick Search & Post-Extract Exclude Filter */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
              <div className="relative w-full sm:w-56">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Include / search links..."
                  className="w-full pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono text-xs outline-none focus:border-orange-500"
                />
              </div>
              <div className="relative w-full sm:w-56">
                <Ban className="w-3.5 h-3.5 text-rose-400/80 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={excludeKeywords}
                  onChange={(e) => setExcludeKeywords(e.target.value)}
                  placeholder="Exclude (e.g. /tag/, /page/)..."
                  className="w-full pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono text-xs outline-none focus:border-rose-500"
                />
              </div>
            </div>
          </div>

          {/* Select all bar */}
          <div className="flex items-center justify-between text-xs px-2 pt-1 text-slate-400">
            <button
              type="button"
              onClick={handleSelectAllFiltered}
              className="flex items-center gap-1.5 hover:text-white transition-colors font-medium"
            >
              {selectedFilteredUrls.length === filteredLinks.length && filteredLinks.length > 0 ? (
                <CheckSquare className="w-4 h-4 text-orange-400" />
              ) : (
                <Square className="w-4 h-4 text-slate-500" />
              )}
              <span>Select all {filteredLinks.length} filtered items</span>
            </button>
            <span>
              {selectedFilteredUrls.length} of {filteredLinks.length} selected
            </span>
          </div>

          {/* Table of Links */}
          <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950 max-h-[600px] overflow-y-auto">
            <table className="w-full text-left text-xs divide-y divide-slate-900">
              <thead className="bg-slate-900/80 sticky top-0 z-10 text-slate-400 font-semibold">
                <tr>
                  <th className="p-3 w-10 text-center">#</th>
                  <th className="p-3">Discovered URL &amp; Anchor Text</th>
                  <th className="p-3 w-32">Type</th>
                  <th className="p-3 w-48">Cloudflare Registry Status</th>
                  <th className="p-3 w-28 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/60">
                {filteredLinks.map((item, idx) => {
                  const isChecked = selectedUrls.has(item.url);
                  const isRegistered = item.isRegisteredInCloudflare;
                  const record = item.cloudflareRecord;

                  return (
                    <tr
                      key={idx}
                      className={`hover:bg-slate-900/40 transition-colors ${
                        isChecked ? 'bg-orange-500/5' : ''
                      }`}
                    >
                      {/* Checkbox & Index */}
                      <td className="p-3 text-center align-top">
                        <button
                          type="button"
                          onClick={() => handleToggleSelect(item.url)}
                          className="text-slate-500 hover:text-orange-400"
                        >
                          {isChecked ? (
                            <CheckSquare className="w-4 h-4 text-orange-400" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>

                      {/* URL & Text */}
                      <td className="p-3 align-top space-y-1 min-w-0">
                        {item.text && item.text !== 'Discovered in text/script source' && (
                          <p className="font-semibold text-slate-200 line-clamp-1">
                            {item.text}
                          </p>
                        )}
                        <p className="font-mono text-cyan-300 text-[11px] break-all select-all">
                          {item.url}
                        </p>
                      </td>

                      {/* Type Badge */}
                      <td className="p-3 align-top">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                            item.type === 'video_media'
                              ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                              : item.type === 'image'
                              ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                              : 'bg-slate-800 text-slate-400 border-slate-700'
                          }`}
                        >
                          {item.type}
                        </span>
                      </td>

                      {/* Cloudflare Registry Details */}
                      <td className="p-3 align-top space-y-1">
                        {isRegistered && record ? (
                          <div className="space-y-0.5">
                            {(() => {
                              const hasProcessed = Boolean(
                                record.cloudflareVideoUrl ||
                                record.cloudflareThumbnailUrl ||
                                record.videoUrl ||
                                record.status === 'uploaded'
                              );
                              if (item.isNewInCloudflare) {
                                return (
                                  <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-bold text-[10px] flex items-center gap-1 w-fit">
                                    <Plus className="w-2.5 h-2.5" />
                                    <span>New Link Added</span>
                                  </span>
                                );
                              }
                              if (hasProcessed) {
                                return (
                                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold text-[10px] flex items-center gap-1 w-fit">
                                    <ShieldCheck className="w-2.5 h-2.5" />
                                    <span>Processed in Cloudflare (0 Copy)</span>
                                  </span>
                                );
                              }
                              return (
                                <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 font-semibold text-[10px] flex items-center gap-1 w-fit">
                                  <span>Tracked Link (Not Processed Yet)</span>
                                </span>
                              );
                            })()}
                            {record.destination && record.destination !== 'none' && (
                              <p className="text-[10px] text-yellow-400 font-medium">
                                Saved to: <strong>{record.destination}</strong>
                                {record.destinationDetail ? ` (${record.destinationDetail})` : ''}
                              </p>
                            )}
                            <span className="text-[9px] font-mono text-slate-500 block truncate">
                              ID: {record.id}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-500 text-[11px] italic">
                            Not in Cloudflare
                          </span>
                        )}
                      </td>

                      {/* Quick Actions */}
                      <td className="p-3 align-top text-right space-x-1 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(item.url, `copy_url_${idx}`)}
                          className="p-1.5 text-slate-400 hover:text-white rounded bg-slate-900 border border-slate-800"
                          title="Copy URL"
                        >
                          {copiedKey === `copy_url_${idx}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            onNavigateTab('webprocessor', [{
                              title: item.text || 'Extracted Video',
                              reelsUrl: item.url,
                              videoUrl: item.url,
                            }])
                          }
                          className="p-1.5 text-orange-400 hover:text-orange-300 rounded bg-orange-500/10 border border-orange-500/20"
                          title="Process this link"
                        >
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
