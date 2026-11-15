import React, { useState, useEffect, useMemo } from 'react';
import {
  CloudflareStatsResponse,
  fetchDatabaseStats,
  fetchFromCloudflare,
  uploadToCloudflare,
  deleteFromCloudflare,
  ALL_D1_COLLECTIONS,
  D1CollectionDescriptor,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import { JsonObjectEditorModal } from './JsonObjectEditorModal';
import {
  Database,
  Film,
  PlaySquare,
  BookOpen,
  Headphones,
  Tv,
  Users,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  FolderTree,
  Bell,
  Sparkles,
  Globe,
  Pencil,
  Trash2,
  Plus,
  Search,
  Layers,
  X,
} from 'lucide-react';

interface AdminStatsDashboardProps {
  onNavigateTab: (tab: string) => void;
}

function resolveObjectId(item: any, preferredKey?: string): string {
  if (!item || typeof item !== 'object') return '';
  if (preferredKey && item[preferredKey] !== undefined && item[preferredKey] !== null && String(item[preferredKey]).trim()) {
    return String(item[preferredKey]).trim();
  }
  for (const k of ['batchId', 'id', '_id', 'userid']) {
    if (item[k] !== undefined && item[k] !== null && String(item[k]).trim()) {
      return String(item[k]).trim();
    }
  }
  return '';
}

function resolveObjectTitle(item: any): string {
  if (!item || typeof item !== 'object') return 'Object';
  return (
    String(
      item.title ||
        item.name ||
        item.username ||
        item.email ||
        item.batchName ||
        item.versionName ||
        item.sourceUrl ||
        item.batchId ||
        item.id ||
        item._id ||
        'Untitled Object'
    ).trim() || 'Untitled Object'
  );
}

export function AdminStatsDashboard({ onNavigateTab }: AdminStatsDashboardProps) {
  const [stats, setStats] = useState<CloudflareStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Active Collection Explorer & Object Editor state
  const [activeCollection, setActiveCollection] = useState<D1CollectionDescriptor | null>(null);
  const [collectionItems, setCollectionItems] = useState<any[]>([]);
  const [loadingCollection, setLoadingCollection] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [collectionSearch, setCollectionSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(50);

  // Modal state for creating / editing any collection object
  const [editingItem, setEditingItem] = useState<{ item: any; isNew: boolean } | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDatabaseStats();
      setStats(data);
      setLastUpdated(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load Cloudflare database stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const openCollectionBrowser = async (col: D1CollectionDescriptor) => {
    setActiveCollection(col);
    setCollectionSearch('');
    setVisibleLimit(50);
    setLoadingCollection(true);
    setCollectionError(null);
    try {
      const res = await fetchFromCloudflare<any>(col.id);
      const list = Array.isArray(res) ? res : res?.data || res?.items || res?.links || (res && typeof res === 'object' ? [res] : []);
      setCollectionItems(list);
    } catch (err: any) {
      setCollectionError(err?.message || `Failed to load objects from /api/${col.id}`);
      setCollectionItems([]);
    } finally {
      setLoadingCollection(false);
    }
  };

  const handleSaveCollectionObject = async (updatedObj: any) => {
    if (!activeCollection) return;
    await uploadToCloudflare(activeCollection.id, updatedObj);
    await Promise.all([openCollectionBrowser(activeCollection), loadStats()]);
  };

  const handleDeleteCollectionObject = async (itemId: string) => {
    if (!activeCollection || !itemId) return;
    setDeletingKey(itemId);
    try {
      await deleteFromCloudflare(activeCollection.id, itemId);
      setCollectionItems((prev) =>
        prev.filter((it) => resolveObjectId(it, activeCollection.idField) !== itemId)
      );
      await loadStats();
    } catch (err: any) {
      setCollectionError(err?.message || `Failed to delete ${itemId}`);
    } finally {
      setDeletingKey(null);
    }
  };

  const filteredCollectionItems = useMemo(() => {
    const q = collectionSearch.trim().toLowerCase();
    if (!q) return collectionItems;
    return collectionItems.filter((item) => {
      try {
        return JSON.stringify(item).toLowerCase().includes(q);
      } catch {
        return false;
      }
    });
  }, [collectionItems, collectionSearch]);

  const collectionCards = [
    {
      id: 'batchvideo',
      title: 'Batch Videos & Series',
      subtitle: 'OTT Web Series & Multi-Episode Batches',
      count: stats?.collections?.batchvideo?.total_documents ?? 0,
      icon: Film,
      color: 'from-orange-500/20 to-amber-500/10 text-orange-400 border-orange-500/30',
      tab: 'batchvideo',
      endpoint: '/api/batchvideo',
      descriptor: ALL_D1_COLLECTIONS.find((c) => c.id === 'batchvideo')!,
    },
    {
      id: 'reels',
      title: 'Short Reels',
      subtitle: 'Vertical Video Shorts & Clips',
      count: stats?.collections?.reels?.total_documents ?? 0,
      icon: PlaySquare,
      color: 'from-rose-500/20 to-pink-500/10 text-rose-400 border-rose-500/30',
      tab: 'reels',
      endpoint: '/api/reels',
      descriptor: ALL_D1_COLLECTIONS.find((c) => c.id === 'reels')!,
    },
    {
      id: 'comics',
      title: 'Comics & Manga',
      subtitle: 'Episodic Chapters & Page Strips',
      count: stats?.collections?.comics?.total_documents ?? 0,
      icon: BookOpen,
      color: 'from-violet-500/20 to-purple-500/10 text-violet-400 border-violet-500/30',
      tab: 'comics',
      endpoint: '/api/comics',
      descriptor: ALL_D1_COLLECTIONS.find((c) => c.id === 'comics')!,
    },
    {
      id: 'stories',
      title: 'Audio Stories',
      subtitle: 'Spoken Narratives, Podcasts & Drama',
      count: stats?.collections?.stories?.total_documents ?? 0,
      icon: Headphones,
      color: 'from-emerald-500/20 to-teal-500/10 text-emerald-400 border-emerald-500/30',
      tab: 'stories',
      endpoint: '/api/stories',
      descriptor: ALL_D1_COLLECTIONS.find((c) => c.id === 'stories')!,
    },
    {
      id: 'channels',
      title: 'Live TV Channels',
      subtitle: 'Streaming Networks & Live Feeds',
      count: stats?.collections?.channels?.total_documents ?? 0,
      icon: Tv,
      color: 'from-sky-500/20 to-blue-500/10 text-sky-400 border-sky-500/30',
      tab: 'channels',
      endpoint: '/api/channels',
      descriptor: ALL_D1_COLLECTIONS.find((c) => c.id === 'channels')!,
    },
    {
      id: 'video_categories',
      title: 'Video Categories',
      subtitle: 'Home Feeds, Rails & Category Slugs',
      count: stats?.collections?.video_categories?.total_documents ?? 0,
      icon: FolderTree,
      color: 'from-yellow-500/20 to-amber-500/10 text-yellow-400 border-yellow-500/30',
      tab: 'categories',
      endpoint: '/api/video_categories',
      descriptor: ALL_D1_COLLECTIONS.find((c) => c.id === 'video_categories')!,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Top Banner Status Bar */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-900 to-slate-950 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-orange-500/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Cloudflare Worker REST API Online
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              Cloudflare OTT Admin &amp; Creator Studio
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl leading-relaxed">
              Upload, inspect, and edit any object across all Cloudflare D1 collections directly via Cloudflare Workers. Connected to{' '}
              <a
                href={CF_WORKER_BASE_URL}
                target="_blank"
                rel="noreferrer"
                className="text-orange-400 hover:text-orange-300 font-mono text-xs underline inline-flex items-center gap-1"
              >
                {CF_WORKER_BASE_URL.replace('https://', '')}
                <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={loadStats}
              disabled={loading}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-medium rounded-xl border border-slate-700 flex items-center gap-2 transition-all shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-orange-400' : ''}`} />
              {loading ? 'Refreshing...' : 'Refresh Stats'}
            </button>
            <a
              href={`${CF_WORKER_BASE_URL}/api/stats`}
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 text-xs font-medium rounded-xl border border-orange-500/30 flex items-center gap-1.5 transition-colors"
            >
              <span>View Raw JSON</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Database Meta Badges */}
        <div className="mt-6 pt-5 border-t border-slate-800/80 flex flex-wrap items-center gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-orange-400" />
            <span>Database Engine:</span>
            <span className="font-semibold text-slate-200 font-mono">
              {stats?.database || 'Cloudflare D1'}
            </span>
          </div>
          <span className="text-slate-700">•</span>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>API Status:</span>
            <span className="capitalize font-semibold text-emerald-400">
              {stats?.status || 'Active'}
            </span>
          </div>
          <span className="text-slate-700">•</span>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-sky-400" />
            <span>Registered Users:</span>
            <span className="font-semibold text-slate-200 font-mono">
              {stats?.collections?.userdata?.total_documents?.toLocaleString() ?? '0'}
            </span>
          </div>
          {lastUpdated && (
            <>
              <span className="text-slate-700">•</span>
              <span className="text-slate-500">
                Last checked: {lastUpdated.toLocaleTimeString()}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Error Banner if any */}
      {error && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-center gap-3 text-rose-300 text-xs">
          <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
          <div className="flex-1">
            <p className="font-semibold">Failed to query Cloudflare Worker API</p>
            <p className="text-slate-400">{error}</p>
          </div>
          <button
            onClick={loadStats}
            className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 rounded-lg text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* Collection Quick Navigation & Edit Cards Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-400" />
            Live Cloudflare D1 Media Collections
          </h2>
          <span className="text-xs text-slate-500">
            Browse &amp; edit objects directly or open creator studio
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {collectionCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.id}
                className="group p-5 bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl transition-all shadow-lg hover:shadow-orange-500/5 relative overflow-hidden flex flex-col justify-between"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className={`p-3 rounded-xl bg-gradient-to-br ${card.color} border`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-black text-white font-mono">
                      {loading ? '...' : card.count}
                    </span>
                    <span className="block text-[11px] text-slate-500 uppercase tracking-wider">
                      Documents
                    </span>
                  </div>
                </div>

                <div className="mt-4 space-y-1">
                  <h3 className="font-bold text-slate-100 text-sm">{card.title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{card.subtitle}</p>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => openCollectionBrowser(card.descriptor)}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-orange-300 border border-slate-700 rounded-lg font-semibold flex items-center gap-1.5 transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>Edit Objects</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigateTab(card.tab)}
                    className="px-2.5 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-lg font-semibold transition-colors"
                  >
                    Open Studio &rarr;
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ALL 14 Cloudflare D1 Collections Table & Direct Object Browser */}
      <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              All Cloudflare D1 Database Collections ({ALL_D1_COLLECTIONS.length})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Select any collection below to inspect, edit JSON fields/objects, create new objects, or delete records live in Cloudflare D1.
            </p>
          </div>
          {activeCollection && (
            <button
              type="button"
              onClick={() => setActiveCollection(null)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium flex items-center gap-1 self-start sm:self-auto"
            >
              <X className="w-3.5 h-3.5" />
              <span>Close Object Browser</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
          {ALL_D1_COLLECTIONS.map((col) => {
            const count = stats?.collections?.[col.id]?.total_documents ?? 0;
            const isSelected = activeCollection?.id === col.id;
            return (
              <button
                key={col.id}
                type="button"
                onClick={() => openCollectionBrowser(col)}
                className={`p-3 rounded-xl border text-left transition-all flex flex-col justify-between gap-1.5 ${
                  isSelected
                    ? 'bg-orange-500/15 border-orange-500/60 shadow-lg shadow-orange-500/10'
                    : 'bg-slate-950/70 hover:bg-slate-900 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-1 w-full">
                  <span className="text-[11px] font-bold text-white truncate">{col.label}</span>
                  <Pencil className={`w-3 h-3 shrink-0 ${isSelected ? 'text-orange-400' : 'text-slate-500'}`} />
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-[10px] font-mono text-slate-500 truncate">{col.id}</span>
                  <span className="text-sm font-black font-mono text-orange-400">
                    {loading ? '…' : count.toLocaleString()}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Live Collection Object List & Editor */}
        {activeCollection && (
          <div className="mt-4 pt-4 border-t border-slate-800 space-y-4 animate-fadeIn">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">
                    {activeCollection.label} Objects
                  </h3>
                  <code className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-[11px] font-mono text-orange-300">
                    /api/{activeCollection.id}
                  </code>
                  <span className="text-xs text-slate-400 font-mono">
                    ({filteredCollectionItems.length} of {collectionItems.length})
                  </span>
                </div>
                <p className="text-xs text-slate-400">{activeCollection.description}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={collectionSearch}
                    onChange={(e) => setCollectionSearch(e.target.value)}
                    placeholder="Filter objects..."
                    className="pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-xl text-xs text-slate-200 outline-none w-48"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => openCollectionBrowser(activeCollection)}
                  disabled={loadingCollection}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-medium border border-slate-700 flex items-center gap-1"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingCollection ? 'animate-spin' : ''}`} />
                  <span>Reload</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const idKey = activeCollection.idField || 'id';
                    const template =
                      idKey === 'batchId'
                        ? { batchId: `batch_${Date.now()}`, title: 'New Batch', description: '', imageUrl: '', category: 'Web Series', isPremium: false, releaseDate: Date.now(), totalVideos: 0, videos: [] }
                        : { [idKey]: `${activeCollection.id}_${Date.now()}`, title: 'New Item' };
                    setEditingItem({ item: template, isNew: true });
                  }}
                  className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Object</span>
                </button>
              </div>
            </div>

            {collectionError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{collectionError}</span>
              </div>
            )}

            {loadingCollection ? (
              <div className="py-10 text-center text-slate-400 text-xs space-y-2">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-orange-400" />
                <p>Fetching objects from Cloudflare D1 (/api/{activeCollection.id})...</p>
              </div>
            ) : filteredCollectionItems.length === 0 ? (
              <div className="py-10 text-center text-slate-500 text-xs bg-slate-950/50 rounded-xl border border-slate-800">
                No matching objects found in {activeCollection.id}. Click &ldquo;+ New Object&rdquo; to create one.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="divide-y divide-slate-800/80 bg-slate-950/70 border border-slate-800 rounded-xl overflow-hidden">
                  {filteredCollectionItems.slice(0, visibleLimit).map((item, idx) => {
                    const objId = resolveObjectId(item, activeCollection.idField);
                    const objTitle = resolveObjectTitle(item);
                    const previewJson = JSON.stringify(item);
                    return (
                      <div
                        key={objId || idx}
                        className="p-3 hover:bg-slate-900/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-colors"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-white truncate max-w-md">
                              {objTitle}
                            </span>
                            {objId && (
                              <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 font-mono text-[10px] text-orange-300">
                                {activeCollection.idField}: {objId}
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-[11px] text-slate-400 truncate max-w-3xl">
                            {previewJson}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setEditingItem({ item, isNew: false })}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-orange-300 border border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            <span>Edit Object</span>
                          </button>
                          {objId && (
                            <button
                              type="button"
                              onClick={() => handleDeleteCollectionObject(objId)}
                              disabled={deletingKey === objId}
                              className="p-1.5 bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-500/30 rounded-lg transition-colors"
                              title="Delete object from Cloudflare D1"
                            >
                              {deletingKey === objId ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {filteredCollectionItems.length > visibleLimit && (
                  <div className="text-center pt-2">
                    <button
                      type="button"
                      onClick={() => setVisibleLimit((prev) => prev + 100)}
                      className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-medium border border-slate-700"
                    >
                      Load More ({filteredCollectionItems.length - visibleLimit} remaining)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Web URL Processor Spotlight */}
      <div className="p-6 bg-slate-900/60 border border-cyan-500/20 rounded-2xl flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400">
            <Globe className="w-4 h-4" />
            <span>Web Scraping &amp; Stream Ingestion Engine</span>
          </div>
          <h3 className="text-base font-bold text-white">
            Inspect Any Website URL &rarr; Extract Direct Video (.mp4 / .m3u8) &amp; Media Links
          </h3>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            Have a website or video page link? Use the <strong>Web Processor</strong> to crawl the site with our backend Axios &amp; Cheerio engine. Automatically extracts streaming media, cover images, OpenGraph headers, and structured metadata.
          </p>
        </div>
        <button
          onClick={() => onNavigateTab('webprocessor')}
          className="px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-xs rounded-xl shadow-lg shadow-cyan-500/20 transition-all shrink-0"
        >
          Open Web Processor &rarr;
        </button>
      </div>

      {/* Integration Workflow Spotlight: R2 Vault + Cloudflare Worker */}
      <div className="p-6 bg-slate-900/60 border border-slate-800/90 rounded-2xl flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-orange-400">
            <Film className="w-4 h-4" />
            <span>High-Speed Direct Pipeline Integration</span>
          </div>
          <h3 className="text-base font-bold text-white">
            Upload Video to Cloudflare R2 &rarr; 1-Click Sync to Worker Database
          </h3>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            Need to upload heavy MP4 video files? Use the <strong>R2 Video Vault</strong> tab to upload your videos and automatically extract 5-second thumbnails directly to Cloudflare R2 storage. Once uploaded, click <em>&ldquo;Send to Batch Video&rdquo;</em> to publish the live playback URLs directly into this Worker API!
          </p>
        </div>
        <button
          onClick={() => onNavigateTab('upload')}
          className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-semibold text-xs rounded-xl shadow-lg shadow-orange-500/20 transition-all shrink-0"
        >
          Open R2 Video Uploader &rarr;
        </button>
      </div>

      {/* Shared Object Editor Modal */}
      {editingItem && activeCollection && (
        <JsonObjectEditorModal
          isOpen={true}
          title={
            editingItem.isNew
              ? `Create New ${activeCollection.label} Object`
              : `Edit ${activeCollection.label}: ${resolveObjectTitle(editingItem.item)}`
          }
          subtitle={`POST /api/${activeCollection.id} · Collection: ${activeCollection.id}`}
          initialData={editingItem.item}
          onClose={() => setEditingItem(null)}
          onSave={handleSaveCollectionObject}
          onDelete={
            !editingItem.isNew && resolveObjectId(editingItem.item, activeCollection.idField)
              ? async () => {
                  const id = resolveObjectId(editingItem.item, activeCollection.idField);
                  await handleDeleteCollectionObject(id);
                }
              : undefined
          }
          saveLabel={editingItem.isNew ? 'Create in Cloudflare D1' : 'Save Changes to D1'}
        />
      )}
    </div>
  );
}
