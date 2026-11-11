import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Film,
  Camera,
  Play,
  Clock,
  HardDrive,
  Sparkles,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
  ExternalLink,
  Layers,
  Check,
  FolderOpen,
} from 'lucide-react';
import { formatBytes, formatDuration, formatDurationHuman, formatSizeMb } from '../utils/formatters';
import {
  inspectVideoFile,
  extractFrameAtTime,
  generateSampleTestVideo,
  generateBatchDemoVideos,
  ExtractedFrameResult,
  VideoAnalysisResult,
} from '../utils/videoProcessor';
import { BatchVideoItem, ProcessedVideoResponse } from '../types';

interface VideoUploaderProps {
  onStartBatchUpload: (params: {
    items: {
      file: File;
      thumbnailBlob: Blob;
      captureTimestamp: number;
      metadata: Record<string, any>;
    }[];
    globalTimestamp: number;
    folderPrefix: string;
  }) => void;
  isProcessing: boolean;
  isR2Configured: boolean;
}

export const VideoUploader: React.FC<VideoUploaderProps> = ({
  onStartBatchUpload,
  isProcessing,
  isR2Configured,
}) => {
  // Global Thumbnail Timestamp for all videos
  const [globalTimestamp, setGlobalTimestamp] = useState<number>(5.0);
  const [folderPrefix, setFolderPrefix] = useState<string>('videos');

  // Batch queue state
  const [batchItems, setBatchItems] = useState<BatchVideoItem[]>([]);
  const [isGeneratingDemo, setIsGeneratingDemo] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // When globalTimestamp changes, re-extract frames for items in queue that are not uploaded yet
  useEffect(() => {
    if (batchItems.length === 0) return;

    let isMounted = true;
    batchItems.forEach(async (item) => {
      if (item.status === 'verified') return;
      try {
        const frame = await extractFrameAtTime(item.file, globalTimestamp);
        if (isMounted) {
          setBatchItems((prev) =>
            prev.map((it) =>
              it.id === item.id
                ? {
                    ...it,
                    thumbnailDataUrl: frame.dataUrl,
                    thumbnailBlob: frame.blob,
                    actualCaptureTime: frame.timestamp,
                  }
                : it
            )
          );
        }
      } catch (err) {
        console.error('Failed to re-extract frame:', err);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [globalTimestamp]);

  // Process newly added files into the queue
  const addFilesToQueue = async (files: FileList | File[]) => {
    setErrorMessage(null);
    const newItems: BatchVideoItem[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name)) {
        const id = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${i}`;
        newItems.push({
          id,
          file,
          status: 'analyzing',
          progress: 0,
        });
      }
    }

    if (newItems.length === 0) {
      setErrorMessage('Please select valid video files (MP4, WebM, MOV, MKV).');
      return;
    }

    // Add items to state
    setBatchItems((prev) => [...prev, ...newItems]);

    // Inspect and extract frames asynchronously
    for (const item of newItems) {
      try {
        const meta = await inspectVideoFile(item.file);
        const frame = await extractFrameAtTime(item.file, globalTimestamp);

        setBatchItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: 'queued',
                  duration: meta.duration,
                  dimensions: `${meta.width}×${meta.height}`,
                  thumbnailDataUrl: frame.dataUrl,
                  thumbnailBlob: frame.blob,
                  actualCaptureTime: frame.timestamp,
                }
              : it
          )
        );
      } catch (err: any) {
        setBatchItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: 'error',
                  errorMessage: err.message || 'Inspection failed',
                }
              : it
          )
        );
      }
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGenerateSingleDemo = async () => {
    setIsGeneratingDemo(true);
    setErrorMessage(null);
    try {
      const file = await generateSampleTestVideo('Exact_Video_Demo_1', 8, 'Exact_Video_Demo_1.webm');
      addFilesToQueue([file]);
    } catch (err: any) {
      setErrorMessage('Failed to generate demo video: ' + err.message);
    } finally {
      setIsGeneratingDemo(false);
    }
  };

  const handleGenerateBatchDemo = async () => {
    setIsGeneratingDemo(true);
    setErrorMessage(null);
    try {
      const files = await generateBatchDemoVideos();
      addFilesToQueue(files);
    } catch (err: any) {
      setErrorMessage('Failed to generate batch demo videos: ' + err.message);
    } finally {
      setIsGeneratingDemo(false);
    }
  };

  const removeItem = (id: string) => {
    setBatchItems((prev) => prev.filter((it) => it.id !== id));
  };

  const clearQueue = () => {
    setBatchItems([]);
  };

  const handleStartUpload = () => {
    const readyItems = batchItems.filter((it) => it.thumbnailBlob);
    if (readyItems.length === 0) {
      setErrorMessage('Please wait for video frames to finish extracting before uploading.');
      return;
    }

    const payload = readyItems.map((item) => {
      const durSec = Math.round(
        item.duration && isFinite(item.duration) && item.duration > 0
          ? item.duration
          : ((item.file as any).explicitDuration || 5)
      );
      const sizeMb = formatSizeMb(item.file.size);
      const durationHuman = formatDurationHuman(durSec);

      return {
        file: item.file,
        thumbnailBlob: item.thumbnailBlob!,
        captureTimestamp: globalTimestamp,
        metadata: {
          exactFilename: item.file.name,
          fileSize: item.file.size,
          fileSizeFormatted: formatBytes(item.file.size),
          sizeMb,
          duration: durSec,
          durationSec: durSec,
          durationFormatted: formatDuration(durSec),
          durationHuman,
          dimensions: item.dimensions || '1920×1080',
          targetThumbnailTimeSeconds: globalTimestamp,
          actualCapturedSecond: item.actualCaptureTime || globalTimestamp,
          uploadTime: Date.now(),
        },
      };
    });

    onStartBatchUpload({
      items: payload,
      globalTimestamp,
      folderPrefix,
    });
  };

  const readyCount = batchItems.filter((it) => it.thumbnailBlob).length;

  return (
    <div className="space-y-6">
      {/* 1. Global Thumbnail Timestamp Control (Applied to all videos in batch) */}
      <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-orange-400" />
              <h3 className="text-sm font-semibold text-white">
                Global Thumbnail Capture Time
              </h3>
            </div>
            <p className="text-xs text-slate-400">
              Set the exact frame timestamp extracted for <strong>all videos</strong> in the batch upload.
            </p>
          </div>

          <div className="flex items-center gap-2 font-mono">
            <span className="text-xs text-slate-400">Capture Frame At:</span>
            <span className="text-base font-bold text-orange-400 tabular-nums">
              {globalTimestamp.toFixed(1)}s
            </span>
          </div>
        </div>

        {/* Timestamp Presets & Input */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 p-1 bg-slate-950 rounded-xl border border-slate-800">
            {[1.0, 2.0, 3.0, 5.0, 10.0].map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setGlobalTimestamp(sec)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors font-mono ${
                  globalTimestamp === sec
                    ? 'bg-orange-500 text-white shadow-sm font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-900'
                }`}
              >
                {sec.toFixed(1)}s
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Custom Second:</label>
            <input
              type="number"
              min={0.1}
              max={3600}
              step={0.1}
              value={globalTimestamp}
              onChange={(e) => setGlobalTimestamp(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              disabled={isProcessing}
              className="w-20 px-2.5 py-1.5 text-xs font-mono bg-slate-950 border border-slate-700/80 rounded-lg text-white text-center focus:outline-none focus:border-orange-500"
            />
          </div>

          <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            <FolderOpen className="w-3.5 h-3.5 text-slate-500" />
            <span>Folder Prefix:</span>
            <input
              type="text"
              value={folderPrefix}
              onChange={(e) => setFolderPrefix(e.target.value)}
              placeholder="videos (or leave empty for root)"
              className="w-28 px-2 py-1 text-xs font-mono bg-slate-950 border border-slate-700/80 rounded-lg text-slate-200 focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>

        <div className="text-[11px] text-slate-400 flex items-center justify-between">
          <span>
            ★ Exact Filename Rule: The exact original name (e.g. <code>my_video.mp4</code>) will be preserved in Cloudflare R2 as <code>{folderPrefix ? `${folderPrefix}/` : ''}my_video.mp4</code>.
          </span>
          <span className="text-slate-500">
            (If video is shorter than {globalTimestamp}s, clamps to safe midpoint)
          </span>
        </div>
      </div>

      {/* 2. Drag & Drop Zone with Multi-Select and Demo Generator */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleFileDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-2xl p-7 transition-all cursor-pointer text-center ${
          dragActive
            ? 'border-orange-500 bg-orange-500/5'
            : 'border-slate-800 hover:border-slate-700 bg-slate-900/40 hover:bg-slate-900/60'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,.mp4,.webm,.mov,.mkv,.avi"
          onChange={handleFileInputChange}
          className="hidden"
        />

        <div className="flex flex-col items-center justify-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-orange-500/10 border border-orange-500/20 text-orange-400 flex items-center justify-center">
            <Upload className="w-6 h-6" />
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-white">
              Drop batch videos here, or click to browse files
            </h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Select multiple videos simultaneously. Each video is analyzed, its thumbnail extracted at {globalTimestamp.toFixed(1)}s, uploaded to Cloudflare R2 with its <strong>exact file name</strong>, and returned in structured object form.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors shadow-sm flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5 text-orange-400" />
              <span>Select Videos (Batch Multi-Select)</span>
            </button>

            <button
              type="button"
              disabled={isGeneratingDemo || isProcessing}
              onClick={handleGenerateBatchDemo}
              className="px-4 py-2 text-xs font-semibold text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 rounded-lg transition-colors flex items-center gap-1.5"
            >
              {isGeneratingDemo ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-orange-400" />
              )}
              <span>Instant 3-Video Batch Demo</span>
            </button>
          </div>
        </div>
      </div>

      {/* 3. Batch Queue Table */}
      {batchItems.length > 0 && (
        <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-orange-400" />
              <h3 className="text-sm font-semibold text-white">
                Batch Upload Queue ({batchItems.length} Videos)
              </h3>
              <span className="text-xs text-slate-400">· Ready: {readyCount}/{batchItems.length}</span>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessing}
                className="px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                <span>Add More</span>
              </button>

              <button
                type="button"
                onClick={clearQueue}
                disabled={isProcessing}
                className="px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear Queue</span>
              </button>
            </div>
          </div>

          {/* Queue Items List */}
          <div className="divide-y divide-slate-800/60 max-h-[480px] overflow-y-auto pr-1">
            {batchItems.map((item, idx) => (
              <div
                key={item.id}
                className="py-3 flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                {/* File info and thumbnail preview */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-16 h-10 rounded-lg bg-black border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center relative">
                    {item.thumbnailDataUrl ? (
                      <img
                        src={item.thumbnailDataUrl}
                        alt="Frame"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <RefreshCw className="w-4 h-4 text-orange-400 animate-spin" />
                    )}
                    <span className="absolute bottom-0.5 right-0.5 text-[9px] font-mono bg-black/80 text-orange-400 px-1 rounded">
                      {globalTimestamp.toFixed(1)}s
                    </span>
                  </div>

                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-slate-500">0{idx + 1}.</span>
                      <h4 className="text-xs font-semibold text-white truncate max-w-xs sm:max-w-md font-mono" title={item.file.name}>
                        {item.file.name}
                      </h4>
                    </div>

                    <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                      <span>{formatBytes(item.file.size)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.duration ? formatDuration(item.duration) : 'Reading...'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.dimensions || '...'}</span>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-400">
                        Target Name: {folderPrefix ? `${folderPrefix}/` : ''}{item.file.name}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Status indicator and action */}
                <div className="flex items-center gap-3 shrink-0 self-end md:self-auto">
                  {item.status === 'queued' && (
                    <span className="px-2.5 py-1 text-[11px] font-mono text-slate-300 bg-slate-800 rounded-md border border-slate-700">
                      Ready to Upload
                    </span>
                  )}
                  {item.status === 'analyzing' && (
                    <span className="px-2.5 py-1 text-[11px] font-mono text-orange-400 bg-orange-500/10 rounded-md border border-orange-500/20 flex items-center gap-1.5">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>Extracting @ {globalTimestamp}s...</span>
                    </span>
                  )}
                  {item.status === 'uploading' && (
                    <span className="px-2.5 py-1 text-[11px] font-mono text-sky-400 bg-sky-500/10 rounded-md border border-sky-500/20 flex items-center gap-1.5">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>Uploading to R2...</span>
                    </span>
                  )}
                  {item.status === 'verified' && (
                    <span className="px-2.5 py-1 text-[11px] font-mono text-emerald-400 bg-emerald-500/10 rounded-md border border-emerald-500/20 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      <span>R2 Verified ✓</span>
                    </span>
                  )}
                  {item.status === 'error' && (
                    <span className="px-2.5 py-1 text-[11px] font-mono text-rose-400 bg-rose-500/10 rounded-md border border-rose-500/20">
                      {item.errorMessage || 'Error'}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    disabled={isProcessing}
                    className="p-1.5 text-slate-400 hover:text-rose-400 rounded transition-colors"
                    title="Remove from batch"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Batch Submission Bar */}
          <div className="pt-3 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-orange-400" />
              <span>
                Upload Target: <strong className="text-white">{isR2Configured ? 'Live Cloudflare R2' : 'Local Emulator'}</strong> · Exact Filename Preservation: <strong className="text-emerald-400">Enforced</strong>
              </span>
            </div>

            <button
              type="button"
              onClick={handleStartUpload}
              disabled={isProcessing || readyCount === 0}
              className="px-6 py-3 text-sm font-semibold text-white bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 rounded-xl transition-all shadow-lg shadow-orange-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Upload className="w-4 h-4" />
              <span>
                {isProcessing
                  ? 'Processing Batch...'
                  : `Upload All (${batchItems.length} Videos) to Cloudflare R2`}
              </span>
            </button>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="p-3.5 bg-rose-950/40 border border-rose-800 rounded-xl text-xs text-rose-300 flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
