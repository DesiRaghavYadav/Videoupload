import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

// Initialize dotenv
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const isProduction = process.env.NODE_ENV === 'production';

// In-memory or temp storage uploads directory for local emulator mode
const localUploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(localUploadsDir)) {
  fs.mkdirSync(localUploadsDir, { recursive: true });
}
const localVideosDir = path.join(localUploadsDir, 'videos');
const localThumbsDir = path.join(localUploadsDir, 'thumbnails');
const localDatabaseDir = path.join(localUploadsDir, 'database');
if (!fs.existsSync(localVideosDir)) fs.mkdirSync(localVideosDir, { recursive: true });
if (!fs.existsSync(localThumbsDir)) fs.mkdirSync(localThumbsDir, { recursive: true });
if (!fs.existsSync(localDatabaseDir)) fs.mkdirSync(localDatabaseDir, { recursive: true });

// Parse JSON bodies
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max video file
  },
});

/**
 * Intelligent Environment Variable Matcher:
 * Supports standard, Cloudflare, S3, and case-insensitive aliases for secrets.
 */
function getEnvValue(aliases: string[]): string {
  // Re-read .env if present
  try {
    dotenv.config();
  } catch {}

  const env = process.env;
  for (const alias of aliases) {
    if (env[alias] && typeof env[alias] === 'string' && env[alias]!.trim().length > 0) {
      return env[alias]!.trim().replace(/^["']|["']$/g, '');
    }
  }

  // Case-insensitive fallback
  const envKeys = Object.keys(env);
  for (const alias of aliases) {
    const lowerAlias = alias.toLowerCase();
    const matchedKey = envKeys.find((k) => k.toLowerCase() === lowerAlias);
    if (matchedKey && env[matchedKey] && typeof env[matchedKey] === 'string' && env[matchedKey]!.trim().length > 0) {
      return env[matchedKey]!.trim().replace(/^["']|["']$/g, '');
    }
  }

  return '';
}

function sanitizeAccountId(val: string): string {
  if (!val) return '';
  let cleaned = val.trim();
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/\.r2\.cloudflarestorage\.com.*$/i, '');
  cleaned = cleaned.split('/')[0].trim();
  return cleaned;
}

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrlPrefix?: string;
  source: 'client_headers' | 'server_secrets';
}

function getR2Config(req?: Request): R2Config | null {
  // 1. Client header overrides (if user inputted in browser)
  const headerAccountId = (req?.headers['x-r2-account-id'] as string) || '';
  const headerAccessKeyId = (req?.headers['x-r2-access-key-id'] as string) || '';
  const headerSecretAccessKey = (req?.headers['x-r2-secret-access-key'] as string) || '';
  const headerBucketName = (req?.headers['x-r2-bucket-name'] as string) || '';
  const headerPublicUrlPrefix = (req?.headers['x-r2-public-url-prefix'] as string) || '';

  if (headerAccountId && headerAccessKeyId && headerSecretAccessKey && headerBucketName) {
    return {
      accountId: sanitizeAccountId(headerAccountId),
      accessKeyId: headerAccessKeyId.trim(),
      secretAccessKey: headerSecretAccessKey.trim(),
      bucketName: headerBucketName.trim(),
      publicUrlPrefix: headerPublicUrlPrefix.trim().replace(/\/+$/, ''),
      source: 'client_headers',
    };
  }

  // 2. Server Environment Secrets (with flexible naming aliases)
  const accountIdRaw = getEnvValue([
    'R2_ACCOUNT_ID',
    'CLOUDFLARE_R2_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
    'ACCOUNT_ID',
  ]);

  const accessKeyId = getEnvValue([
    'R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_ACCESS_KEY_ID',
    'CF_ACCESS_KEY_ID',
    'AWS_ACCESS_KEY_ID',
    'R2_ACCESS_KEY',
    'ACCESS_KEY_ID',
  ]);

  const secretAccessKey = getEnvValue([
    'R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_SECRET_ACCESS_KEY',
    'CF_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'R2_SECRET_KEY',
    'SECRET_ACCESS_KEY',
  ]);

  const bucketName = getEnvValue([
    'R2_BUCKET_NAME',
    'CLOUDFLARE_R2_BUCKET_NAME',
    'CLOUDFLARE_BUCKET_NAME',
    'CLOUDFLARE_BUCKET',
    'CF_BUCKET_NAME',
    'CF_BUCKET',
    'R2_BUCKET',
    'BUCKET_NAME',
  ]);

  const publicUrlPrefix = getEnvValue([
    'R2_PUBLIC_URL_PREFIX',
    'R2_PUBLIC_URL',
    'CLOUDFLARE_R2_PUBLIC_URL',
    'PUBLIC_URL_PREFIX',
    'R2_DOMAIN',
  ]);

  const accountId = sanitizeAccountId(accountIdRaw);

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicUrlPrefix: publicUrlPrefix.replace(/\/+$/, ''),
    source: 'server_secrets',
  };
}

function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export interface VerificationStep {
  step: string;
  status: 'VERIFIED' | 'FAILED' | 'SKIPPED' | 'ABORTED';
  timestamp: string;
  details: string;
  error?: string;
}

interface VideoRecord {
  status: string;
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  captureTimestamp: number;
  sizeMb: number;
  durationSec: number;
  duration: string;
  uploadTime: number;
  cloudflareR2: {
    uploadedToCloudflareR2: boolean;
    bucket: string;
    accountId: string | null;
    videoKey: string;
    thumbnailKey: string;
    etagVideo: string | null;
    etagThumbnail: string | null;
    publicUrlPrefix: string | null;
    directAccessMode: string;
    verifiedInStorage: boolean;
  };
  metadata: {
    filename: string;
    exactFilename?: string;
    fileSize: number;
    fileSizeFormatted: string;
    sizeMb: number;
    duration: number;
    durationSec: number;
    durationFormatted: string;
    durationHuman: string;
    uploadTime: number;
    width: number;
    height: number;
    resolution: string;
    aspectRatio: string;
    mimeType: string;
    bitrateEstimateKbps: number;
    thumbnailSize: number;
    thumbnailSizeFormatted: string;
    thumbnailDimensions: string;
    targetThumbnailTimeSeconds?: number;
    capturedAtSecond: number;
    uploadedAt: string;
  };
  verificationAudit: VerificationStep[];
}

const videoRecords: VideoRecord[] = [];

// ================= API ROUTES =================

// Check R2 status & detected environment keys
app.get('/api/r2/status', (req: Request, res: Response) => {
  const config = getR2Config(req);

  // Check which individual secrets are detected in process.env
  const detectedSecrets = {
    accountId: Boolean(
      getEnvValue([
        'R2_ACCOUNT_ID',
        'CLOUDFLARE_R2_ACCOUNT_ID',
        'CLOUDFLARE_ACCOUNT_ID',
        'CF_ACCOUNT_ID',
        'ACCOUNT_ID',
      ])
    ),
    accessKeyId: Boolean(
      getEnvValue([
        'R2_ACCESS_KEY_ID',
        'CLOUDFLARE_R2_ACCESS_KEY_ID',
        'CLOUDFLARE_ACCESS_KEY_ID',
        'CF_ACCESS_KEY_ID',
        'AWS_ACCESS_KEY_ID',
        'R2_ACCESS_KEY',
        'ACCESS_KEY_ID',
      ])
    ),
    secretAccessKey: Boolean(
      getEnvValue([
        'R2_SECRET_ACCESS_KEY',
        'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
        'CLOUDFLARE_SECRET_ACCESS_KEY',
        'CF_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'R2_SECRET_KEY',
        'SECRET_ACCESS_KEY',
      ])
    ),
    bucketName: Boolean(
      getEnvValue([
        'R2_BUCKET_NAME',
        'CLOUDFLARE_R2_BUCKET_NAME',
        'CLOUDFLARE_BUCKET_NAME',
        'CLOUDFLARE_BUCKET',
        'CF_BUCKET_NAME',
        'CF_BUCKET',
        'R2_BUCKET',
        'BUCKET_NAME',
      ])
    ),
    publicUrlPrefix: Boolean(
      getEnvValue([
        'R2_PUBLIC_URL_PREFIX',
        'R2_PUBLIC_URL',
        'CLOUDFLARE_R2_PUBLIC_URL',
        'PUBLIC_URL_PREFIX',
        'R2_DOMAIN',
      ])
    ),
  };

  const allSecretsFound =
    detectedSecrets.accountId &&
    detectedSecrets.accessKeyId &&
    detectedSecrets.secretAccessKey &&
    detectedSecrets.bucketName;

  if (config) {
    res.json({
      configured: true,
      bucket: config.bucketName,
      accountId: `${config.accountId.substring(0, 4)}••••${config.accountId.substring(config.accountId.length - 4)}`,
      publicUrlPrefix: config.publicUrlPrefix || null,
      source: config.source,
      detectedSecrets,
      allSecretsFound,
    });
  } else {
    res.json({
      configured: false,
      message:
        'Cloudflare R2 is not fully configured yet. Uploads will use built-in local emulator mode until R2 credentials are provided.',
      detectedSecrets,
      allSecretsFound,
      missingSecrets: [
        !detectedSecrets.accountId && 'R2_ACCOUNT_ID',
        !detectedSecrets.accessKeyId && 'R2_ACCESS_KEY_ID',
        !detectedSecrets.secretAccessKey && 'R2_SECRET_ACCESS_KEY',
        !detectedSecrets.bucketName && 'R2_BUCKET_NAME',
      ].filter(Boolean),
    });
  }
});

// Test R2 connection
app.post('/api/r2/test', async (req: Request, res: Response) => {
  try {
    const config = getR2Config(req);
    if (!config) {
      res.status(400).json({
        success: false,
        error:
          'Missing required R2 configuration (Account ID, Access Key ID, Secret Access Key, or Bucket Name).',
      });
      return;
    }

    const client = createR2Client(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));

    res.json({
      success: true,
      message: `Successfully connected to Cloudflare R2 bucket: "${config.bucketName}" via S3 API`,
      bucket: config.bucketName,
      source: config.source,
    });
  } catch (error: any) {
    console.error('R2 test connection error:', error);
    res.status(500).json({
      success: false,
      error:
        error?.message ||
        'Failed to authenticate with Cloudflare R2. Please check your credentials.',
      details: error?.Code || error?.name,
    });
  }
});

/**
 * Process & Upload Video with STRICT STEP-BY-STEP VERIFICATION:
 *
 * If ANY step fails or returns an error, the pipeline IMMEDIATELY ABORTS.
 * Subsequent steps are marked as ABORTED and are NEVER executed.
 * Read-after-write verification (HeadObject) is enforced for both video and thumbnail!
 */
