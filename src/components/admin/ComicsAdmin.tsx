import React, { useState, useEffect } from 'react';
import {
  ComicPayload,
  ComicChapter,
  uploadToCloudflare,
  fetchFromCloudflare,
  CF_WORKER_BASE_URL,
} from '../../services/cloudflareWorkerApi';
import {
  BookOpen,
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
  Image,
  FileText,
} from 'lucide-react';

const DEFAULT_SAMPLE_COMIC: ComicPayload = {
  id: Math.floor(Math.random() * 800 + 100),
  title: 'Solo Leveling: Shadow Sovereign',
  category: 'Action & Fantasy',
  imageUrl:
    'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=600&q=80',
  description:
    'The weakest hunter awakens a clandestine leveling system, battling catastrophic dungeon bosses to protect the realm.',
  likesCount: '50k',
  isPremium: 1,
  chapters: [
    {
      chapterNumber: 1,
      title: 'Chapter 1: The D-Rank Dungeon',
      pagesCsv:
        'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=400&q=80,https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&w=400&q=80,https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=400&q=80',
      pdfUrl: '',
    },
    {
      chapterNumber: 2,
      title: 'Chapter 2: The Awakening',
      pagesCsv:
        'https://images.unsplash.com/photo-1544717305-2782549b5136?auto=format&fit=crop&w=400&q=80,https://images.unsplash.com/photo-1516339901601-2e1b62dc0c45?auto=format&fit=crop&w=400&q=80',
      pdfUrl: '',
    },
  ],
};

