import React, { useState } from 'react';
import {
  Play,
  Film,
  Camera,
  Copy,
  Check,
  ExternalLink,
  Download,
  Database,
  Clock,
  HardDrive,
  Maximize2,
  Sparkles,
  ShieldCheck,
  Layers,
  ArrowRight,
  FolderTree,
} from 'lucide-react';
import { ProcessedVideoResponse } from '../types';
import { JsonObjectViewer } from './JsonObjectViewer';
import { formatBytes, formatDuration } from '../utils/formatters';

interface ResultDisplayProps {
  result: ProcessedVideoResponse;
  batchResults?: ProcessedVideoResponse[];
  onUploadAnother: () => void;
  onNavigateToDatabase?: () => void;
  onNavigateToBatchVideo?: () => void;
  onNavigateToReels?: () => void;
  onNavigateToCategories?: () => void;
}

export const ResultDisplay: React.FC<ResultDisplayProps> = ({
  result,
  batchResults,
  onUploadAnother,
  onNavigateToDatabase,
  onNavigateToBatchVideo,
  onNavigateToReels,
  onNavigateToCategories,
}) => {
  // If batchResults has multiple items, allow switching between viewing the whole batch vs single video
  const isBatch = Boolean(batchResults && batchResults.length > 1);
  const [activeItem, setActiveItem] = useState<ProcessedVideoResponse>(result);
  const [copiedVideoUrl, setCopiedVideoUrl] = useState(false);
  const [copiedThumbUrl, setCopiedThumbUrl] = useState(false);
  const [viewMode, setViewMode] = useState<'batch' | 'single'>(isBatch ? 'batch' : 'single');

  const copyToClipboard = (text: string, type: 'video' | 'thumb') => {
    navigator.clipboard.writeText(text);
    if (type === 'video') {
      setCopiedVideoUrl(true);
      setTimeout(() => setCopiedVideoUrl(false), 2000);
    } else {
      setCopiedThumbUrl(true);
      setTimeout(() => setCopiedThumbUrl(false), 2000);
    }
  };

  const { metadata, cloudflareR2 } = activeItem;

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Top Banner & Quick KPI Metrics */}
      <div className="p-6 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-400 mb-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>
                {isBatch
                  ? `Batch of ${batchResults?.length} Videos Ingested & Verified Successfully`
                  : 'Video & Thumbnail Ingested & Verified Successfully'}
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight font-mono">
              {isBatch ? `Batch Ingestion (${batchResults?.length} Videos)` : metadata.exactFilename || metadata.filename}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onNavigateToBatchVideo && (
              <button
                onClick={onNavigateToBatchVideo}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 rounded-xl transition-all flex items-center gap-1.5 shadow-sm shadow-orange-500/20"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Send to Batch Video Series</span>
              </button>
            )}

            {onNavigateToReels && (
              <button
                onClick={onNavigateToReels}
                className="px-3.5 py-2 text-xs font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 rounded-xl transition-colors flex items-center gap-1.5 shadow-sm"
              >
                <Play className="w-3.5 h-3.5 text-rose-400" />
                <span>Send to Reels</span>
              </button>
            )}

            {onNavigateToCategories && (
              <button
                onClick={onNavigateToCategories}
                className="px-3.5 py-2 text-xs font-semibold text-yellow-300 bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/30 rounded-xl transition-colors flex items-center gap-1.5 shadow-sm"
              >
                <FolderTree className="w-3.5 h-3.5 text-yellow-400" />
                <span>Add to Category</span>
              </button>
            )}

            {onNavigateToDatabase && (
              <button
                onClick={onNavigateToDatabase}
                className="px-3.5 py-2 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors flex items-center gap-1.5 shadow-sm"
              >
                <Database className="w-3.5 h-3.5 text-orange-400" />
                <span>R2 Manifest</span>
              </button>
            )}

            {isBatch && (
              <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs font-medium">
                <button
                  onClick={() => setViewMode('batch')}
                  className={`px-3 py-1.5 rounded-md transition-colors ${
                    viewMode === 'batch'
                      ? 'bg-orange-500 text-white font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  All Batch Objects ({batchResults?.length})
                </button>
                <button
                  onClick={() => setViewMode('single')}
                  className={`px-3 py-1.5 rounded-md transition-colors ${
                    viewMode === 'single'
                      ? 'bg-orange-500 text-white font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Single Video Inspector
                </button>
              </div>
            )}

            <button
              onClick={onUploadAnother}
              className="px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors shadow-sm"
            >
              Upload More Videos
            </button>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
            <div className="text-[11px] text-slate-400 font-medium">
              {isBatch && viewMode === 'batch' ? 'Total Batch Videos' : 'Video File Size'}
            </div>
            <div className="text-base font-bold font-mono text-white mt-1 tabular-nums">
              {isBatch && viewMode === 'batch'
                ? `${batchResults?.length} Files`
                : metadata.fileSizeFormatted}
            </div>
            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
              {isBatch && viewMode === 'batch'
                ? formatBytes(batchResults?.reduce((acc, it) => acc + it.metadata.fileSize, 0) || 0)
                : `${metadata.fileSize.toLocaleString()} bytes`}
            </div>
          </div>

          <div className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
            <div className="text-[11px] text-slate-400 font-medium">Thumbnail Timestamp</div>
            <div className="text-base font-bold font-mono text-orange-400 mt-1 tabular-nums">
              {activeItem.captureTimestamp.toFixed(1)}s mark
            </div>
            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
              Applied consistently to all videos
            </div>
          </div>

          <div className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
            <div className="text-[11px] text-slate-400 font-medium">Exact Filename Rule</div>
            <div className="text-base font-bold font-mono text-emerald-400 mt-1 tabular-nums truncate" title={metadata.exactFilename || metadata.filename}>
              {metadata.exactFilename || metadata.filename}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
              Preserved in Cloudflare R2
            </div>
          </div>

          <div className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
            <div className="text-[11px] text-slate-400 font-medium">Storage Destination</div>
            <div className="text-base font-bold font-mono text-white mt-1 tabular-nums">
              {cloudflareR2.uploadedToCloudflareR2 ? 'Cloudflare R2' : 'Emulator'}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
              Bucket: {cloudflareR2.bucket}
            </div>
          </div>
        </div>
      </div>

      {/* If Batch Mode: Show Grid of All Uploaded Videos with Playback Links */}
      {isBatch && viewMode === 'batch' && batchResults && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-orange-400" />
              <h3 className="text-base font-semibold text-white">
                Uploaded Batch Files ({batchResults.length})
              </h3>
            </div>
            <span className="text-xs text-slate-400 font-mono">Exact names given to all files</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {batchResults.map((item, idx) => (
              <div
                key={item.id}
                onClick={() => {
                  setActiveItem(item);
                  setViewMode('single');
                }}
                className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between space-y-3 ${
                  activeItem.id === item.id
                    ? 'bg-slate-900 border-orange-500/60 shadow-lg'
                    : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="relative aspect-video rounded-lg overflow-hidden bg-black border border-slate-800">
                  <img
                    src={item.thumbnailUrl}
                    alt={item.metadata.exactFilename || item.metadata.filename}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[10px] font-mono text-orange-400 border border-white/10">
                    {item.metadata.durationFormatted}
                  </div>
                  <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[10px] font-mono text-white border border-white/10">
                    {item.captureTimestamp.toFixed(1)}s Frame
                  </div>
                </div>

                <div className="min-w-0">
                  <h4 className="text-xs font-semibold text-white font-mono truncate" title={item.metadata.exactFilename || item.metadata.filename}>
                    {item.metadata.exactFilename || item.metadata.filename}
                  </h4>
                  <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono mt-1">
                    <span>{item.metadata.fileSizeFormatted}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.metadata.resolution}</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs" onClick={(e) => e.stopPropagation()}>
                  <a
                    href={item.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-orange-400 hover:underline flex items-center gap-1 font-mono text-[11px]"
                  >
                    <span>Play Video</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>

                  <button
                    onClick={() => {
                      setActiveItem(item);
                      setViewMode('single');
                    }}
                    className="text-slate-400 hover:text-white flex items-center gap-1 text-[11px]"
                  >
                    <span>Inspect</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Combined JSON Array of all batch return objects */}
          <div className="space-y-3 pt-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <h3 className="text-base font-semibold text-white">
                  Combined Batch Return Object (JSON Array)
                </h3>
                <p className="text-xs text-slate-400">
                  Full array of all {batchResults.length} videos with exact filenames, playback URLs, thumbnail URLs, and metadata returned in object form.
                </p>
              </div>
            </div>

            <JsonObjectViewer data={batchResults} title={`batchResponseArray [${batchResults.length} items]`} />
          </div>
        </div>
      )}

      {/* Single Video View (Or individual inspector in batch mode) */}
      {(viewMode === 'single' || !isBatch) && (
        <div className="space-y-8">
          {isBatch && (
            <div className="flex items-center justify-between p-3 bg-slate-950/70 border border-slate-800 rounded-xl text-xs">
              <div className="flex items-center gap-2 text-slate-300">
                <span>Currently Inspecting:</span>
                <strong className="text-white font-mono">{metadata.exactFilename || metadata.filename}</strong>
              </div>
              <button
                onClick={() => setViewMode('batch')}
                className="text-orange-400 hover:underline font-medium"
              >
                ← Back to All Batch Videos
              </button>
            </div>
          )}

          {/* Media Playback & Thumbnail Side-by-Side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Cloudflare R2 Video Playback */}
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl flex flex-col justify-between space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Film className="w-4 h-4 text-orange-400" />
                  <h3 className="text-sm font-semibold text-white">Cloudflare R2 Video Playback</h3>
                </div>
                <span className="text-[11px] font-mono text-slate-400">{metadata.mimeType}</span>
              </div>

              <div className="relative aspect-video rounded-xl bg-black border border-slate-800 overflow-hidden shadow-inner flex items-center justify-center">
                <video
                  src={activeItem.videoUrl}
                  poster={activeItem.thumbnailUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>

              {/* URL & Quick Actions */}
              <div className="space-y-2 pt-1">
                <div className="text-[11px] text-slate-400 font-medium flex items-center justify-between">
                  <span>Playback URL (Exact Name in R2):</span>
                  <span className="font-mono text-slate-300 truncate max-w-[240px]">
                    {cloudflareR2.videoKey}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={activeItem.videoUrl}
                    className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-300 font-mono truncate select-all focus:outline-none"
                  />
                  <button
                    onClick={() => copyToClipboard(activeItem.videoUrl, 'video')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    {copiedVideoUrl ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-slate-400" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  <a
                    href={activeItem.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors shrink-0"
                    title="Open video in new tab"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* 5-Sec Thumbnail Frame */}
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl flex flex-col justify-between space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Camera className="w-4 h-4 text-orange-400" />
                  <h3 className="text-sm font-semibold text-white">
                    Thumbnail Frame ({activeItem.captureTimestamp.toFixed(1)}s)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-amber-400">
                  Target Timestamp: {activeItem.captureTimestamp.toFixed(1)}s
                </span>
              </div>

              <div className="relative aspect-video rounded-xl bg-slate-950 border border-slate-800 overflow-hidden shadow-inner flex items-center justify-center group">
                <img
                  src={activeItem.thumbnailUrl}
                  alt="Extracted frame thumbnail"
                  className="w-full h-full object-cover transition-transform group-hover:scale-[1.02] duration-300"
                />
                <div className="absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded bg-black/80 backdrop-blur-sm border border-white/10 text-[11px] font-mono text-white flex items-center gap-2">
                  <span>{metadata.thumbnailDimensions}</span>
                  <span aria-hidden="true">·</span>
                  <span>{metadata.thumbnailSizeFormatted}</span>
                </div>
              </div>

              {/* Thumbnail URL & Actions */}
              <div className="space-y-2 pt-1">
                <div className="text-[11px] text-slate-400 font-medium flex items-center justify-between">
                  <span>Thumbnail R2 URL:</span>
                  <span className="font-mono text-slate-300 truncate max-w-[240px]">
                    {cloudflareR2.thumbnailKey}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={activeItem.thumbnailUrl}
                    className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-300 font-mono truncate select-all focus:outline-none"
                  />
                  <button
                    onClick={() => copyToClipboard(activeItem.thumbnailUrl, 'thumb')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    {copiedThumbUrl ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-slate-400" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  <a
                    href={activeItem.thumbnailUrl}
                    download={`${metadata.exactFilename || metadata.filename}-thumb.jpg`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors shrink-0"
                    title="Download thumbnail image"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* Verification Audit Trail Breakdown */}
          {activeItem.verificationAudit && activeItem.verificationAudit.length > 0 && (
            <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-sm font-semibold text-white">
                    Step-by-Step Verification Audit Trail ({metadata.exactFilename || metadata.filename})
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-emerald-400 font-medium">
                  All {activeItem.verificationAudit.length} Stages Cryptographically Verified
                </span>
              </div>

              <div className="divide-y divide-slate-800/60 font-mono text-xs">
                {activeItem.verificationAudit.map((st, i) => (
                  <div key={i} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                      <span className="font-semibold text-slate-200">{st.step}</span>
                      <span className="text-slate-400 font-sans text-[11px] truncate max-w-md">
                        {st.details}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-right">
                      <span className="text-[10px] text-slate-500 font-sans">
                        {new Date(st.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-emerald-400 font-semibold text-[11px] tracking-wider bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/60">
                        {st.status} ✓
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Return Object View for Current Video */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <h3 className="text-base font-semibold text-white">
                  Individual Metadata Return Object
                </h3>
                <p className="text-xs text-slate-400">
                  Exact filename, duration, size, dimensions, and Cloudflare R2 URLs formatted in structured JSON object.
                </p>
              </div>
            </div>

            <JsonObjectViewer data={activeItem} title={`resultObject (${metadata.exactFilename || metadata.filename})`} />
          </div>
        </div>
      )}
    </div>
  );
};