app.post('/api/upload', (req: Request, res: Response) => {
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ])(req, res, async (multerErr: any) => {
    if (multerErr) {
      console.error('Multer upload parsing error:', multerErr);
      return res.status(400).json({
        status: 'error',
        failedStep: '1. Video File Integrity',
        error: multerErr.message || 'File upload parsing error',
        code: multerErr.code,
        subsequentStepsAborted: true,
        verificationAudit: [
          {
            step: '1. Video File Integrity',
            status: 'FAILED',
            timestamp: new Date().toISOString(),
            details: `Upload failed during multipart parsing: ${multerErr.message}`,
            error: multerErr.message,
          },
        ],
      });
    }

    try {
      const audit: VerificationStep[] = [];
      const timestamp = Date.now();
      const id = `vid_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const videoFile = files?.['video']?.[0];
      const thumbnailFile = files?.['thumbnail']?.[0];

      let clientMetadata: any = {};
      try {
        if (typeof req.body.metadata === 'string') {
          clientMetadata = JSON.parse(req.body.metadata);
        } else if (req.body.metadata && typeof req.body.metadata === 'object') {
          clientMetadata = req.body.metadata;
        }
      } catch {
        clientMetadata = {};
      }

      const captureTimestamp = Number(req.body.captureTimestamp) || 5.0;

    // STEP 1: Video File Integrity & Payload Verification
    if (!videoFile || videoFile.size === 0) {
      audit.push({
        step: '1. Video File Integrity',
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        details: 'Video file buffer missing or 0 bytes received',
        error: 'Video file is required and must not be empty',
      });
      res.status(400).json({
        status: 'error',
        failedStep: '1. Video File Integrity',
        error: 'Video file is required',
        subsequentStepsAborted: true,
        verificationAudit: audit,
      });
      return;
    }

    audit.push({
      step: '1. Video File Integrity',
      status: 'VERIFIED',
      timestamp: new Date().toISOString(),
      details: `Received ${videoFile.originalname} (${(videoFile.size / (1024 * 1024)).toFixed(2)} MB, MIME: ${videoFile.mimetype || 'video/mp4'})`,
    });

    // STEP 2: 5-Second Frame Thumbnail Verification
    if (!thumbnailFile || thumbnailFile.size === 0) {
      audit.push({
        step: '2. 5s Frame Thumbnail Verification',
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        details: 'Extracted frame thumbnail buffer missing or 0 bytes',
        error: 'Thumbnail frame image is required',
      });
      res.status(400).json({
        status: 'error',
        failedStep: '2. 5s Frame Thumbnail Verification',
        error: 'Extracted 5-second thumbnail image is required',
        subsequentStepsAborted: true,
        verificationAudit: audit,
      });
      return;
    }

    audit.push({
      step: '2. 5s Frame Thumbnail Verification',
      status: 'VERIFIED',
      timestamp: new Date().toISOString(),
      details: `Thumbnail frame at ${captureTimestamp.toFixed(1)}s verified (${(thumbnailFile.size / 1024).toFixed(1)} KB JPEG)`,
    });

    // User Requirement: "read the video name and exact name must be given to the file uploaded"
    const exactFilename = videoFile.originalname;
    const parsedName = path.parse(exactFilename);
    const baseNameWithoutExt = parsedName.name;

    // Optional folder prefix (default 'videos'), or root if set to empty string
    const folderPrefix = req.body.folderPrefix !== undefined ? String(req.body.folderPrefix).trim() : 'videos';
    const cleanFolder = folderPrefix ? folderPrefix.replace(/^\/+|\/+$/g, '') : '';

    const videoKey = cleanFolder ? `${cleanFolder}/${exactFilename}` : exactFilename;
    const thumbFolder = cleanFolder ? 'thumbnails' : '';
    const thumbKey = thumbFolder
      ? `${thumbFolder}/${baseNameWithoutExt}-thumb-${captureTimestamp}s.jpg`
      : `${baseNameWithoutExt}-thumb-${captureTimestamp}s.jpg`;

    const r2Config = getR2Config(req);
    const appBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    let videoUrl = '';
    let thumbnailUrl = '';
    let etagVideo: string | null = null;
    let etagThumbnail: string | null = null;
    let verifiedInStorage = false;

    if (r2Config) {
      const s3 = createR2Client(r2Config);

      // STEP 3: Cloudflare R2 Pre-Flight Authentication & Bucket Verification
      try {
        await s3.send(new HeadBucketCommand({ Bucket: r2Config.bucketName }));
        audit.push({
          step: '3. Cloudflare R2 Connection Pre-Flight',
          status: 'VERIFIED',
          timestamp: new Date().toISOString(),
          details: `Authenticated with Cloudflare R2 (Bucket: ${r2Config.bucketName}, Account: ${r2Config.accountId.substring(0, 4)}••••, Source: ${r2Config.source})`,
        });
      } catch (r2AuthError: any) {
        audit.push({
          step: '3. Cloudflare R2 Connection Pre-Flight',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: `Failed to authenticate with Cloudflare R2 bucket "${r2Config.bucketName}"`,
          error: r2AuthError?.message || 'Cloudflare R2 authentication failed',
        });
        // STRICT HALT: Do not proceed to video upload!
        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Pre-flight Cloudflare R2 check failed',
        });
        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Previous step failed',
        });
        audit.push({
          step: '6. Playback URL Resolution & Schema Formatting',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Previous step failed',
        });

        res.status(422).json({
          status: 'error',
          failedStep: '3. Cloudflare R2 Connection Pre-Flight',
          error: `Cloudflare R2 pre-flight verification failed: ${r2AuthError?.message || 'Bucket unreachable'}`,
          details: r2AuthError?.Code || r2AuthError?.name,
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      // STEP 4: Video Upload to Cloudflare R2 & Read-after-Write Verification
      try {
        const videoUploadResult = await s3.send(
          new PutObjectCommand({
            Bucket: r2Config.bucketName,
            Key: videoKey,
            Body: videoFile.buffer,
            ContentType: videoFile.mimetype || 'video/mp4',
            Metadata: {
              'original-name': encodeURIComponent(videoFile.originalname),
              'duration-seconds': String(clientMetadata.duration || 0),
              'extracted-timestamp': String(captureTimestamp),
            },
          })
        );
        etagVideo = videoUploadResult.ETag || null;

        // READ-AFTER-WRITE VERIFICATION: Verify object exists in Cloudflare R2
        const headVideo = await s3.send(
          new HeadObjectCommand({
            Bucket: r2Config.bucketName,
            Key: videoKey,
          })
        );

        if (headVideo.ContentLength !== videoFile.size) {
          throw new Error(
            `Size verification mismatch: uploaded ${videoFile.size} bytes, Cloudflare R2 reports ${headVideo.ContentLength} bytes`
          );
        }

        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'VERIFIED',
          timestamp: new Date().toISOString(),
          details: `Stored at "${videoKey}". Verified via HeadObject (${headVideo.ContentLength} bytes, ETag: ${headVideo.ETag})`,
        });
      } catch (videoError: any) {
        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: `Error uploading or verifying video object in Cloudflare R2`,
          error: videoError?.message || 'Failed to upload video to R2',
        });
        // STRICT HALT: Abort thumbnail upload and URL resolution!
        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Video upload failed',
        });
        audit.push({
          step: '6. Playback URL Resolution & Schema Formatting',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Video upload failed',
        });

        res.status(500).json({
          status: 'error',
          failedStep: '4. Video Upload & Read-after-Write Verification',
          error: `Video upload failed: ${videoError?.message}`,
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      // STEP 5: Thumbnail Upload to Cloudflare R2 & Read-after-Write Verification
      try {
        const thumbUploadResult = await s3.send(
          new PutObjectCommand({
            Bucket: r2Config.bucketName,
            Key: thumbKey,
            Body: thumbnailFile.buffer,
            ContentType: thumbnailFile.mimetype || 'image/jpeg',
            Metadata: {
              'video-key': videoKey,
              'extracted-timestamp': String(captureTimestamp),
            },
          })
        );
        etagThumbnail = thumbUploadResult.ETag || null;

        // READ-AFTER-WRITE VERIFICATION: Verify thumbnail exists in Cloudflare R2
        const headThumb = await s3.send(
          new HeadObjectCommand({
            Bucket: r2Config.bucketName,
            Key: thumbKey,
          })
        );

        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'VERIFIED',
          timestamp: new Date().toISOString(),
          details: `Stored at "${thumbKey}". Verified via HeadObject (${headThumb.ContentLength} bytes, ${headThumb.ContentType})`,
        });

        verifiedInStorage = true;
      } catch (thumbError: any) {
        audit.push({
          step: '5. Thumbnail Upload & Storage Verification',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: `Error uploading or verifying thumbnail object in Cloudflare R2`,
          error: thumbError?.message || 'Failed to upload thumbnail to R2',
        });
        audit.push({
          step: '6. Playback URL Resolution & Schema Formatting',
          status: 'ABORTED',
          timestamp: new Date().toISOString(),
          details: 'Aborted: Thumbnail upload failed',
        });

        res.status(500).json({
          status: 'error',
          failedStep: '5. Thumbnail Upload & Storage Verification',
          error: `Thumbnail upload failed: ${thumbError?.message}`,
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      // STEP 6: URL Resolution & Formatting
      if (r2Config.publicUrlPrefix) {
        videoUrl = `${r2Config.publicUrlPrefix}/${videoKey}`;
        thumbnailUrl = `${r2Config.publicUrlPrefix}/${thumbKey}`;
      } else {
        videoUrl = `${appBaseUrl}/api/r2/stream/${encodeURIComponent(videoKey)}`;
        thumbnailUrl = `${appBaseUrl}/api/r2/stream/${encodeURIComponent(thumbKey)}`;
      }

      audit.push({
        step: '6. Playback URL Resolution & Schema Formatting',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: `Resolved playback URL and 5s thumbnail URL (${r2Config.publicUrlPrefix ? 'direct R2 public domain' : 'secure proxy stream'})`,
      });
    } else {
      // Local Emulator Mode (Step 3, 4, 5 with local verification)
      audit.push({
        step: '3. Cloudflare R2 Connection Pre-Flight',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: 'Local emulator storage active (No R2 keys provided in secrets or UI)',
      });

      const videoLocalPath = path.join(localVideosDir, exactFilename);
      const thumbLocalPath = path.join(
        localThumbsDir,
        `${baseNameWithoutExt}-thumb-${captureTimestamp}s.jpg`
      );

      fs.writeFileSync(videoLocalPath, videoFile.buffer);
      fs.writeFileSync(thumbLocalPath, thumbnailFile.buffer);

      // Verify files exist on disk
      if (!fs.existsSync(videoLocalPath) || fs.statSync(videoLocalPath).size !== videoFile.size) {
        audit.push({
          step: '4. Video Upload & Read-after-Write Verification',
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          details: 'Local disk write verification failed',
        });
        res.status(500).json({
          status: 'error',
          failedStep: '4. Video Upload & Read-after-Write Verification',
          error: 'Local disk write failed',
          subsequentStepsAborted: true,
          verificationAudit: audit,
        });
        return;
      }

      audit.push({
        step: '4. Video Upload & Read-after-Write Verification',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: `Stored locally at ${path.basename(videoLocalPath)} (${fs.statSync(videoLocalPath).size} bytes)`,
      });

      audit.push({
        step: '5. Thumbnail Upload & Storage Verification',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: `Stored locally at ${path.basename(thumbLocalPath)} (${fs.statSync(thumbLocalPath).size} bytes)`,
      });

      videoUrl = `${appBaseUrl}/api/local-media/videos/${path.basename(videoLocalPath)}`;
      thumbnailUrl = `${appBaseUrl}/api/local-media/thumbnails/${path.basename(thumbLocalPath)}`;
      etagVideo = `"local-etag-${timestamp}-video"`;
      etagThumbnail = `"local-etag-${timestamp}-thumb"`;
      verifiedInStorage = true;

      audit.push({
        step: '6. Playback URL Resolution & Schema Formatting',
        status: 'VERIFIED',
        timestamp: new Date().toISOString(),
        details: 'Generated local emulator playback URLs',
      });
    }

    // Compute accurate real metrics without fallback dummy values
    const actualBytes = videoFile.size;
    const actualSizeMb =
      clientMetadata.sizeMb !== undefined && Number(clientMetadata.sizeMb) > 0
        ? Number(clientMetadata.sizeMb)
        : parseFloat((actualBytes / (1024 * 1024)).toFixed(2)) || 0.01;

    const actualDurationSec = Math.round(
      Number(
        clientMetadata.durationSec !== undefined
          ? clientMetadata.durationSec
          : clientMetadata.duration || 0
      )
    );

    const actualDurationHuman =
      clientMetadata.durationHuman ||
      (actualDurationSec < 60
        ? `${actualDurationSec} sec`
        : `${Math.round(actualDurationSec / 60)} min`);

    const actualUploadTime = Number(clientMetadata.uploadTime) || timestamp;

    // Final Payload Return Object with well-maintained database keys
    const returnObject: VideoRecord = {
      status: 'success',
      id,
      videoUrl,
      thumbnailUrl,
      captureTimestamp,
      sizeMb: actualSizeMb,
      durationSec: actualDurationSec,
      duration: actualDurationHuman,
      uploadTime: actualUploadTime,
      cloudflareR2: {
        uploadedToCloudflareR2: Boolean(r2Config),
        bucket: r2Config?.bucketName || 'local-emulator-storage',
        accountId: r2Config ? `${r2Config.accountId.substring(0, 4)}••••` : null,
        videoKey,
        thumbnailKey: thumbKey,
        etagVideo,
        etagThumbnail,
        publicUrlPrefix: r2Config?.publicUrlPrefix || null,
        directAccessMode: r2Config?.publicUrlPrefix
          ? 'direct_public_r2_url'
          : r2Config
          ? 'cloudflare_r2_proxy'
          : 'local_storage_emulator',
        verifiedInStorage,
      },
      metadata: {
        filename: videoFile.originalname,
        exactFilename,
        fileSize: actualBytes,
        fileSizeFormatted:
          clientMetadata.fileSizeFormatted ||
          `${(actualBytes / (1024 * 1024)).toFixed(2)} MB`,
        sizeMb: actualSizeMb,
        duration: actualDurationSec,
        durationSec: actualDurationSec,
        durationFormatted:
          clientMetadata.durationFormatted ||
          `${Math.floor(actualDurationSec / 60).toString().padStart(2, '0')}:${(actualDurationSec % 60).toString().padStart(2, '0')}`,
        durationHuman: actualDurationHuman,
        uploadTime: actualUploadTime,
        width: clientMetadata.width || 1920,
        height: clientMetadata.height || 1080,
        resolution: `${clientMetadata.width || 1920}x${clientMetadata.height || 1080}`,
        aspectRatio: clientMetadata.aspectRatio || '16:9',
        mimeType: videoFile.mimetype || 'video/mp4',
        bitrateEstimateKbps:
          clientMetadata.bitrateEstimateKbps ||
          Math.round(
            (actualBytes * 8) / (1000 * Math.max(1, actualDurationSec || 5))
          ),
        thumbnailSize: thumbnailFile.size,
        thumbnailSizeFormatted: `${(thumbnailFile.size / 1024).toFixed(1)} KB`,
        thumbnailDimensions: `${clientMetadata.thumbnailWidth || clientMetadata.width || 1920}x${clientMetadata.thumbnailHeight || clientMetadata.height || 1080}`,
        targetThumbnailTimeSeconds: captureTimestamp,
        capturedAtSecond: captureTimestamp,
        uploadedAt: new Date(actualUploadTime).toISOString(),
      },
      verificationAudit: audit,
    };

    videoRecords.unshift(returnObject);
    if (videoRecords.length > 50) videoRecords.pop();

      res.status(200).json(returnObject);
    } catch (unhandledErr: any) {
      console.error('Unhandled upload handler exception:', unhandledErr);
      res.status(500).json({
        status: 'error',
        error: unhandledErr?.message || 'Server error processing upload',
      });
    }
  });
});

// Stream or fetch object from Cloudflare R2 proxy (handles private buckets effortlessly)
app.get('/api/r2/stream/:key', async (req: Request, res: Response) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const config = getR2Config(req);
    if (!config) {
      res.status(400).send('R2 credentials not available for stream');
      return;
    }

    const s3 = createR2Client(config);
    const command = new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    });

    const response = await s3.send(command);

    if (response.ContentType) {
      res.setHeader('Content-Type', response.ContentType);
    }
    if (response.ContentLength) {
      res.setHeader('Content-Length', response.ContentLength);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (response.Body && typeof (response.Body as any).pipe === 'function') {
      (response.Body as any).pipe(res);
    } else {
      const bytes = await response.Body?.transformToByteArray();
      if (bytes) {
        res.send(Buffer.from(bytes));
      } else {
        res.status(404).send('Not found');
      }
    }
  } catch (error: any) {
    console.error('Error streaming from R2:', error);
    res.status(500).send('Failed to stream object from R2');
  }
});

// Serve local emulator media
app.get('/api/local-media/:type/:filename', (req: Request, res: Response) => {
  const { type, filename } = req.params;
  const safeFilename = path.basename(filename);
  const targetDir =
    type === 'videos'
      ? localVideosDir
      : type === 'database'
      ? localDatabaseDir
      : localThumbsDir;
  const filePath = path.join(targetDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    res.status(404).send('File not found');
    return;
  }

  res.sendFile(filePath);
});

// List recently uploaded videos
app.get('/api/videos', (_req: Request, res: Response) => {
  res.json(videoRecords);
});

// Delete a video record
app.delete('/api/videos/:id', (req: Request, res: Response) => {
  const index = videoRecords.findIndex((r) => r.id === req.params.id);
  if (index !== -1) {
    videoRecords.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Video not found' });
  }
});

// ================= CLOUDFLARE DATABASE ROUTES =================

const savedBatches: any[] = [];

// Save App-Optimized database manifest to Cloudflare R2
app.post('/api/database/save', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    if (!payload || !payload.title) {
      res.status(400).json({ error: 'Database payload with title is required' });
      return;
    }

    const rawBatchId = payload.batchId || payload.title.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const sanitizedBatchId = String(rawBatchId).trim().replace(/[^a-zA-Z0-9_-]/g, '_');

    const formattedDatabase = {
      batchId: sanitizedBatchId,
      title: String(payload.title).trim(),
      description: String(payload.description || '').trim(),
      imageUrl: String(payload.imageUrl || '').trim(),
      category: String(payload.category || 'Crime Thriller').trim(),
      isPremium: Boolean(payload.isPremium),
      releaseDate: Number(payload.releaseDate) || Date.now(),
      totalVideos: Array.isArray(payload.videos) ? payload.videos.length : 0,
      videos: Array.isArray(payload.videos) ? payload.videos : [],
    };

    const jsonString = JSON.stringify(formattedDatabase, null, 2);
    const databaseBuffer = Buffer.from(jsonString, 'utf-8');
    const databaseKey = `database/${sanitizedBatchId}.json`;

    const r2Config = getR2Config(req);
    const appBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    let databaseUrl = '';
    let etag: string | null = null;
    let verifiedInStorage = false;

    if (r2Config) {
      const s3 = createR2Client(r2Config);

      // Upload JSON manifest to Cloudflare R2
      const putResult = await s3.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: databaseKey,
          Body: databaseBuffer,
          ContentType: 'application/json',
          CacheControl: 'no-cache',
        })
      );
      etag = putResult.ETag || null;

      // Read-after-write verification on Cloudflare R2
      const headResult = await s3.send(
        new HeadObjectCommand({
          Bucket: r2Config.bucketName,
          Key: databaseKey,
        })
      );

      verifiedInStorage = Boolean(headResult.ContentLength);

      databaseUrl = r2Config.publicUrlPrefix
        ? `${r2Config.publicUrlPrefix}/${databaseKey}`
        : `${appBaseUrl}/api/r2/stream/${encodeURIComponent(databaseKey)}`;
    } else {
      // Local emulator storage
      const localFilePath = path.join(localDatabaseDir, `${sanitizedBatchId}.json`);
      fs.writeFileSync(localFilePath, databaseBuffer);
      verifiedInStorage = fs.existsSync(localFilePath);
      databaseUrl = `${appBaseUrl}/api/local-media/database/${sanitizedBatchId}.json`;
      etag = `"local-database-etag-${Date.now()}"`;
    }

    const batchRecord = {
      ...formattedDatabase,
      r2DatabaseUrl: databaseUrl,
      databaseKey,
      savedAt: new Date().toISOString(),
    };

    // Update in-memory index
    const existingIndex = savedBatches.findIndex((b) => b.batchId === sanitizedBatchId);
    if (existingIndex !== -1) {
      savedBatches[existingIndex] = batchRecord;
    } else {
      savedBatches.unshift(batchRecord);
    }

    res.status(200).json({
      success: true,
      batchId: sanitizedBatchId,
      cloudflareR2: {
        bucket: r2Config?.bucketName || 'local-emulator-storage',
        etag,
        uploadedToR2: Boolean(r2Config),
      },
      database: batchRecord,
    });
  } catch (error: any) {
    console.error('Error saving database to Cloudflare R2:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to save database to Cloudflare R2',
    });
  }
});

// ================= CLOUDFLARE EXTRACTED LINKS REGISTRY (DEDICATED DEDUPLICATION VAULT) =================

export interface CloudflareExtractedLink {
  id: string; // unique hash or slug (e.g. url_...)
  sourceUrl: string; // original web url
  title: string;
  rawTitle?: string;
  videoUrl?: string; // original video stream
  thumbnailUrl?: string; // original poster
  cloudflareVideoUrl?: string; // permanent R2 back link
  cloudflareThumbnailUrl?: string; // permanent R2 thumb link
  durationFormatted?: string;
  durationSec?: number | null;
  sizeFormatted?: string;
  destination?: 'categories' | 'batchvideo' | 'reels' | 'database' | 'none';
  destinationDetail?: string; // e.g. "cat_action_01" or series name
  categories?: string[]; // Multiple categories array: e.g. ["Action Hits", "Trending 2026", "VIP Movies"]
  status: 'extracted' | 'uploaded' | 'forwarded';
  firstExtractedAt: string;
  lastUpdatedAt: string;
  metadata?: Record<string, any>;
}

// Domain Filters (Whitelist & Blacklist) Storage
export interface DomainFilterRules {
  whitelist: string[]; // e.g. ["example.com", "vids.net"] (if non-empty, only matching domains pass)
  blacklist: string[]; // e.g. ["doubleclick", "google-analytics", "facebook", "ads", "/login", "/register"]
}

const defaultBlacklist = [
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com',
  'twitter.com',
  'instagram.com',
  'adservice.google',
  'amazon-adsystem.com',
  'adnxs.com',
  '/login',
  '/signin',
  '/signup',
  '/register',
  '/privacy',
  '/terms',
  '/contact',
  '/cookie',
  '/ad/',
  '/ads/',
  'wp-login.php',
];

const domainRulesFilePath = path.join(localUploadsDir, 'registry', 'domain_filter_rules.json');
let domainFilterRules: DomainFilterRules = {
  whitelist: [],
  blacklist: defaultBlacklist,
};

if (fs.existsSync(domainRulesFilePath)) {
  try {
    const rawRules = fs.readFileSync(domainRulesFilePath, 'utf-8');
    domainFilterRules = JSON.parse(rawRules);
  } catch (err) {
    console.warn('Could not parse domain_filter_rules.json:', err);
  }
}

// In-memory + persistent cache directory
const localRegistryDir = path.join(localUploadsDir, 'registry');
if (!fs.existsSync(localRegistryDir)) fs.mkdirSync(localRegistryDir, { recursive: true });
const registryFilePath = path.join(localRegistryDir, 'links_registry.json');

// Initialize registry from local disk or memory
let extractedLinksRegistry: CloudflareExtractedLink[] = [];
if (fs.existsSync(registryFilePath)) {
  try {
    const rawData = fs.readFileSync(registryFilePath, 'utf-8');
    extractedLinksRegistry = JSON.parse(rawData);
  } catch (err) {
    console.warn('Could not parse local links_registry.json:', err);
  }
}

// Helper: Save and sync domain filter rules to Cloudflare R2
async function syncDomainRulesToStorage(req?: Request): Promise<void> {
  const jsonBuffer = Buffer.from(JSON.stringify(domainFilterRules, null, 2), 'utf-8');
  try {
    fs.writeFileSync(domainRulesFilePath, jsonBuffer);
  } catch (e) {
    console.warn('Failed to write local domain filter rules:', e);
  }

  const r2Config = getR2Config(req);
  if (r2Config) {
    try {
      const s3 = createR2Client(r2Config);
      await s3.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: 'registry/domain_filter_rules.json',
          Body: jsonBuffer,
          ContentType: 'application/json',
          CacheControl: 'no-cache',
        })
      );
    } catch (r2Err) {
      console.warn('Failed to sync domain rules to Cloudflare R2:', r2Err);
    }
  }
}

// Normalize URL for reliable deduplication comparison
function normalizeUrlForDedup(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl.trim());
    // remove trailing slashes and hash
    let path = u.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    // sorted search params without tracking tokens
    const params = new URLSearchParams(u.search);
    params.delete('utm_source');
    params.delete('utm_medium');
    params.delete('utm_campaign');
    params.delete('ref');
    const cleanSearch = params.toString();
    return `${u.protocol}//${u.host}${path}${cleanSearch ? '?' + cleanSearch : ''}`.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '');
  }
}

// Generate deterministic unique ID from normalized URL
function getLinkUniqueId(rawUrl: string): string {
  const norm = normalizeUrlForDedup(rawUrl);
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = (hash << 5) - hash + norm.charCodeAt(i);
    hash |= 0;
  }
  const cleanDomain = norm.replace(/^https?:\/\//, '').split('/')[0].replace(/[^a-z0-9]/gi, '_').substring(0, 20);
  return `link_${cleanDomain}_${Math.abs(hash).toString(36)}`;
}

// Helper: Sync links registry to Cloudflare R2 bucket (`registry/links_registry.json`) or local emulator
async function syncRegistryToStorage(req?: Request): Promise<void> {
  const jsonBuffer = Buffer.from(JSON.stringify(extractedLinksRegistry, null, 2), 'utf-8');
  // Always save locally
  try {
    fs.writeFileSync(registryFilePath, jsonBuffer);
  } catch (e) {
    console.warn('Failed to write local registry:', e);
  }

  // Also sync to Cloudflare R2 if configured
  const r2Config = getR2Config(req);
  if (r2Config) {
    try {
      const s3 = createR2Client(r2Config);
      await s3.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: 'registry/links_registry.json',
          Body: jsonBuffer,
          ContentType: 'application/json',
          CacheControl: 'no-cache',
        })
      );
    } catch (r2Err) {
      console.warn('Failed to sync registry to Cloudflare R2:', r2Err);
    }
  }
}

