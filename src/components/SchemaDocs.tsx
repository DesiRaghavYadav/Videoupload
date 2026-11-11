import React, { useState } from 'react';
import {
  Database,
  Terminal,
  Copy,
  Check,
  Film,
  PlaySquare,
  BookOpen,
  Headphones,
  Tv,
  FileCode,
  ExternalLink,
  Zap,
  FolderTree,
} from 'lucide-react';
import { CF_WORKER_BASE_URL } from '../services/cloudflareWorkerApi';

export const SchemaDocs: React.FC = () => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const JS_HELPER_CODE = `export async function uploadToCloudflare(endpoint, payload) {
  const url = \`https://ott-api.5abhishektrialhae.workers.dev/api/\${endpoint}\`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(\`Cloudflare Upload failed (\${response.status}): \${errorText}\`);
  }

  return await response.json();
}`;

  const BATCH_VIDEO_SCHEMA = `{
  "batchId": "series_unique_id_01",
  "title": "Midnight Shadows: The Syndicate",
  "description": "An undercover agent gets embroiled in a web of deceit across the city.",
  "imageUrl": "https://example.com/poster.jpg",
  "category": "Crime Thriller",
  "isPremium": true,
  "releaseDate": 1730900000000,
  "totalVideos": 2,
  "videos": [
    {
      "videoIndex": 1,
      "title": "Episode 1: The Informant",
      "videoUrl": "https://example.com/videos/ep1.mp4",
      "imageUrl": "https://example.com/thumbnails/ep1.jpg",
      "duration": "22 min",
      "description": "Episode 1 synopsis",
      "uploadTime": 1730900000000,
      "durationSec": 1320,
      "sizeMb": 185.5
    },
    {
      "videoIndex": 2,
      "title": "Episode 2: Point of No Return",
      "videoUrl": "https://example.com/videos/ep2.mp4",
      "imageUrl": "https://example.com/thumbnails/ep2.jpg",
      "duration": "24 min",
      "description": "Episode 2 synopsis",
      "uploadTime": 1730986400000,
      "durationSec": 1440,
      "sizeMb": 210.0
    }
  ]
}`;

  const REEL_SCHEMA = `{
  "id": 101,
  "title": "Viral Dance Moves",
  "description": "Trending stage reel performance",
  "imageUrl": "https://example.com/reel_poster.jpg",
  "videoUrl": "https://example.com/reels/clip1.mp4",
  "likesCount": "12.5k",
  "isLiked": 0,
  "createdAt": 1730900000000
}`;

  const COMIC_SCHEMA = `{
  "id": 1,
  "title": "Solo Leveling Chronicle",
  "category": "Action & Fantasy",
  "imageUrl": "https://example.com/comic_cover.jpg",
  "description": "The weakest hunter becomes the strongest sovereign.",
  "likesCount": "50k",
  "isPremium": 1,
  "chapters": [
    {
      "chapterNumber": 1,
      "title": "Chapter 1: The D-Rank Dungeon",
      "pagesCsv": "https://example.com/p1.jpg,https://example.com/p2.jpg,https://example.com/p3.jpg",
      "pdfUrl": ""
    }
  ]
}`;

  const STORY_SCHEMA = `{
  "id": 1,
  "title": "The Haunted Cabin",
  "category": "Horror & Mystery",
  "imageUrl": "https://example.com/audio_cover.jpg",
  "content": "Deep in the woods lies a secret.",
  "audioUrl": "https://example.com/audio/ep1.mp3",
  "duration": "18 min",
  "isPremium": 0,
  "releaseDate": 1730900000000
}`;

  const CHANNEL_SCHEMA = `{
  "id": 1,
  "name": "Live Cinema HD",
  "imageUrl": "https://example.com/channel_logo.jpg"
}`;

  const CATEGORY_SCHEMA = `{
  "id": "cat_action_01",
  "name": "Action & Adventure",
  "isPortrait": false,
  "type": "video",
  "videos": [
    {
      "id": 101,
      "title": "Stealth Mission Alpha",
      "description": "Special forces team infiltrates a rogue facility.",
      "imageUrl": "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad",
      "reelsUrl": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      "category": "Action & Adventure",
      "isPremium": false,
      "rating": 4.8,
      "likesCount": "24k"
    }
  ]
}`;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Intro */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-orange-400">
          <Zap className="w-4 h-4" />
          <span>Cloudflare Worker REST API Specifications</span>
        </div>
        <h2 className="text-xl font-bold text-white tracking-tight">
          Cloudflare D1 &amp; Worker REST Endpoints
        </h2>
        <p className="text-xs text-slate-300 leading-relaxed">
          Base URL:{' '}
          <code className="text-orange-400 font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
            {CF_WORKER_BASE_URL}
          </code>
          . All endpoints support standard HTTP <code>POST</code> (with <code>Content-Type: application/json</code>) and <code>GET</code>. CORS is enabled (<code>*</code>) for browser and backend calls.
        </p>
      </div>

      {/* Helper Function */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <FileCode className="w-4 h-4 text-emerald-400" />
            <span>JavaScript / TypeScript API Helper Function</span>
          </h3>
          <button
            onClick={() => copyText(JS_HELPER_CODE, 'helper')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'helper' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'helper' ? 'Copied' : 'Copy Function'}
          </button>
        </div>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-emerald-400 overflow-x-auto leading-relaxed">
          {JS_HELPER_CODE}
        </pre>
      </div>

      {/* Endpoints Table */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Database className="w-4 h-4 text-orange-400" />
          <span>Available Endpoints &amp; Operations</span>
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="pb-2">Resource</th>
                <th className="pb-2">POST Endpoint</th>
                <th className="pb-2">GET Endpoint</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              <tr>
                <td className="py-2.5 text-orange-300 font-sans font-semibold">Batch Videos / Web Series</td>
                <td className="py-2.5 text-emerald-400">/api/batchvideo</td>
                <td className="py-2.5 text-sky-400">/api/batchvideo</td>
              </tr>
              <tr>
                <td className="py-2.5 text-rose-300 font-sans font-semibold">Short Reels</td>
                <td className="py-2.5 text-emerald-400">/api/reels</td>
                <td className="py-2.5 text-sky-400">/api/reels</td>
              </tr>
              <tr>
                <td className="py-2.5 text-violet-300 font-sans font-semibold">Comics &amp; Chapters</td>
                <td className="py-2.5 text-emerald-400">/api/comics</td>
                <td className="py-2.5 text-sky-400">/api/comics</td>
              </tr>
              <tr>
                <td className="py-2.5 text-emerald-300 font-sans font-semibold">Audio Stories &amp; Podcasts</td>
                <td className="py-2.5 text-emerald-400">/api/stories</td>
                <td className="py-2.5 text-sky-400">/api/stories</td>
              </tr>
              <tr>
                <td className="py-2.5 text-sky-300 font-sans font-semibold">Live TV Channels</td>
                <td className="py-2.5 text-emerald-400">/api/channels</td>
                <td className="py-2.5 text-sky-400">/api/channels</td>
              </tr>
              <tr>
                <td className="py-2.5 text-yellow-300 font-sans font-semibold">Video Categories &amp; Rails</td>
                <td className="py-2.5 text-emerald-400">/api/video_categories</td>
                <td className="py-2.5 text-sky-400">/api/video_categories</td>
              </tr>
              <tr>
                <td className="py-2.5 text-slate-400 font-sans font-semibold">Database Stats &amp; Count</td>
                <td className="py-2.5 text-slate-600">—</td>
                <td className="py-2.5 text-sky-400">/api/stats</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Schema A: Batch Videos */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Film className="w-4 h-4 text-orange-400" />
            <span>A) Batch Videos Schema (POST /api/batchvideo)</span>
          </h3>
          <button
            onClick={() => copyText(BATCH_VIDEO_SCHEMA, 'batch')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'batch' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'batch' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-orange-300 overflow-x-auto leading-relaxed">
          {BATCH_VIDEO_SCHEMA}
        </pre>
      </div>

      {/* Schema B: Short Reels */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <PlaySquare className="w-4 h-4 text-rose-400" />
            <span>B) Short Reels Schema (POST /api/reels)</span>
          </h3>
          <button
            onClick={() => copyText(REEL_SCHEMA, 'reel')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'reel' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'reel' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-rose-300 overflow-x-auto leading-relaxed">
          {REEL_SCHEMA}
        </pre>
      </div>

      {/* Schema C: Comics */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-violet-400" />
            <span>C) Comics &amp; Chapters Schema (POST /api/comics)</span>
          </h3>
          <button
            onClick={() => copyText(COMIC_SCHEMA, 'comic')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'comic' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'comic' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-violet-300 overflow-x-auto leading-relaxed">
          {COMIC_SCHEMA}
        </pre>
      </div>

      {/* Schema D: Audio Stories */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Headphones className="w-4 h-4 text-emerald-400" />
            <span>D) Audio Stories Schema (POST /api/stories)</span>
          </h3>
          <button
            onClick={() => copyText(STORY_SCHEMA, 'story')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'story' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'story' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto leading-relaxed">
          {STORY_SCHEMA}
        </pre>
      </div>

      {/* Schema E: Channels */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Tv className="w-4 h-4 text-sky-400" />
            <span>E) Channels Schema (POST /api/channels)</span>
          </h3>
          <button
            onClick={() => copyText(CHANNEL_SCHEMA, 'channel')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'channel' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'channel' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-sky-300 overflow-x-auto leading-relaxed">
          {CHANNEL_SCHEMA}
        </pre>
      </div>

      {/* Schema F: Video Categories & Home Rails */}
      <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <FolderTree className="w-4 h-4 text-yellow-400" />
            <span>F) Video Categories &amp; Rails Schema (POST /api/video_categories)</span>
          </h3>
          <button
            onClick={() => copyText(CATEGORY_SCHEMA, 'category')}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
          >
            {copiedKey === 'category' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'category' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Supports 16:9 Landscape (<code className="text-slate-300 font-mono">isPortrait: false</code>) and 9:16 Vertical Reel (<code className="text-slate-300 font-mono">isPortrait: true</code>) formats. The worker matches or inserts documents by <code className="text-yellow-400 font-mono">id</code>.
        </p>
        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-yellow-300 overflow-x-auto leading-relaxed">
          {CATEGORY_SCHEMA}
        </pre>
      </div>
    </div>
  );
};
