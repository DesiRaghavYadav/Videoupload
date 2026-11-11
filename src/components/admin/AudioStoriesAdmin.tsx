import React, { useState, useEffect } from 'react';
import {
  AudioStoryPayload,
  uploadToCloudflare,
  fetchFromCloudflare,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import {
  Headphones,
  Send,
  RefreshCw,
  Eye,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  Layers,
  Volume2,
  Clock,
  Music,
} from 'lucide-react';

const DEFAULT_SAMPLE_STORY: AudioStoryPayload = {
  id: Math.floor(Math.random() * 800 + 100),
  title: 'The Haunted Cabin: Whispers in the Pines',
  category: 'Horror & Mystery',
  imageUrl:
    'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80',
  content:
    'Deep in the dense mountain woods lies a secluded timber cabin abandoned for decades. On foggy autumn evenings, hikers report acoustic echoes that defy explanation...',
  audioUrl:
    'https://commondatastorage.googleapis.com/codeskulptor-demos/DDR_assets/Kangaroo_MusiQue_-_The_Neverending_Story.mp3',
  duration: '18 min',
  isPremium: 0,
  releaseDate: Date.now(),
};

export function AudioStoriesAdmin() {
  const [activeSubTab, setActiveSubTab] = useState<'create' | 'browse'>('create');
  const [formData, setFormData] = useState<AudioStoryPayload>(DEFAULT_SAMPLE_STORY);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
    data?: any;
  } | null>(null);

  // Existing stories
  const [existingStories, setExistingStories] = useState<any[]>([]);
  const [isLoadingStories, setIsLoadingStories] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const loadExistingStories = async () => {
    setIsLoadingStories(true);
    setFetchError(null);
    try {
      const data = await fetchFromCloudflare<any>('stories');
      const list = Array.isArray(data) ? data : data?.data || data?.stories || [];
      setExistingStories(list);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to fetch audio stories');
    } finally {
      setIsLoadingStories(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'browse') {
      loadExistingStories();
    }
  }, [activeSubTab]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitResult(null);

    const payload: AudioStoryPayload = {
      ...formData,
      id: Number(formData.id) || Date.now(),
      isPremium: formData.isPremium ? 1 : 0,
      releaseDate: Number(formData.releaseDate) || Date.now(),
    };

    try {
      const res = await uploadToCloudflare('stories', payload);
      setSubmitResult({
        success: true,
        message: `Successfully uploaded Audio Story "${payload.title}" to Cloudflare Worker REST API!`,
        data: res,
      });
    } catch (err: any) {
      setSubmitResult({
        success: false,
        message: err.message || 'Failed to upload audio story',
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
            <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Headphones className="w-4 h-4" />
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Audio Stories &amp; Podcasts Studio
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Endpoint: <code className="text-emerald-300 font-mono">POST /api/stories</code> &amp; <code className="text-slate-300 font-mono">GET /api/stories</code>
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 flex">
          <button
            onClick={() => setActiveSubTab('create')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'create'
                ? 'bg-emerald-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Create Audio Story
          </button>
          <button
            onClick={() => setActiveSubTab('browse')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'browse'
                ? 'bg-emerald-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Browse Stories
          </button>
        </div>
      </div>

      {activeSubTab === 'create' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Quick Preset Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-900/80 border border-slate-800 rounded-xl text-xs">
            <span className="text-slate-400 font-medium">Quick Preset:</span>
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...DEFAULT_SAMPLE_STORY,
                  id: Math.floor(Math.random() * 800 + 100),
                })
              }
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
            >
              Load Haunted Cabin Sample
            </button>
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
                  <pre className="mt-2 p-2 bg-slate-950/80 rounded font-mono text-[11px] text-slate-300 overflow-x-auto">
                    {JSON.stringify(submitResult.data, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}

          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              Audio Story Details
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Story ID (Numeric)</label>
                <input
                  type="number"
                  required
                  value={formData.id}
                  onChange={(e) => setFormData({ ...formData, id: Number(e.target.value) })}
                  placeholder="1"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Story Title</label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="The Haunted Cabin"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Genre / Category</label>
                <input
                  type="text"
                  required
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  placeholder="Horror &amp; Mystery"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              <div className="md:col-span-2 space-y-1.5">
                <label className="text-slate-300 font-semibold">Audio Stream URL (MP3 / AAC / M4A)</label>
                <input
                  type="url"
                  required
                  value={formData.audioUrl}
                  onChange={(e) => setFormData({ ...formData, audioUrl: e.target.value })}
                  placeholder="https://example.com/audio/ep1.mp3"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Duration String</label>
                <input
                  type="text"
                  value={formData.duration}
                  onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                  placeholder="18 min"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              <div className="md:col-span-2 space-y-1.5">
                <label className="text-slate-300 font-semibold">Cover Artwork URL</label>
                <input
                  type="url"
                  required
                  value={formData.imageUrl}
                  onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
                  placeholder="https://example.com/cover.jpg"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Access Level</label>
                <div className="pt-2">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={Boolean(formData.isPremium)}
                      onChange={(e) =>
                        setFormData({ ...formData, isPremium: e.target.checked ? 1 : 0 })
                      }
                      className="rounded accent-emerald-500 w-4 h-4"
                    />
                    <span>VIP Premium Story</span>
                  </label>
                </div>
              </div>

              <div className="md:col-span-3 space-y-1.5">
                <label className="text-slate-300 font-semibold">Story Narrative Content / Synopsis</label>
                <textarea
                  rows={3}
                  value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  placeholder="Deep in the woods lies a secret..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              {/* Live Audio Player Test Preview */}
              {formData.audioUrl && (
                <div className="md:col-span-3 p-3 bg-slate-950/80 rounded-xl border border-slate-800 space-y-2">
                  <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5" />
                    Audio Stream Playback Test:
                  </span>
                  <audio
                    src={formData.audioUrl}
                    controls
                    className="w-full h-8 outline-none"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg shadow-emerald-500/20 flex items-center gap-2 transition-all"
              >
                <Send className={`w-4 h-4 ${isSubmitting ? 'animate-pulse' : ''}`} />
                {isSubmitting ? 'Uploading Story...' : 'Upload Audio Story to Cloudflare D1'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        /* Browse Stories */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Fetched from <code className="text-slate-300 font-mono">GET /api/stories</code> ({existingStories.length} items found)
            </p>
            <button
              onClick={loadExistingStories}
              disabled={isLoadingStories}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingStories ? 'animate-spin text-emerald-400' : ''}`} />
              {isLoadingStories ? 'Loading...' : 'Reload'}
            </button>
          </div>

          {fetchError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{fetchError}</span>
            </div>
          )}

          {isLoadingStories ? (
            <div className="py-12 text-center text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-400" />
              <p>Fetching audio stories from Cloudflare Worker...</p>
            </div>
          ) : existingStories.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs bg-slate-900/50 rounded-2xl border border-slate-800">
              No audio stories found in database. Create one above!
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {existingStories.map((story, idx) => (
                <div
                  key={story.id || idx}
                  className="p-4 bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl space-y-3 transition-colors flex flex-col justify-between"
                >
                  <div className="flex gap-3">
                    {story.imageUrl && (
                      <div className="w-20 h-20 rounded-xl overflow-hidden bg-slate-950 shrink-0">
                        <img
                          src={story.imageUrl}
                          alt={story.title}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      </div>
                    )}
                    <div className="space-y-1 flex-1 min-w-0">
                      <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wider">
                        {story.category || 'Audio Story'}
                      </span>
                      <h4 className="font-bold text-white text-sm line-clamp-1">
                        {story.title}
                      </h4>
                      <p className="text-xs text-slate-400 line-clamp-2">
                        {story.content}
                      </p>
                    </div>
                  </div>

                  {story.audioUrl && (
                    <div className="pt-2">
                      <audio
                        src={story.audioUrl}
                        controls
                        className="w-full h-7 outline-none"
                      />
                    </div>
                  )}

                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500 font-mono">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      {story.duration || 'N/A'}
                    </span>
                    <span>ID #{story.id || idx + 1}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