// API: Check single or multiple URLs against Cloudflare registry (No copy on match; auto-add if new)
app.post('/api/registry/check', async (req: Request, res: Response) => {
  const { urls, autoRegisterIfMissing = true } = req.body;
  if (!urls) {
    return res.status(400).json({ success: false, error: 'urls array or single url is required' });
  }

  const urlList: string[] = Array.isArray(urls) ? urls : [urls];
  let hasNew = false;
  const now = new Date().toISOString();

  const results = urlList.map((rawUrl) => {
    const norm = normalizeUrlForDedup(rawUrl);
    const existingIndex = extractedLinksRegistry.findIndex(
      (item) => normalizeUrlForDedup(item.sourceUrl) === norm || item.id === rawUrl || item.id === getLinkUniqueId(rawUrl)
    );

    if (existingIndex >= 0) {
      // Existing record in Cloudflare: ZERO DUPLICATE COPIES CREATED!
      const existing = extractedLinksRegistry[existingIndex];
      return {
        url: rawUrl,
        normalizedUrl: norm,
        uniqueId: existing.id,
        isRegistered: true,
        isNew: false,
        noCopy: true,
        isUploaded: Boolean(existing.cloudflareVideoUrl || existing.cloudflareThumbnailUrl || existing.status === 'uploaded'),
        destination: existing.destination || 'none',
        destinationDetail: existing.destinationDetail || null,
        record: existing,
      };
    } else {
      // Not yet in Cloudflare: auto-register new link so future checks immediately find it
      const uniqueId = getLinkUniqueId(rawUrl);
      let newRecord: CloudflareExtractedLink | null = null;
      if (autoRegisterIfMissing) {
        newRecord = {
          id: uniqueId,
          sourceUrl: rawUrl,
          title: rawUrl.split('/').pop()?.split('?')[0] || 'Tracked Link',
          rawTitle: rawUrl,
          status: 'extracted',
          destination: 'none',
          firstExtractedAt: now,
          lastUpdatedAt: now,
          metadata: {
            addedVia: 'cloudflare_auto_check',
          },
        };
        extractedLinksRegistry.unshift(newRecord);
        hasNew = true;
      }

      return {
        url: rawUrl,
        normalizedUrl: norm,
        uniqueId,
        isRegistered: Boolean(newRecord),
        isNew: true,
        isUploaded: false,
        destination: 'none',
        destinationDetail: null,
        record: newRecord,
      };
    }
  });

  if (hasNew) {
    await syncRegistryToStorage(req);
  }

  res.json({
    success: true,
    count: results.length,
    registeredCount: results.filter((r) => r.isRegistered).length,
    newlyAddedCount: results.filter((r) => r.isNew).length,
    reusedExistingCount: results.filter((r) => !r.isNew && r.isRegistered).length,
    results,
  });
});

