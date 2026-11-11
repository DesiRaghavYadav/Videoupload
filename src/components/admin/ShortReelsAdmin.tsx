import React, { useState, useEffect } from 'react';
import {
  ShortReelPayload,
  uploadToCloudflare,
  fetchFromCloudflare,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import { ProcessedVideoResponse } from '../../types';
import {
  PlaySquare,
  Send,
  RefreshCw,
  Heart,
  Eye,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Sparkles,
  ExternalLink,
  Play,
  Flame,
} from 'lucide-react';

interface ShortReelsAdminProps {
  recentR2Uploads?: ProcessedVideoResponse[];
}

const DEFAULT_SAMPLE_REEL: ShortReelPayload = {
  id: Math.floor(Math.random() * 900 + 100),
  title: 'Viral Dance Moves: Stage Flash',
  description: 'Trending high-energy live stage dance sequence with electrifying choreography.',
  imageUrl:
    'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80',
  videoUrl:
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  likesCount: '12.5k',
  isLiked: 0,
  createdAt: Date.now(),
};

export function ShortReelsAdmin({ recentR2Uploads = [] }: ShortReelsAdminProps) {
  const [activeSubTab, setActiveSubTab] = useState<'create' | 'browse'>('create');
  const [formData, setFormData] = useState<ShortReelPayload>(DEFAULT_SAMPLE_REEL);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
    data?: any;
  } | null>(null);

  // Existing reels
  const [existingReels, setExistingReels] = useState<any[]>([]);
  const [isLoadingReels, setIsLoadingReels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Playing reel modal
  const [activeVideoModal, setActiveVideoModal] = useState<string | null>(null);

  const loadExistingReels = async () => {
    setIsLoadingReels(true);
    setFetchError(null);
    try {
      const data = await fetchFromCloudflare<any>('reels');
      const list = Array.isArray(data) ? data : data?.data || data?.reels || [];
      setExistingReels(list);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to fetch short reels');
    } finally {
      setIsLoadingReels(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'browse') {
      loadExistingReels();
    }
  }, [activeSubTab]);

  const handleUseR2Video = (rec: ProcessedVideoResponse) => {
    setFormData((prev) => ({
      ...prev,
      title:
        rec.metadata?.exactFilename?.replace(/\.[^/.]+$/, '') ||
        rec.metadata?.filename ||
        prev.title,
      videoUrl: rec.videoUrl,
      imageUrl: rec.thumbnailUrl,
      description: `Short reel from Cloudflare R2 Vault (${rec.metadata?.exactFilename || rec.metadata?.filename})`,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitResult(null);

    const payload: ShortReelPayload = {
      ...formData,
      id: Number(formData.id) || Date.now(),
      likesCount: formData.likesCount || '10.5k',
      isLiked: formData.isLiked ? 1 : 0,
      createdAt: Number(formData.createdAt) || Date.now(),
    };

    try {
      const res = await uploadToCloudflare('reels', payload);
      setSubmitResult({
        success: true,
        message: `Successfully uploaded Short Reel "${payload.title}" to Cloudflare Worker REST API!`,
        data: res,
      });
    } catch (err: any) {
      setSubmitResult({
        success: false,
        message: err.message || 'Failed to upload short reel',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <PlaySquare className="w-4 h-4" />
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Short Reels &amp; Viral Clips Studio
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Endpoint: <code className="text-rose-300 font-mono">POST /api/reels</code> &amp; <code className="text-slate-300 font-mono">GET /api/reels</code>
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 flex">
          <button
            onClick={() => setActiveSubTab('create')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'create'
                ? 'bg-rose-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Create Reel
          </button>
          <button
            onClick={() => setActiveSubTab('browse')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'browse'
                ? 'bg-rose-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Browse Reels
          </button>
        </div>
      </div>

      {activeSubTab === 'create' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Form */}
          <div className="lg:col-span-2 space-y-6">
            {/* Quick Actions Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-900/80 border border-slate-800 rounded-xl text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400 font-medium">Quick Preset:</span>
                <button
                  type="button"
                  onClick={() =>
                    setFormData({
                      ...DEFAULT_SAMPLE_REEL,
                      id: Math.floor(Math.random() * 900 + 100),
                    })
                  }
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                >
                  Load Viral Dance Sample
                </button>
              </div>

              {recentR2Uploads.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500 text-[11px]">Insert R2:</span>
                  <select
                    onChange={(e) => {
                      const selected = recentR2Uploads.find((r) => r.id === e.target.value);
                      if (selected) handleUseR2Video(selected);
                    }}
                    defaultValue=""
                    className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-orange-300 outline-none"
                  >
                    <option value="" disabled>Select Uploaded R2 Video</option>
                    {recentR2Uploads.map((rec) => (
                      <option key={rec.id} value={rec.id}>
                        {rec.metadata?.exactFilename || rec.metadata?.filename}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Submission Status Banner */}
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
                    <pre className="mt-2 p-2 bg-slate-950/80 rounded font-mono text-[11px] text-slate-300 overflow-x-auto">
                      {JSON.stringify(submitResult.data, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Reel ID (Numeric)</label>
                  <input
                    type="number"
                    required
                    value={formData.id}
                    onChange={(e) => setFormData({ ...formData, id: Number(e.target.value) })}
                    placeholder="101"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Reel Title</label>
                  <input
                    type="text"
                    required
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="Viral Dance Moves"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-100 text-xs outline-none"
                  />
                </div>

                <div className="sm:col-span-2 space-y-1.5">
                  <label className="text-slate-300 font-semibold">Video Playback Stream URL</label>
                  <input
                    type="url"
                    required
                    value={formData.videoUrl}
                    onChange={(e) => setFormData({ ...formData, videoUrl: e.target.value })}
                    placeholder="https://pub-...r2.dev/videos/clip1.mp4"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                  />
                </div>

                <div className="sm:col-span-2 space-y-1.5">
                  <label className="text-slate-300 font-semibold">Thumbnail / Cover Image URL</label>
                  <input
                    type="url"
                    required
                    value={formData.imageUrl}
                    onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
                    placeholder="https://pub-...r2.dev/thumbnails/clip1.jpg"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Likes Display Count</label>
                  <input
                    type="text"
                    value={formData.likesCount}
                    onChange={(e) => setFormData({ ...formData, likesCount: e.target.value })}
                    placeholder="12.5k"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-100 text-xs outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Initial Like Status</label>
                  <div className="flex items-center gap-3 pt-2">
                    <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={Boolean(formData.isLiked)}
                        onChange={(e) =>
                          setFormData({ ...formData, isLiked: e.target.checked ? 1 : 0 })
                        }
                        className="rounded accent-rose-500 w-4 h-4"
                      />
                      <span>Mark Liked by Default</span>
                    </label>
                  </div>
                </div>

                <div className="sm:col-span-2 space-y-1.5">
                  <label className="text-slate-300 font-semibold">Description / Hashtags</label>
                  <textarea
                    rows={2}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Trending stage reel performance #viral #dance"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-rose-500 rounded-lg text-slate-100 text-xs outline-none"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-6 py-2.5 bg-gradient-to-r from-rose-500 to-pink-500 hover:from-rose-600 hover:to-pink-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg shadow-rose-500/20 flex items-center gap-2 transition-all"
                >
                  <Send className={`w-4 h-4 ${isSubmitting ? 'animate-pulse' : ''}`} />
                  {isSubmitting ? 'Uploading Reel...' : 'Upload Reel to Cloudflare D1'}
                </button>
              </div>
            </form>
          </div>

          {/* Interactive Mobile Reel Simulator Preview */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-rose-400" />
              Live Vertical Reel Frame Preview
            </h3>

            <div className="w-full max-w-[280px] mx-auto aspect-[9/16] bg-slate-950 rounded-3xl border-4 border-slate-800 shadow-2xl relative overflow-hidden flex flex-col justify-between p-4">
              {/* Background video or thumbnail */}
              {formData.videoUrl ? (
                <video
                  src={formData.videoUrl}
                  poster={formData.imageUrl}
                  className="absolute inset-0 w-full h-full object-cover"
                  controls
                  playsInline
                />
              ) : formData.imageUrl ? (
                <img
                  src={formData.imageUrl}
                  alt={formData.title}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">
                  No video or image URL
                </div>
              )}

              {/* Top Bar Overlay */}
              <div className="relative z-10 flex items-center justify-between text-white/80 text-[11px] font-semibold drop-shadow">
                <span className="flex items-center gap-1 bg-black/40 px-2 py-0.5 rounded-full backdrop-blur-sm">
                  <Flame className="w-3 h-3 text-rose-400" />
                  Trending Reel
                </span>
                <span className="font-mono text-[10px]">#{formData.id}</span>
              </div>

              {/* Right Action Icons Overlay */}
              <div className="relative z-10 self-end space-y-3 flex flex-col items-center">
                <div className="flex flex-col items-center gap-1">
                  <div className="w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm border border-white/20 flex items-center justify-center text-rose-400">
                    <Heart className="w-4 h-4 fill-current" />
                  </div>
                  <span className="text-[10px] text-white font-bold drop-shadow">
                    {formData.likesCount || '0'}
                  </span>
                </div>
              </div>

              {/* Bottom Caption Overlay */}
              <div className="relative z-10 space-y-1 text-white drop-shadow">
                <h4 className="font-bold text-xs line-clamp-1">{formData.title}</h4>
                <p className="text-[10px] text-slate-200 line-clamp-2 leading-relaxed">
                  {formData.description}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Browse Existing Reels */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Fetched from <code className="text-slate-300 font-mono">GET /api/reels</code> ({existingReels.length} items found)
            </p>
            <button
              onClick={loadExistingReels}
              disabled={isLoadingReels}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingReels ? 'animate-spin text-rose-400' : ''}`} />
              {isLoadingReels ? 'Loading...' : 'Reload'}
            </button>
          </div>

          {fetchError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{fetchError}</span>
            </div>
          )}

          {isLoadingReels ? (
            <div className="py-12 text-center text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-rose-400" />
              <p>Fetching short reels from Cloudflare Worker...</p>
            </div>
          ) : existingReels.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs bg-slate-900/50 rounded-2xl border border-slate-800">
              No reels found. Create your first reel above!
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {existingReels.map((reel, idx) => (
                <div
                  key={reel.id || reel._id || idx}
                  className="group bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-xl overflow-hidden flex flex-col justify-between transition-all"
                >
                  <div className="aspect-[9/16] bg-slate-950 relative overflow-hidden">
                    <img
                      src={reel.imageUrl}
                      alt={reel.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent opacity-80" />

                    {reel.videoUrl && (
                      <button
                        onClick={() => setActiveVideoModal(reel.videoUrl)}
                        className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40"
                      >
                        <div className="w-10 h-10 rounded-full bg-rose-500 text-white flex items-center justify-center shadow-lg">
                          <Play className="w-5 h-5 fill-current ml-0.5" />
                        </div>
                      </button>
                    )}

                    <div className="absolute bottom-2 left-2 right-2 text-white">
                      <div className="flex items-center gap-1 text-[10px] text-rose-400 font-bold mb-1">
                        <Heart className="w-3 h-3 fill-current" />
                        <span>{reel.likesCount || '10k'}</span>
                      </div>
                      <h4 className="font-bold text-xs line-clamp-2 leading-tight">
                        {reel.title}
                      </h4>
                    </div>
                  </div>

                  <div className="p-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-500 font-mono">
                    <span>ID #{reel.id || idx + 1}</span>
                    <a
                      href={reel.videoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-400 hover:text-white"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Video Modal */}
      {activeVideoModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full overflow-hidden shadow-2xl space-y-3 p-4">
            <div className="flex justify-between items-center text-xs">
              <span className="font-bold text-white">Reel Player</span>
              <button
                onClick={() => setActiveVideoModal(null)}
                className="text-slate-400 hover:text-white px-2 py-0.5 bg-slate-800 rounded"
              >
                Close
              </button>
            </div>
            <div className="aspect-[9/16] bg-black rounded-xl overflow-hidden">
              <video
                src={activeVideoModal}
                controls
                autoPlay
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
