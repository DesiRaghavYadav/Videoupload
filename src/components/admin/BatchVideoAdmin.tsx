import React, { useState, useEffect } from 'react';
import {
  BatchVideoPayload,
  BatchVideoEpisode,
  uploadToCloudflare,
  fetchFromCloudflare,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import { ProcessedVideoResponse } from '../../types';
import { formatDurationHuman, formatSizeMb } from '../../utils/formatters';
import {
  Film,
  Plus,
  Trash2,
  Send,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Layers,
  Clock,
  HardDrive,
  Eye,
  AlertCircle,
  CheckCircle2,
  ListVideo,
  FileJson,
} from 'lucide-react';

interface BatchVideoAdminProps {
  recentR2Uploads?: ProcessedVideoResponse[];
}

export function mapR2UploadsToEpisodes(uploads: ProcessedVideoResponse[]): BatchVideoEpisode[] {
  return uploads.map((rec, idx) => {
    // 1. durationSec: check rec.durationSec, rec.metadata?.durationSec, rec.metadata?.duration
    const durSec = Math.round(
      Number(
        rec.durationSec !== undefined && rec.durationSec !== null
          ? rec.durationSec
          : rec.metadata?.durationSec !== undefined && rec.metadata?.durationSec !== null
          ? rec.metadata.durationSec
          : rec.metadata?.duration || 0
      )
    );

    // 2. duration formatted: check rec.duration, rec.metadata?.durationHuman, formatDurationHuman(durSec)
    const durationHuman =
      rec.duration ||
      rec.metadata?.durationHuman ||
      formatDurationHuman(durSec);

    // 3. sizeMb: check rec.sizeMb, rec.metadata?.sizeMb, or formatSizeMb(rec.metadata?.fileSize)
    const rawSize = rec.sizeMb !== undefined && rec.sizeMb !== null ? rec.sizeMb : rec.metadata?.sizeMb;
    const sizeMb =
      rawSize !== undefined && Number(rawSize) > 0
        ? Number(rawSize)
        : formatSizeMb(rec.metadata?.fileSize || 0);

    // 4. uploadTime: check rec.uploadTime, rec.metadata?.uploadTime
    const uploadTime = Number(
      rec.uploadTime !== undefined && rec.uploadTime !== null
        ? rec.uploadTime
        : rec.metadata?.uploadTime || Date.now()
    );

    // 5. title: exact filename without extension
    const cleanFileName = (
      rec.metadata?.exactFilename ||
      rec.metadata?.filename ||
      `Episode_${idx + 1}`
    )
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim();

    const title = cleanFileName.toLowerCase().startsWith('episode')
      ? cleanFileName
      : `Episode ${idx + 1}: ${cleanFileName}`;

    return {
      videoIndex: idx + 1,
      title,
      videoUrl: rec.videoUrl,
      imageUrl: rec.thumbnailUrl,
      duration: durationHuman,
      description: `Imported from Cloudflare R2 Vault (${rec.metadata?.exactFilename || rec.metadata?.filename || `video_${idx + 1}`})`,
      uploadTime,
      durationSec: durSec,
      sizeMb,
    };
  });
}

function buildBatchPayloadFromUploads(uploads: ProcessedVideoResponse[]): BatchVideoPayload {
  const episodes = mapR2UploadsToEpisodes(uploads);
  const rawFirstTitle = episodes[0]?.title?.replace(/^Episode \d+:\s*/, '') || 'Web Series';
  return {
    batchId: `batch_${Date.now().toString(36)}`,
    title: `${rawFirstTitle} (Batch Series)`,
    description: `Series containing ${episodes.length} video(s) uploaded to Cloudflare R2 storage with synchronized thumbnail captures.`,
    imageUrl: episodes[0]?.imageUrl || '',
    category: 'Web Series',
    isPremium: true,
    releaseDate: Date.now(),
    totalVideos: episodes.length,
    videos: episodes,
  };
}

const DEFAULT_SAMPLE_BATCH: BatchVideoPayload = {
  batchId: `crime_syndicate_s0${Math.floor(Math.random() * 90 + 10)}`,
  title: 'Midnight Shadows: The Syndicate',
  description:
    'An undercover agent gets embroiled in a clandestine web of deceit and high-octane confrontations across the city.',
  imageUrl:
    'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?auto=format&fit=crop&w=800&q=80',
  category: 'Crime Thriller',
  isPremium: true,
  releaseDate: Date.now(),
  totalVideos: 2,
  videos: [
    {
      videoIndex: 1,
      title: 'Episode 1: The Informant',
      videoUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      imageUrl:
        'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?auto=format&fit=crop&w=600&q=80',
      duration: '22 min',
      description: 'A covert asset goes dark in the industrial district.',
      uploadTime: Date.now() - 86400000,
      durationSec: 1320,
      sizeMb: 185.5,
    },
    {
      videoIndex: 2,
      title: 'Episode 2: Point of No Return',
      videoUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      imageUrl:
        'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80',
      duration: '24 min',
      description: 'The squad raids the abandoned harbor warehouse.',
      uploadTime: Date.now(),
      durationSec: 1440,
      sizeMb: 210.0,
    },
  ],
};

export function BatchVideoAdmin({ recentR2Uploads = [] }: BatchVideoAdminProps) {
  const [activeSubTab, setActiveSubTab] = useState<'create' | 'browse'>('create');
  const [formData, setFormData] = useState<BatchVideoPayload>(() =>
    recentR2Uploads.length > 0
      ? buildBatchPayloadFromUploads(recentR2Uploads)
      : DEFAULT_SAMPLE_BATCH
  );
  const [userHasEdited, setUserHasEdited] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
    data?: any;
  } | null>(null);

  // Existing batches from Worker API
  const [existingBatches, setExistingBatches] = useState<any[]>([]);
  const [isLoadingBatches, setIsLoadingBatches] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // JSON Preview modal / section
  const [showJsonPreview, setShowJsonPreview] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  // Selected batch for detail modal
  const [selectedBatchDetails, setSelectedBatchDetails] = useState<any | null>(null);

  // Automatically update form when new R2 uploads arrive unless user explicitly edited
  useEffect(() => {
    if (recentR2Uploads.length > 0 && !userHasEdited) {
      setFormData(buildBatchPayloadFromUploads(recentR2Uploads));
    }
  }, [recentR2Uploads, userHasEdited]);

  const loadExistingBatches = async () => {
    setIsLoadingBatches(true);
    setFetchError(null);
    try {
      const data = await fetchFromCloudflare<any>('batchvideo');
      // Sometimes workers return array or nested arrays:
      const flattened = Array.isArray(data)
        ? data.flat(2)
        : data?.data || data?.batches || [];
      setExistingBatches(flattened);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to fetch existing batch videos');
    } finally {
      setIsLoadingBatches(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'browse') {
      loadExistingBatches();
    }
  }, [activeSubTab]);

  const handleAddEpisode = () => {
    setUserHasEdited(true);
    const nextIndex = formData.videos.length + 1;
    const newEp: BatchVideoEpisode = {
      videoIndex: nextIndex,
      title: `Episode ${nextIndex}: Untitled`,
      videoUrl: '',
      imageUrl: '',
      duration: '5 min',
      description: `Episode ${nextIndex} synopsis...`,
      uploadTime: Date.now(),
      durationSec: 300,
      sizeMb: 50.0,
    };
    setFormData((prev) => ({
      ...prev,
      totalVideos: prev.videos.length + 1,
      videos: [...prev.videos, newEp],
    }));
  };

  const handleRemoveEpisode = (index: number) => {
    setUserHasEdited(true);
    setFormData((prev) => {
      const filtered = prev.videos.filter((_, i) => i !== index);
      const reindexed = filtered.map((ep, idx) => ({
        ...ep,
        videoIndex: idx + 1,
      }));
      return {
        ...prev,
        totalVideos: reindexed.length,
        videos: reindexed,
      };
    });
  };

  const handleEpisodeChange = (
    index: number,
    field: keyof BatchVideoEpisode,
    value: any
  ) => {
    setUserHasEdited(true);
    setFormData((prev) => {
      const updated = [...prev.videos];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, videos: updated };
    });
  };

  const handleImportR2Videos = () => {
    if (!recentR2Uploads || recentR2Uploads.length === 0) {
      alert('No recent R2 uploads found. Upload videos first in the R2 Video Vault tab.');
      return;
    }

    const importedEpisodes = mapR2UploadsToEpisodes(recentR2Uploads);
    setFormData((prev) => ({
      ...prev,
      imageUrl: prev.imageUrl || importedEpisodes[0]?.imageUrl || '',
      totalVideos: importedEpisodes.length,
      videos: importedEpisodes,
    }));
    setUserHasEdited(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitResult(null);

    const payload: BatchVideoPayload = {
      ...formData,
      batchId: formData.batchId.trim(),
      title: formData.title.trim(),
      totalVideos: formData.videos.length,
      releaseDate: Number(formData.releaseDate) || Date.now(),
      videos: formData.videos.map((ep, idx) => ({
        ...ep,
        videoIndex: idx + 1,
        durationSec: Number(ep.durationSec) || 60,
        sizeMb: Number(ep.sizeMb) || 1,
        uploadTime: Number(ep.uploadTime) || Date.now(),
      })),
    };

    try {
      const res = await uploadToCloudflare('batchvideo', payload);
      setSubmitResult({
        success: true,
        message: `Successfully uploaded Batch Video "${payload.title}" (ID: ${payload.batchId}) to Cloudflare Worker REST API!`,
        data: res,
      });
    } catch (err: any) {
      setSubmitResult({
        success: false,
        message: err.message || 'Failed to upload batch video to Cloudflare Worker',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyJsonToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(formData, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Sub-Header & Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-orange-500/10 text-orange-400 border border-orange-500/20">
              <Film className="w-4 h-4" />
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Batch Videos &amp; Web Series Manager
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Endpoint: <code className="text-orange-300 font-mono">POST /api/batchvideo</code> &amp; <code className="text-slate-300 font-mono">GET /api/batchvideo</code>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 flex">
            <button
              onClick={() => setActiveSubTab('create')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                activeSubTab === 'create'
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Upload / Editor
            </button>
            <button
              onClick={() => setActiveSubTab('browse')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                activeSubTab === 'browse'
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Browse Live Batches
            </button>
          </div>
        </div>
      </div>

      {activeSubTab === 'create' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Quick Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-900/80 border border-slate-800 rounded-xl text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">Quick Actions:</span>
              <button
                type="button"
                onClick={() => setFormData(DEFAULT_SAMPLE_BATCH)}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
              >
                Load Crime Syndicate Sample
              </button>
              {recentR2Uploads.length > 0 && (
                <button
                  type="button"
                  onClick={handleImportR2Videos}
                  className="px-2.5 py-1 rounded bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/30 transition-colors font-medium flex items-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Import {recentR2Uploads.length} R2 Uploaded Videos
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowJsonPreview(!showJsonPreview)}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5"
              >
                <FileJson className="w-3.5 h-3.5 text-orange-400" />
                {showJsonPreview ? 'Hide JSON' : 'Inspect JSON'}
              </button>
              <button
                type="button"
                onClick={copyJsonToClipboard}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5"
              >
                {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedJson ? 'Copied' : 'Copy Payload'}
              </button>
            </div>
          </div>

          {/* Submission Feedback Banner */}
          {submitResult && (
            <div
              className={`p-4 rounded-xl border flex items-start gap-3 text-xs ${
                submitResult.success
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              }`}
            >
              {submitResult.success ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1 flex-1">
                <p className="font-bold">{submitResult.message}</p>
                {submitResult.data && (
                  <pre className="mt-2 p-2.5 bg-slate-950/80 rounded-lg font-mono text-[11px] text-slate-300 overflow-x-auto max-h-40">
                    {JSON.stringify(submitResult.data, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* JSON Preview Drawer if toggled */}
          {showJsonPreview && (
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono text-orange-400">POST /api/batchvideo Payload</span>
                <span>{formData.videos.length} Episodes</span>
              </div>
              <pre className="p-3 bg-slate-900/90 rounded-lg text-xs font-mono text-emerald-400 overflow-x-auto max-h-64">
                {JSON.stringify(formData, null, 2)}
              </pre>
            </div>
          )}

          {/* Series Meta Card */}
          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4 text-orange-400" />
              Series Information
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">
                  Batch ID <span className="text-orange-400 font-normal">(Unique Slug)</span>
                </label>
                <input
                  type="text"
                  required
                  value={formData.batchId}
                  onChange={(e) => setFormData({ ...formData, batchId: e.target.value })}
                  placeholder="e.g. crime_syndicate_s01"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Series Title</label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="e.g. Midnight Shadows: The Syndicate"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Category</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 text-xs outline-none"
                >
                  <option value="Crime Thriller">Crime Thriller</option>
                  <option value="Action &amp; Adventure">Action &amp; Adventure</option>
                  <option value="Drama">Drama</option>
                  <option value="Romance">Romance</option>
                  <option value="Horror &amp; Mystery">Horror &amp; Mystery</option>
                  <option value="Stage Dance">Stage Dance</option>
                  <option value="Freshly Added Now!">Freshly Added Now!</option>
                  <option value="Comedy">Comedy</option>
                  <option value="Sci-Fi">Sci-Fi</option>
                </select>
              </div>

              <div className="md:col-span-2 space-y-1.5">
                <label className="text-slate-300 font-semibold">Series Poster Image URL</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    required
                    value={formData.imageUrl}
                    onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
                    placeholder="https://example.com/poster.jpg"
                    className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 text-xs outline-none font-mono"
                  />
                  {formData.imageUrl && (
                    <a
                      href={formData.imageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 shrink-0"
                    >
                      <Eye className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Access Level</label>
                <div className="flex items-center gap-3 pt-1.5">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={Boolean(formData.isPremium)}
                      onChange={(e) =>
                        setFormData({ ...formData, isPremium: e.target.checked })
                      }
                      className="rounded accent-orange-500 w-4 h-4"
                    />
                    <span>Premium Exclusive (VIP Only)</span>
                  </label>
                </div>
              </div>

              <div className="md:col-span-3 space-y-1.5">
                <label className="text-slate-300 font-semibold">Description / Synopsis</label>
                <textarea
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Enter overall web series synopsis..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>
            </div>
          </div>

          {/* Episodes List Section */}
          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <ListVideo className="w-4 h-4 text-orange-400" />
                  Episodes &amp; Video Playlist ({formData.videos.length})
                </h3>
                <p className="text-xs text-slate-400">
                  Total Videos: <span className="font-semibold text-white">{formData.videos.length}</span>
                </p>
              </div>

              <button
                type="button"
                onClick={handleAddEpisode}
                className="px-3 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors self-start sm:self-auto"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Episode
              </button>
            </div>

            <div className="space-y-3">
              {formData.videos.map((ep, idx) => (
                <div
                  key={idx}
                  className="p-4 bg-slate-950/70 border border-slate-800 hover:border-slate-700 rounded-xl space-y-3 transition-colors"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30 flex items-center justify-center font-bold text-xs">
                        {idx + 1}
                      </span>
                      <span className="font-semibold text-white text-xs">
                        {ep.title || `Episode ${idx + 1}`}
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={formData.videos.length <= 1}
                      onClick={() => handleRemoveEpisode(idx)}
                      className="p-1 text-slate-500 hover:text-rose-400 disabled:opacity-30 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="space-y-1">
                      <label className="text-slate-400">Episode Title</label>
                      <input
                        type="text"
                        value={ep.title}
                        onChange={(e) => handleEpisodeChange(idx, 'title', e.target.value)}
                        placeholder="e.g. Episode 1: The Informant"
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 text-xs"
                      />
                    </div>

                    <div className="md:col-span-2 space-y-1">
                      <label className="text-slate-400">Video Playback Stream URL</label>
                      <input
                        type="url"
                        required
                        value={ep.videoUrl}
                        onChange={(e) => handleEpisodeChange(idx, 'videoUrl', e.target.value)}
                        placeholder="https://pub-...r2.dev/videos/ep1.mp4"
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 font-mono text-xs"
                      />
                    </div>

                    <div className="md:col-span-2 space-y-1">
                      <label className="text-slate-400">Thumbnail Frame Image URL</label>
                      <input
                        type="url"
                        required
                        value={ep.imageUrl}
                        onChange={(e) => handleEpisodeChange(idx, 'imageUrl', e.target.value)}
                        placeholder="https://pub-...r2.dev/thumbnails/ep1.jpg"
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 font-mono text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <label className="text-slate-400">Duration</label>
                        <input
                          type="text"
                          value={ep.duration}
                          onChange={(e) => handleEpisodeChange(idx, 'duration', e.target.value)}
                          placeholder="22 min"
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-400">Duration (Sec)</label>
                        <input
                          type="number"
                          value={ep.durationSec}
                          onChange={(e) =>
                            handleEpisodeChange(idx, 'durationSec', Number(e.target.value))
                          }
                          placeholder="1320"
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-400">Size (MB)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={ep.sizeMb}
                          onChange={(e) =>
                            handleEpisodeChange(idx, 'sizeMb', Number(e.target.value))
                          }
                          placeholder="185.5"
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 text-xs font-mono"
                        />
                      </div>
                    </div>

                    <div className="md:col-span-3 space-y-1">
                      <label className="text-slate-400">Episode Synopsis</label>
                      <input
                        type="text"
                        value={ep.description}
                        onChange={(e) => handleEpisodeChange(idx, 'description', e.target.value)}
                        placeholder="Brief scene description..."
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-orange-500 rounded text-slate-100 text-xs"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Submit Action Button */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg shadow-orange-500/20 flex items-center gap-2 transition-all"
            >
              <Send className={`w-4 h-4 ${isSubmitting ? 'animate-pulse' : ''}`} />
              {isSubmitting ? 'Uploading to Cloudflare D1...' : 'Upload Series to Cloudflare Database'}
            </button>
          </div>
        </form>
      ) : (
        /* Live Batches Browser */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Fetched from <code className="text-slate-300 font-mono">GET /api/batchvideo</code> ({existingBatches.length} items found)
            </p>
            <button
              onClick={loadExistingBatches}
              disabled={isLoadingBatches}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingBatches ? 'animate-spin text-orange-400' : ''}`} />
              {isLoadingBatches ? 'Loading...' : 'Reload'}
            </button>
          </div>

          {fetchError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{fetchError}</span>
            </div>
          )}

          {isLoadingBatches ? (
            <div className="py-12 text-center text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-orange-400" />
              <p>Fetching batches from Cloudflare Workers...</p>
            </div>
          ) : existingBatches.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs bg-slate-900/50 rounded-2xl border border-slate-800">
              No batch videos found in database. Use the Upload tab to add one!
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {existingBatches.map((batch, index) => {
                const epCount = Array.isArray(batch.videos)
                  ? batch.videos.length
                  : batch.totalVideos || 0;
                return (
                  <div
                    key={batch.batchId || batch.id || index}
                    className="p-4 bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl space-y-3 transition-colors flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      {batch.imageUrl && (
                        <div className="h-36 w-full rounded-xl overflow-hidden bg-slate-950 relative">
                          <img
                            src={batch.imageUrl}
                            alt={batch.title}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                          <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-slate-900/90 backdrop-blur-md text-[10px] font-semibold text-orange-300 border border-slate-700">
                            {batch.category || 'Series'}
                          </div>
                          {batch.isPremium ? (
                            <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-bold text-[10px]">
                              VIP
                            </div>
                          ) : null}
                        </div>
                      )}

                      <div className="space-y-1">
                        <span className="text-[10px] font-mono text-slate-500">
                          {batch.batchId || batch.id}
                        </span>
                        <h4 className="font-bold text-white text-sm line-clamp-1">
                          {batch.title || batch.name || 'Untitled Batch'}
                        </h4>
                        <p className="text-xs text-slate-400 line-clamp-2">
                          {batch.description}
                        </p>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                      <span className="font-medium text-slate-300">
                        {epCount} {epCount === 1 ? 'Episode' : 'Episodes'}
                      </span>
                      <button
                        onClick={() => setSelectedBatchDetails(batch)}
                        className="text-orange-400 hover:text-orange-300 font-medium flex items-center gap-1 text-[11px]"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Inspect Details
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Detail Modal */}
      {selectedBatchDetails && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-bold text-white text-sm">
                Batch Record: {selectedBatchDetails.title}
              </h3>
              <button
                onClick={() => setSelectedBatchDetails(null)}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 bg-slate-800 rounded"
              >
                Close
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-4 text-xs">
              <pre className="p-3 bg-slate-950 rounded-xl font-mono text-emerald-400 text-xs overflow-x-auto">
                {JSON.stringify(selectedBatchDetails, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