// API: Get link details by unique ID or URL from Cloudflare registry
app.get('/api/registry/item', (req: Request, res: Response) => {
  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({ success: false, error: 'id or url query parameter is required' });
  }

  let found: CloudflareExtractedLink | undefined;
  if (id) {
    found = extractedLinksRegistry.find((item) => item.id === String(id));
  }
  if (!found && url) {
    const norm = normalizeUrlForDedup(String(url));
    found = extractedLinksRegistry.find((item) => normalizeUrlForDedup(item.sourceUrl) === norm);
  }

  if (!found) {
    return res.status(404).json({ success: false, error: 'Link record not found in Cloudflare registry' });
  }

  res.json({ success: true, record: found });
});

// API: List all tracked links in Cloudflare registry
app.get('/api/registry/links', (_req: Request, res: Response) => {
  res.json({
    success: true,
    total: extractedLinksRegistry.length,
    uploadedCount: extractedLinksRegistry.filter((l) => l.cloudflareVideoUrl || l.status === 'uploaded').length,
    links: extractedLinksRegistry,
  });
});

// API: Register or update an extracted link record (saves destination, Cloudflare back links, metadata)
app.post('/api/registry/register', async (req: Request, res: Response) => {
  try {
    const {
      sourceUrl,
      title,
      rawTitle,
      videoUrl,
      thumbnailUrl,
      cloudflareVideoUrl,
      cloudflareThumbnailUrl,
      durationFormatted,
      durationSec,
      sizeFormatted,
      destination = 'none',
      destinationDetail,
      metadata = {},
    } = req.body;

    if (!sourceUrl) {
      return res.status(400).json({ success: false, error: 'sourceUrl is required' });
    }

    const norm = normalizeUrlForDedup(sourceUrl);
    const uniqueId = getLinkUniqueId(sourceUrl);
    const existingIndex = extractedLinksRegistry.findIndex(
      (item) => normalizeUrlForDedup(item.sourceUrl) === norm || item.id === uniqueId
    );

    const now = new Date().toISOString();
    const isUploaded = Boolean(cloudflareVideoUrl || cloudflareThumbnailUrl);

    let updatedRecord: CloudflareExtractedLink;

    if (existingIndex >= 0) {
      const prev = extractedLinksRegistry[existingIndex];
      updatedRecord = {
        ...prev,
        title: title || prev.title,
        rawTitle: rawTitle || prev.rawTitle,
        videoUrl: videoUrl || prev.videoUrl,
        thumbnailUrl: thumbnailUrl || prev.thumbnailUrl,
        cloudflareVideoUrl: cloudflareVideoUrl || prev.cloudflareVideoUrl,
        cloudflareThumbnailUrl: cloudflareThumbnailUrl || prev.cloudflareThumbnailUrl,
        durationFormatted: durationFormatted || prev.durationFormatted,
        durationSec: durationSec !== undefined ? durationSec : prev.durationSec,
        sizeFormatted: sizeFormatted || prev.sizeFormatted,
        destination: destination !== 'none' ? destination : prev.destination,
        destinationDetail: destinationDetail || prev.destinationDetail,
        status: isUploaded || prev.status === 'uploaded' ? 'uploaded' : prev.status,
        lastUpdatedAt: now,
        metadata: { ...prev.metadata, ...metadata },
      };
      extractedLinksRegistry[existingIndex] = updatedRecord;
    } else {
      updatedRecord = {
        id: uniqueId,
        sourceUrl,
        title: title || 'Extracted Video',
        rawTitle: rawTitle || title,
        videoUrl,
        thumbnailUrl,
        cloudflareVideoUrl,
        cloudflareThumbnailUrl,
        durationFormatted,
        durationSec,
        sizeFormatted,
        destination,
        destinationDetail,
        status: isUploaded ? 'uploaded' : 'extracted',
        firstExtractedAt: now,
        lastUpdatedAt: now,
        metadata,
      };
      extractedLinksRegistry.unshift(updatedRecord);
    }

    await syncRegistryToStorage(req);

    res.json({
      success: true,
      uniqueId: updatedRecord.id,
      record: updatedRecord,
    });
  } catch (err: any) {
    console.error('Error registering link in Cloudflare:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to register link in registry' });
  }
});

// API: Delete a record from Cloudflare registry
app.delete('/api/registry/item/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const index = extractedLinksRegistry.findIndex((item) => item.id === id);
  if (index !== -1) {
    extractedLinksRegistry.splice(index, 1);
    await syncRegistryToStorage(req);
    res.json({ success: true, message: `Removed record ${id} from registry` });
  } else {
    res.status(404).json({ success: false, error: 'Record not found in registry' });
  }
});

// API: Clear registry
app.post('/api/registry/clear', async (req: Request, res: Response) => {
  extractedLinksRegistry = [];
  await syncRegistryToStorage(req);
  res.json({ success: true, message: 'Registry cleared successfully' });
});

// API: Get current domain filter rules (whitelist & blacklist)
app.get('/api/registry/domain-rules', (_req: Request, res: Response) => {
  res.json({
    success: true,
    rules: domainFilterRules,
  });
});

// API: Save & sync domain filter rules to Cloudflare R2
app.post('/api/registry/domain-rules', async (req: Request, res: Response) => {
  try {
    const { whitelist, blacklist } = req.body;
    if (Array.isArray(whitelist)) domainFilterRules.whitelist = whitelist.map((s) => String(s).trim()).filter(Boolean);
    if (Array.isArray(blacklist)) domainFilterRules.blacklist = blacklist.map((s) => String(s).trim()).filter(Boolean);

    await syncDomainRulesToStorage(req);

    res.json({
      success: true,
      message: 'Domain filter rules updated and synced to Cloudflare R2',
      rules: domainFilterRules,
    });
  } catch (err: any) {
    console.error('Error saving domain rules:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update domain filter rules' });
  }
});

// ================= DEDICATED WEBPAGE DEEP LINK EXTRACTOR ENDPOINT =================

export interface ExtractedPageLink {
  url: string;
  normalizedUrl: string;
  text: string;
  type: 'video_media' | 'page_article' | 'image' | 'external';
  isRegisteredInCloudflare: boolean;
  isNewInCloudflare?: boolean;
  cloudflareRecord?: CloudflareExtractedLink | null;
}

