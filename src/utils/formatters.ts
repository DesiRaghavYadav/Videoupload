/**
 * Format bytes into human-readable string (KB, MB, GB)
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Format seconds into HH:MM:SS or MM:SS
 */
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const paddedMins = mins.toString().padStart(2, '0');
  const paddedSecs = secs.toString().padStart(2, '0');

  if (hrs > 0) {
    const paddedHrs = hrs.toString().padStart(2, '0');
    return `${paddedHrs}:${paddedMins}:${paddedSecs}`;
  }
  return `${paddedMins}:${paddedSecs}`;
}

/**
 * Compute common aspect ratio representation
 */
export function calculateAspectRatio(width: number, height: number): string {
  if (!width || !height) return '16:9';

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  const ratioW = Math.round(width) / divisor;
  const ratioH = Math.round(height) / divisor;

  // Normalize common standard aspect ratios
  const decimal = width / height;
  if (Math.abs(decimal - 16 / 9) < 0.05) return '16:9 (Widescreen)';
  if (Math.abs(decimal - 9 / 16) < 0.05) return '9:16 (Vertical)';
  if (Math.abs(decimal - 4 / 3) < 0.05) return '4:3 (Standard)';
  if (Math.abs(decimal - 1) < 0.05) return '1:1 (Square)';
  if (Math.abs(decimal - 21 / 9) < 0.05) return '21:9 (Ultrawide)';

  return `${ratioW}:${ratioH}`;
}

/**
 * Format bitrate in kbps or Mbps
 */
export function formatBitrate(kbps: number): string {
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(2)} Mbps`;
  }
  return `${Math.round(kbps)} Kbps`;
}

/**
 * Format ISO date string into readable local timestamp
 */
export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * Format duration into human string matching the required schema format (e.g. "22 min", "8 sec", "1h 15m")
 */
export function formatDurationHuman(seconds: number): string {
  const s = Math.round(Math.max(0, Number(seconds) || 0));
  if (s < 60) return `${s} sec`;
  const mins = Math.floor(s / 60);
  const remSecs = s % 60;
  if (mins < 60) {
    return remSecs > 0 ? `${mins} min ${remSecs}s` : `${mins} min`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours} hr`;
}

/**
 * Format bytes into numeric megabytes (MB) rounded cleanly to 2 decimal places
 */
export function formatSizeMb(bytes: number): number {
  if (!bytes || bytes <= 0) return 0.01;
  const mb = bytes / (1024 * 1024);
  return mb < 0.01 ? 0.01 : parseFloat(mb.toFixed(2));
}

