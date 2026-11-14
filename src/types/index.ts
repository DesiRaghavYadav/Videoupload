export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrlPrefix?: string;
}

export interface DetectedSecretsStatus {
  accountId: boolean;
  accessKeyId: boolean;
  secretAccessKey: boolean;
  bucketName: boolean;
  publicUrlPrefix: boolean;
}

export interface R2StatusResponse {
  configured: boolean;
  bucket?: string;
  accountId?: string;
  publicUrlPrefix?: string | null;
  source?: 'client_headers' | 'server_secrets';
  message?: string;
  detectedSecrets?: DetectedSecretsStatus;
  allSecretsFound?: boolean;
  missingSecrets?: string[];
}

export interface VideoMetadata {
  filename: string;
  exactFilename?: string;
  fileSize: number;
  fileSizeFormatted: string;
  sizeMb?: number;
  duration: number;
  durationSec?: number;
  durationFormatted: string;
  durationHuman?: string;
  uploadTime?: number;
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
}

export interface BatchVideoItem {
  id: string;
  file: File;
  status: 'queued' | 'analyzing' | 'extracting' | 'uploading' | 'verified' | 'error';
  progress: number;
  duration?: number;
  dimensions?: string;
  actualCaptureTime?: number;
  thumbnailDataUrl?: string;
  thumbnailBlob?: Blob;
  result?: ProcessedVideoResponse;
  errorMessage?: string;
}

export interface AppOptimizedVideo {
  id: number;
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

export interface AppOptimizedBatchDatabase {
  batchId: string;
  title: string;
  description: string;
  imageUrl: string;
  category: string;
  isPremium: boolean;
  releaseDate: number;
  totalVideos: number;
  videos: AppOptimizedVideo[];
  r2DatabaseUrl?: string;
  savedAt?: string;
}

export interface SaveDatabaseResponse {
  success: boolean;
  batchId: string;
  databaseUrl: string;
  databaseKey: string;
  verifiedInStorage: boolean;
  cloudflareR2: {
    bucket: string;
    etag: string | null;
    uploadedToR2: boolean;
  };
  database: AppOptimizedBatchDatabase;
}

export interface CloudflareR2Details {
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
}

export interface VerificationStep {
  step: string;
  status: 'VERIFIED' | 'FAILED' | 'SKIPPED' | 'ABORTED';
  timestamp: string;
  details: string;
  error?: string;
}

export interface ProcessedVideoResponse {
  status: 'success' | 'error';
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  captureTimestamp: number;
  sizeMb?: number;
  durationSec?: number;
  duration?: string;
  uploadTime?: number;
  cloudflareR2: CloudflareR2Details;
  metadata: VideoMetadata;
  verificationAudit: VerificationStep[];
  failedStep?: string;
  error?: string;
  details?: string;
  subsequentStepsAborted?: boolean;
}

export type PipelineStage =
  | 'idle'
  | 'validating_video'
  | 'extracting_frame'
  | 'preflight_r2'
  | 'uploading_video'
  | 'verifying_video'
  | 'uploading_thumbnail'
  | 'verifying_thumbnail'
  | 'complete'
  | 'error';

export interface PipelineProgress {
  stage: PipelineStage;
  percent: number;
  message: string;
  activeStepName: string;
  failedStep?: string;
  error?: string;
  auditTrail?: VerificationStep[];
}

export interface SystemResourcesResponse {
  cpu: {
    cores: number;
    model: string;
    speedMhz: number;
    speedFormatted: string;
    usagePercent: number;
    loadAverage: number[];
  };
  ram: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    totalFormatted: string;
    usedFormatted: string;
    freeFormatted: string;
    processRssFormatted: string;
  };
  disk: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    totalFormatted: string;
    usedFormatted: string;
    freeFormatted: string;
    mountPoint: string;
  };
  vpsRecommendation: {
    recommendedWorkers: number;
    maxSafeWorkers: number;
    currentCpuStatus: 'healthy' | 'moderate' | 'high';
    currentRamStatus: 'healthy' | 'moderate' | 'low';
    reason: string;
  };
  system: {
    uptimeSeconds: number;
    uptimeFormatted: string;
    platform: string;
    arch: string;
    hostname: string;
  };
  timestamp: string;
}