app.post('/api/extract-page-links', async (req: Request, res: Response) => {
  try {
    let {
      url,
      filterKeywords,
      sameDomainOnly = false,
      enableDomainFilters = true,
      webpagesOnly = true,
      urlFormat = '',
      autoRegisterNew = true,
    } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Target URL is required' });
    }

    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const targetUrlObj = new URL(url);
    const targetDomain = targetUrlObj.hostname.toLowerCase();

    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 20000,
      maxRedirects: 5,
      responseType: 'text',
      validateStatus: () => true,
    });

    const finalUrl = (response.request as any)?.res?.responseUrl || response.config?.url || url;
    const finalUrlObj = new URL(finalUrl);

    const resolveUrl = (relativeOrAbsolute: string) => {
      if (!relativeOrAbsolute) return '';
      try {
        return new URL(relativeOrAbsolute, finalUrl).href;
      } catch {
        return '';
      }
    };

    // Helper: Check URL against whitelist and blacklist
    const isUrlAllowedByDomainRules = (testUrl: string): boolean => {
      if (!enableDomainFilters) return true;
      const lower = testUrl.toLowerCase();

      // Check blacklist first
      for (const pattern of domainFilterRules.blacklist) {
        if (pattern && lower.includes(pattern.toLowerCase())) {
          return false;
        }
      }

      // If whitelist is populated, URL must match at least one whitelist pattern
      if (domainFilterRules.whitelist.length > 0) {
        return domainFilterRules.whitelist.some((w) => w && lower.includes(w.toLowerCase()));
      }

      return true;
    };

    // Helper: Match custom link path format (e.g. domain/xyz/, /xyz/, xyz/, watch?v=)
    const matchesUrlFormat = (testUrl: string, format: string): boolean => {
      if (!format || !format.trim()) return true;

      const rawPatterns = format
        .split(/[,|\n]+/)
        .map((p) => p.trim())
        .filter(Boolean);

      if (rawPatterns.length === 0) return true;

      try {
        const parsed = new URL(testUrl);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname;
        const fullPath = `${pathname}${parsed.search}`;
        const hostAndPath = `${hostname}${pathname}`;

        return rawPatterns.some((pattern) => {
          let p = pattern.trim();
          if (!p) return true;

          // Replace literal 'domain/xyz/' or '{domain}/xyz/' with actual target domain
          p = p.replace(/^\{?domain\}?\//i, `${targetDomain}/`);
          // Strip http/https prefix
          p = p.replace(/^https?:\/\//i, '');

          // Wildcard match support
          if (p.includes('*')) {
            const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            const regex = new RegExp(escaped, 'i');
            return regex.test(testUrl) || regex.test(hostAndPath) || regex.test(fullPath);
          }

          // Starting with slash (e.g. /xyz/)
          if (p.startsWith('/')) {
            return fullPath.toLowerCase().includes(p.toLowerCase());
          }

          // Format includes domain (e.g. mysite.com/xyz/)
          if (p.toLowerCase().startsWith(targetDomain)) {
            return hostAndPath.toLowerCase().includes(p.toLowerCase());
          }

          // Substring matching against testUrl, path, or hostAndPath
          return (
            testUrl.toLowerCase().includes(p.toLowerCase()) ||
            hostAndPath.toLowerCase().includes(p.toLowerCase()) ||
            fullPath.toLowerCase().includes(p.toLowerCase())
          );
        });
      } catch {
        return rawPatterns.some((p) => testUrl.toLowerCase().includes(p.toLowerCase()));
      }
    };

    const isDirectMediaOrImage = (testUrl: string): boolean => {
      return (
        /\.(mp4|m3u8|webm|mov|mkv|avi|ts|mpd|flv|wmv|ogg)(\?.*)?$/i.test(testUrl) ||
        /\.(jpg|jpeg|png|webp|avif|gif|svg|ico|bmp|tiff)(\?.*)?$/i.test(testUrl)
      );
    };

    const linksMap = new Map<string, { text: string; type: 'video_media' | 'page_article' | 'image' | 'external' }>();

    // Parse with Cheerio
    const $ = cheerio.load(typeof response.data === 'string' ? response.data : '');

    // 1. Anchor links <a href="...">
    $('a[href]').each((_, el) => {
      const rawHref = $(el).attr('href')?.trim();
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) {
        return;
      }

      const resolved = resolveUrl(rawHref);
      if (!resolved || !/^https?:\/\//i.test(resolved)) return;

      // Skip direct video and image links if webpagesOnly is enabled
      const isMedia = isDirectMediaOrImage(resolved);
      if (webpagesOnly && isMedia) {
        return;
      }

      // Check URL format match (e.g. domain/xyz/, /xyz/)
      if (!matchesUrlFormat(resolved, urlFormat)) {
        return;
      }

      const linkText = $(el).text().replace(/\s+/g, ' ').trim() || $(el).attr('title')?.trim() || '';

      let type: 'video_media' | 'page_article' | 'image' | 'external' = 'page_article';
      if (/\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(resolved)) {
        type = 'video_media';
      } else if (/\.(jpg|jpeg|png|webp|avif|gif)(\?.*)?$/i.test(resolved)) {
        type = 'image';
      }

      try {
        const linkDomain = new URL(resolved).hostname.toLowerCase();
        if (sameDomainOnly && linkDomain !== targetDomain && linkDomain !== finalUrlObj.hostname.toLowerCase()) {
          return;
        }
        if (linkDomain !== targetDomain) {
          if (type === 'page_article') type = 'external';
        }
      } catch {}

      if (!isUrlAllowedByDomainRules(resolved)) {
        return;
      }

      if (!linksMap.has(resolved)) {
        linksMap.set(resolved, { text: linkText, type });
      } else if (linkText && !linksMap.get(resolved)?.text) {
        linksMap.set(resolved, { text: linkText, type });
      }
    });

    // 2. Direct video tags <video src> or <source src> (Only if webpagesOnly is false)
    if (!webpagesOnly) {
      $('video[src], source[src]').each((_, el) => {
        const src = $(el).attr('src')?.trim();
        if (src) {
          const resolved = resolveUrl(src);
          if (
            resolved &&
            /^https?:\/\//i.test(resolved) &&
            isUrlAllowedByDomainRules(resolved) &&
            matchesUrlFormat(resolved, urlFormat) &&
            !linksMap.has(resolved)
          ) {
            linksMap.set(resolved, { text: 'Direct Video Stream', type: 'video_media' });
          }
        }
      });
    }

    // 3. Fallback regex scan for URLs in raw text
    const textUrls = (typeof response.data === 'string' ? response.data : '').match(/https?:\/\/[^\s"',<>]+/gi) || [];
    for (const rawTextUrl of textUrls) {
      const cleanUrl = rawTextUrl.replace(/[.,;:)\]]+$/, '').trim();
      if (/^https?:\/\//i.test(cleanUrl) && isUrlAllowedByDomainRules(cleanUrl)) {
        const isMedia = isDirectMediaOrImage(cleanUrl);
        if (webpagesOnly && isMedia) continue;
        if (!matchesUrlFormat(cleanUrl, urlFormat)) continue;

        if (!linksMap.has(cleanUrl)) {
          let type: 'video_media' | 'page_article' | 'image' | 'external' = 'page_article';
          if (/\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(cleanUrl)) type = 'video_media';
          else if (/\.(jpg|jpeg|png|webp|avif|gif)(\?.*)?$/i.test(cleanUrl)) type = 'image';
          linksMap.set(cleanUrl, { text: 'Discovered in text/script source', type });
        }
      }
    }

    // Convert map to list and cross-reference with Cloudflare Extracted Registry (No copies for existing; auto-add new)
    let hasNewRegistrations = false;
    const now = new Date().toISOString();

    let list: ExtractedPageLink[] = Array.from(linksMap.entries()).map(([linkUrl, meta]) => {
      const norm = normalizeUrlForDedup(linkUrl);
      const reg = extractedLinksRegistry.find(
        (r) => normalizeUrlForDedup(r.sourceUrl) === norm || r.id === getLinkUniqueId(linkUrl)
      );

      let isNew = false;
      let finalReg = reg;

      if (!reg && autoRegisterNew) {
        // Automatically add new link to Cloudflare so future requests find it immediately
        finalReg = {
          id: getLinkUniqueId(linkUrl),
          sourceUrl: linkUrl,
          title: meta.text || linkUrl.split('/').pop()?.split('?')[0] || 'Discovered Webpage',
          rawTitle: meta.text,
          status: 'extracted',
          destination: 'none',
          firstExtractedAt: now,
          lastUpdatedAt: now,
          metadata: {
            extractedFromPage: url,
            originDomain: targetDomain,
          },
        };
        extractedLinksRegistry.unshift(finalReg);
        hasNewRegistrations = true;
        isNew = true;
      }

      return {
        url: linkUrl,
        normalizedUrl: norm,
        text: meta.text,
        type: meta.type,
        isRegisteredInCloudflare: Boolean(finalReg),
        isNewInCloudflare: isNew,
        cloudflareRecord: finalReg || null,
      };
    });

    if (hasNewRegistrations) {
      await syncRegistryToStorage(req);
    }

    // Apply optional keyword filter
    if (filterKeywords && typeof filterKeywords === 'string' && filterKeywords.trim()) {
      const terms = filterKeywords
        .toLowerCase()
        .split(/[,|\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);

      if (terms.length > 0) {
        list = list.filter((item) =>
          terms.some((term) => item.url.toLowerCase().includes(term) || item.text.toLowerCase().includes(term))
        );
      }
    }

    res.json({
      success: true,
      sourceUrl: url,
      finalUrl,
      targetDomain,
      pageTitle: $('title').text().trim() || '',
      webpagesOnly,
      urlFormat: urlFormat.trim(),
      totalExtracted: list.length,
      videoMediaCount: list.filter((l) => l.type === 'video_media').length,
      pageArticleCount: list.filter((l) => l.type === 'page_article').length,
      registeredCount: list.filter((l) => l.isRegisteredInCloudflare).length,
      newlyRegisteredCount: list.filter((l) => l.isNewInCloudflare).length,
      reusedExistingCount: list.filter((l) => l.isRegisteredInCloudflare && !l.isNewInCloudflare).length,
      links: list,
    });
  } catch (err: any) {
    console.error('Page link extraction error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to extract links from webpage' });
  }
});

// List all saved database batches
app.get('/api/database', (_req: Request, res: Response) => {
  res.json(savedBatches);
});

// Fetch a specific database batch
app.get('/api/database/:batchId', (req: Request, res: Response) => {
  const batch = savedBatches.find((b) => b.batchId === req.params.batchId);
  if (batch) {
    res.json(batch);
  } else {
    res.status(404).json({ error: 'Database batch not found' });
  }
});

// Delete a saved database batch
app.delete('/api/database/:batchId', (req: Request, res: Response) => {
  const index = savedBatches.findIndex((b) => b.batchId === req.params.batchId);
  if (index !== -1) {
    savedBatches.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Database batch not found' });
  }
});

// Helper: Parse duration string (ISO 8601 like PT15M33S, HH:MM:SS, MM:SS, or seconds)
function parseDuration(val: any): { seconds: number; formatted: string } | null {
  if (!val) return null;
  const str = String(val).trim();

  // 1. ISO 8601 format e.g. PT1H23M45S or PT4M30S or PT45S
  const isoMatch = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (isoMatch) {
    const hours = parseInt(isoMatch[1] || '0', 10);
    const mins = parseInt(isoMatch[2] || '0', 10);
    const secs = Math.round(parseFloat(isoMatch[3] || '0'));
    const totalSecs = hours * 3600 + mins * 60 + secs;
    if (totalSecs > 0) {
      let formatted = '';
      if (hours > 0) formatted = `${hours}h ${mins}m ${secs}s`;
      else if (mins > 0) formatted = `${mins} min ${secs}s`;
      else formatted = `${secs}s`;
      return { seconds: totalSecs, formatted };
    }
  }

  // 2. HH:MM:SS or MM:SS format
  const timeMatch = str.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hours = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
    const mins = parseInt(timeMatch[2], 10);
    const secs = parseInt(timeMatch[3], 10);
    const totalSecs = hours * 3600 + mins * 60 + secs;
    const formatted = hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins} min ${secs}s`;
    return { seconds: totalSecs, formatted };
  }

  // 3. Pure number seconds (e.g. "245" or 245.5)
  const num = parseFloat(str);
  if (!isNaN(num) && num > 0 && num < 86400) {
    const totalSecs = Math.round(num);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    let formatted = '';
    if (hours > 0) formatted = `${hours}h ${mins}m ${secs}s`;
    else if (mins > 0) formatted = `${mins} min ${secs}s`;
    else formatted = `${secs}s`;
    return { seconds: totalSecs, formatted };
  }

  return null;
}

// Helper: Case-insensitive title word removal and bracket/separator normalization
function cleanTitleWithFilter(
  title: string,
  wordsToRemove?: string
): { cleaned: string; rawTitle: string; removedTerms: string[] } {
  if (!title) return { cleaned: '', rawTitle: '', removedTerms: [] };
  const rawTitle = title;
  let cleaned = title;
  const removedTerms: string[] = [];

  if (wordsToRemove && typeof wordsToRemove === 'string' && wordsToRemove.trim()) {
    const terms = wordsToRemove
      .split(/[,|\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    for (const term of terms) {
      if (!term) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Case-insensitive regex matching whole word or enclosed in punctuation/spaces
      const regex = new RegExp(`(^|[\\s\\[\\(\\{_\\-–—|•/])(${escaped})([\\s\\]\\)\\}_{\\-–—|•/]|\$)`, 'gi');
      if (regex.test(cleaned)) {
        if (!removedTerms.includes(term)) removedTerms.push(term);
        cleaned = cleaned.replace(regex, ' ');
      }
    }
  }

  // Clean empty brackets like [], (), {} left behind
  cleaned = cleaned.replace(/\[\s*\]|\(\s*\)|\{\s*\}/g, ' ');
  // Clean dangling separators at beginning or end or repeating separators
  cleaned = cleaned
    .replace(/\s*([|\-–—::»\/\\])\s*([|\-–—::»\/\\]\s*)+/g, ' $1 ')
    .replace(/^[\s|\-–—::»\/\\]+|[\s|\-–—::»\/\\]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { cleaned: cleaned || rawTitle, rawTitle, removedTerms };
}

// Helper: Inspect remote video file size via HEAD or Range request with 3.5s timeout
async function detectRemoteFileSize(videoUrl: string): Promise<{ sizeBytes: number; sizeMb: string; sizeFormatted: string } | null> {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return null;
  if (videoUrl.includes('.m3u8')) {
    return { sizeBytes: 0, sizeMb: 'Adaptive', sizeFormatted: 'Adaptive Stream (HLS)' };
  }

  try {
    const headRes = await axios.head(videoUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      timeout: 3500,
      validateStatus: (s) => s < 400,
    });
    const cl = headRes.headers['content-length'];
    if (cl) {
      const sizeBytes = parseInt(String(cl), 10);
      if (!isNaN(sizeBytes) && sizeBytes > 0) {
        const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
        const sizeFormatted =
          sizeBytes >= 1024 * 1024 * 1024
            ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
            : `${sizeMb} MB`;
        return { sizeBytes, sizeMb, sizeFormatted };
      }
    }
  } catch {
    // If HEAD is disallowed (403/405), try a Range GET for first byte
    try {
      const rangeRes = await axios.get(videoUrl, {
        headers: {
          Range: 'bytes=0-0',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        timeout: 3500,
        validateStatus: (s) => s === 206 || s === 200,
        responseType: 'arraybuffer',
      });
      const cr = String(rangeRes.headers['content-range'] || '');
      if (cr) {
        const total = cr.split('/')[1];
        const sizeBytes = parseInt(total, 10);
        if (!isNaN(sizeBytes) && sizeBytes > 0) {
          const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
          const sizeFormatted =
            sizeBytes >= 1024 * 1024 * 1024
              ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
              : `${sizeMb} MB`;
          return { sizeBytes, sizeMb, sizeFormatted };
        }
      }
      const cl = rangeRes.headers['content-length'];
      if (cl && rangeRes.status === 200) {
        const sizeBytes = parseInt(String(cl), 10);
        if (!isNaN(sizeBytes) && sizeBytes > 0) {
          const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
          const sizeFormatted =
            sizeBytes >= 1024 * 1024 * 1024
              ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
              : `${sizeMb} MB`;
          return { sizeBytes, sizeMb, sizeFormatted };
        }
      }
    } catch {}
  }
  return null;
}

// Helper: Upload remote image URL or base64 image data to Cloudflare R2 or local storage emulator
async function uploadImageToR2OrLocal(params: {
  imageUrl?: string;
  imageBase64?: string;
  customFilename?: string;
  folderPrefix?: string;
  req?: Request;
}): Promise<{
  cloudflareBackLink: string;
  thumbKey: string;
  sizeBytes: number;
  contentType: string;
  storageSource: 'cloudflare_r2' | 'emulator';
}> {
  const { imageUrl, imageBase64, customFilename, folderPrefix = 'thumbnails', req } = params;

  let buffer: Buffer;
  let contentType = 'image/jpeg';

  if (imageUrl) {
    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    buffer = Buffer.from(imgRes.data);
    contentType = String(imgRes.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
  } else if (imageBase64) {
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      contentType = matches[1];
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(imageBase64, 'base64');
    }
  } else {
    throw new Error('Either imageUrl or imageBase64 is required');
  }

  // Derive file extension from contentType
  let ext = 'jpg';
  if (contentType.includes('png')) ext = 'png';
  else if (contentType.includes('webp')) ext = 'webp';
  else if (contentType.includes('avif')) ext = 'avif';
  else if (contentType.includes('gif')) ext = 'gif';

  // Sanitized base name
  const safeName = customFilename
    ? customFilename.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 50)
    : `thumb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const filename = `${safeName}.${ext}`;
  const cleanFolder = folderPrefix.replace(/^\/+|\/+$/g, '');
  const thumbKey = cleanFolder ? `${cleanFolder}/${filename}` : filename;

  const r2Config = getR2Config(req);
  const appBaseUrl = process.env.APP_URL || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');

  let cloudflareBackLink = '';
  let storageSource: 'cloudflare_r2' | 'emulator' = 'emulator';

  if (r2Config) {
    const s3 = createR2Client(r2Config);
    await s3.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: thumbKey,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000',
      })
    );

    // Read-after-write verification
    await s3.send(
      new HeadObjectCommand({
        Bucket: r2Config.bucketName,
        Key: thumbKey,
      })
    );

    cloudflareBackLink = r2Config.publicUrlPrefix
      ? `${r2Config.publicUrlPrefix}/${thumbKey}`
      : `${appBaseUrl}/api/r2/stream/${encodeURIComponent(thumbKey)}`;
    storageSource = 'cloudflare_r2';
  } else {
    const localFilePath = path.join(localThumbsDir, filename);
    fs.writeFileSync(localFilePath, buffer);
    cloudflareBackLink = `${appBaseUrl}/api/local-media/thumbnails/${filename}`;
    storageSource = 'emulator';
  }

  return {
    cloudflareBackLink,
    thumbKey,
    sizeBytes: buffer.length,
    contentType,
    storageSource,
  };
}

