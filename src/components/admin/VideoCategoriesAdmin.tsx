import React, { useState, useEffect } from 'react';
import {
  VideoCategory,
  VideoItem,
  getCategories,
  createCategory,
  addVideoToCategory,
  addBatchVideosToCategory,
  removeVideoFromCategory,
  uploadToCloudflare,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import { ProcessedVideoResponse } from '../../types';
import {
  FolderTree,
  Plus,
  Trash2,
  Send,
  RefreshCw,
  Eye,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  Layers,
  Film,
  Sparkles,
  Star,
  Heart,
  Lock,
  Play,
  FileJson,
  Monitor,
  Smartphone,
  ChevronRight,
  ListPlus,
  ArrowRight,
  CheckCheck,
} from 'lucide-react';

interface VideoCategoriesAdminProps {
  recentR2Uploads?: ProcessedVideoResponse[];
  prefilledVideo?: {
    title?: string;
    description?: string;
    imageUrl?: string;
    reelsUrl?: string;
    isPremium?: boolean;
    rating?: number;
    likesCount?: string;
    categoryId?: string;
  } | null;
  prefilledBatchVideos?: Array<{
    title: string;
    description?: string;
    imageUrl?: string;
    reelsUrl?: string;
    isPremium?: boolean;
    rating?: number;
    likesCount?: string;
  }> | null;
}

export function VideoCategoriesAdmin({
  recentR2Uploads = [],
  prefilledVideo = null,
  prefilledBatchVideos = null,
}: VideoCategoriesAdminProps) {
  // Navigation tabs: 'add-video' | 'create-category' | 'browse'
  const [activeTab, setActiveTab] = useState<'add-video' | 'create-category' | 'browse'>('add-video');

  // Categories state from GET /api/video_categories
  const [categories, setCategories] = useState<VideoCategory[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // TAB 1: Create Category State
  const [newCatName, setNewCatName] = useState('');
  const [newCatId, setNewCatId] = useState('');
  const [isCustomId, setIsCustomId] = useState(false);
  const [newCatIsPortrait, setNewCatIsPortrait] = useState(false);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);

  // TAB 2: Add Video State
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [videoInputMode, setVideoInputMode] = useState<'single' | 'batch'>('single');

  // Single video form
  const [singleVideo, setSingleVideo] = useState<{
    title: string;
    description: string;
    imageUrl: string;
    reelsUrl: string;
    isPremium: boolean;
    rating: number;
    likesCount: string;
    additionalCategoryIds: string[];
  }>({
    title: '',
    description: '',
    imageUrl: '',
    reelsUrl: '',
    isPremium: false,
    rating: 4.8,
    likesCount: '12k',
    additionalCategoryIds: [],
  });

  // Batch videos form
  const [batchVideos, setBatchVideos] = useState<
    Array<{
      tempKey: string;
      title: string;
      description: string;
      imageUrl: string;
      reelsUrl: string;
      isPremium: boolean;
      rating: number;
      likesCount: string;
    }>
  >([]);

  // Feedback states
  const [isSavingVideo, setIsSavingVideo] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'warning' | 'error';
    message: string;
    details?: any;
    skippedItems?: Array<{ video: Partial<VideoItem>; reason: string }>;
  } | null>(null);

  // Inspector modal
  const [inspectCategory, setInspectCategory] = useState<VideoCategory | null>(null);
  const [copiedJson, setCopiedJson] = useState(false);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);

  // Fetch categories on mount
  const loadCategories = async (preferredSelectId?: string) => {
    setIsLoadingCategories(true);
    setFetchError(null);
    try {
      const data = await getCategories();
      setCategories(data);
      if (data.length > 0) {
        if (preferredSelectId && data.some((c) => c.id === preferredSelectId)) {
          setSelectedCategoryId(preferredSelectId);
        } else if (!selectedCategoryId || !data.some((c) => c.id === selectedCategoryId)) {
          setSelectedCategoryId(data[0].id);
        }
      }
    } catch (err: any) {
      setFetchError(err.message || 'Failed to fetch video categories from Cloudflare Worker');
    } finally {
      setIsLoadingCategories(false);
    }
  };

  useEffect(() => {
    loadCategories();
  }, []);

  // Populate single video form if prefilledVideo is passed
  useEffect(() => {
    if (prefilledVideo) {
      setSingleVideo((prev) => ({
        ...prev,
        title: prefilledVideo.title || prev.title,
        description: prefilledVideo.description !== undefined ? prefilledVideo.description : prev.description,
        imageUrl: prefilledVideo.imageUrl || prev.imageUrl,
        reelsUrl: prefilledVideo.reelsUrl || prev.reelsUrl,
        isPremium: prefilledVideo.isPremium !== undefined ? prefilledVideo.isPremium : prev.isPremium,
        rating: prefilledVideo.rating || prev.rating,
        likesCount: prefilledVideo.likesCount || prev.likesCount,
      }));
      if (prefilledVideo.categoryId) {
        setSelectedCategoryId(prefilledVideo.categoryId);
      }
      setActiveTab('add-video');
      setVideoInputMode('single');
    }
  }, [prefilledVideo]);

  // Populate batch video form if prefilledBatchVideos array is passed from WebProcessor
  useEffect(() => {
    if (prefilledBatchVideos && prefilledBatchVideos.length > 0) {
      setBatchVideos(
        prefilledBatchVideos.map((v, idx) => ({
          tempKey: `prefilled_${Date.now()}_${idx}`,
          title: v.title,
          description: v.description || '',
          imageUrl: v.imageUrl || '',
          reelsUrl: v.reelsUrl || '',
          isPremium: Boolean(v.isPremium),
          rating: v.rating || 4.8,
          likesCount: v.likesCount || '12k',
        }))
      );
      setActiveTab('add-video');
      setVideoInputMode('batch');
    }
  }, [prefilledBatchVideos]);

  // Update auto-generated slug when category name changes (unless user explicitly edited ID)
  const handleCatNameChange = (name: string) => {
    setNewCatName(name);
    if (!isCustomId) {
      const slug = 'cat_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      setNewCatId(slug);
    }
  };

  // Pre-fill single video from recent R2 upload if user clicks quick action
  const handleSelectR2ForSingleVideo = (record: ProcessedVideoResponse) => {
    const cleanName = (record.metadata?.exactFilename || record.metadata?.filename || 'Uploaded Video')
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim();

    setSingleVideo((prev) => ({
      ...prev,
      title: cleanName,
      description: `Ingested from Cloudflare R2 Vault: ${record.metadata?.exactFilename || record.metadata?.filename}`,
      imageUrl: record.thumbnailUrl,
      reelsUrl: record.videoUrl,
    }));
  };

  // Populate batch list from all recent R2 uploads
  const handleImportAllR2ToBatch = () => {
    if (recentR2Uploads.length === 0) {
      alert('No recent R2 uploads found. Upload videos first in the R2 Video Vault tab.');
      return;
    }

    const items = recentR2Uploads.map((rec, idx) => {
      const cleanName = (rec.metadata?.exactFilename || rec.metadata?.filename || `Video ${idx + 1}`)
        .replace(/\.[^/.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .trim();

      return {
        tempKey: `item_${Date.now()}_${idx}`,
        title: cleanName,
        description: `Ingested from Cloudflare R2: ${rec.metadata?.exactFilename || rec.metadata?.filename}`,
        imageUrl: rec.thumbnailUrl,
        reelsUrl: rec.videoUrl,
        isPremium: false,
        rating: 4.8,
        likesCount: `${(Math.random() * 15 + 5).toFixed(1)}k`,
      };
    });

    setBatchVideos(items);
    setVideoInputMode('batch');
  };

  // Add blank row to batch list
  const handleAddBatchRow = () => {
    setBatchVideos((prev) => [
      ...prev,
      {
        tempKey: `item_${Date.now()}_${prev.length}`,
        title: `Episode / Video ${prev.length + 1}`,
        description: '',
        imageUrl: '',
        reelsUrl: '',
        isPremium: false,
        rating: 4.5,
        likesCount: '2.5k',
      },
    ]);
  };

  const handleRemoveBatchRow = (index: number) => {
    setBatchVideos((prev) => prev.filter((_, i) => i !== index));
  };

  const handleBatchRowChange = (index: number, field: string, value: any) => {
    setBatchVideos((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  // TAB 1: Handle Create Category
  const handleCreateCategorySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;

    setIsCreatingCategory(true);
    setFeedback(null);

    try {
      const createdId = newCatId.trim() || `cat_${newCatName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const res = await createCategory(newCatName.trim(), newCatIsPortrait, createdId);

      setFeedback({
        type: 'success',
        message: `Category "${newCatName}" created successfully in Cloudflare Database!`,
        details: res,
      });

      // Reload categories and select the newly created one
      await loadCategories(createdId);
      setSelectedCategoryId(createdId);

      // Reset form
      setNewCatName('');
      setNewCatId('');
      setIsCustomId(false);
      setNewCatIsPortrait(false);

      // Offer to switch to Add Video tab
      setTimeout(() => {
        setActiveTab('add-video');
      }, 800);
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to create category on Cloudflare Worker',
      });
    } finally {
      setIsCreatingCategory(false);
    }
  };

  // TAB 2: Handle Add Single Video to Category
  const handleAddSingleVideoSubmit = async (e?: React.FormEvent, forcePush: boolean = false) => {
    if (e) e.preventDefault();
    if (!selectedCategoryId) {
      setFeedback({ type: 'error', message: 'Please select an existing category first.' });
      return;
    }
    if (!singleVideo.title.trim() || !singleVideo.reelsUrl.trim()) {
      setFeedback({ type: 'error', message: 'Video title and Video Stream URL (reelsUrl) are required.' });
      return;
    }

    setIsSavingVideo(true);
    setFeedback(null);

    try {
      const targetCategory = categories.find((c) => c.id === selectedCategoryId);
      const additionalNames = (singleVideo.additionalCategoryIds || [])
        .map((catId) => categories.find((c) => c.id === catId)?.name)
        .filter(Boolean) as string[];
      const mergedCategoryNames = Array.from(new Set([targetCategory?.name || 'Category Video', ...additionalNames]));

      const res = await addVideoToCategory(selectedCategoryId, {
        ...singleVideo,
        category: targetCategory?.name || 'Category Video',
        categories: mergedCategoryNames,
        forcePush,
      });

      if (res.skipped) {
        setFeedback({
          type: 'warning',
          message: res.reason || `Skipped in "${targetCategory?.name}". Already present in this category.`,
          skippedItems: [{ video: { ...singleVideo, categories: mergedCategoryNames }, reason: res.reason || 'Already in category' }],
        });
      } else {
        setFeedback({
          type: 'success',
          message: `Added video "${singleVideo.title}" to category "${targetCategory?.name || selectedCategoryId}"!${
            mergedCategoryNames.length > 1 ? ` (Cross-published across ${mergedCategoryNames.length} categories: ${mergedCategoryNames.join(', ')})` : ''
          }`,
          details: res.category,
        });

        // Clear video form inputs
        setSingleVideo({
          title: '',
          description: '',
          imageUrl: '',
          reelsUrl: '',
          isPremium: false,
          rating: 4.8,
          likesCount: '12k',
          additionalCategoryIds: [],
        });
      }

      // Reload categories to show updated count
      await loadCategories(selectedCategoryId);
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to add video to category',
      });
    } finally {
      setIsSavingVideo(false);
    }
  };

  // TAB 2: Handle Add Batch Videos to Category
  const handleAddBatchVideosSubmit = async (e?: React.FormEvent, forceVideos?: any[]) => {
    if (e) e.preventDefault();
    const videosToProcess = forceVideos || batchVideos;

    if (!selectedCategoryId) {
      setFeedback({ type: 'error', message: 'Please select a destination category first.' });
      return;
    }
    if (videosToProcess.length === 0) {
      setFeedback({ type: 'error', message: 'No videos in the batch to upload. Add rows or import from R2.' });
      return;
    }

    const invalidRow = videosToProcess.find((v) => !v.title.trim() || !v.reelsUrl.trim());
    if (invalidRow) {
      setFeedback({
        type: 'error',
        message: 'All videos in the batch must have a title and a valid stream URL (reelsUrl).',
      });
      return;
    }

    setIsSavingVideo(true);
    setFeedback(null);

    try {
      const targetCategory = categories.find((c) => c.id === selectedCategoryId);

      // Add batch videos to category (with duplicate checking)
      const res = await addBatchVideosToCategory(
        selectedCategoryId,
        videosToProcess.map((v) => ({ ...v, forcePush: Boolean(forceVideos) })),
        { name: targetCategory?.name, isPortrait: targetCategory?.isPortrait }
      );

      if (res.skippedVideos.length > 0) {
        const addedMsg = res.addedCount > 0 ? `Synced ${res.addedCount} new videos. ` : '';
        setFeedback({
          type: 'warning',
          message: `${addedMsg}Skipped ${res.skippedVideos.length} video(s) already in "${targetCategory?.name || selectedCategoryId}".`,
          details: res.category,
          skippedItems: res.skippedVideos,
        });
      } else {
        setFeedback({
          type: 'success',
          message: `Successfully synced all ${res.addedCount} videos into category "${targetCategory?.name || selectedCategoryId}"!`,
          details: res.category,
        });
      }

      if (!forceVideos) {
        setBatchVideos([]);
      }
      await loadCategories(selectedCategoryId);
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to save batch videos into category',
      });
    } finally {
      setIsSavingVideo(false);
    }
  };

  // Remove video from category
  const handleRemoveVideo = async (categoryId: string, videoId: number, videoTitle: string) => {
    if (!confirm(`Are you sure you want to remove "${videoTitle}" from this category?`)) {
      return;
    }

    try {
      await removeVideoFromCategory(categoryId, videoId);
      await loadCategories(categoryId);
      if (inspectCategory && inspectCategory.id === categoryId) {
        setInspectCategory((prev) =>
          prev ? { ...prev, videos: prev.videos.filter((v) => v.id !== videoId) } : null
        );
      }
    } catch (err: any) {
      alert(`Failed to remove video: ${err.message}`);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  const activeSelectedCategory = categories.find((c) => c.id === selectedCategoryId);

  return (
    <div className="space-y-6">
      {/* Header & Sub-Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              <FolderTree className="w-4 h-4" />
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Category &amp; Video Manager
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Endpoint: <code className="text-yellow-300 font-mono">POST /api/video_categories</code> &amp; <code className="text-slate-300 font-mono">GET /api/video_categories</code>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 flex text-xs font-semibold">
            <button
              onClick={() => {
                setActiveTab('add-video');
                setFeedback(null);
              }}
              className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                activeTab === 'add-video'
                  ? 'bg-yellow-500 text-slate-950 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ListPlus className="w-3.5 h-3.5" />
              <span>Add Video to Category</span>
            </button>
            <button
              onClick={() => {
                setActiveTab('create-category');
                setFeedback(null);
              }}
              className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                activeTab === 'create-category'
                  ? 'bg-yellow-500 text-slate-950 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add New Category</span>
            </button>
            <button
              onClick={() => {
                setActiveTab('browse');
                setFeedback(null);
                loadCategories();
              }}
              className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                activeTab === 'browse'
                  ? 'bg-yellow-500 text-slate-950 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Browse Categories ({categories.length})</span>
            </button>
          </div>

          <button
            onClick={() => loadCategories(selectedCategoryId)}
            disabled={isLoadingCategories}
            title="Refresh Categories"
            className="p-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 rounded-xl transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingCategories ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Global Feedback Banner */}
      {feedback && (
        <div
          className={`p-4 rounded-xl border flex items-start gap-3 text-xs animate-fadeIn ${
            feedback.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : feedback.type === 'warning'
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : feedback.type === 'warning' ? (
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          )}
          <div className="space-y-2 flex-1">
            <div className="flex items-center justify-between">
              <p className="font-bold text-sm">{feedback.message}</p>
            </div>

            {/* Skipped Items list & Manual Push Action */}
            {feedback.skippedItems && feedback.skippedItems.length > 0 && (
              <div className="mt-2 p-3 bg-slate-950/80 rounded-xl border border-amber-500/30 space-y-2.5 text-xs">
                <div className="flex items-center justify-between text-amber-200 font-semibold">
                  <span>Skipped Videos ({feedback.skippedItems.length})</span>
                  <span className="text-[11px] text-amber-400/80 font-normal">
                    Prevented duplicate entry in category
                  </span>
                </div>
                <div className="max-h-36 overflow-y-auto space-y-1 text-slate-300">
                  {feedback.skippedItems.map((s, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-2 p-1.5 bg-slate-900 rounded font-mono text-[11px]"
                    >
                      <span className="truncate">{s.video.title || 'Untitled Video'}</span>
                      <span className="text-amber-400 shrink-0 text-[10px]">{s.reason}</span>
                    </div>
                  ))}
                </div>
                <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-2 border-t border-slate-800">
                  <p className="text-[11px] text-amber-300/90 italic">
                    Skipped in this category. You can manually push if you want it duplicated anyway:
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (videoInputMode === 'single') {
                        handleAddSingleVideoSubmit(undefined, true);
                      } else {
                        handleAddBatchVideosSubmit(
                          undefined,
                          feedback.skippedItems?.map((s) => s.video)
                        );
                      }
                    }}
                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-all text-xs flex items-center gap-1.5 shrink-0 shadow-md shadow-amber-500/20"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Manually Push Again (Force Add)</span>
                  </button>
                </div>
              </div>
            )}

            {feedback.details && !feedback.skippedItems && (
              <pre className="mt-2 p-2 bg-slate-950/80 rounded font-mono text-[11px] text-slate-300 overflow-x-auto">
                {JSON.stringify(feedback.details, null, 2)}
              </pre>
            )}
          </div>
          <button
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-200 text-xs px-2 py-0.5"
          >
            ✕
          </button>
        </div>
      )}

      {/* ============================================================== */}
      {/* TAB 1: ADD NEW CATEGORY                                        */}
      {/* ============================================================== */}
      {activeTab === 'create-category' && (
        <form onSubmit={handleCreateCategorySubmit} className="space-y-6">
          <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Plus className="w-4 h-4 text-yellow-400" />
                  Create New Video Category
                </h3>
                <p className="text-xs text-slate-400">
                  Creates a dedicated category document in Cloudflare D1 with an initial empty video list (<code className="text-slate-300 font-mono">[]</code>).
                </p>
              </div>

              {/* Layout Indicator Preview */}
              <div className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Selected Layout:</span>
                <span className="text-yellow-400 font-semibold flex items-center gap-1">
                  {newCatIsPortrait ? (
                    <>
                      <Smartphone className="w-3.5 h-3.5" />
                      Vertical Portrait (9:16)
                    </>
                  ) : (
                    <>
                      <Monitor className="w-3.5 h-3.5" />
                      Horizontal Wide (16:9)
                    </>
                  )}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
              {/* Category Name */}
              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold flex items-center justify-between">
                  <span>Category Name</span>
                  <span className="text-slate-500 font-normal">e.g., Bollywood Blockbusters</span>
                </label>
                <input
                  type="text"
                  required
                  value={newCatName}
                  onChange={(e) => handleCatNameChange(e.target.value)}
                  placeholder="e.g. Action Hits, Romance Specials, Trending Movies"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 text-xs outline-none transition-colors"
                />
              </div>

              {/* Unique ID */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-slate-300 font-semibold">Unique Category ID</label>
                  <button
                    type="button"
                    onClick={() => setIsCustomId(!isCustomId)}
                    className="text-[11px] text-yellow-400 hover:text-yellow-300 underline"
                  >
                    {isCustomId ? 'Auto-Generate Slug' : 'Customize ID'}
                  </button>
                </div>
                <input
                  type="text"
                  required
                  value={newCatId}
                  onChange={(e) => {
                    setIsCustomId(true);
                    setNewCatId(e.target.value);
                  }}
                  placeholder="e.g. cat_action_hits"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 font-mono text-xs outline-none transition-colors"
                />
              </div>
            </div>

            {/* Card Layout Toggle (16:9 vs 9:16) */}
            <div className="space-y-2 pt-2">
              <label className="text-slate-300 font-semibold text-xs block">
                Card Display Layout / Aspect Ratio
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setNewCatIsPortrait(false)}
                  className={`p-4 rounded-xl border text-left transition-all flex items-start gap-3.5 ${
                    !newCatIsPortrait
                      ? 'bg-yellow-500/10 border-yellow-500/50 ring-1 ring-yellow-500/30'
                      : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className={`p-2.5 rounded-lg shrink-0 ${!newCatIsPortrait ? 'bg-yellow-500 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>
                    <Monitor className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-white">Horizontal Wide Card</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">16:9</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Optimized for traditional movies, web series, and desktop landscape video players (<code className="text-slate-300">isPortrait: false</code>).
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setNewCatIsPortrait(true)}
                  className={`p-4 rounded-xl border text-left transition-all flex items-start gap-3.5 ${
                    newCatIsPortrait
                      ? 'bg-yellow-500/10 border-yellow-500/50 ring-1 ring-yellow-500/30'
                      : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className={`p-2.5 rounded-lg shrink-0 ${newCatIsPortrait ? 'bg-yellow-500 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>
                    <Smartphone className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-white">Vertical Portrait Card</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">9:16</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Optimized for vertical reels, mobile phone full-screen clips, and TikTok/Shorts rails (<code className="text-slate-300">isPortrait: true</code>).
                    </p>
                  </div>
                </button>
              </div>
            </div>

            {/* Submit Action */}
            <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="text-xs text-slate-500">
                Submits payload with <code className="text-slate-400 font-mono">type: "video"</code> and <code className="text-slate-400 font-mono">videos: []</code> to <code className="text-yellow-400 font-mono">POST /api/video_categories</code>.
              </div>

              <button
                type="submit"
                disabled={isCreatingCategory || !newCatName.trim()}
                className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 text-slate-950 font-bold rounded-xl transition-all shadow-lg shadow-yellow-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-xs"
              >
                {isCreatingCategory ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Creating Category...</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    <span>Create Category</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* ============================================================== */}
      {/* TAB 2: ADD VIDEO TO CATEGORY                                   */}
      {/* ============================================================== */}
      {activeTab === 'add-video' && (
        <div className="space-y-6">
          {/* Quick R2 Vault Banner if user has uploaded videos in this session */}
          {recentR2Uploads.length > 0 && (
            <div className="p-4 bg-gradient-to-r from-yellow-500/10 via-amber-500/10 to-orange-500/10 border border-yellow-500/30 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-yellow-500 text-slate-950 font-bold shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <span className="font-bold text-white text-sm">
                    {recentR2Uploads.length} R2 Video Uploads Available
                  </span>
                  <p className="text-slate-400 mt-0.5">
                    Stream URLs, 5s frame thumbnails, and exact filenames from your R2 storage vault are ready to be synced into your categories with unique distinct keys.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleImportAllR2ToBatch}
                  className="px-3.5 py-2 bg-yellow-500 hover:bg-yellow-400 text-slate-950 font-bold rounded-xl transition-all shadow-sm flex items-center gap-1.5"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  <span>Batch Sync All {recentR2Uploads.length} Videos</span>
                </button>
              </div>
            </div>
          )}

          {/* Form Card */}
          <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-6">
            {/* Top Toolbar: Category Selector & Mode Switch */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
              {/* Category Dropdown */}
              <div className="flex-1 max-w-xl space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-slate-300 font-bold flex items-center gap-2">
                    <FolderTree className="w-3.5 h-3.5 text-yellow-400" />
                    Target Video Category
                  </label>
                  <span className="text-slate-500 text-[11px]">
                    Populated live from <code className="text-slate-400">GET /api/video_categories</code>
                  </span>
                </div>

                {categories.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedCategoryId}
                      onChange={(e) => setSelectedCategoryId(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 text-xs outline-none font-medium transition-colors"
                    >
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name} ({cat.videos?.length || 0} videos) · [{cat.isPortrait ? '9:16 Portrait' : '16:9 Landscape'}] · ID: {cat.id}
                        </option>
                      ))}
                    </select>

                    {activeSelectedCategory && (
                      <span className={`px-2.5 py-2 rounded-xl text-[11px] font-semibold shrink-0 border ${
                        activeSelectedCategory.isPortrait
                          ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                          : 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                      }`}>
                        {activeSelectedCategory.isPortrait ? '9:16 Reel' : '16:9 Video'}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-amber-400 flex items-center justify-between">
                    <span>No categories found in database yet.</span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('create-category')}
                      className="underline text-yellow-400 font-semibold"
                    >
                      Create First Category
                    </button>
                  </div>
                )}
              </div>

              {/* Mode Switch: Single Video vs Batch Videos */}
              <div className="flex items-center gap-2 shrink-0 self-start lg:self-auto">
                <span className="text-xs text-slate-400">Input Mode:</span>
                <div className="bg-slate-950 p-1 border border-slate-800 rounded-xl flex text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setVideoInputMode('single')}
                    className={`px-3 py-1.5 rounded-lg transition-all ${
                      videoInputMode === 'single'
                        ? 'bg-yellow-500 text-slate-950 shadow-sm font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Single Video Form
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setVideoInputMode('batch');
                      if (batchVideos.length === 0 && recentR2Uploads.length > 0) {
                        handleImportAllR2ToBatch();
                      } else if (batchVideos.length === 0) {
                        handleAddBatchRow();
                      }
                    }}
                    className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                      videoInputMode === 'batch'
                        ? 'bg-yellow-500 text-slate-950 shadow-sm font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>Batch Videos</span>
                    {batchVideos.length > 0 && (
                      <span className="px-1.5 py-0.2 rounded-full bg-slate-900 text-[10px] text-yellow-400">
                        {batchVideos.length}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Quick Fill from Recent R2 Pills */}
            {recentR2Uploads.length > 0 && videoInputMode === 'single' && (
              <div className="space-y-2 p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl text-xs">
                <span className="text-slate-400 font-medium">Quick Pre-fill from R2 Uploads:</span>
                <div className="flex flex-wrap gap-2">
                  {recentR2Uploads.map((rec) => (
                    <button
                      key={rec.id}
                      type="button"
                      onClick={() => handleSelectR2ForSingleVideo(rec)}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-yellow-400 transition-colors flex items-center gap-1.5 text-[11px]"
                    >
                      <Film className="w-3 h-3 text-orange-400" />
                      <span>{rec.metadata?.exactFilename || rec.metadata?.filename}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* -------------------------------------------------------- */}
            {/* SUB-FLOW A: SINGLE VIDEO FORM                           */}
            {/* -------------------------------------------------------- */}
            {videoInputMode === 'single' ? (
              <form onSubmit={handleAddSingleVideoSubmit} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  {/* Video Title */}
                  <div className="space-y-1.5 md:col-span-2">
                    <label className="text-slate-300 font-semibold">Video Title *</label>
                    <input
                      type="text"
                      required
                      value={singleVideo.title}
                      onChange={(e) => setSingleVideo({ ...singleVideo, title: e.target.value })}
                      placeholder="e.g. Stealth Mission Alpha: Night Infiltration"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 text-xs outline-none transition-colors"
                    />
                  </div>

                  {/* reelsUrl (Direct Video URL) */}
                  <div className="space-y-1.5">
                    <label className="text-slate-300 font-semibold flex items-center justify-between">
                      <span>Video Stream URL (reelsUrl) *</span>
                      <span className="text-slate-500 font-normal">.mp4 or .m3u8</span>
                    </label>
                    <input
                      type="url"
                      required
                      value={singleVideo.reelsUrl}
                      onChange={(e) => setSingleVideo({ ...singleVideo, reelsUrl: e.target.value })}
                      placeholder="https://pub-...r2.dev/videos/mission_alpha.mp4"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 font-mono text-xs outline-none transition-colors"
                    />
                  </div>

                  {/* imageUrl (Thumbnail URL) */}
                  <div className="space-y-1.5">
                    <label className="text-slate-300 font-semibold flex items-center justify-between">
                      <span>Thumbnail Image URL (imageUrl)</span>
                      <span className="text-slate-500 font-normal">Poster / Cover frame</span>
                    </label>
                    <input
                      type="url"
                      value={singleVideo.imageUrl}
                      onChange={(e) => setSingleVideo({ ...singleVideo, imageUrl: e.target.value })}
                      placeholder="https://pub-...r2.dev/thumbnails/mission_alpha-thumb-5s.jpg"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 font-mono text-xs outline-none transition-colors"
                    />
                  </div>

                  {/* Description / Synopsis */}
                  <div className="space-y-1.5 md:col-span-2">
                    <label className="text-slate-300 font-semibold">Description / Synopsis</label>
                    <textarea
                      rows={2}
                      value={singleVideo.description}
                      onChange={(e) => setSingleVideo({ ...singleVideo, description: e.target.value })}
                      placeholder="A covert operative team infiltrates a rogue industrial plant under midnight radar..."
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 text-xs outline-none transition-colors resize-none"
                    />
                  </div>

                  {/* Meta Settings: Rating, Likes, VIP */}
                  <div className="space-y-1.5">
                    <label className="text-slate-300 font-semibold">User Rating (1.0 - 5.0)</label>
                    <div className="flex items-center gap-2">
                      <Star className="w-4 h-4 text-amber-400 shrink-0" />
                      <input
                        type="number"
                        step="0.1"
                        min="1"
                        max="5"
                        value={singleVideo.rating}
                        onChange={(e) => setSingleVideo({ ...singleVideo, rating: parseFloat(e.target.value) || 4.5 })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 text-xs outline-none"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-slate-300 font-semibold">Likes Count Badge</label>
                    <div className="flex items-center gap-2">
                      <Heart className="w-4 h-4 text-rose-400 shrink-0" />
                      <input
                        type="text"
                        value={singleVideo.likesCount}
                        onChange={(e) => setSingleVideo({ ...singleVideo, likesCount: e.target.value })}
                        placeholder="e.g. 18.5k"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-yellow-500 rounded-xl text-slate-100 text-xs outline-none"
                      />
                    </div>
                  </div>

                  <div className="md:col-span-2 pt-2">
                    <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                      <input
                        type="checkbox"
                        checked={singleVideo.isPremium}
                        onChange={(e) => setSingleVideo({ ...singleVideo, isPremium: e.target.checked })}
                        className="w-4 h-4 rounded text-yellow-500 accent-yellow-500 bg-slate-900 border-slate-700"
                      />
                      <div className="space-y-0.5">
                        <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                          <Lock className="w-3.5 h-3.5 text-yellow-400" />
                          Mark as Premium VIP Video
                        </span>
                        <p className="text-[11px] text-slate-400">
                          Locks video behind premium subscription tier on client playback.
                        </p>
                      </div>
                    </label>
                  </div>

                  {/* Multi-Category Tags & Cross-Publishing (0 Storage Overhead) */}
                  {categories.length > 1 && (
                    <div className="md:col-span-2 p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-slate-300 font-semibold flex items-center gap-2">
                          <Layers className="w-3.5 h-3.5 text-yellow-400" />
                          <span>Cross-Publish into Multiple Categories (0 Added Storage)</span>
                        </label>
                        <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                          Same R2 File · Multi-Tagged
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Primary: <strong className="text-yellow-400 font-mono">{activeSelectedCategory?.name}</strong>. Check additional categories to include in this video's <code className="text-slate-300">categories: [...]</code> tag list:
                      </p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {categories
                          .filter((c) => c.id !== selectedCategoryId)
                          .map((c) => {
                            const isSelected = singleVideo.additionalCategoryIds.includes(c.id);
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => {
                                  setSingleVideo((prev) => {
                                    const next = isSelected
                                      ? prev.additionalCategoryIds.filter((id) => id !== c.id)
                                      : [...prev.additionalCategoryIds, c.id];
                                    return { ...prev, additionalCategoryIds: next };
                                  });
                                }}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors flex items-center gap-1.5 ${
                                  isSelected
                                    ? 'bg-yellow-500/20 border-yellow-500/60 text-yellow-300 font-bold'
                                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                <span>{isSelected ? '✓' : '+'}</span>
                                <span>{c.name}</span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Form Footer */}
                <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <span>Target:</span>
                    <strong className="text-yellow-400 font-mono">{activeSelectedCategory?.name || selectedCategoryId}</strong>
                    <span className="text-slate-500">· {activeSelectedCategory?.videos?.length || 0} existing videos</span>
                  </div>

                  <button
                    type="submit"
                    disabled={isSavingVideo || !singleVideo.title.trim() || !singleVideo.reelsUrl.trim()}
                    className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 text-slate-950 font-bold rounded-xl transition-all shadow-lg shadow-yellow-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-xs"
                  >
                    {isSavingVideo ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Syncing to Cloudflare...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        <span>Add Video &amp; Save</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            ) : (
              /* -------------------------------------------------------- */
              /* SUB-FLOW B: BATCH VIDEOS INGESTION FORM                 */
              /* -------------------------------------------------------- */
              <form onSubmit={handleAddBatchVideosSubmit} className="space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs">
                  <div>
                    <span className="font-bold text-white">Batch Video List ({batchVideos.length} Items)</span>
                    <p className="text-slate-400 text-[11px]">
                      Each video will receive a distinct unique ID. All videos will be appended to category <strong>{activeSelectedCategory?.name}</strong>.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {recentR2Uploads.length > 0 && (
                      <button
                        type="button"
                        onClick={handleImportAllR2ToBatch}
                        className="px-3 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-lg transition-colors flex items-center gap-1 font-semibold"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Re-import R2 Vault</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleAddBatchRow}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors flex items-center gap-1 font-semibold"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Row</span>
                    </button>
                  </div>
                </div>

                {/* Batch Items List */}
                <div className="space-y-3">
                  {batchVideos.map((video, idx) => (
                    <div
                      key={video.tempKey}
                      className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3 relative group text-xs"
                    >
                      <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-900">
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 font-bold flex items-center justify-center text-[10px]">
                            {idx + 1}
                          </span>
                          <span className="font-semibold text-slate-200">
                            {video.title || `Video ${idx + 1}`}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveBatchRow(idx)}
                          className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                          title="Remove video row"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="space-y-1 md:col-span-1">
                          <label className="text-slate-400 font-medium text-[11px]">Title *</label>
                          <input
                            type="text"
                            required
                            value={video.title}
                            onChange={(e) => handleBatchRowChange(idx, 'title', e.target.value)}
                            placeholder="Video title"
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-yellow-500 rounded-lg text-slate-100 text-xs outline-none"
                          />
                        </div>

                        <div className="space-y-1 md:col-span-2">
                          <label className="text-slate-400 font-medium text-[11px]">Stream URL (reelsUrl) *</label>
                          <input
                            type="url"
                            required
                            value={video.reelsUrl}
                            onChange={(e) => handleBatchRowChange(idx, 'reelsUrl', e.target.value)}
                            placeholder="https://...mp4"
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-yellow-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                          />
                        </div>

                        <div className="space-y-1 md:col-span-2">
                          <label className="text-slate-400 font-medium text-[11px]">Thumbnail URL (imageUrl)</label>
                          <input
                            type="url"
                            value={video.imageUrl}
                            onChange={(e) => handleBatchRowChange(idx, 'imageUrl', e.target.value)}
                            placeholder="https://...jpg"
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-yellow-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                          />
                        </div>

                        <div className="flex items-center gap-3 pt-4">
                          <label className="flex items-center gap-1.5 cursor-pointer text-slate-300">
                            <input
                              type="checkbox"
                              checked={video.isPremium}
                              onChange={(e) => handleBatchRowChange(idx, 'isPremium', e.target.checked)}
                              className="w-3.5 h-3.5 rounded text-yellow-500 accent-yellow-500"
                            />
                            <span>VIP</span>
                          </label>

                          <div className="flex items-center gap-1 text-[11px] text-slate-400">
                            <span>Rating:</span>
                            <input
                              type="number"
                              step="0.1"
                              min="1"
                              max="5"
                              value={video.rating}
                              onChange={(e) =>
                                handleBatchRowChange(idx, 'rating', parseFloat(e.target.value) || 4.5)
                              }
                              className="w-12 px-1.5 py-0.5 bg-slate-900 border border-slate-800 rounded text-center text-xs"
                            />
                          </div>

                          <div className="flex items-center gap-1 text-[11px] text-slate-400">
                            <span>Likes:</span>
                            <input
                              type="text"
                              value={video.likesCount}
                              onChange={(e) => handleBatchRowChange(idx, 'likesCount', e.target.value)}
                              className="w-14 px-1.5 py-0.5 bg-slate-900 border border-slate-800 rounded text-center text-xs"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  {batchVideos.length === 0 && (
                    <div className="p-8 border border-dashed border-slate-800 rounded-xl text-center text-slate-500 space-y-2 text-xs">
                      <p>No batch videos in list yet.</p>
                      <button
                        type="button"
                        onClick={handleAddBatchRow}
                        className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700"
                      >
                        + Add First Video
                      </button>
                    </div>
                  )}
                </div>

                {/* Batch Submit */}
                <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="text-xs text-slate-400">
                    Syncs <strong className="text-white">{batchVideos.length}</strong> videos with unique keys into category <code className="text-yellow-400 font-mono">{activeSelectedCategory?.name}</code>.
                  </div>

                  <button
                    type="submit"
                    disabled={isSavingVideo || batchVideos.length === 0}
                    className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 text-slate-950 font-bold rounded-xl transition-all shadow-lg shadow-yellow-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-xs"
                  >
                    {isSavingVideo ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Syncing Batch to Cloudflare...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        <span>Sync All {batchVideos.length} Videos to Category</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* TAB 3: BROWSE & MANAGE CATEGORIES                             */}
      {/* ============================================================== */}
      {activeTab === 'browse' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-slate-900/80 border border-slate-800 rounded-2xl text-xs">
            <div>
              <span className="font-bold text-white text-sm">
                Cloudflare Categories Rail &amp; Video Library
              </span>
              <p className="text-slate-400 mt-0.5">
                Displays live video categories stored in Cloudflare D1 with attached video objects and playback links.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => loadCategories()}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingCategories ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
              <button
                onClick={() => setActiveTab('create-category')}
                className="px-3 py-1.5 bg-yellow-500 hover:bg-yellow-400 text-slate-950 font-bold rounded-xl transition-colors flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Category</span>
              </button>
            </div>
          </div>

          {fetchError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300">
              {fetchError}
            </div>
          )}

          {isLoadingCategories ? (
            <div className="p-12 text-center text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-yellow-400" />
              <p>Fetching categories from Cloudflare Worker REST API...</p>
            </div>
          ) : categories.length === 0 ? (
            <div className="p-12 border border-dashed border-slate-800 rounded-2xl text-center space-y-3">
              <FolderTree className="w-8 h-8 text-slate-600 mx-auto" />
              <div className="space-y-1">
                <p className="font-semibold text-slate-300 text-sm">No video categories found</p>
                <p className="text-xs text-slate-500">
                  Create your first category or add videos to get started.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('create-category')}
                className="px-4 py-2 bg-yellow-500 text-slate-950 font-bold rounded-xl text-xs hover:bg-yellow-400"
              >
                Create Category
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {categories.map((cat) => (
                <div
                  key={cat.id}
                  className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-4"
                >
                  {/* Category Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-base font-bold text-white tracking-tight">
                          {cat.name}
                        </h3>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          cat.isPortrait
                            ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                            : 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                        }`}>
                          {cat.isPortrait ? '9:16 Vertical Reel' : '16:9 Wide Video'}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[10px] font-mono">
                          {cat.videos?.length || 0} videos
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 font-mono">
                        ID: <span className="text-slate-300">{cat.id}</span> · Type: <span className="text-slate-300">{cat.type || 'video'}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setSelectedCategoryId(cat.id);
                          setActiveTab('add-video');
                        }}
                        className="px-3 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Video</span>
                      </button>

                      <button
                        onClick={() => setInspectCategory(cat)}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        <FileJson className="w-3.5 h-3.5 text-yellow-400" />
                        <span>Inspect JSON</span>
                      </button>
                    </div>
                  </div>

                  {/* Attached Videos Grid */}
                  {cat.videos && cat.videos.length > 0 ? (
                    <div className={`grid gap-4 ${
                      cat.isPortrait
                        ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'
                        : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'
                    }`}>
                      {cat.videos.map((v, vIdx) => (
                        <div
                          key={v.id || vIdx}
                          className="bg-slate-950 border border-slate-800/80 rounded-xl overflow-hidden flex flex-col group hover:border-slate-700 transition-all text-xs"
                        >
                          {/* Thumbnail / Video Preview */}
                          <div
                            className={`relative bg-slate-900 overflow-hidden ${
                              cat.isPortrait ? 'aspect-[9/16]' : 'aspect-video'
                            }`}
                          >
                            {v.imageUrl ? (
                              <img
                                src={v.imageUrl}
                                alt={v.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                onError={(e) => {
                                  (e.target as HTMLElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-600 bg-slate-950">
                                <Film className="w-8 h-8 opacity-40" />
                              </div>
                            )}

                            {/* Play Overlay */}
                            {v.reelsUrl && (
                              <button
                                onClick={() => setPreviewVideoUrl(v.reelsUrl)}
                                className="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white"
                                title="Play Video Preview"
                              >
                                <span className="p-2.5 rounded-full bg-yellow-500 text-slate-950 shadow-lg">
                                  <Play className="w-4 h-4 fill-current" />
                                </span>
                              </button>
                            )}

                            {/* Badges */}
                            <div className="absolute top-2 left-2 flex items-center gap-1">
                              {v.isPremium && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-500/90 text-slate-950 font-bold text-[9px] flex items-center gap-0.5 shadow">
                                  <Lock className="w-2.5 h-2.5" />
                                  VIP
                                </span>
                              )}
                            </div>

                            <div className="absolute bottom-2 right-2 flex items-center gap-1">
                              {v.rating && (
                                <span className="px-1.5 py-0.5 rounded bg-slate-950/80 backdrop-blur-sm text-amber-400 font-bold text-[10px] flex items-center gap-0.5">
                                  <Star className="w-2.5 h-2.5 fill-current" />
                                  {v.rating}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Video Details */}
                          <div className="p-3 space-y-1.5 flex-1 flex flex-col justify-between">
                            <div>
                              <h4 className="font-bold text-white text-xs truncate" title={v.title}>
                                {v.title}
                              </h4>
                              {v.description && (
                                <p className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">
                                  {v.description}
                                </p>
                              )}
                            </div>

                            <div className="pt-2 border-t border-slate-900 flex items-center justify-between text-[10px] text-slate-500">
                              <span className="flex items-center gap-1">
                                <Heart className="w-3 h-3 text-rose-400" />
                                {v.likesCount || '1.2k'}
                              </span>

                              <button
                                onClick={() => handleRemoveVideo(cat.id, v.id, v.title)}
                                className="text-slate-500 hover:text-rose-400 transition-colors p-1"
                                title="Remove from category"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-6 border border-dashed border-slate-800 rounded-xl text-center text-xs text-slate-500 space-y-2">
                      <p>No videos added to this category yet.</p>
                      <button
                        onClick={() => {
                          setSelectedCategoryId(cat.id);
                          setActiveTab('add-video');
                        }}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 text-yellow-400 font-semibold hover:bg-slate-700 transition-colors text-xs"
                      >
                        + Add Videos to {cat.name}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ============================================================== */}
      {/* JSON INSPECTOR MODAL                                           */}
      {/* ============================================================== */}
      {inspectCategory && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileJson className="w-4 h-4 text-yellow-400" />
                <h3 className="font-bold text-white text-sm">
                  {inspectCategory.name} · Category JSON Object
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copyToClipboard(JSON.stringify(inspectCategory, null, 2))}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1"
                >
                  {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedJson ? 'Copied' : 'Copy'}</span>
                </button>
                <button
                  onClick={() => setInspectCategory(null)}
                  className="p-1 text-slate-400 hover:text-white"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto flex-1 font-mono text-[11px] text-slate-300 bg-slate-950">
              <pre>{JSON.stringify(inspectCategory, null, 2)}</pre>
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900/90 text-right text-xs">
              <button
                onClick={() => setInspectCategory(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* VIDEO PLAYBACK PREVIEW MODAL                                   */}
      {/* ============================================================== */}
      {previewVideoUrl && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl">
            <div className="p-3.5 border-b border-slate-800 flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5 text-yellow-400 fill-current" />
                Live Video Playback
              </span>
              <button
                onClick={() => setPreviewVideoUrl(null)}
                className="text-slate-400 hover:text-white px-2 py-0.5"
              >
                ✕
              </button>
            </div>
            <div className="bg-black aspect-video flex items-center justify-center">
              <video
                src={previewVideoUrl}
                controls
                autoPlay
                className="w-full h-full max-h-[60vh] object-contain"
              />
            </div>
            <div className="p-3 bg-slate-950 flex items-center justify-between text-xs font-mono text-slate-400">
              <span className="truncate max-w-md">{previewVideoUrl}</span>
              <button
                onClick={() => setPreviewVideoUrl(null)}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg shrink-0"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