export function ComicsAdmin() {
  const [activeSubTab, setActiveSubTab] = useState<'create' | 'browse'>('create');
  const [formData, setFormData] = useState<ComicPayload>(DEFAULT_SAMPLE_COMIC);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
    data?: any;
  } | null>(null);

  // Existing comics
  const [existingComics, setExistingComics] = useState<any[]>([]);
  const [isLoadingComics, setIsLoadingComics] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedComicDetails, setSelectedComicDetails] = useState<any | null>(null);

  const loadExistingComics = async () => {
    setIsLoadingComics(true);
    setFetchError(null);
    try {
      const data = await fetchFromCloudflare<any>('comics');
      const list = Array.isArray(data) ? data : data?.data || data?.comics || [];
      setExistingComics(list);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to fetch comics');
    } finally {
      setIsLoadingComics(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'browse') {
      loadExistingComics();
    }
  }, [activeSubTab]);

  const handleAddChapter = () => {
    const nextNum = formData.chapters.length + 1;
    const newChapter: ComicChapter = {
      chapterNumber: nextNum,
      title: `Chapter ${nextNum}: New Dawn`,
      pagesCsv: '',
      pdfUrl: '',
    };
    setFormData((prev) => ({
      ...prev,
      chapters: [...prev.chapters, newChapter],
    }));
  };

  const handleRemoveChapter = (index: number) => {
    setFormData((prev) => {
      const filtered = prev.chapters.filter((_, i) => i !== index);
      const renumbered = filtered.map((c, i) => ({
        ...c,
        chapterNumber: i + 1,
      }));
      return { ...prev, chapters: renumbered };
    });
  };

  const handleChapterChange = (
    index: number,
    field: keyof ComicChapter,
    value: any
  ) => {
    setFormData((prev) => {
      const updated = [...prev.chapters];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, chapters: updated };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitResult(null);

    const payload: ComicPayload = {
      ...formData,
      id: Number(formData.id) || Date.now(),
      likesCount: formData.likesCount || '50k',
      isPremium: formData.isPremium ? 1 : 0,
      chapters: formData.chapters.map((ch, idx) => ({
        ...ch,
        chapterNumber: idx + 1,
        pagesCsv: (ch.pagesCsv || '').trim(),
      })),
    };

    try {
      const res = await uploadToCloudflare('comics', payload);
      setSubmitResult({
        success: true,
        message: `Successfully uploaded Comic "${payload.title}" to Cloudflare Worker REST API!`,
        data: res,
      });
    } catch (err: any) {
      setSubmitResult({
        success: false,
        message: err.message || 'Failed to upload comic to Cloudflare Worker',
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
            <span className="p-1.5 rounded-lg bg-violet-500/10 text-violet-400 border border-violet-500/20">
              <BookOpen className="w-4 h-4" />
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Comics, Webtoons &amp; Manga Studio
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Endpoint: <code className="text-violet-300 font-mono">POST /api/comics</code> &amp; <code className="text-slate-300 font-mono">GET /api/comics</code>
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 flex">
          <button
            onClick={() => setActiveSubTab('create')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'create'
                ? 'bg-violet-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Create Comic
          </button>
          <button
            onClick={() => setActiveSubTab('browse')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === 'browse'
                ? 'bg-violet-500 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Browse Comics
          </button>
        </div>
      </div>

      {activeSubTab === 'create' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Quick Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-900/80 border border-slate-800 rounded-xl text-xs">
            <span className="text-slate-400 font-medium">Quick Preset:</span>
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...DEFAULT_SAMPLE_COMIC,
                  id: Math.floor(Math.random() * 800 + 100),
                })
              }
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
            >
              Load Solo Leveling Sample
            </button>
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

          {/* Comic Main Details Card */}
          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4 text-violet-400" />
              Comic Series Details
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Comic ID (Numeric)</label>
                <input
                  type="number"
                  required
                  value={formData.id}
                  onChange={(e) => setFormData({ ...formData, id: Number(e.target.value) })}
                  placeholder="1"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Title</label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Solo Leveling Chronicle"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Category / Genre</label>
                <input
                  type="text"
                  required
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  placeholder="Action & Fantasy"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg text-slate-100 text-xs outline-none"
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
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Likes Count</label>
                  <input
                    type="text"
                    value={formData.likesCount}
                    onChange={(e) => setFormData({ ...formData, likesCount: e.target.value })}
                    placeholder="50k"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg text-slate-100 text-xs outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">VIP Pass</label>
                  <div className="pt-2">
                    <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={Boolean(formData.isPremium)}
                        onChange={(e) =>
                          setFormData({ ...formData, isPremium: e.target.checked ? 1 : 0 })
                        }
                        className="rounded accent-violet-500 w-4 h-4"
                      />
                      <span>Premium (1)</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="md:col-span-3 space-y-1.5">
                <label className="text-slate-300 font-semibold">Description</label>
                <textarea
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Comic lore and premise summary..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg text-slate-100 text-xs outline-none"
                />
              </div>
            </div>
          </div>

          {/* Chapters & Manga Reader Pages */}
          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <FileText className="w-4 h-4 text-violet-400" />
                  Chapters &amp; Page Strip Manager ({formData.chapters.length})
                </h3>
                <p className="text-xs text-slate-400">
                  Provide comma-separated image URLs in <code className="text-violet-300 font-mono">pagesCsv</code> for reading strips
                </p>
              </div>

              <button
                type="button"
                onClick={handleAddChapter}
                className="px-3 py-1.5 bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 border border-violet-500/30 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Chapter
              </button>
            </div>

            <div className="space-y-4">
              {formData.chapters.map((ch, idx) => {
                const pageUrls = ch.pagesCsv
                  ? ch.pagesCsv.split(',').map((p) => p.trim()).filter(Boolean)
                  : [];
                return (
                  <div
                    key={idx}
                    className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3"
                  >
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-violet-500/20 text-violet-400 border border-violet-500/30 flex items-center justify-center font-bold text-xs">
                          {idx + 1}
                        </span>
                        <span className="font-semibold text-white text-xs">
                          {ch.title || `Chapter ${idx + 1}`}
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          ({pageUrls.length} pages)
                        </span>
                      </div>

                      <button
                        type="button"
                        disabled={formData.chapters.length <= 1}
                        onClick={() => handleRemoveChapter(idx)}
                        className="p-1 text-slate-500 hover:text-rose-400 disabled:opacity-30 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="space-y-1">
                        <label className="text-slate-400">Chapter Title</label>
                        <input
                          type="text"
                          value={ch.title}
                          onChange={(e) =>
                            handleChapterChange(idx, 'title', e.target.value)
                          }
                          placeholder="Chapter 1: The D-Rank Dungeon"
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-violet-500 rounded text-slate-100 text-xs"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-slate-400">Optional PDF URL</label>
                        <input
                          type="text"
                          value={ch.pdfUrl || ''}
                          onChange={(e) =>
                            handleChapterChange(idx, 'pdfUrl', e.target.value)
                          }
                          placeholder="https://example.com/chapter1.pdf"
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-violet-500 rounded text-slate-100 font-mono text-xs"
                        />
                      </div>

                      <div className="md:col-span-2 space-y-1">
                        <label className="text-slate-400">
                          Pages CSV (Comma-separated Image URLs)
                        </label>
                        <textarea
                          rows={2}
                          value={ch.pagesCsv}
                          onChange={(e) =>
                            handleChapterChange(idx, 'pagesCsv', e.target.value)
                          }
                          placeholder="https://example.com/p1.jpg, https://example.com/p2.jpg, https://example.com/p3.jpg"
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-violet-500 rounded text-slate-100 font-mono text-xs"
                        />
                      </div>

                      {/* Visual Page Strips Preview */}
                      {pageUrls.length > 0 && (
                        <div className="md:col-span-2 space-y-1 pt-1">
                          <span className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                            <Image className="w-3.5 h-3.5 text-violet-400" />
                            Page Strip Preview ({pageUrls.length} detected):
                          </span>
                          <div className="flex gap-2 overflow-x-auto pb-2 pt-1">
                            {pageUrls.map((url, pIdx) => (
                              <div
                                key={pIdx}
                                className="w-16 h-24 rounded bg-slate-900 border border-slate-800 shrink-0 relative overflow-hidden group"
                              >
                                <img
                                  src={url}
                                  alt={`Page ${pIdx + 1}`}
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    (e.target as HTMLElement).style.opacity = '0.2';
                                  }}
                                />
                                <span className="absolute bottom-1 right-1 text-[9px] bg-black/60 px-1 rounded text-white font-mono">
                                  #{pIdx + 1}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg shadow-violet-500/20 flex items-center gap-2 transition-all"
            >
              <Send className={`w-4 h-4 ${isSubmitting ? 'animate-pulse' : ''}`} />
              {isSubmitting ? 'Uploading Comic...' : 'Upload Comic to Cloudflare D1'}
            </button>
          </div>
        </form>
      ) : (
        /* Browse Comics */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Fetched from <code className="text-slate-300 font-mono">GET /api/comics</code> ({existingComics.length} items found)
            </p>
            <button
              onClick={loadExistingComics}
              disabled={isLoadingComics}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingComics ? 'animate-spin text-violet-400' : ''}`} />
              {isLoadingComics ? 'Loading...' : 'Reload'}
            </button>
          </div>

          {fetchError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{fetchError}</span>
            </div>
          )}

          {isLoadingComics ? (
            <div className="py-12 text-center text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-violet-400" />
              <p>Fetching comics from Cloudflare Worker...</p>
            </div>
          ) : existingComics.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs bg-slate-900/50 rounded-2xl border border-slate-800">
              No comics found in database. Create one above!
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {existingComics.map((comic, idx) => (
                <div
                  key={comic.id || idx}
                  className="p-4 bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl space-y-3 transition-colors flex flex-col justify-between"
                >
                  <div className="flex gap-3">
                    {comic.imageUrl && (
                      <div className="w-20 h-28 rounded-lg overflow-hidden bg-slate-950 shrink-0">
                        <img
                          src={comic.imageUrl}
                          alt={comic.title}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      </div>
                    )}
                    <div className="space-y-1 flex-1 min-w-0">
                      <span className="text-[10px] text-violet-400 font-semibold uppercase tracking-wider">
                        {comic.category || 'Manga'}
                      </span>
                      <h4 className="font-bold text-white text-sm line-clamp-1">
                        {comic.title}
                      </h4>
                      <p className="text-xs text-slate-400 line-clamp-2">
                        {comic.description}
                      </p>
                      <div className="pt-1 flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                        <span>Likes: {comic.likesCount || '0'}</span>
                        {comic.isPremium ? (
                          <span className="text-amber-400 font-semibold">VIP</span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                    <span>
                      {Array.isArray(comic.chapters) ? comic.chapters.length : 0} Chapters
                    </span>
                    <button
                      onClick={() => setSelectedComicDetails(comic)}
                      className="text-violet-400 hover:text-violet-300 font-medium flex items-center gap-1 text-[11px]"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      View JSON
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* JSON Inspector Modal */}
      {selectedComicDetails && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-bold text-white text-sm">
                Comic: {selectedComicDetails.title}
              </h3>
              <button
                onClick={() => setSelectedComicDetails(null)}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 bg-slate-800 rounded"
              >
                Close
              </button>
            </div>
            <div className="p-4 overflow-y-auto text-xs">
              <pre className="p-3 bg-slate-950 rounded-xl font-mono text-emerald-400 text-xs overflow-x-auto">
                {JSON.stringify(selectedComicDetails, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
