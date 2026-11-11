import { R2Credentials, R2StatusResponse, ProcessedVideoResponse } from '../types';

const STORAGE_KEY = 'r2_credentials_vault_v1';

/**
 * Retrieve saved R2 credentials from localStorage
 */
export function getSavedR2Credentials(): R2Credentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.accountId && parsed.accessKeyId && parsed.secretAccessKey && parsed.bucketName) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save R2 credentials to localStorage
 */
export function saveR2Credentials(credentials: R2Credentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}

/**
 * Clear saved credentials
 */
export function clearR2Credentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Build headers for API requests using either provided credentials or saved credentials
 */
export function getR2Headers(override?: R2Credentials | null): Record<string, string> {
  const creds = override !== undefined ? override : getSavedR2Credentials();
  if (!creds) return {};

  const headers: Record<string, string> = {
    'x-r2-account-id': creds.accountId,
    'x-r2-access-key-id': creds.accessKeyId,
    'x-r2-secret-access-key': creds.secretAccessKey,
    'x-r2-bucket-name': creds.bucketName,
  };

  if (creds.publicUrlPrefix) {
    headers['x-r2-public-url-prefix'] = creds.publicUrlPrefix;
  }

  return headers;
}

/**
 * Fetch current R2 connection status from backend
 */
export async function fetchR2Status(credentialsOverride?: R2Credentials | null): Promise<R2StatusResponse> {
  const headers = getR2Headers(credentialsOverride);
  const res = await fetch('/api/r2/status', { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: Failed to query R2 status`);
  }
  return res.json();
}

/**
 * Test R2 connection with specified or saved credentials
 */
export async function testR2Connection(credentials?: R2Credentials | null): Promise<{
  success: boolean;
  message: string;
  bucket?: string;
  error?: string;
}> {
  const headers = getR2Headers(credentials);
  const res = await fetch('/api/r2/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
  return res.json();
}

/**
 * Upload video and extracted thumbnail to Cloudflare R2 / Server
 */
export async function uploadVideoAndThumbnail(params: {
  videoFile: File;
  thumbnailBlob: Blob;
  captureTimestamp: number;
  metadata: Record<string, any>;
  folderPrefix?: string;
  credentials?: R2Credentials | null;
  onProgress?: (percent: number) => void;
}): Promise<ProcessedVideoResponse> {
  const formData = new FormData();
  formData.append('video', params.videoFile, params.videoFile.name);
  formData.append(
    'thumbnail',
    params.thumbnailBlob,
    `${params.videoFile.name.replace(/\.[^/.]+$/, '')}-thumb.jpg`
  );
  formData.append('captureTimestamp', String(params.captureTimestamp));
  formData.append('metadata', JSON.stringify(params.metadata));
  if (params.folderPrefix !== undefined) {
    formData.append('folderPrefix', params.folderPrefix);
  }

  const headers = getR2Headers(params.credentials);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    // Attach R2 credential headers if available
    Object.entries(headers).forEach(([key, val]) => {
      xhr.setRequestHeader(key, val);
    });

    if (xhr.upload && params.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          params.onProgress?.(percent);
        }
      };
    }

    xhr.onload = () => {
      let parsedData: any = null;
      let isJson = false;

      if (xhr.responseText && xhr.responseText.trim().length > 0) {
        try {
          parsedData = JSON.parse(xhr.responseText);
          isJson = true;
        } catch {
          isJson = false;
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        if (isJson && parsedData) {
          resolve(parsedData);
        } else {
          const preview = xhr.responseText
            ? xhr.responseText.slice(0, 160).replace(/\s+/g, ' ').trim()
            : '(empty body)';
          reject(new Error(`Server returned unexpected response (${xhr.status}): ${preview}`));
        }
      } else {
        if (isJson && parsedData) {
          const err: any = new Error(
            parsedData.error || `Upload failed with status ${xhr.status}`
          );
          err.failedStep = parsedData.failedStep;
          err.verificationAudit = parsedData.verificationAudit;
          err.subsequentStepsAborted = parsedData.subsequentStepsAborted;
          reject(err);
        } else {
          const preview = xhr.responseText
            ? xhr.responseText.slice(0, 160).replace(/\s+/g, ' ').trim()
            : xhr.statusText || 'Unknown error';
          reject(new Error(`Server error (${xhr.status}): ${preview}`));
        }
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error during upload'));
    };

    xhr.send(formData);
  });
}

/**
 * Fetch upload history
 */
export async function fetchUploadHistory(): Promise<ProcessedVideoResponse[]> {
  try {
    const res = await fetch('/api/videos');
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

/**
 * Delete a processed video
 */
export async function deleteVideoRecord(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Save App-Optimized Batch Database JSON manifest directly to Cloudflare R2
 */
export async function saveDatabaseToR2(
  database: any,
  credentialsOverride?: R2Credentials | null
): Promise<any> {
  const headers = getR2Headers(credentialsOverride);
  const res = await fetch('/api/database/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(database),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to save database' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch all saved database manifests from Cloudflare R2
 */
export async function fetchSavedDatabases(): Promise<any[]> {
  try {
    const res = await fetch('/api/database');
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

/**
 * Delete a saved database manifest
 */
export async function deleteSavedDatabase(batchId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/database/${batchId}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
