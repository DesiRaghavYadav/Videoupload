import React, { useState, useEffect } from 'react';
import {
  Database,
  Cloud,
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  Download,
  Plus,
  Trash2,
  Sparkles,
  RefreshCw,
  Layers,
  FileCode,
  ShieldCheck,
  Film,
  Calendar,
  Lock,
} from 'lucide-react';
import {
  AppOptimizedBatchDatabase,
  AppOptimizedVideo,
  ProcessedVideoResponse,
  SaveDatabaseResponse,
} from '../types';
import { JsonObjectViewer } from './JsonObjectViewer';
import {
  saveDatabaseToR2,
  fetchSavedDatabases,
  deleteSavedDatabase,
} from '../utils/r2Service';
import { formatDurationHuman, formatSizeMb } from '../utils/formatters';

interface AppDatabaseManagerProps {
  recentUploads: ProcessedVideoResponse[];
  isR2Configured: boolean;
}

export function mapUploadsToOptimizedVideos(uploads: ProcessedVideoResponse[]): AppOptimizedVideo[] {
  return uploads.map((rec, i) => {
    const cleanFileName = (
      rec.metadata?.exactFilename ||
      rec.metadata?.filename ||
      `Episode_${i + 1}`
    )
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim();

    const title = cleanFileName.toLowerCase().startsWith('episode')
      ? cleanFileName
      : `Episode ${i + 1}: ${cleanFileName}`;

    const durSec = Math.round(
      Number(
        rec.durationSec !== undefined && rec.durationSec !== null
          ? rec.durationSec
          : rec.metadata?.durationSec !== undefined && rec.metadata?.durationSec !== null
          ? rec.metadata.durationSec
          : rec.metadata?.duration || 0
      )
    );

    const durationStr =
      rec.duration ||
      rec.metadata?.durationHuman ||
      formatDurationHuman(durSec);

    const rawSize = rec.sizeMb !== undefined && rec.sizeMb !== null ? rec.sizeMb : rec.metadata?.sizeMb;
    const sizeMb =
      rawSize !== undefined && Number(rawSize) > 0
        ? Number(rawSize)
        : formatSizeMb(rec.metadata?.fileSize || 0);

    const uploadTime = Number(
      rec.uploadTime !== undefined && rec.uploadTime !== null
        ? rec.uploadTime
        : rec.metadata?.uploadTime || Date.now()
    );

    return {
      id: i + 1,
      videoIndex: i + 1,
      title,
      videoUrl: rec.videoUrl,
      imageUrl: rec.thumbnailUrl,
      duration: durationStr,
      description: `Video asset from ${rec.metadata?.exactFilename || rec.metadata?.filename || `video_${i + 1}`}`,
      uploadTime,
      durationSec: durSec,
      sizeMb,
    };
  });
}

export function buildOptimizedDatabaseFromUploads(uploads: ProcessedVideoResponse[]): AppOptimizedBatchDatabase {
  const videos = mapUploadsToOptimizedVideos(uploads);
  const rawFirstTitle = videos[0]?.title?.replace(/^Episode \d+:\s*/, '') || 'Series';
  return {
    batchId: `batch_${Date.now().toString(36)}`,
    title: `${rawFirstTitle} (Batch Series)`,
    description: `Collection of ${videos.length} video(s) uploaded to Cloudflare R2 storage with extracted thumbnail frames.`,
    imageUrl: videos[0]?.imageUrl || '',
    category: 'Action & Drama',
    isPremium: true,
    releaseDate: Date.now(),
    totalVideos: videos.length,
    videos,
  };
}

