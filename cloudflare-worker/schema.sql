-- Cloudflare D1 SQLite Schema for OTT & Streaming Admin Studio
-- Paste directly into Cloudflare Dashboard -> D1 -> ott-database -> Console

-- 1. Video Categories & Nested Video Items (GET/POST /api/video_categories)
CREATE TABLE IF NOT EXISTS video_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  isPortrait INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'video',
  videosJson TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_categories_updated ON video_categories (updatedAt DESC);

-- 2. General / Comic Categories (GET/POST /api/categories)
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  isPortrait INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'comic',
  videosJson TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- 3. Batch Videos & Web Series (GET/POST /api/batchvideo)
CREATE TABLE IF NOT EXISTS batchvideo (
  batchId TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  imageUrl TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Web Series',
  isPremium INTEGER NOT NULL DEFAULT 0,
  releaseDate INTEGER NOT NULL,
  totalVideos INTEGER NOT NULL DEFAULT 0,
  videosJson TEXT NOT NULL DEFAULT '[]',
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batchvideo_release ON batchvideo (releaseDate DESC);

-- 4. Short Reels (GET/POST /api/reels)
CREATE TABLE IF NOT EXISTS reels (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  imageUrl TEXT NOT NULL DEFAULT '',
  videoUrl TEXT NOT NULL,
  likesCount TEXT NOT NULL DEFAULT '0',
  isLiked INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reels_created ON reels (createdAt DESC);

-- 5. Comics & Manga (GET/POST /api/comics)
CREATE TABLE IF NOT EXISTS comics (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  imageUrl TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  likesCount TEXT NOT NULL DEFAULT '0',
  isPremium INTEGER NOT NULL DEFAULT 0,
  chaptersJson TEXT NOT NULL DEFAULT '[]',
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comics_updated ON comics (updatedAt DESC);

-- 6. Audio & Multi-Part Stories (GET/POST /api/stories)
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Audio Story',
  imageUrl TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  audioUrl TEXT NOT NULL DEFAULT '',
  partsJson TEXT NOT NULL DEFAULT '[]',
  duration TEXT NOT NULL DEFAULT '',
  isPremium INTEGER NOT NULL DEFAULT 0,
  releaseDate INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_release ON stories (releaseDate DESC);

-- 7. Live TV Channels (GET/POST /api/channels)
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  imageUrl TEXT NOT NULL DEFAULT '',
  streamUrl TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL
);

-- 8. Companion Collections (userdata, audio_batches, notifications, fcm_history, ad_config, version)
CREATE TABLE IF NOT EXISTS userdata (
  id TEXT PRIMARY KEY,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_batches (
  id TEXT PRIMARY KEY,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fcm_history (
  id TEXT PRIMARY KEY,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ad_config (
  id TEXT PRIMARY KEY,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS version (
  id TEXT PRIMARY KEY,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

-- 9. Extracted Links Deduplication Registry (GET/POST/DELETE /api/links_registry)
CREATE TABLE IF NOT EXISTS links_registry (
  id TEXT PRIMARY KEY,
  sourceUrl TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'extracted',
  cloudflareVideoUrl TEXT NOT NULL DEFAULT '',
  cloudflareThumbnailUrl TEXT NOT NULL DEFAULT '',
  payloadJson TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_registry_source ON links_registry (sourceUrl);
CREATE INDEX IF NOT EXISTS idx_links_registry_updated ON links_registry (updatedAt DESC);
