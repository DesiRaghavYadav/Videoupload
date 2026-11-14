/**
 * Cloudflare Worker REST API Service
 * Base URL: https://ott-api.fussionbhakti3.workers.dev
 * Handles Content Management for OTT / Streaming platform
 */

export const CF_WORKER_BASE_URL = 'https://ott-api.fussionbhakti3.workers.dev';

export interface BatchVideoEpisode {
  videoIndex: number;
  title: string;
  videoUrl: string;
  imageUrl: string;
  duration: string;
  description: string;
  uploadTime: number;
  durationSec: number;
  sizeMb: number;
}

export interface BatchVideoPayload {
  batchId: string;
  title: string;
  description: string;
  imageUrl: string;
  category: string;
  isPremium: boolean | number;
  releaseDate: number;
  totalVideos: number;
  videos: BatchVideoEpisode[];
  [key: string]: any;
}

export interface ShortReelPayload {
  id?: number | string;
  title: string;
  description: string;
  imageUrl: string;
  videoUrl: string;
  likesCount: string;
  isLiked: number | boolean;
  createdAt: number;
  [key: string]: any;
}

export interface ComicChapter {
  chapterNumber: number;
  title: string;
  pagesCsv: string;
  pdfUrl?: string;
}

export interface ComicPayload {
  id?: number;
  title: string;
  category: string;
  imageUrl: string;
  description: string;
  likesCount: string;
  isPremium: number | boolean;
  chapters: ComicChapter[];
  [key: string]: any;
}

export interface AudioStoryPayload {
  id?: number;
  title: string;
  category: string;
  imageUrl: string;
  content: string;
  audioUrl: string;
  duration: string;
  isPremium: number | boolean;
  releaseDate: number;
  [key: string]: any;
}

export interface ChannelPayload {
  id?: number;
  name: string;
  imageUrl: string;
  [key: string]: any;
}

export interface VideoItem {
  id: number;
  title: string;
  description: string;
  imageUrl: string;
  reelsUrl: string;
  category: string;
  categories?: string[]; // Multiple categories array support
  isPremium: boolean;
  rating: number;
  likesCount: string;
  [key: string]: any;
}

export interface VideoCategory {
  id: string;
  name: string;
  isPortrait: boolean;
  type: string;
  videos: VideoItem[];
  videosJson?: string;
  [key: string]: any;
}

export type VideoCategoryPayload = VideoCategory;

export interface CollectionStat {
  total_documents: number;
  raw_chunks?: number;
  url: string;
}

export interface CloudflareStatsResponse {
  status: string;
  database: string;
  collections: {
    comics?: CollectionStat;
    stories?: CollectionStat;
    categories?: CollectionStat;
    video_categories?: CollectionStat;
    channels?: CollectionStat;
    reels?: CollectionStat;
    version?: CollectionStat;
    userdata?: CollectionStat;
    fcm_history?: CollectionStat;
    ad_config?: CollectionStat;
    notifications?: CollectionStat;
    audio_batches?: CollectionStat;
    [key: string]: CollectionStat | undefined;
  };
}

/**
 * Upload helper conforming to user requirement:
 * export async function uploadToCloudflare(endpoint, payload) { ... }
 */
