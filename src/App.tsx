import React, { useState, useEffect } from 'react';
import { Header, AppTabType } from './components/Header';
import { VideoUploader } from './components/VideoUploader';
import { ProcessingProgress } from './components/ProcessingProgress';
import { ResultDisplay } from './components/ResultDisplay';
import { RecentUploads } from './components/RecentUploads';
import { SchemaDocs } from './components/SchemaDocs';
import { R2SettingsModal } from './components/R2SettingsModal';
import { AppDatabaseManager } from './components/AppDatabaseManager';
import { AdminStatsDashboard } from './components/admin/AdminStatsDashboard';
import { BatchVideoAdmin } from './components/admin/BatchVideoAdmin';
import { ShortReelsAdmin } from './components/admin/ShortReelsAdmin';
import { ComicsAdmin } from './components/admin/ComicsAdmin';
import { AudioStoriesAdmin } from './components/admin/AudioStoriesAdmin';
import { ChannelsAdmin } from './components/admin/ChannelsAdmin';
import { VideoCategoriesAdmin } from './components/admin/VideoCategoriesAdmin';
import { WebProcessor } from './components/WebProcessor';
import { PageLinkExtractor } from './components/PageLinkExtractor';
import {
  R2StatusResponse,
  ProcessedVideoResponse,
  PipelineProgress,
} from './types';
import {
  fetchR2Status,
  uploadVideoAndThumbnail,
  fetchUploadHistory,
  deleteVideoRecord,
} from './utils/r2Service';
import { Cloud, ShieldCheck, HardDrive, Zap } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTabType>('dashboard');
  const [r2Status, setR2Status] = useState<R2StatusResponse | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Pipeline execution state
  const [isProcessing, setIsProcessing] = useState(false);
  const [forwardedMediaData, setForwardedMediaData] = useState<any>(null);
  const [forwardedBatchVideos, setForwardedBatchVideos] = useState<any[] | null>(null);
  const [progress, setProgress] = useState<PipelineProgress>({
    stage: 'idle',
    percent: 0,
    message: '',
    activeStepName: '',
  });

  // Current result & history records
  const [currentResult, setCurrentResult] = useState<ProcessedVideoResponse | null>(null);
  const [currentBatchResults, setCurrentBatchResults] = useState<ProcessedVideoResponse[]>([]);
  const [historyRecords, setHistoryRecords] = useState<ProcessedVideoResponse[]>([]);

  // Load status and history on initial mount
  const refreshStatusAndHistory = async () => {
    try {
      const status = await fetchR2Status();
      setR2Status(status);
    } catch (err) {
      console.warn('Could not fetch R2 status:', err);
    }

    try {
      const records = await fetchUploadHistory();
      setHistoryRecords(records);
    } catch (err) {
      console.warn('Could not fetch history:', err);
    }
  };

  useEffect(() => {
    refreshStatusAndHistory();
  }, []);

  // Handle batch video upload & thumbnail pipeline with exact filenames
  const handleStartBatchUpload = async (params: {
    items: {
      file: File;
      thumbnailBlob: Blob;
      captureTimestamp: number;
      metadata: Record<string, any>;
    }[];
    globalTimestamp: number;
    folderPrefix: string;
  }) => {
    setIsProcessing(true);
    setCurrentResult(null);
    setCurrentBatchResults([]);

    const total = params.items.length;
    const successfulUploads: ProcessedVideoResponse[] = [];

    try {
      for (let i = 0; i < total; i++) {
        const item = params.items[i];
        const videoNum = i + 1;

        // Step 1 & 2: Video validation
        setProgress({
          stage: 'validating_video',
          percent: Math.round((i / total) * 100) + 5,
          message: `Video ${videoNum}/${total}: Validating "${item.file.name}" & extracting frame at ${params.globalTimestamp.toFixed(1)}s...`,
          activeStepName: `Video ${videoNum}/${total}: ${item.file.name}`,
        });

        await new Promise((r) => setTimeout(r, 150));

        // Step 3, 4, 5: Cloudflare R2 Upload with EXACT filename & HeadObject verification
        setProgress({
          stage: 'uploading_video',
          percent: Math.round((i / total) * 100) + 15,
          message: `Video ${videoNum}/${total}: Uploading "${item.file.name}" to Cloudflare R2 with exact filename...`,
          activeStepName: `Uploading: ${item.file.name}`,
        });

        const response = await uploadVideoAndThumbnail({
          videoFile: item.file,
          thumbnailBlob: item.thumbnailBlob,
          captureTimestamp: params.globalTimestamp,
          metadata: item.metadata,
          folderPrefix: params.folderPrefix,
          onProgress: (p) => {
            const basePercent = Math.round((i / total) * 100);
            const itemSpan = Math.round(100 / total);
            const currentPercent = basePercent + Math.round((p / 100) * itemSpan);
            setProgress({
              stage: p > 70 ? 'uploading_thumbnail' : 'uploading_video',
              percent: Math.min(98, currentPercent),
              message: `Video ${videoNum}/${total}: Streaming "${item.file.name}" (${p}%)...`,
              activeStepName: `Uploading: ${item.file.name}`,
            });
          },
        });

        successfulUploads.push(response);
      }

      // Step 6: Complete
      setProgress({
        stage: 'complete',
        percent: 100,
        message: `Successfully uploaded and verified all ${total} batch videos with exact names and ${params.globalTimestamp.toFixed(1)}s thumbnails.`,
        activeStepName: 'Batch Complete',
        auditTrail: successfulUploads[successfulUploads.length - 1]?.verificationAudit,
      });

      setCurrentResult(successfulUploads[0]);
      setCurrentBatchResults(successfulUploads);
      setHistoryRecords((prev) => [
        ...successfulUploads,
        ...prev.filter((p) => !successfulUploads.some((s) => s.id === p.id)),
      ]);
    } catch (err: any) {
      console.error('Batch upload error:', err);
      setProgress({
        stage: 'error',
        percent: 100,
        message: err.message || 'Batch upload failed',
        activeStepName: err.failedStep || 'Batch Pipeline',
        failedStep: err.failedStep,
        error: err.message,
        auditTrail: err.verificationAudit,
      });
      if (successfulUploads.length > 0) {
        setCurrentResult(successfulUploads[0]);
        setCurrentBatchResults(successfulUploads);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteRecord = async (id: string) => {
    const ok = await deleteVideoRecord(id);
    if (ok) {
      setHistoryRecords((prev) => prev.filter((r) => r.id !== id));
      if (currentResult?.id === id) {
        setCurrentResult(null);
      }
    }
  };

  const handleSelectRecord = (record: ProcessedVideoResponse) => {
    setCurrentResult(record);
    setActiveTab('upload');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Bar & Section Nav */}
      <Header
        r2Status={r2Status}
        onOpenSettings={() => setIsSettingsOpen(true)}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* TAB 0: DASHBOARD & STATS */}
        {activeTab === 'dashboard' && (
          <AdminStatsDashboard onNavigateTab={(t) => setActiveTab(t as AppTabType)} />
        )}

        {/* TAB 0.5: WEB PROCESSOR & SCRAPER (AXIOS / CHEERIO) */}
        {activeTab === 'webprocessor' && (
          <WebProcessor
            onNavigateTab={(t, initialData) => {
              if (Array.isArray(initialData)) {
                setForwardedBatchVideos(initialData);
                setForwardedMediaData(null);
              } else if (initialData) {
                setForwardedMediaData(initialData);
                setForwardedBatchVideos(null);
              }
              setActiveTab(t);
            }}
          />
        )}

        {/* TAB 0.8: DEDICATED WEBPAGE URL & LINK EXTRACTOR */}
        {activeTab === 'linkextractor' && (
          <PageLinkExtractor
            onNavigateTab={(t, initialData) => {
              if (Array.isArray(initialData)) {
                setForwardedBatchVideos(initialData);
                setForwardedMediaData(null);
              } else if (initialData) {
                setForwardedMediaData(initialData);
                setForwardedBatchVideos(null);
              }
              setActiveTab(t);
            }}
          />
        )}

        {/* TAB 1: BATCH VIDEOS / WEB SERIES */}
        {activeTab === 'batchvideo' && (
          <BatchVideoAdmin recentR2Uploads={historyRecords} />
        )}

        {/* TAB 1.5: APP DATABASE MANAGER (OPTIMIZED JSON MANIFEST FOR R2) */}
        {activeTab === 'database' && (
          <AppDatabaseManager
            recentUploads={historyRecords}
            isR2Configured={Boolean(r2Status?.configured)}
          />
        )}

        {/* TAB 2: SHORT REELS */}
        {activeTab === 'reels' && (
          <ShortReelsAdmin recentR2Uploads={historyRecords} />
        )}

        {/* TAB 3: COMICS & CHAPTERS */}
        {activeTab === 'comics' && <ComicsAdmin />}

        {/* TAB 4: AUDIO STORIES */}
        {activeTab === 'stories' && <AudioStoriesAdmin />}

        {/* TAB 5: LIVE TV CHANNELS */}
        {activeTab === 'channels' && <ChannelsAdmin />}

        {/* TAB 6: VIDEO CATEGORIES */}
        {activeTab === 'categories' && (
          <VideoCategoriesAdmin
            recentR2Uploads={historyRecords}
            prefilledVideo={forwardedMediaData}
            prefilledBatchVideos={forwardedBatchVideos}
          />
        )}

        {/* TAB 7: R2 VIDEO VAULT (DIRECT STORAGE & 5S THUMBNAIL UPLOADER) */}
        {activeTab === 'upload' && (
          <div className="space-y-8">
            {/* Environment Status Notice */}
            {r2Status?.configured ? (
              <div className="p-3.5 bg-slate-900/90 border border-emerald-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-3">
                  <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <div className="space-y-0.5">
                    <span className="font-semibold text-emerald-300">
                      Cloudflare R2 Active &amp; Verified ({r2Status.source === 'server_secrets' ? 'Server Secrets Environment' : 'Browser Session'})
                    </span>
                    <p className="text-slate-400">
                      Connected to bucket <code className="text-slate-200 font-mono">{r2Status.bucket}</code> via S3 API. Read-after-write verification is active on every upload.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  View R2 Configuration
                </button>
              </div>
            ) : (
              <div className="p-4 bg-slate-900/90 border border-amber-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
                    <HardDrive className="w-4 h-4" />
                  </div>
                  <div className="space-y-0.5">
                    <span className="font-semibold text-amber-300">
                      Operating in Built-in Storage Emulator Mode
                    </span>
                    <p className="text-slate-400 leading-relaxed">
                      Videos and 5s thumbnails are processed, verified, and streamed locally with full metadata objects. To stream directly to your Cloudflare bucket, click <strong>R2 Settings</strong> or check your Secrets panel.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-3 py-1.5 text-xs font-semibold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  Configure Cloudflare R2
                </button>
              </div>
            )}

            {/* Show Result If Completed, else Show Uploader */}
            {currentResult ? (
              <ResultDisplay
                result={currentResult}
                batchResults={currentBatchResults}
                onUploadAnother={() => {
                  setCurrentResult(null);
                  setCurrentBatchResults([]);
                }}
                onNavigateToBatchVideo={() => setActiveTab('batchvideo')}
                onNavigateToCategories={() => setActiveTab('categories')}
                onNavigateToDatabase={() => setActiveTab('database')}
                onNavigateToReels={() => setActiveTab('reels')}
              />
            ) : (
              <div className="space-y-6">
                {/* Intro Section */}
                <div className="space-y-2">
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                    Cloudflare R2 Video &amp; Thumbnail Storage Vault
                  </h1>
                  <p className="text-sm text-slate-400 max-w-2xl leading-relaxed">
                    Set a shared thumbnail capture timestamp for all videos, upload single or multiple batch videos, and preserve exact file names in Cloudflare R2 storage with full metadata returned in structured object form.
                  </p>
                </div>

                {/* Uploader Component with Batch Multi-Select & Shared Timestamp */}
                <VideoUploader
                  onStartBatchUpload={handleStartBatchUpload}
                  isProcessing={isProcessing}
                  isR2Configured={Boolean(r2Status?.configured)}
                />

                {/* Pipeline Progress Indicator */}
                {isProcessing && <ProcessingProgress progress={progress} />}
              </div>
            )}

            {/* Quick Recent Records Strip if any exist */}
            {historyRecords.length > 0 && !currentResult && (
              <div className="pt-6 border-t border-slate-900">
                <RecentUploads
                  records={historyRecords.slice(0, 3)}
                  onSelectRecord={handleSelectRecord}
                  onDeleteRecord={handleDeleteRecord}
                />
              </div>
            )}
          </div>
        )}

        {/* TAB 8: VAULT RECORDS HISTORY */}
        {activeTab === 'history' && (
          <RecentUploads
            records={historyRecords}
            onSelectRecord={handleSelectRecord}
            onDeleteRecord={handleDeleteRecord}
          />
        )}

        {/* TAB 9: SCHEMA & API DOCUMENTATION */}
        {activeTab === 'docs' && <SchemaDocs />}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Cloudflare OTT Admin · Worker REST API &amp; Cloudflare D1</span>
          </div>
          <div className="flex items-center gap-4 text-slate-400">
            <button
              onClick={() => setActiveTab('docs')}
              className="hover:text-slate-200 transition-colors"
            >
              API Endpoints &amp; Schemas
            </button>
            <span aria-hidden="true">·</span>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="hover:text-slate-200 transition-colors"
            >
              R2 Storage Settings
            </button>
          </div>
        </div>
      </footer>

      {/* Cloudflare R2 Settings Modal */}
      <R2SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSaved={refreshStatusAndHistory}
      />
    </div>
  );
}
