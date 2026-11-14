/**
 * Ready-to-Deploy Cloudflare Worker + D1 REST API (TypeScript version for Wrangler)
 * Matches all endpoints and payloads across all 12 collections.
 */

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface Env {
  DB: D1DatabaseLike;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw as T) ?? fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function getTableCount(db: D1DatabaseLike, tableName: string): Promise<number> {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

async function readJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON request body');
  }
}

const GENERIC_JSON_COLLECTIONS: Record<string, { timeCol: string; idKeys: string[] }> = {
  userdata: { timeCol: 'updatedAt', idKeys: ['userid', 'id', '_id'] },
  audio_batches: { timeCol: 'updatedAt', idKeys: ['_id', 'id', 'batchName'] },
  notifications: { timeCol: 'createdAt', idKeys: ['_id', 'id'] },
  fcm_history: { timeCol: 'createdAt', idKeys: ['_id', 'id'] },
  ad_config: { timeCol: 'updatedAt', idKeys: ['_id', 'id'] },
  version: { timeCol: 'updatedAt', idKeys: ['_id', 'id'] },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (!env.DB) {
      return jsonResponse({ error: 'D1 binding "DB" is missing.' }, 500);
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const segments = pathname.split('/').filter(Boolean);

    try {
      if (pathname === '/' || pathname === '/api' || pathname === '/api/stats') {
        const [vc, ct, bv, rl, cm, st, ch, ud, ab, nt, fh, ac, vr, lr] = await Promise.all([
          getTableCount(env.DB, 'video_categories'),
          getTableCount(env.DB, 'categories'),
          getTableCount(env.DB, 'batchvideo'),
          getTableCount(env.DB, 'reels'),
          getTableCount(env.DB, 'comics'),
          getTableCount(env.DB, 'stories'),
          getTableCount(env.DB, 'channels'),
          getTableCount(env.DB, 'userdata'),
          getTableCount(env.DB, 'audio_batches'),
          getTableCount(env.DB, 'notifications'),
          getTableCount(env.DB, 'fcm_history'),
          getTableCount(env.DB, 'ad_config'),
          getTableCount(env.DB, 'version'),
          getTableCount(env.DB, 'links_registry'),
        ]);
        const o = url.origin;
        return jsonResponse({
          status: 'active',
          database: 'Cloudflare D1',
          collections: {
            video_categories: { total_documents: vc, url: `${o}/api/video_categories` },
            categories: { total_documents: ct, url: `${o}/api/categories` },
            batchvideo: { total_documents: bv, url: `${o}/api/batchvideo` },
            reels: { total_documents: rl, url: `${o}/api/reels` },
            comics: { total_documents: cm, url: `${o}/api/comics` },
            stories: { total_documents: st, url: `${o}/api/stories` },
            channels: { total_documents: ch, url: `${o}/api/channels` },
            userdata: { total_documents: ud, url: `${o}/api/userdata` },
            audio_batches: { total_documents: ab, url: `${o}/api/audio_batches` },
            notifications: { total_documents: nt, url: `${o}/api/notifications` },
            fcm_history: { total_documents: fh, url: `${o}/api/fcm_history` },
            ad_config: { total_documents: ac, url: `${o}/api/ad_config` },
            version: { total_documents: vr, url: `${o}/api/version` },
            links_registry: { total_documents: lr, url: `${o}/api/links_registry` },
          },
        });
      }

      if (segments[0] !== 'api' || segments.length < 2) {
        return jsonResponse({ error: 'Not found', path: pathname }, 404);
      }

      const collection = segments[1];
      const itemIdParam = segments[2] ? decodeURIComponent(segments[2]) : null;

      if (collection === 'video_categories' || collection === 'categories') {
        const table = collection === 'categories' ? 'categories' : 'video_categories';
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT id, name, isPortrait, type, videosJson FROM ${table} ORDER BY createdAt ASC, name ASC`
          ).all<Record<string, any>>();
          return jsonResponse(
            results.map((r) => {
              const videos = safeJsonParse<any[]>(r.videosJson, []);
              return {
                id: String(r.id),
                name: String(r.name),
                isPortrait: Boolean(r.isPortrait),
                type: String(r.type || (table === 'categories' ? 'comic' : 'video')),
                videos,
                videosJson: typeof r.videosJson === 'string' ? r.videosJson : JSON.stringify(videos),
              };
            })
          );
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const name = String(body.name || '').trim();
          if (!name && !body.id) return jsonResponse({ error: 'Category id or name is required' }, 400);
          const id =
            String(body.id ?? '').trim() ||
            `cat_${name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_')}`;
          const isPortrait = body.isPortrait ? 1 : 0;
          const type = String(body.type || (table === 'categories' ? 'comic' : 'video'));
          const videos = Array.isArray(body.videos) ? body.videos : safeJsonParse<any[]>(body.videosJson, []);
          const videosJson =
            typeof body.videosJson === 'string' && !Array.isArray(body.videos)
              ? body.videosJson
              : JSON.stringify(videos);
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO ${table} (id, name, isPortrait, type, videosJson, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               isPortrait = excluded.isPortrait,
               type = excluded.type,
               videosJson = excluded.videosJson,
               updatedAt = excluded.updatedAt`
          )
            .bind(id, name || id, isPortrait, type, videosJson, now, now)
            .run();
          return jsonResponse({ id, name: name || id, isPortrait: Boolean(isPortrait), type, videos, videosJson });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(itemIdParam).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (collection === 'batchvideo') {
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT batchId, title, description, imageUrl, category, isPremium, releaseDate, totalVideos, videosJson FROM batchvideo ORDER BY releaseDate DESC`
          ).all<Record<string, any>>();
          return jsonResponse(
            results.map((r) => {
              const videos = safeJsonParse<any[]>(r.videosJson, []);
              return {
                batchId: String(r.batchId),
                title: String(r.title),
                description: String(r.description || ''),
                imageUrl: String(r.imageUrl || ''),
                category: String(r.category || 'Web Series'),
                isPremium: Boolean(r.isPremium),
                releaseDate: Number(r.releaseDate) || 0,
                totalVideos: Number(r.totalVideos ?? videos.length),
                videos,
              };
            })
          );
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const title = String(body.title || '').trim();
          const batchId = String(body.batchId || body.id || '').trim() || `batch_${Date.now().toString(36)}`;
          if (!title) return jsonResponse({ error: 'title is required' }, 400);
          const videos = Array.isArray(body.videos) ? body.videos : safeJsonParse<any[]>(body.videosJson, []);
          const videosJson = JSON.stringify(videos);
          const description = String(body.description || '');
          const imageUrl = String(body.imageUrl || '');
          const category = String(body.category || 'Web Series');
          const isPremium = body.isPremium ? 1 : 0;
          const releaseDate = Number(body.releaseDate) || Date.now();
          const totalVideos = Number(body.totalVideos ?? videos.length);
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO batchvideo (batchId, title, description, imageUrl, category, isPremium, releaseDate, totalVideos, videosJson, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(batchId) DO UPDATE SET
               title = excluded.title,
               description = excluded.description,
               imageUrl = excluded.imageUrl,
               category = excluded.category,
               isPremium = excluded.isPremium,
               releaseDate = excluded.releaseDate,
               totalVideos = excluded.totalVideos,
               videosJson = excluded.videosJson,
               updatedAt = excluded.updatedAt`
          )
            .bind(batchId, title, description, imageUrl, category, isPremium, releaseDate, totalVideos, videosJson, now)
            .run();
          return jsonResponse({ success: true, batchId, title, description, imageUrl, category, isPremium: Boolean(isPremium), releaseDate, totalVideos, videos });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM batchvideo WHERE batchId = ?`).bind(itemIdParam).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (collection === 'reels') {
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT id, title, description, imageUrl, videoUrl, likesCount, isLiked, createdAt FROM reels ORDER BY createdAt DESC, id DESC`
          ).all<Record<string, any>>();
          return jsonResponse(results);
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const id = Number(body.id) || Date.now();
          const title = String(body.title || '').trim();
          const videoUrl = String(body.videoUrl || '').trim();
          if (!title || !videoUrl) return jsonResponse({ error: 'title and videoUrl are required' }, 400);
          const description = String(body.description || '');
          const imageUrl = String(body.imageUrl || '');
          const likesCount = String(body.likesCount || '0');
          const isLiked = body.isLiked ? 1 : 0;
          const createdAt = Number(body.createdAt) || Date.now();
          await env.DB.prepare(
            `INSERT INTO reels (id, title, description, imageUrl, videoUrl, likesCount, isLiked, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               description = excluded.description,
               imageUrl = excluded.imageUrl,
               videoUrl = excluded.videoUrl,
               likesCount = excluded.likesCount,
               isLiked = excluded.isLiked,
               createdAt = excluded.createdAt,
               updatedAt = excluded.updatedAt`
          )
            .bind(id, title, description, imageUrl, videoUrl, likesCount, isLiked, createdAt, Date.now())
            .run();
          return jsonResponse({ success: true, id, title, description, imageUrl, videoUrl, likesCount, isLiked, createdAt });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM reels WHERE id = ?`).bind(Number(itemIdParam)).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (collection === 'comics') {
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT id, title, category, imageUrl, description, likesCount, isPremium, chaptersJson FROM comics ORDER BY updatedAt DESC, id DESC`
          ).all<Record<string, any>>();
          return jsonResponse(
            results.map((r) => ({
              id: Number(r.id),
              title: String(r.title),
              category: String(r.category || 'General'),
              imageUrl: String(r.imageUrl || ''),
              description: String(r.description || ''),
              likesCount: String(r.likesCount || '0'),
              isPremium: Number(r.isPremium ? 1 : 0),
              chaptersJson: typeof r.chaptersJson === 'string' ? r.chaptersJson : JSON.stringify(r.chaptersJson || []),
              chapters: safeJsonParse<any[]>(r.chaptersJson, []),
            }))
          );
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const id = Number(body.id) || Date.now();
          const title = String(body.title || '').trim();
          if (!title) return jsonResponse({ error: 'title is required' }, 400);
          const category = String(body.category || 'General');
          const imageUrl = String(body.imageUrl || '');
          const description = String(body.description || '');
          const likesCount = String(body.likesCount || '0');
          const isPremium = body.isPremium ? 1 : 0;
          const chapters = Array.isArray(body.chapters) ? body.chapters : safeJsonParse<any[]>(body.chaptersJson, []);
          const chaptersJson =
            typeof body.chaptersJson === 'string' && !Array.isArray(body.chapters)
              ? body.chaptersJson
              : JSON.stringify(chapters);
          await env.DB.prepare(
            `INSERT INTO comics (id, title, category, imageUrl, description, likesCount, isPremium, chaptersJson, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               category = excluded.category,
               imageUrl = excluded.imageUrl,
               description = excluded.description,
               likesCount = excluded.likesCount,
               isPremium = excluded.isPremium,
               chaptersJson = excluded.chaptersJson,
               updatedAt = excluded.updatedAt`
          )
            .bind(id, title, category, imageUrl, description, likesCount, isPremium, chaptersJson, Date.now())
            .run();
          return jsonResponse({ success: true, id, title, category, imageUrl, description, likesCount, isPremium, chapters });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM comics WHERE id = ?`).bind(Number(itemIdParam)).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (collection === 'stories') {
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT id, title, category, imageUrl, content, audioUrl, partsJson, duration, isPremium, releaseDate FROM stories ORDER BY releaseDate DESC, id DESC`
          ).all<Record<string, any>>();
          return jsonResponse(
            results.map((r) => ({
              id: Number(r.id),
              title: String(r.title),
              category: String(r.category || 'Audio Story'),
              imageUrl: String(r.imageUrl || ''),
              content: String(r.content || ''),
              audioUrl: String(r.audioUrl || ''),
              partsJson: typeof r.partsJson === 'string' ? r.partsJson : JSON.stringify(r.partsJson || []),
              duration: String(r.duration || ''),
              isPremium: Boolean(r.isPremium),
              releaseDate: Number(r.releaseDate) || 0,
            }))
          );
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const id = Number(body.id) || Date.now();
          const title = String(body.title || '').trim();
          if (!title) return jsonResponse({ error: 'title is required' }, 400);
          const category = String(body.category || 'Audio Story');
          const imageUrl = String(body.imageUrl || '');
          const content = String(body.content || '');
          const audioUrl = String(body.audioUrl || '');
          const partsJson =
            typeof body.partsJson === 'string'
              ? body.partsJson
              : JSON.stringify(Array.isArray(body.parts) ? body.parts : []);
          const duration = String(body.duration || '');
          const isPremium = body.isPremium ? 1 : 0;
          const releaseDate = Number(body.releaseDate) || Date.now();
          await env.DB.prepare(
            `INSERT INTO stories (id, title, category, imageUrl, content, audioUrl, partsJson, duration, isPremium, releaseDate, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               category = excluded.category,
               imageUrl = excluded.imageUrl,
               content = excluded.content,
               audioUrl = excluded.audioUrl,
               partsJson = excluded.partsJson,
               duration = excluded.duration,
               isPremium = excluded.isPremium,
               releaseDate = excluded.releaseDate,
               updatedAt = excluded.updatedAt`
          )
            .bind(id, title, category, imageUrl, content, audioUrl, partsJson, duration, isPremium, releaseDate, Date.now())
            .run();
          return jsonResponse({ success: true, id, title, category, imageUrl, content, audioUrl, partsJson, duration, isPremium: Boolean(isPremium), releaseDate });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM stories WHERE id = ?`).bind(Number(itemIdParam)).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (collection === 'channels') {
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT id, name, imageUrl, streamUrl FROM channels ORDER BY id ASC`
          ).all<Record<string, any>>();
          return jsonResponse(results);
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const id = Number(body.id) || Date.now();
          const name = String(body.name || '').trim();
          if (!name) return jsonResponse({ error: 'name is required' }, 400);
          const imageUrl = String(body.imageUrl || '');
          const streamUrl = String(body.streamUrl || '');
          await env.DB.prepare(
            `INSERT INTO channels (id, name, imageUrl, streamUrl, updatedAt)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               imageUrl = excluded.imageUrl,
               streamUrl = excluded.streamUrl,
               updatedAt = excluded.updatedAt`
          )
            .bind(id, name, imageUrl, streamUrl, Date.now())
            .run();
          return jsonResponse({ success: true, id, name, imageUrl, streamUrl });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM channels WHERE id = ?`).bind(Number(itemIdParam)).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (GENERIC_JSON_COLLECTIONS[collection]) {
        const cfg = GENERIC_JSON_COLLECTIONS[collection];
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT id, payloadJson FROM ${collection} ORDER BY ${cfg.timeCol} DESC`
          ).all<Record<string, any>>();
          return jsonResponse(
            results.map((r) => ({
              _id: String(r.id),
              ...safeJsonParse<Record<string, any>>(r.payloadJson, {}),
            }))
          );
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const items = Array.isArray(body) ? body : [body];
          const stmt = env.DB.prepare(
            `INSERT INTO ${collection} (id, payloadJson, ${cfg.timeCol})
             VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               payloadJson = excluded.payloadJson,
               ${cfg.timeCol} = excluded.${cfg.timeCol}`
          );
          const statements: D1PreparedStatementLike[] = [];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            let resolvedId = '';
            for (const k of cfg.idKeys) {
              if (item[k] !== undefined && item[k] !== null && String(item[k]).trim()) {
                resolvedId = String(item[k]).trim();
                break;
              }
            }
            if (!resolvedId) {
              resolvedId = `${collection}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            }
            const ts = Number(item.timestamp || item.updatedAt || item.createdAt) || Date.now();
            statements.push(stmt.bind(resolvedId, JSON.stringify(item), ts));
          }
          if (statements.length === 1) {
            await statements[0].run();
          } else if (statements.length > 1) {
            await env.DB.batch(statements);
          }
          return jsonResponse({ success: true, upserted: statements.length });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM ${collection} WHERE id = ?`).bind(itemIdParam).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      if (collection === 'links_registry') {
        if (request.method === 'GET') {
          const { results = [] } = await env.DB.prepare(
            `SELECT payloadJson FROM links_registry ORDER BY updatedAt DESC`
          ).all<Record<string, any>>();
          return jsonResponse(results.map((r) => safeJsonParse<Record<string, any>>(r.payloadJson, {})));
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await readJsonBody(request);
          const items = Array.isArray(body) ? body : Array.isArray(body?.links) ? body.links : [body];
          const stmt = env.DB.prepare(
            `INSERT INTO links_registry (id, sourceUrl, title, status, cloudflareVideoUrl, cloudflareThumbnailUrl, payloadJson, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               sourceUrl = excluded.sourceUrl,
               title = excluded.title,
               status = excluded.status,
               cloudflareVideoUrl = excluded.cloudflareVideoUrl,
               cloudflareThumbnailUrl = excluded.cloudflareThumbnailUrl,
               payloadJson = excluded.payloadJson,
               updatedAt = excluded.updatedAt`
          );
          const statements: D1PreparedStatementLike[] = [];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id || '').trim() || `link_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const sourceUrl = String(item.sourceUrl || '');
            const title = String(item.title || '');
            const status = String(item.status || 'extracted');
            const cfVid = String(item.cloudflareVideoUrl || '');
            const cfThumb = String(item.cloudflareThumbnailUrl || '');
            const updatedAt = Date.parse(item.lastUpdatedAt || '') || Date.now();
            statements.push(stmt.bind(id, sourceUrl, title, status, cfVid, cfThumb, JSON.stringify(item), updatedAt));
          }
          if (statements.length === 1) {
            await statements[0].run();
          } else if (statements.length > 1) {
            await env.DB.batch(statements);
          }
          return jsonResponse({ success: true, upserted: statements.length });
        }
        if (request.method === 'DELETE' && itemIdParam) {
          await env.DB.prepare(`DELETE FROM links_registry WHERE id = ?`).bind(itemIdParam).run();
          return jsonResponse({ success: true, deletedId: itemIdParam });
        }
      }

      return jsonResponse({ error: `Unsupported route or method: ${request.method} ${pathname}` }, 404);
    } catch (err: any) {
      return jsonResponse({ error: err?.message || 'Internal Cloudflare Worker error' }, 500);
    }
  },
};