export async function uploadToCloudflare<T = any>(
  endpoint: string,
  payload: any
): Promise<T> {
  const cleanEndpoint = endpoint.replace(/^\/+|\/+$/g, '').replace(/^api\//, '');
  const url = `${CF_WORKER_BASE_URL}/api/${cleanEndpoint}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare Upload failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as T;
}

/**
 * Fetch items from Cloudflare Worker REST API
 */
export async function fetchFromCloudflare<T = any>(endpoint: string): Promise<T> {
  const cleanEndpoint = endpoint.replace(/^\/+|\/+$/g, '').replace(/^api\//, '');
  const url = `${CF_WORKER_BASE_URL}/api/${cleanEndpoint}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare GET failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as T;
}

/**
 * Fetch overall database statistics
 */
export async function fetchDatabaseStats(): Promise<CloudflareStatsResponse> {
  return await fetchFromCloudflare<CloudflareStatsResponse>('stats');
}

/**
 * Fetch all categories with parsed videos
 */
export async function getCategories(): Promise<VideoCategory[]> {
  const data = await fetchFromCloudflare<any>('video_categories');
  const rawList = Array.isArray(data)
    ? data.flat(2)
    : data?.data || data?.categories || [];

  return rawList.map((cat: any) => {
    let parsedVideos: VideoItem[] = [];
    if (Array.isArray(cat.videos)) {
      parsedVideos = cat.videos;
    } else if (cat.videosJson) {
      try {
        parsedVideos = typeof cat.videosJson === 'string' ? JSON.parse(cat.videosJson) : cat.videosJson;
      } catch {
        parsedVideos = [];
      }
    }
    return {
      id: String(cat.id || ''),
      name: String(cat.name || ''),
      isPortrait: Boolean(cat.isPortrait),
      type: 'video',
      videos: Array.isArray(parsedVideos) ? parsedVideos : [],
      videosJson: typeof cat.videosJson === 'string' ? cat.videosJson : JSON.stringify(parsedVideos),
    };
  });
}

/**
 * Create a new video category
 */
export async function createCategory(
  name: string,
  isPortrait: boolean = false,
  customId?: string
): Promise<any> {
  const cleanName = name.trim();
  const id = customId?.trim() || `cat_${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  const payload: VideoCategory = {
    id,
    name: cleanName,
    isPortrait,
    type: 'video',
    videos: [],
    videosJson: JSON.stringify([]),
  };

  return await uploadToCloudflare('video_categories', payload);
}

/**
 * Add a single video into an existing category (Checks for duplicates)
 */
export async function addVideoToCategory(
  categoryId: string,
  newVideo: Partial<VideoItem> & { videoUrl?: string; forcePush?: boolean }
): Promise<{ success: boolean; skipped?: boolean; reason?: string; category: VideoCategory }> {
  const categories = await getCategories();
  const category = categories.find((c) => c.id === categoryId);
  if (!category) throw new Error(`Category "${categoryId}" not found`);

  const streamUrl = (newVideo.reelsUrl || newVideo.videoUrl || '').trim();
  const title = (newVideo.title || '').trim();

  const genericTitles = new Set(['extracted video', 'processed video', 'untitled video', 'video']);
  const isNonGenericTitle = Boolean(title) && !genericTitles.has(title.toLowerCase());

  // Duplicate Check: Check if video with same stream URL or same non-generic title (when URL absent) already exists
  const alreadyExists = category.videos.some(
    (v) =>
      (streamUrl && v.reelsUrl?.trim().toLowerCase() === streamUrl.toLowerCase()) ||
      (!streamUrl && isNonGenericTitle && v.title?.trim().toLowerCase() === title.toLowerCase())
  );

  if (alreadyExists && !newVideo.forcePush) {
    return {
      success: false,
      skipped: true,
      reason: `Already in "${category.name}". Skipped to prevent duplicate in this category.`,
      category,
    };
  }

  const existingCategories = Array.isArray(newVideo.categories) ? newVideo.categories : [];
  const mergedCategories = Array.from(new Set([...existingCategories, category.name]));

  const videoItem: VideoItem = {
    id: typeof newVideo.id === 'number' && newVideo.id > 0 ? newVideo.id : Date.now(),
    title: title || 'Untitled Video',
    description: newVideo.description || '',
    imageUrl: newVideo.imageUrl || '',
    reelsUrl: streamUrl,
    category: category.name,
    categories: mergedCategories,
    isPremium: Boolean(newVideo.isPremium),
    rating: Number(newVideo.rating) || 4.5,
    likesCount: newVideo.likesCount || '1.5k',
  };

  category.videos = [...category.videos, videoItem];
  category.videosJson = JSON.stringify(category.videos);

  const res = await uploadToCloudflare('video_categories', category);
  return { success: true, skipped: false, category: res };
}

/**
 * Add multiple / batch videos into a category with duplicate skipping and manual push support
 */
export async function addBatchVideosToCategory(
  categoryId: string,
  newVideos: Array<Partial<VideoItem> & { videoUrl?: string; forcePush?: boolean }>,
  fallbackCategoryInfo?: { name?: string; isPortrait?: boolean }
): Promise<{
  success: boolean;
  addedCount: number;
  skippedVideos: Array<{ video: Partial<VideoItem>; reason: string }>;
  category: VideoCategory;
}> {
  const categories = await getCategories();
  let category = categories.find((c) => c.id === categoryId);

  if (!category && fallbackCategoryInfo?.name) {
    category = categories.find(
      (c) => c.name.toLowerCase() === fallbackCategoryInfo.name!.toLowerCase()
    );
  }

  const categoryName = category?.name || fallbackCategoryInfo?.name || 'Trending Videos';
  const isPortrait = category ? category.isPortrait : Boolean(fallbackCategoryInfo?.isPortrait);
  const targetId = category?.id || categoryId;
  const existingVideos = category?.videos || [];

  const skippedVideos: Array<{ video: Partial<VideoItem>; reason: string }> = [];
  const toAdd: VideoItem[] = [];
  const baseTimestamp = Date.now();

  newVideos.forEach((item, idx) => {
    const streamUrl = (item.reelsUrl || item.videoUrl || '').trim();
    const title = (item.title || '').trim();

    const genericTitles = new Set(['extracted video', 'processed video', 'untitled video', 'video']);
    const isNonGenericTitle = Boolean(title) && !genericTitles.has(title.toLowerCase());

    // Check if already exists in this target category
    const duplicate = existingVideos.some(
      (v) =>
        (streamUrl && v.reelsUrl?.trim().toLowerCase() === streamUrl.toLowerCase()) ||
        (!streamUrl && isNonGenericTitle && v.title?.trim().toLowerCase() === title.toLowerCase())
    );

    if (duplicate && !item.forcePush) {
      skippedVideos.push({
        video: item,
        reason: `Already in "${categoryName}". Skipped duplicate.`,
      });
      return;
    }

    const distinctId =
      typeof item.id === 'number' && item.id > 0
        ? item.id
        : baseTimestamp + idx * 10 + Math.floor(Math.random() * 9);

    const existingCategories = Array.isArray(item.categories) ? item.categories : [];
    const mergedCategories = Array.from(new Set([...existingCategories, categoryName]));

    toAdd.push({
      id: distinctId,
      title: title || `Video ${idx + 1}`,
      description: item.description || '',
      imageUrl: item.imageUrl || '',
      reelsUrl: streamUrl,
      category: categoryName,
      categories: mergedCategories,
      isPremium: Boolean(item.isPremium),
      rating: Number(item.rating) || 4.5,
      likesCount: item.likesCount || '2.4k',
    });
  });

  const mergedVideos = [...existingVideos, ...toAdd];
  const payload: VideoCategory = {
    id: targetId,
    name: categoryName,
    isPortrait,
    type: 'video',
    videos: mergedVideos,
    videosJson: JSON.stringify(mergedVideos),
  };

  const uploadResult = await uploadToCloudflare('video_categories', payload);

  return {
    success: true,
    addedCount: toAdd.length,
    skippedVideos,
    category: uploadResult,
  };
}

/**
 * Remove a video from an existing category
 */
export async function removeVideoFromCategory(
  categoryId: string,
  videoId: number
): Promise<any> {
  const categories = await getCategories();
  const category = categories.find((c) => c.id === categoryId);
  if (!category) throw new Error(`Category "${categoryId}" not found`);

  category.videos = category.videos.filter((v) => v.id !== videoId);
  category.videosJson = JSON.stringify(category.videos);

  return await uploadToCloudflare('video_categories', category);
}