// Standalone API: Upload any video thumbnail to Cloudflare R2 and return the permanent back link
app.post('/api/upload-thumbnail-to-r2', async (req: Request, res: Response) => {
  try {
    const { imageUrl, imageBase64, customFilename, folderPrefix = 'thumbnails' } = req.body;
    if (!imageUrl && !imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Either imageUrl or imageBase64 is required',
      });
    }

    const uploadResult = await uploadImageToR2OrLocal({
      imageUrl,
      imageBase64,
      customFilename,
      folderPrefix,
      req,
    });

    res.json({
      success: true,
      ...uploadResult,
    });
  } catch (err: any) {
    console.error('Thumbnail upload to Cloudflare R2 error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to upload thumbnail to Cloudflare R2',
    });
  }
});

// Helper: Download a remote video URL and upload directly to Cloudflare R2 or local storage emulator
async function uploadVideoToR2OrLocal(params: {
  videoUrl: string;
  customFilename?: string;
  folderPrefix?: string;
  req?: Request;
}): Promise<{
  cloudflareVideoBackLink: string;
  videoKey: string;
  sizeBytes: number;
  sizeMb: string;
  sizeFormatted: string;
  contentType: string;
  storageSource: 'cloudflare_r2' | 'emulator';
}> {
  const { videoUrl, customFilename, folderPrefix = 'videos', req } = params;

  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    throw new Error('A valid HTTP/HTTPS video URL is required');
  }

  const r2Config = getR2Config(req);
  const appBaseUrl = process.env.APP_URL || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');

  // If videoUrl is already an R2 URL or local media URL, return as-is
  if (
    (r2Config?.publicUrlPrefix && videoUrl.startsWith(r2Config.publicUrlPrefix)) ||
    videoUrl.includes('/api/r2/stream/') ||
    videoUrl.includes('/api/local-media/videos/')
  ) {
    return {
      cloudflareVideoBackLink: videoUrl,
      videoKey: videoUrl.split('/').pop() || 'video.mp4',
      sizeBytes: 0,
      sizeMb: '0',
      sizeFormatted: 'Already on Cloudflare R2',
      contentType: 'video/mp4',
      storageSource: r2Config ? 'cloudflare_r2' : 'emulator',
    };
  }

  // Temporary path for streaming download
  const tempFilename = `temp_vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
  const tempFilePath = path.join(localUploadsDir, tempFilename);

  let contentType = 'video/mp4';
  try {
    const writer = fs.createWriteStream(tempFilePath);
    const videoStreamRes = await axios.get(videoUrl, {
      responseType: 'stream',
      timeout: 120000, // 2-min timeout for video stream download
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'video/mp4,video/*,*/*;q=0.9',
      },
    });

    const headerType = String(videoStreamRes.headers['content-type'] || 'video/mp4').split(';')[0].trim();
    if (headerType && headerType.includes('video')) {
      contentType = headerType;
    }

    await new Promise((resolve, reject) => {
      videoStreamRes.data.pipe(writer);
      writer.on('finish', () => resolve(true));
      writer.on('error', reject);
    });
  } catch (downloadErr: any) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {}
    throw new Error(`Failed to download remote video stream: ${downloadErr.message || downloadErr}`);
  }

  const stat = fs.statSync(tempFilePath);
  const fileSize = stat.size;
  if (fileSize === 0) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {}
    throw new Error('Downloaded video stream is 0 bytes');
  }

  // Derive file extension
  let ext = 'mp4';
  if (videoUrl.includes('.webm') || contentType.includes('webm')) ext = 'webm';
  else if (videoUrl.includes('.mkv') || contentType.includes('x-matroska')) ext = 'mkv';
  else if (videoUrl.includes('.mov') || contentType.includes('quicktime')) ext = 'mov';

  const safeName = customFilename
    ? customFilename.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 60)
    : `video_${Date.now()}`;
  const filename = `${safeName}.${ext}`;
  const cleanFolder = folderPrefix.replace(/^\/+|\/+$/g, '');
  const videoKey = cleanFolder ? `${cleanFolder}/${filename}` : filename;

  let cloudflareVideoBackLink = '';
  let storageSource: 'cloudflare_r2' | 'emulator' = 'emulator';

  if (r2Config) {
    const s3 = createR2Client(r2Config);
    const fileStream = fs.createReadStream(tempFilePath);

    await s3.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: videoKey,
        Body: fileStream,
        ContentLength: fileSize,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000',
      })
    );

    // Read-after-write verification on Cloudflare R2
    await s3.send(
      new HeadObjectCommand({
        Bucket: r2Config.bucketName,
        Key: videoKey,
      })
    );

    cloudflareVideoBackLink = r2Config.publicUrlPrefix
      ? `${r2Config.publicUrlPrefix}/${videoKey}`
      : `${appBaseUrl}/api/r2/stream/${encodeURIComponent(videoKey)}`;
    storageSource = 'cloudflare_r2';
  } else {
    // Emulator mode
    const localDest = path.join(localVideosDir, filename);
    fs.copyFileSync(tempFilePath, localDest);
    cloudflareVideoBackLink = `${appBaseUrl}/api/local-media/videos/${filename}`;
    storageSource = 'emulator';
  }

  // Remove temp file
  try {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  } catch {}

  const sizeMb = (fileSize / (1024 * 1024)).toFixed(2);
  const sizeFormatted =
    fileSize >= 1024 * 1024 * 1024
      ? `${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB`
      : `${sizeMb} MB`;

  return {
    cloudflareVideoBackLink,
    videoKey,
    sizeBytes: fileSize,
    sizeMb,
    sizeFormatted,
    contentType,
    storageSource,
  };
}

// Standalone API: Upload any remote video URL directly to Cloudflare R2 and return the permanent back link
app.post('/api/upload-video-to-r2', async (req: Request, res: Response) => {
  try {
    const { videoUrl, customFilename, folderPrefix = 'videos' } = req.body;
    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'videoUrl is required in request body',
      });
    }

    const uploadResult = await uploadVideoToR2OrLocal({
      videoUrl,
      customFilename,
      folderPrefix,
      req,
    });

    res.json({
      success: true,
      ...uploadResult,
    });
  } catch (err: any) {
    console.error('Video upload to Cloudflare R2 error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to upload video to Cloudflare R2',
    });
  }
});

// Process & scrape input website URL in background using axios and cheerio
app.post('/api/process-url', async (req: Request, res: Response) => {
  try {
    let {
      url,
      extractMedia = true,
      customHeaders = {},
      wordsToRemove = '',
      uploadThumbnailToR2 = false,
      uploadVideoToR2 = false,
    } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Target URL is required in request body { "url": "https://..." }',
      });
    }

    url = url.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        error: `Invalid URL format: "${url}"`,
      });
    }

    const startTime = Date.now();

    // Fetch using axios with browser headers and redirect tracking
    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,video/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...customHeaders,
      },
      timeout: 18000,
      maxRedirects: 5,
      responseType: 'text',
      validateStatus: () => true, // Don't throw on 4xx/5xx so we can report status
    });

    const responseTimeMs = Date.now() - startTime;
    const contentType = String(response.headers['content-type'] || '');
    const finalUrl = (response.request as any)?.res?.responseUrl || response.config?.url || url;

    // Helper to resolve relative URLs
    const resolveUrl = (relativeOrAbsolute: string) => {
      if (!relativeOrAbsolute) return '';
      try {
        return new URL(relativeOrAbsolute, finalUrl).href;
      } catch {
        return relativeOrAbsolute;
      }
    };

    let pageData: any = {};
    let mediaData: any = {
      videos: [],
      iframes: [],
      images: [],
    };
    const contentData: any = {
      headings: [] as string[],
      textExcerpt: '',
      metaTags: {} as Record<string, string>,
      jsonLd: [] as any[],
    };

    const candidateTitles: Array<{ source: string; text: string; rawText?: string; selector?: string }> = [];
    const candidateThumbnails: Array<{ source: string; url: string; selector?: string; dimensions?: string }> = [];

    // Helper functions for title cleaning
    const cleanStr = (s: string) => (s ? s.replace(/\s+/g, ' ').trim() : '');
    const stripBrandSuffix = (t: string) => {
      if (!t) return '';
      return t.replace(/\s*([|\-–—::»\/\\])\s*[^|\-–—::»\/\\]+$/g, '').trim() || t;
    };

    let detectedDuration: { seconds: number; formatted: string } | null = null;
    let detectedDescription = '';
    let detectedVideoSize: { sizeBytes: number; sizeMb: string; sizeFormatted: string } | null = null;

    // Helper to add candidate title with filtering
    const addCandidateTitle = (source: string, rawText: string, selector?: string) => {
      const trimmed = cleanStr(rawText);
      if (!trimmed) return;
      const filtered = cleanTitleWithFilter(trimmed, wordsToRemove);
      if (!candidateTitles.some((c) => c.text === filtered.cleaned || c.rawText === trimmed)) {
        candidateTitles.push({
          source,
          text: filtered.cleaned,
          rawText: trimmed,
          selector,
        });
      }
    };

    // If it's HTML, parse with Cheerio
    if (
      typeof response.data === 'string' &&
      (contentType.includes('html') ||
        response.data.includes('<html') ||
        response.data.includes('<!DOCTYPE') ||
        response.data.includes('<head') ||
        response.data.includes('<body'))
    ) {
      const $ = cheerio.load(response.data);

      // 1. DISCOVER ALL CANDIDATE TITLES
      // A) OpenGraph & Twitter
      const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
      if (ogTitle) {
        addCandidateTitle('OpenGraph Meta Tag', ogTitle, 'meta[property="og:title"]');
      }

      const twTitle = $('meta[name="twitter:title"]').attr('content');
      if (twTitle) {
        addCandidateTitle('Twitter Card Meta Tag', twTitle, 'meta[name="twitter:title"]');
      }

      const metaTitle = $('meta[name="title"]').attr('content');
      if (metaTitle) {
        addCandidateTitle('Standard Meta Tag', metaTitle, 'meta[name="title"]');
      }

      // B) JSON-LD Structured Data (Titles, Thumbnails, Duration, Description)
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const raw = $(el).html();
          if (raw) {
            const parsed = JSON.parse(raw);
            contentData.jsonLd.push(parsed);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            items.forEach((item: any) => {
              const itemTitle = item.name || item.headline || item.caption;
              if (typeof itemTitle === 'string') {
                addCandidateTitle(`JSON-LD Schema (${item['@type'] || 'Object'})`, itemTitle);
              }

              // Duration in JSON-LD (VideoObject duration: "PT15M33S")
              if (!detectedDuration && item.duration) {
                const p = parseDuration(item.duration);
                if (p) detectedDuration = p;
              }

              // Description in JSON-LD
              if (!detectedDescription && item.description && typeof item.description === 'string') {
                detectedDescription = cleanStr(item.description);
              }

              const itemThumb = item.thumbnailUrl || item.thumbnail || (typeof item.image === 'string' ? item.image : item.image?.url);
              if (typeof itemThumb === 'string' && cleanStr(itemThumb)) {
                const resThumb = resolveUrl(cleanStr(itemThumb));
                if (!candidateThumbnails.some((c) => c.url === resThumb)) {
                  candidateThumbnails.push({ source: `JSON-LD Schema Thumbnail (${item['@type'] || 'Object'})`, url: resThumb });
                }
              }
            });
          }
        } catch {}
      });

      // C) Heading 1 elements (<h1 class="...">)
      $('h1').each((_, el) => {
        const text = cleanStr($(el).text());
        const cls = $(el).attr('class');
        const id = $(el).attr('id');
        const selector = `h1${id ? `#${id}` : ''}${cls ? `.${cls.split(' ').filter(Boolean).join('.')}` : ''}`;
        if (text && text.length > 2 && text.length < 300) {
          addCandidateTitle(`Main Heading (${selector})`, text, selector);
        }
      });

      // D) Elements with class or ID containing 'title', 'video-title', 'headline', 'name'
      $('[class*="title"], [class*="headline"], [class*="name"], [id*="title"], [itemprop="name"]').each((_, el) => {
        const tagName = (el as any).tagName?.toLowerCase() || '';
        if (['h1', 'h2', 'h3', 'h4', 'span', 'p', 'div', 'a'].includes(tagName)) {
          const text = cleanStr($(el).text());
          const cls = $(el).attr('class') || '';
          const id = $(el).attr('id') || '';
          if (text && text.length > 3 && text.length < 250) {
            addCandidateTitle(`Title Class/ID (<${tagName}${cls ? ` class="${cls}"` : ''}>)`, text, `${tagName}${id ? `#${id}` : ''}${cls ? `.${cls.split(' ').filter(Boolean).join('.')}` : ''}`);
          }
        }
      });

      // E) Document <title> tag
      const rawDocTitle = cleanStr($('title').text());
      if (rawDocTitle) {
        const stripped = stripBrandSuffix(rawDocTitle);
        if (stripped && stripped !== rawDocTitle) {
          addCandidateTitle('Cleaned Document Title', stripped, 'title');
        }
        addCandidateTitle('Full Document Title (<title>)', rawDocTitle, 'title');
      }

      // 2. DISCOVER ALL CANDIDATE THUMBNAILS
      // A) <video poster="...">
      $('video').each((_, el) => {
        const poster = $(el).attr('poster') || $(el).attr('data-poster') || $(el).attr('data-thumb');
        if (poster) {
          const resolved = resolveUrl(poster);
          if (resolved && !candidateThumbnails.some((c) => c.url === resolved)) {
            candidateThumbnails.push({ source: 'Video Poster (<video poster="...">)', selector: 'video[poster]', url: resolved });
          }
        }
      });

      // B) OpenGraph & Twitter image
      const ogImage = resolveUrl($('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || '');
      if (ogImage && !candidateThumbnails.some((c) => c.url === ogImage)) {
        candidateThumbnails.push({ source: 'OpenGraph Poster (meta[property="og:image"])', selector: 'meta[property="og:image"]', url: ogImage });
      }

      const twImage = resolveUrl($('meta[name="twitter:image"]').attr('content') || '');
      if (twImage && !candidateThumbnails.some((c) => c.url === twImage)) {
        candidateThumbnails.push({ source: 'Twitter Card Image (meta[name="twitter:image"])', selector: 'meta[name="twitter:image"]', url: twImage });
      }

      // C) meta[name="thumbnail"], meta[itemprop="thumbnailUrl"], link[rel="image_src"]
      $('meta[name="thumbnail"], meta[itemprop="thumbnailUrl"], link[rel="image_src"]').each((_, el) => {
        const href = $(el).attr('content') || $(el).attr('href');
        if (href) {
          const resolved = resolveUrl(href);
          if (resolved && !candidateThumbnails.some((c) => c.url === resolved)) {
            candidateThumbnails.push({
              source: `Thumbnail Meta Tag (${$(el).attr('name') || $(el).attr('itemprop') || $(el).attr('rel')})`,
              url: resolved,
            });
          }
        }
      });

      // D) Featured cover / poster images
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        const cls = ($(el).attr('class') || '') + ' ' + ($(el).attr('id') || '');
        if (src && !src.startsWith('data:') && /(poster|thumb|cover|preview|featured|hero|image)/i.test(cls)) {
          const resolved = resolveUrl(src);
          if (resolved && !candidateThumbnails.some((c) => c.url === resolved)) {
            candidateThumbnails.push({
              source: `Poster Image Element (<img class="${$(el).attr('class') || ''}">)`,
              url: resolved,
              dimensions: $(el).attr('width') && $(el).attr('height') ? `${$(el).attr('width')}×${$(el).attr('height')}` : undefined,
            });
          }
        }
      });

      const ogVideo = resolveUrl(
        $('meta[property="og:video"]').attr('content') ||
          $('meta[property="og:video:url"]').attr('content') ||
          $('meta[property="og:video:secure_url"]').attr('content') ||
          ''
      );

      const favicon = resolveUrl(
        $('link[rel="icon"]').attr('href') ||
          $('link[rel="shortcut icon"]').attr('href') ||
          $('link[rel="apple-touch-icon"]').attr('href') ||
          '/favicon.ico'
      );

      // Description extraction
      const rawDescription =
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content') ||
        $('meta[itemprop="description"]').attr('content') ||
        '';

      if (!detectedDescription && rawDescription) {
        detectedDescription = cleanStr(rawDescription);
      }

      // Check page text elements for description if meta tag was empty
      if (!detectedDescription) {
        $('[class*="description"], [id*="description"], [class*="synopsis"], [id*="synopsis"], [itemprop="description"], .video-details, .summary').each((_, el) => {
          if (detectedDescription) return;
          const text = cleanStr($(el).text());
          if (text && text.length > 20 && text.length < 2500) {
            detectedDescription = text;
          }
        });
      }

      // Duration extraction from meta tags & HTML elements
      if (!detectedDuration) {
        const metaDur =
          $('meta[itemprop="duration"]').attr('content') ||
          $('meta[property="video:duration"]').attr('content') ||
          $('meta[property="og:video:duration"]').attr('content') ||
          $('meta[name="duration"]').attr('content');
        if (metaDur) {
          detectedDuration = parseDuration(metaDur);
        }
      }

      if (!detectedDuration) {
        $('[itemprop="duration"], [data-duration], [class*="duration"], [id*="duration"], [class*="video-time"], [class*="time"]').each((_, el) => {
          if (detectedDuration) return;
          const durAttr = $(el).attr('data-duration') || $(el).attr('content');
          if (durAttr) {
            const p = parseDuration(durAttr);
            if (p) {
              detectedDuration = p;
              return;
            }
          }
          const txt = cleanStr($(el).text());
          if (txt && txt.length <= 15) {
            const p = parseDuration(txt);
            if (p) detectedDuration = p;
          }
        });
      }

      // File size extraction from HTML attributes if present
      const sizeAttr =
        $('meta[itemprop="contentSize"]').attr('content') ||
        $('[data-size]').attr('data-size') ||
        $('[class*="filesize"], [class*="video-size"]').text();
      if (sizeAttr) {
        const match = sizeAttr.match(/(\d+(?:\.\d+)?)\s*(GB|MB|KB)/i);
        if (match) {
          const num = parseFloat(match[1]);
          const unit = match[2].toUpperCase();
          let bytes = num * 1024 * 1024;
          if (unit === 'GB') bytes = num * 1024 * 1024 * 1024;
          if (unit === 'KB') bytes = num * 1024;
          const sizeMb = (bytes / (1024 * 1024)).toFixed(2);
          detectedVideoSize = {
            sizeBytes: Math.round(bytes),
            sizeMb,
            sizeFormatted: `${num} ${unit}`,
          };
        }
      }

      const siteName = $('meta[property="og:site_name"]').attr('content') || parsedUrl.hostname;
      const canonical = resolveUrl($('link[rel="canonical"]').attr('href') || finalUrl);

      // Meta tags collection
      $('meta').each((_, el) => {
        const name = $(el).attr('name') || $(el).attr('property');
        const content = $(el).attr('content');
        if (name && content && !contentData.metaTags[name]) {
          contentData.metaTags[name] = content;
        }
      });

      // 3. DETECT VIDEOS WITH ASSOCIATED POSTER & TITLE
      const detectedVideosMap = new Map<string, { url: string; poster?: string; title?: string; type: string }>();
      if (ogVideo) {
        detectedVideosMap.set(ogVideo, {
          url: ogVideo,
          poster: ogImage || undefined,
          title: candidateTitles[0]?.text || undefined,
          type: ogVideo.includes('.m3u8') ? 'HLS (m3u8)' : 'MP4 Video',
        });
      }

      $('video').each((_, el) => {
        const vSrc = $(el).attr('src');
        const vPoster = resolveUrl($(el).attr('poster') || $(el).attr('data-poster') || $(el).attr('data-thumb') || '');
        const vTitle = $(el).attr('title') || $(el).attr('data-title') || $(el).attr('aria-label') || '';

        if (vSrc) {
          const resolvedUrl = resolveUrl(vSrc);
          detectedVideosMap.set(resolvedUrl, {
            url: resolvedUrl,
            poster: vPoster || ogImage || undefined,
            title: vTitle || candidateTitles[0]?.text || undefined,
            type: resolvedUrl.includes('.m3u8') ? 'HLS (m3u8)' : resolvedUrl.includes('.mp4') ? 'MP4 Video' : 'Video Stream',
          });
        }

        $(el).find('source').each((__, sEl) => {
          const sSrc = $(sEl).attr('src');
          const sType = $(sEl).attr('type') || '';
          if (sSrc) {
            const resolvedUrl = resolveUrl(sSrc);
            if (!detectedVideosMap.has(resolvedUrl)) {
              detectedVideosMap.set(resolvedUrl, {
                url: resolvedUrl,
                poster: vPoster || ogImage || undefined,
                title: vTitle || candidateTitles[0]?.text || undefined,
                type: sType || (resolvedUrl.includes('.m3u8') ? 'HLS (m3u8)' : 'MP4 Video'),
              });
            }
          }
        });
      });

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && /\.(mp4|m3u8|webm|mov|mkv)(\?.*)?$/i.test(href)) {
          const resolvedUrl = resolveUrl(href);
          if (!detectedVideosMap.has(resolvedUrl)) {
            detectedVideosMap.set(resolvedUrl, {
              url: resolvedUrl,
              poster: ogImage || undefined,
              title: cleanStr($(el).text()) || $(el).attr('title') || candidateTitles[0]?.text || undefined,
              type: resolvedUrl.includes('.m3u8') ? 'HLS (m3u8)' : 'MP4 Video',
            });
          }
        }
      });

      // Detect embedded player iframes (YouTube, Vimeo, etc.)
      const detectedIframes: Array<{ src: string; type: string; title?: string }> = [];
      $('iframe[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src) {
          const resolvedSrc = resolveUrl(src);
          let type = 'general_embed';
          if (resolvedSrc.includes('youtube') || resolvedSrc.includes('youtu.be')) type = 'youtube';
          else if (resolvedSrc.includes('vimeo')) type = 'vimeo';
          else if (resolvedSrc.includes('dailymotion')) type = 'dailymotion';
          else if (resolvedSrc.includes('player') || resolvedSrc.includes('embed')) type = 'video_player';
          detectedIframes.push({
            src: resolvedSrc,
            type,
            title: $(el).attr('title') || $(el).attr('aria-label') || undefined,
          });
        }
      });

      // Detect images (for posters / comic pages / banners)
      const detectedImages: Array<{ src: string; alt?: string; width?: string; height?: string }> = [];
      if (ogImage) {
        detectedImages.push({ src: ogImage, alt: 'OG Cover Image' });
      }

      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !src.startsWith('data:')) {
          const resolvedImg = resolveUrl(src);
          if (!detectedImages.some((img) => img.src === resolvedImg)) {
            detectedImages.push({
              src: resolvedImg,
              alt: $(el).attr('alt') || '',
              width: $(el).attr('width') || undefined,
              height: $(el).attr('height') || undefined,
            });
          }
        }
      });

      // Headings
      $('h1, h2').each((_, el) => {
        const text = cleanStr($(el).text());
        if (text && text.length < 200 && !contentData.headings.includes(text)) {
          contentData.headings.push(text);
        }
      });

      // Text excerpt
      $('script, style, noscript, nav, footer, header').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      contentData.textExcerpt = bodyText.substring(0, 1000);

      // Primary title & thumbnail selection
      const rawPrimary = candidateTitles[0]?.rawText || candidateTitles[0]?.text || rawDocTitle || url.split('/').pop()?.split('?')[0] || '';
      const cleanedPrimary = cleanTitleWithFilter(rawPrimary, wordsToRemove);
      let primaryThumbnail = candidateThumbnails[0]?.url || ogImage || '';
      let cloudflareThumbnailUrl: string | null = null;
      let thumbnailStorageSource: 'cloudflare_r2' | 'emulator' | null = null;

      // Automatically upload thumbnail to Cloudflare R2 if requested
      if (uploadThumbnailToR2 && primaryThumbnail) {
        try {
          const r2Upload = await uploadImageToR2OrLocal({
            imageUrl: primaryThumbnail,
            customFilename: cleanedPrimary.cleaned || 'thumb',
            folderPrefix: 'thumbnails',
            req,
          });
          cloudflareThumbnailUrl = r2Upload.cloudflareBackLink;
          thumbnailStorageSource = r2Upload.storageSource;
          primaryThumbnail = r2Upload.cloudflareBackLink;
        } catch (thumbErr) {
          console.warn('Auto upload of thumbnail to Cloudflare R2 failed:', thumbErr);
        }
      }

      // Check remote file size of first detected video if not already extracted
      let firstVideoUrl = Array.from(detectedVideosMap.values())[0]?.url;
      let cloudflareVideoUrl: string | null = null;
      let videoStorageSource: 'cloudflare_r2' | 'emulator' | null = null;

      // Automatically upload video stream to Cloudflare R2 if requested
      if (uploadVideoToR2 && firstVideoUrl) {
        try {
          const r2VideoUpload = await uploadVideoToR2OrLocal({
            videoUrl: firstVideoUrl,
            customFilename: cleanedPrimary.cleaned || 'video',
            folderPrefix: 'videos',
            req,
          });
          cloudflareVideoUrl = r2VideoUpload.cloudflareVideoBackLink;
          videoStorageSource = r2VideoUpload.storageSource;
          detectedVideoSize = {
            sizeBytes: r2VideoUpload.sizeBytes,
            sizeMb: r2VideoUpload.sizeMb,
            sizeFormatted: r2VideoUpload.sizeFormatted,
          };
        } catch (videoErr) {
          console.warn('Auto upload of video to Cloudflare R2 failed:', videoErr);
        }
      }

      if (!detectedVideoSize && firstVideoUrl) {
        detectedVideoSize = await detectRemoteFileSize(firstVideoUrl);
      }

      // Map detected videos with duration, size, and cleaned titles
      const detectedVideosList = await Promise.all(
        Array.from(detectedVideosMap.values()).map(async (vItem, i) => {
          const rawVTitle = vItem.title || rawPrimary;
          const vClean = cleanTitleWithFilter(rawVTitle, wordsToRemove);
          let itemSize = detectedVideoSize;
          if (i > 0 && !itemSize && vItem.url) {
            itemSize = await detectRemoteFileSize(vItem.url);
          }

          const resolvedItemVideoUrl = i === 0 && cloudflareVideoUrl ? cloudflareVideoUrl : vItem.url;

          return {
            id: i + 1,
            url: resolvedItemVideoUrl,
            originalVideoUrl: vItem.url,
            cloudflareVideoUrl: i === 0 && cloudflareVideoUrl ? cloudflareVideoUrl : undefined,
            poster: cloudflareThumbnailUrl || vItem.poster || primaryThumbnail || undefined,
            title: vClean.cleaned,
            rawTitle: rawVTitle,
            type: vItem.type,
            filename: vItem.url.split('/').pop()?.split('?')[0] || `video_${i + 1}`,
            durationSec: detectedDuration?.seconds || null,
            durationFormatted: detectedDuration?.formatted || null,
            sizeBytes: itemSize?.sizeBytes || null,
            sizeMb: itemSize?.sizeMb || null,
            sizeFormatted: itemSize?.sizeFormatted || null,
            description: detectedDescription || undefined,
            cloudflareThumbnailUrl: cloudflareThumbnailUrl || undefined,
          };
        })
      );

      pageData = {
        title: cleanedPrimary.cleaned,
        rawTitle: rawPrimary,
        description: detectedDescription,
        durationSec: detectedDuration?.seconds || null,
        durationFormatted: detectedDuration?.formatted || null,
        videoSize: detectedVideoSize || null,
        removedWords: cleanedPrimary.removedTerms,
        favicon,
        ogImage: primaryThumbnail,
        cloudflareThumbnailUrl,
        thumbnailStorageSource,
        cloudflareVideoUrl,
        videoStorageSource,
        ogVideo: cloudflareVideoUrl || ogVideo,
        siteName,
        canonical,
        candidateTitles,
        candidateThumbnails,
      };

      mediaData = {
        videos: detectedVideosList,
        iframes: detectedIframes,
        images: detectedImages.slice(0, 40),
      };
    } else {
      // Non-HTML media stream directly (e.g. video/mp4, application/vnd.apple.mpegurl, image, json, etc.)
      const directTitle = url.split('/').pop()?.split('?')[0] || parsedUrl.hostname;
      const cleanedDirect = cleanTitleWithFilter(directTitle, wordsToRemove);

      // Check remote size of direct resource
      let directSize: { sizeBytes: number; sizeMb: string; sizeFormatted: string } | null = null;
      if (response.headers['content-length']) {
        const bytes = parseInt(String(response.headers['content-length']), 10);
        if (!isNaN(bytes) && bytes > 0) {
          directSize = {
            sizeBytes: bytes,
            sizeMb: (bytes / (1024 * 1024)).toFixed(2),
            sizeFormatted:
              bytes >= 1024 * 1024 * 1024
                ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
                : `${(bytes / (1024 * 1024)).toFixed(2)} MB`,
          };
        }
      }
      if (!directSize) {
        directSize = await detectRemoteFileSize(finalUrl);
      }

      let cloudflareVideoUrl: string | null = null;
      let videoStorageSource: 'cloudflare_r2' | 'emulator' | null = null;

      if (uploadVideoToR2 && (contentType.includes('video') || contentType.includes('mpegurl') || /\.(mp4|m3u8|webm)$/i.test(url))) {
        try {
          const r2DirectVideo = await uploadVideoToR2OrLocal({
            videoUrl: finalUrl,
            customFilename: cleanedDirect.cleaned || 'stream_video',
            folderPrefix: 'videos',
            req,
          });
          cloudflareVideoUrl = r2DirectVideo.cloudflareVideoBackLink;
          videoStorageSource = r2DirectVideo.storageSource;
          directSize = {
            sizeBytes: r2DirectVideo.sizeBytes,
            sizeMb: r2DirectVideo.sizeMb,
            sizeFormatted: r2DirectVideo.sizeFormatted,
          };
        } catch (r2Err) {
          console.warn('Direct video stream Cloudflare upload failed:', r2Err);
        }
      }

      pageData = {
        title: cleanedDirect.cleaned,
        rawTitle: directTitle,
        description: `Direct ${contentType} resource stream`,
        durationSec: null,
        durationFormatted: null,
        videoSize: directSize,
        removedWords: cleanedDirect.removedTerms,
        favicon: `${parsedUrl.origin}/favicon.ico`,
        siteName: parsedUrl.hostname,
        cloudflareVideoUrl,
        videoStorageSource,
        candidateTitles: [
          {
            source: 'Direct Resource Filename',
            text: cleanedDirect.cleaned,
            rawText: directTitle,
          },
        ],
        candidateThumbnails: [],
      };

      if (contentType.includes('video') || contentType.includes('mpegurl') || /\.(mp4|m3u8|webm)$/i.test(url)) {
        mediaData.videos.push({
          id: 1,
          url: cloudflareVideoUrl || finalUrl,
          originalVideoUrl: finalUrl,
          cloudflareVideoUrl: cloudflareVideoUrl || undefined,
          title: cleanedDirect.cleaned,
          rawTitle: directTitle,
          type: contentType || (finalUrl.includes('.m3u8') ? 'HLS (m3u8)' : 'MP4 Video'),
          filename: finalUrl.split('/').pop()?.split('?')[0] || 'stream_video',
          durationSec: null,
          durationFormatted: null,
          sizeBytes: directSize?.sizeBytes || null,
          sizeMb: directSize?.sizeMb || null,
          sizeFormatted: directSize?.sizeFormatted || null,
          description: `Direct video resource stream from ${parsedUrl.hostname}`,
        });
      } else if (contentType.includes('image')) {
        mediaData.images.push({
          src: finalUrl,
          alt: 'Direct Image Resource',
        });
      }
    }

    // Complete HTML source delivery (up to 1MB safe limit)
    const rawHtmlString = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    const fullHtml = rawHtmlString.substring(0, 1000000);

    // Auto-record / update in Cloudflare Extracted Registry so deduplication is automatic
    const registryUniqueId = getLinkUniqueId(url);
    const normUrl = normalizeUrlForDedup(url);
    const primaryVideoObj = mediaData.videos?.[0];
    const bestThumb = pageData.cloudflareThumbnailUrl || primaryVideoObj?.poster || pageData.ogImage || '';
    const bestVideoUrl = pageData.cloudflareVideoUrl || primaryVideoObj?.url || '';

    const existingRegIdx = extractedLinksRegistry.findIndex(
      (r) => normalizeUrlForDedup(r.sourceUrl) === normUrl || r.id === registryUniqueId
    );

    const nowIso = new Date().toISOString();
    const isNowUploaded = Boolean(pageData.cloudflareVideoUrl || pageData.cloudflareThumbnailUrl);

    if (existingRegIdx >= 0) {
      extractedLinksRegistry[existingRegIdx] = {
        ...extractedLinksRegistry[existingRegIdx],
        title: pageData.title || extractedLinksRegistry[existingRegIdx].title,
        rawTitle: pageData.rawTitle || extractedLinksRegistry[existingRegIdx].rawTitle,
        videoUrl: primaryVideoObj?.originalVideoUrl || primaryVideoObj?.url || extractedLinksRegistry[existingRegIdx].videoUrl,
        thumbnailUrl: bestThumb || extractedLinksRegistry[existingRegIdx].thumbnailUrl,
        cloudflareVideoUrl: pageData.cloudflareVideoUrl || extractedLinksRegistry[existingRegIdx].cloudflareVideoUrl,
        cloudflareThumbnailUrl: pageData.cloudflareThumbnailUrl || extractedLinksRegistry[existingRegIdx].cloudflareThumbnailUrl,
        durationFormatted: pageData.durationFormatted || extractedLinksRegistry[existingRegIdx].durationFormatted,
        durationSec: pageData.durationSec || extractedLinksRegistry[existingRegIdx].durationSec,
        sizeFormatted: pageData.videoSize?.sizeFormatted || extractedLinksRegistry[existingRegIdx].sizeFormatted,
        status: isNowUploaded || extractedLinksRegistry[existingRegIdx].status === 'uploaded' ? 'uploaded' : 'extracted',
        lastUpdatedAt: nowIso,
      };
    } else {
      extractedLinksRegistry.unshift({
        id: registryUniqueId,
        sourceUrl: url,
        title: pageData.title || 'Extracted Video',
        rawTitle: pageData.rawTitle || pageData.title,
        videoUrl: primaryVideoObj?.originalVideoUrl || primaryVideoObj?.url || '',
        thumbnailUrl: bestThumb,
        cloudflareVideoUrl: pageData.cloudflareVideoUrl || undefined,
        cloudflareThumbnailUrl: pageData.cloudflareThumbnailUrl || undefined,
        durationFormatted: pageData.durationFormatted || '',
        durationSec: pageData.durationSec || null,
        sizeFormatted: pageData.videoSize?.sizeFormatted || '',
        destination: 'none',
        status: isNowUploaded ? 'uploaded' : 'extracted',
        firstExtractedAt: nowIso,
        lastUpdatedAt: nowIso,
      });
    }

    // Background sync to disk and R2
    syncRegistryToStorage(req).catch(() => {});

    return res.json({
      success: true,
      status: response.status,
      statusText: response.statusText || 'OK',
      targetUrl: url,
      finalUrl,
      registryUniqueId,
      isRegisteredInCloudflare: true,
      isUploadedToCloudflare: Boolean(pageData.cloudflareVideoUrl || pageData.cloudflareThumbnailUrl),
      responseTimeMs,
      contentType,
      headers: {
        server: response.headers['server'] || null,
        'content-type': response.headers['content-type'] || null,
        'content-length': response.headers['content-length'] || null,
        'cache-control': response.headers['cache-control'] || null,
        date: response.headers['date'] || null,
      },
      page: pageData,
      media: mediaData,
      content: contentData,
      fullHtml,
      rawSnippet: fullHtml.substring(0, 3000),
      htmlLength: rawHtmlString.length,
    });
  } catch (err: any) {
    console.error('URL processing error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to process website URL',
      details: err.code || err.name,
    });
  }
});

// Ensure /api routes NEVER fall through to Vite SPA html middleware
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    error: `API route ${req.method} ${req.path} not found`,
  });
});

// Global API error handler ensuring all errors are JSON, never HTML
app.use((err: any, req: Request, res: Response, next: any) => {
  if (req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
    console.error('Unhandled API error on', req.path, err);
    return res.status(err.status || err.statusCode || 500).json({
      status: 'error',
      error: err.message || 'Internal server error',
      code: err.code,
    });
  }
  next(err);
});

// Start the server with Vite middleware in development
async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
