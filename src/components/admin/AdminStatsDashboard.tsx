import React, { useState, useEffect } from 'react';
import {
  CloudflareStatsResponse,
  fetchDatabaseStats,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
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
} from 'lucide-react';

interface AdminStatsDashboardProps {
  onNavigateTab: (tab: string) => void;
}

export function AdminStatsDashboard({ onNavigateTab }: AdminStatsDashboardProps) {
  const [stats, setStats] = useState<CloudflareStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

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

  const collectionCards = [
    {
      id: 'batchvideo',
      title: 'Batch Videos & Series',
      subtitle: 'OTT Web Series & Multi-Episode Batches',
      count: stats?.collections?.video_categories?.total_documents ?? 0,
      icon: Film,
      color: 'from-orange-500/20 to-amber-500/10 text-orange-400 border-orange-500/30',
      tab: 'batchvideo',
      endpoint: '/api/batchvideo',
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
              Upload, edit, and sync rich multi-media directly to your live Cloudflare D1 Database via Cloudflare Workers. Connected to{' '}
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
              {stats?.collections?.userdata?.total_documents?.toLocaleString() ?? '1,820+'}
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

      {/* Collection Quick Navigation Cards Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-400" />
            Live Cloudflare D1 Collections
          </h2>
          <span className="text-xs text-slate-500">
            Click any card to open creator upload form
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {collectionCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.id}
                onClick={() => onNavigateTab(card.tab)}
                className="group p-5 bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl transition-all cursor-pointer shadow-lg hover:shadow-orange-500/5 hover:-translate-y-0.5 relative overflow-hidden flex flex-col justify-between"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className={`p-3 rounded-xl bg-gradient-to-br ${card.color} border`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-black text-white font-mono group-hover:text-orange-400 transition-colors">
                      {loading ? '...' : card.count}
                    </span>
                    <span className="block text-[11px] text-slate-500 uppercase tracking-wider">
                      Documents
                    </span>
                  </div>
                </div>

                <div className="mt-4 space-y-1">
                  <h3 className="font-bold text-slate-100 group-hover:text-white flex items-center justify-between text-sm">
                    {card.title}
                    <span className="text-xs text-slate-500 group-hover:text-orange-400 transition-colors">
                      Upload &rarr;
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    {card.subtitle}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-500">
                  <span>POST &amp; GET {card.endpoint}</span>
                  <span className="text-emerald-400/80 font-medium">Ready</span>
                </div>
              </div>
            );
          })}
        </div>
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
    </div>
  );
}