export const AppDatabaseManager: React.FC<AppDatabaseManagerProps> = ({
  recentUploads,
  isR2Configured,
}) => {
  // User's default optimized schema template
  const defaultTemplate: AppOptimizedBatchDatabase = {
    batchId: 'crime_syndicate_s01',
    title: 'Midnight Shadows: The Syndicate',
    description:
      'An undercover agent gets embroiled in a clandestine web of deceit and high-octane confrontations across the city.',
    imageUrl:
      'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?auto=format&fit=crop&w=800&q=80',
    category: 'Crime Thriller',
    isPremium: true,
    releaseDate: 1730900000000,
    totalVideos: 2,
    videos: [
      {
        id: 1,
        videoIndex: 1,
        title: 'Episode 1: The Informant',
        videoUrl:
          'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        imageUrl:
          'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?auto=format&fit=crop&w=600&q=80',
        duration: '22 min',
        description: 'A covert asset goes dark in the industrial district.',
        uploadTime: 1730900000000,
        durationSec: 1320,
        sizeMb: 185.5,
      },
      {
        id: 2,
        videoIndex: 2,
        title: 'Episode 2: Point of No Return',
        videoUrl:
          'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
        imageUrl:
          'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80',
        duration: '24 min',
        description: 'The squad raids the abandoned harbor warehouse.',
        uploadTime: 1730986400000,
        durationSec: 1440,
        sizeMb: 210.0,
      },
    ],
  };

  const [dbData, setDbData] = useState<AppOptimizedBatchDatabase>(() =>
    recentUploads && recentUploads.length > 0
      ? buildOptimizedDatabaseFromUploads(recentUploads)
      : defaultTemplate
  );
  const [userEdited, setUserEdited] = useState(false);
  const [savedBatches, setSavedBatches] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveDatabaseResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedDbUrl, setCopiedDbUrl] = useState(false);

  // Sync with recentUploads if user hasn't customized
  useEffect(() => {
    if (recentUploads.length > 0 && !userEdited) {
      setDbData(buildOptimizedDatabaseFromUploads(recentUploads));
    }
  }, [recentUploads, userEdited]);

  // Load saved databases from Cloudflare R2 on mount
  const loadSavedBatches = async () => {
    try {
      const batches = await fetchSavedDatabases();
      setSavedBatches(batches);
    } catch (e) {
      console.warn('Failed to fetch saved databases:', e);
    }
  };

  useEffect(() => {
    loadSavedBatches();
  }, []);

  // Update top-level field
  const handleFieldChange = (
    field: keyof AppOptimizedBatchDatabase,
    value: any
  ) => {
    setDbData((prev) => ({
      ...prev,
      [field]: value,
    }));
    setSaveResult(null);
  };

  // Update specific video in the database
  const handleVideoFieldChange = (
    index: number,
    field: keyof AppOptimizedVideo,
    value: any
  ) => {
    setDbData((prev) => {
      const updated = [...prev.videos];
      updated[index] = {
        ...updated[index],
        [field]: value,
      };
      return {
        ...prev,
        videos: updated,
        totalVideos: updated.length,
      };
    });
    setSaveResult(null);
  };

  // Add new video row
  const handleAddVideo = () => {
    setDbData((prev) => {
      const nextIndex = prev.videos.length + 1;
      const newVideo: AppOptimizedVideo = {
        id: nextIndex,
        videoIndex: nextIndex,
        title: `Episode ${nextIndex}: Untitled`,
        videoUrl: '',
        imageUrl: '',
        duration: '10 min',
        description: '',
        uploadTime: Date.now(),
        durationSec: 600,
        sizeMb: 100.0,
      };
      const updated = [...prev.videos, newVideo];
      return {
        ...prev,
        videos: updated,
        totalVideos: updated.length,
      };
    });
  };

  // Remove video row
  const handleRemoveVideo = (index: number) => {
    setDbData((prev) => {
      const updated = prev.videos.filter((_, idx) => idx !== index);
      // Re-index remaining videos
      const reindexed = updated.map((v, i) => ({
        ...v,
        id: i + 1,
        videoIndex: i + 1,
      }));
      return {
        ...prev,
        videos: reindexed,
        totalVideos: reindexed.length,
      };
    });
  };

  // Auto-populate from uploaded videos in this session
  const handlePopulateFromUploads = () => {
    if (recentUploads.length === 0) {
      setErrorMessage('No videos uploaded yet in this session to import.');
      return;
    }

    const mappedVideos = mapUploadsToOptimizedVideos(recentUploads);

    setDbData((prev) => ({
      ...prev,
      imageUrl: recentUploads[0]?.thumbnailUrl || prev.imageUrl,
      totalVideos: mappedVideos.length,
      videos: mappedVideos,
    }));

    setUserEdited(true);
    setErrorMessage(null);
    setSaveResult(null);
  };

  // Save to Cloudflare R2
  const handleSaveToR2 = async () => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const result = await saveDatabaseToR2(dbData);
      setSaveResult(result);
      await loadSavedBatches();
    } catch (err: any) {
      console.error('Error saving database:', err);
      setErrorMessage(err.message || 'Failed to save database to Cloudflare R2');
    } finally {
      setIsSaving(false);
    }
  };

  // Delete saved database
  const handleDeleteBatch = async (batchId: string) => {
    const ok = await deleteSavedDatabase(batchId);
    if (ok) {
      setSavedBatches((prev) => prev.filter((b) => b.batchId !== batchId));
    }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedDbUrl(true);
    setTimeout(() => setCopiedDbUrl(false), 2000);
  };

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header Banner */}
      <div className="p-6 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-orange-400" />
              <h2 className="text-xl font-bold text-white tracking-tight">
                App-Optimized Database Manifest for Cloudflare
              </h2>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              Format, generate, and persist your structured series and batch database directly to Cloudflare R2. Produces a public CDN JSON endpoint optimized for streaming mobile, web, and TV clients.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handlePopulateFromUploads}
              className="px-3.5 py-2 text-xs font-semibold text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 rounded-xl transition-colors flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-orange-400" />
              <span>Import Uploaded Videos ({recentUploads.length})</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDbData(defaultTemplate);
                setSaveResult(null);
              }}
              className="px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors"
            >
              Load Example Template
            </button>
          </div>
        </div>
      </div>

      {/* Save Success Alert Banner */}
      {saveResult && (
        <div className="p-5 bg-emerald-950/40 border border-emerald-800/80 rounded-2xl shadow-xl space-y-3 animate-fadeIn">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-emerald-900/50">
            <div className="flex items-center gap-2 text-emerald-300 text-sm font-semibold">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <span>Database Successfully Saved to Cloudflare R2 Storage!</span>
            </div>
            <span className="text-[11px] font-mono text-emerald-400 font-medium">
              Key: {saveResult.databaseKey}
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">
              Cloudflare R2 Public Database URL (Ready for app ingestion):
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={saveResult.databaseUrl}
                className="w-full px-3.5 py-2 text-xs font-mono bg-slate-950 border border-emerald-800/70 rounded-lg text-emerald-300 select-all focus:outline-none"
              />
              <button
                onClick={() => copyUrl(saveResult.databaseUrl)}
                className="px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
              >
                {copiedDbUrl ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-400" />
                    <span>Copy URL</span>
                  </>
                )}
              </button>
              <a
                href={saveResult.databaseUrl}
                target="_blank"
                rel="noreferrer"
                className="p-2 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors shrink-0"
                title="View JSON in new tab"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="p-4 bg-rose-950/40 border border-rose-800 rounded-xl text-xs text-rose-300 flex items-center gap-2">
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Editor & JSON Preview Two-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        {/* Left Column: Form Editor */}
        <div className="p-6 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-orange-400" />
              <span>Series / Batch Manifest Metadata</span>
            </h3>
            <span className="text-xs font-mono text-slate-400">
              Total Videos: {dbData.videos.length}
            </span>
          </div>

          <div className="space-y-4 text-xs">
            {/* Batch ID & Title */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-slate-300 mb-1">
                  Batch ID (Unique Identifier)
                </label>
                <input
                  type="text"
                  value={dbData.batchId}
                  onChange={(e) => handleFieldChange('batchId', e.target.value)}
                  placeholder="e.g. crime_syndicate_s01"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-orange-500"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={dbData.title}
                  onChange={(e) => handleFieldChange('title', e.target.value)}
                  placeholder="e.g. Midnight Shadows: The Syndicate"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-xs focus:outline-none focus:border-orange-500"
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block font-medium text-slate-300 mb-1">
                Description / Synopsis
              </label>
              <textarea
                rows={2}
                value={dbData.description}
                onChange={(e) => handleFieldChange('description', e.target.value)}
                placeholder="Brief synopsis..."
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-xs focus:outline-none focus:border-orange-500"
              />
            </div>

            {/* Poster Image URL */}
            <div>
              <label className="block font-medium text-slate-300 mb-1">
                Cover Image URL (Poster / Thumbnail)
              </label>
              <input
                type="text"
                value={dbData.imageUrl}
                onChange={(e) => handleFieldChange('imageUrl', e.target.value)}
                placeholder="https://pub-xxxxxx.r2.dev/thumbnails/..."
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-orange-500"
              />
            </div>

            {/* Category, Premium, Release Date */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block font-medium text-slate-300 mb-1">Category</label>
                <input
                  type="text"
                  value={dbData.category}
                  onChange={(e) => handleFieldChange('category', e.target.value)}
                  placeholder="e.g. Crime Thriller"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-xs focus:outline-none focus:border-orange-500"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Access Level</label>
                <select
                  value={dbData.isPremium ? 'premium' : 'free'}
                  onChange={(e) => handleFieldChange('isPremium', e.target.value === 'premium')}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-xs focus:outline-none focus:border-orange-500"
                >
                  <option value="premium">Premium (isPremium: true)</option>
                  <option value="free">Free (isPremium: false)</option>
                </select>
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Release Timestamp</label>
                <input
                  type="number"
                  value={dbData.releaseDate}
                  onChange={(e) => handleFieldChange('releaseDate', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-orange-500"
                />
              </div>
            </div>

            {/* Videos List */}
            <div className="pt-4 border-t border-slate-800 space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">
                  Episodes / Videos Array ({dbData.videos.length})
                </span>
                <button
                  type="button"
                  onClick={handleAddVideo}
                  className="px-2.5 py-1 text-[11px] font-medium text-orange-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Episode</span>
                </button>
              </div>

              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                {dbData.videos.map((vid, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-mono text-[10px] font-bold">
                          #{vid.videoIndex}
                        </span>
                        <input
                          type="text"
                          value={vid.title}
                          onChange={(e) => handleVideoFieldChange(idx, 'title', e.target.value)}
                          placeholder="Episode title"
                          className="font-semibold text-white bg-transparent border-b border-transparent hover:border-slate-700 focus:border-orange-500 focus:outline-none px-1"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRemoveVideo(idx)}
                        className="text-slate-500 hover:text-rose-400 transition-colors p-1"
                        title="Remove episode"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-400">Video Playback URL</label>
                        <input
                          type="text"
                          value={vid.videoUrl}
                          onChange={(e) => handleVideoFieldChange(idx, 'videoUrl', e.target.value)}
                          placeholder="https://pub-xxxxxx.r2.dev/videos/..."
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-200 font-mono text-[11px] focus:outline-none focus:border-orange-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400">Thumbnail URL</label>
                        <input
                          type="text"
                          value={vid.imageUrl}
                          onChange={(e) => handleVideoFieldChange(idx, 'imageUrl', e.target.value)}
                          placeholder="https://pub-xxxxxx.r2.dev/thumbnails/..."
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-200 font-mono text-[11px] focus:outline-none focus:border-orange-500"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-400">Duration (Display)</label>
                        <input
                          type="text"
                          value={vid.duration}
                          onChange={(e) => handleVideoFieldChange(idx, 'duration', e.target.value)}
                          placeholder="e.g. 22 min"
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-200 text-[11px] focus:outline-none focus:border-orange-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400">Duration (Sec)</label>
                        <input
                          type="number"
                          value={vid.durationSec}
                          onChange={(e) =>
                            handleVideoFieldChange(idx, 'durationSec', Number(e.target.value))
                          }
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-200 font-mono text-[11px] focus:outline-none focus:border-orange-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400">Size (MB)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={vid.sizeMb}
                          onChange={(e) =>
                            handleVideoFieldChange(idx, 'sizeMb', parseFloat(e.target.value) || 0)
                          }
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-200 font-mono text-[11px] focus:outline-none focus:border-orange-500"
                        />
                      </div>
                    </div>

                    <div>
                      <input
                        type="text"
                        value={vid.description}
                        onChange={(e) => handleVideoFieldChange(idx, 'description', e.target.value)}
                        placeholder="Episode summary..."
                        className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-300 text-[11px] focus:outline-none focus:border-orange-500"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Save Button */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleSaveToR2}
                disabled={isSaving || !dbData.batchId}
                className="w-full py-3 px-4 text-sm font-semibold text-white bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 rounded-xl transition-all shadow-lg shadow-orange-500/25 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isSaving ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Cloud className="w-4 h-4" />
                )}
                <span>
                  {isSaving
                    ? 'Saving to Cloudflare R2...'
                    : 'Save Database to Cloudflare R2 Storage'}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: JSON Object Viewer */}
        <div className="space-y-6">
          <JsonObjectViewer
            data={dbData}
            title={`App-Optimized Schema: ${dbData.batchId || 'database'}.json`}
          />

          {/* Saved Cloudflare Databases List */}
          {savedBatches.length > 0 && (
            <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" />
                  <span>Persisted Cloudflare Databases ({savedBatches.length})</span>
                </h4>
                <span className="text-xs text-slate-400">Available on R2 CDN</span>
              </div>

              <div className="divide-y divide-slate-800/60">
                {savedBatches.map((b) => (
                  <div
                    key={b.batchId}
                    className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-white font-mono flex items-center gap-2">
                        <span>{b.batchId}</span>
                        <span className="text-[10px] text-slate-400 font-sans font-normal">
                          ({b.totalVideos} videos · {b.category})
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 truncate max-w-sm font-mono mt-0.5">
                        {b.r2DatabaseUrl}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <a
                        href={b.r2DatabaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2.5 py-1 text-[11px] font-medium text-orange-400 hover:text-white bg-slate-800 rounded-lg border border-slate-700 transition-colors flex items-center gap-1"
                      >
                        <span>Open JSON</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <button
                        onClick={() => handleDeleteBatch(b.batchId)}
                        className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                        title="Delete manifest"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
