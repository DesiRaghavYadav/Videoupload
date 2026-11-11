import React, { useState, useEffect } from 'react';
import {
  ChannelPayload,
  uploadToCloudflare,
  fetchFromCloudflare,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import {
  Tv,
  Send,
  RefreshCw,
  Eye,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  Layers,
  Radio,
} from 'lucide-react';

const DEFAULT_SAMPLE_CHANNEL: ChannelPayload = {
  id: Math.floor(Math.random() * 800 + 100),
  name: 'Live Cinema HD 24/7',
  imageUrl:
    'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=300&q=80',
};

export function ChannelsAdmin() {
  const [activeSubTab, setActiveSubTab] = useState<'create' | 'browse'>('create');
  const [formData, setFormData] = useState<ChannelPayload>(DEFAULT_SAMPLE_CHANNEL);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
    data?: any;
  } | null>(null);

  // Existing channels
  const [existingChannels, setExistingChannels] = useState<any[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const loadExistingChannels = async () => {
    setIsLoadingChannels(true);
    setFetchError(null);
    try {
      const data = await fetchFromCloudflare<any>('channels');
      const list = Array.isArray(data) ? data : data?.data || data?.channels || [];
      setExistingChannels(list);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to fetch live channels');
    } finally {
      setIsLoadingChannels(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'browse') {
      loadExistingChannels();
    }
  }, [activeSubTab]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitResult(null);

    const payload: ChannelPayload = {
      ...formData,
      id: Number(formData.id) || Date.now(),
      name: formData.name.trim(),
    };

    try {
      const res = await uploadToCloudflare('channels', payload);
      setSubmitResult({
        success: true,
        message: `Successfully uploaded Live Channel "${payload.name}" to Cloudflare Worker REST API!`,
        data: res,
      });
    } catch (err: any) {
      setSubmitResult({
        success: false,
        message: err.message || 'Failed to upload channel',
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
            <span className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Tv className="w-4 h-4" />
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Live TV Channels &amp; Broadcast Feeds
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Endpoint: <code className="text-sky-300 font-mono">POST /api/channels</code> &amp; <code className="text-slate-300 font-mono">GET /api/channels</code>
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 flex">
          <button
            onClick={() => setActiveSubTab('create')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'create'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Create Channel
          </button>
          <button
            onClick={() => setActiveSubTab('browse')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'browse'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Browse Channels
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
                  ...DEFAULT_SAMPLE_CHANNEL,
                  id: Math.floor(Math.random() * 800 + 100),
                })
              }
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
            >
              Load Cinema HD Sample
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

          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4 max-w-2xl">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Radio className="w-4 h-4 text-sky-400" />
              Channel Details
            </h3>

            <div className="space-y-4 text-xs">
              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Channel ID (Numeric)</label>
                <input
                  type="number"
                  required
                  value={formData.id}
                  onChange={(e) => setFormData({ ...formData, id: Number(e.target.value) })}
                  placeholder="1"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Channel Name</label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Live Cinema HD"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Channel Logo / Poster Image URL</label>
                <input
                  type="url"
                  required
                  value={formData.imageUrl}
                  onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
                  placeholder="https://example.com/channel_logo.jpg"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              {/* Logo Preview */}
              {formData.imageUrl && (
                <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800 flex items-center gap-4">
                  <div className="w-14 h-14 rounded-full overflow-hidden bg-slate-900 border border-slate-700 shrink-0">
                    <img
                      src={formData.imageUrl}
                      alt={formData.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-white block">
                      {formData.name || 'Channel Logo Preview'}
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">
                      ID #{formData.id}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-6 py-2.5 bg-gradient-to-r from-sky-500 to-blue-500 hover:from-sky-600 hover:to-blue-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg shadow-sky-500/20 flex items-center gap-2 transition-all"
              >
                <Send className={`w-4 h-4 ${isSubmitting ? 'animate-pulse' : ''}`} />
                {isSubmitting ? 'Uploading Channel...' : 'Upload Channel to Cloudflare D1'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        /* Browse Channels */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Fetched from <code className="text-slate-300 font-mono">GET /api/channels</code> ({existingChannels.length} items found)
            </p>
            <button
              onClick={loadExistingChannels}
              disabled={isLoadingChannels}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingChannels ? 'animate-spin text-sky-400' : ''}`} />
              {isLoadingChannels ? 'Loading...' : 'Reload'}
            </button>
          </div>

          {fetchError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{fetchError}</span>
            </div>
          )}

          {isLoadingChannels ? (
            <div className="py-12 text-center text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-sky-400" />
              <p>Fetching channels from Cloudflare Worker...</p>
            </div>
          ) : existingChannels.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs bg-slate-900/50 rounded-2xl border border-slate-800">
              No channels found in database. Create one above!
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {existingChannels.map((channel, idx) => (
                <div
                  key={channel.id || idx}
                  className="p-4 bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl flex flex-col items-center text-center space-y-3 transition-colors group"
                >
                  <div className="w-16 h-16 rounded-full overflow-hidden bg-slate-950 border-2 border-slate-800 group-hover:border-sky-500 transition-colors shrink-0">
                    <img
                      src={channel.imageUrl}
                      alt={channel.name}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                  </div>
                  <div className="space-y-0.5 min-w-0 w-full">
                    <h4 className="font-bold text-white text-xs truncate">
                      {channel.name}
                    </h4>
                    <span className="text-[10px] text-slate-500 font-mono block">
                      ID #{channel.id || idx + 1}
                    </span>
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
