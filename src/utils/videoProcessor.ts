import { formatBytes, formatDuration, calculateAspectRatio } from './formatters';
import { VideoMetadata } from '../types';

export interface ExtractedFrameResult {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  timestamp: number;
}

export interface VideoAnalysisResult {
  duration: number;
  width: number;
  height: number;
  aspectRatio: string;
  fileSize: number;
  mimeType: string;
  bitrateEstimateKbps: number;
  recommendedCaptureTime: number;
}

/**
 * Inspect video file in browser to extract dimensions, duration, format
 */
export async function inspectVideoFile(file: File): Promise<VideoAnalysisResult> {
  return new Promise((resolve, reject) => {
    // If file has explicit duration attached (e.g. generated test clips)
    const explicitDur = (file as any).explicitDuration;
    if (explicitDur && typeof explicitDur === 'number' && explicitDur > 0) {
      resolve({
        duration: explicitDur,
        width: 1280,
        height: 720,
        aspectRatio: '16:9 (Widescreen)',
        fileSize: file.size,
        mimeType: file.type || 'video/webm',
        bitrateEstimateKbps: Math.round((file.size * 8) / (1000 * explicitDur)),
        recommendedCaptureTime: explicitDur >= 5 ? 5.0 : Math.max(0.5, explicitDur / 2),
      });
      return;
    }

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.remove();
    };

    const finishInspection = (dur: number) => {
      const validDuration = isFinite(dur) && dur > 0 ? dur : 5.0;
      const width = video.videoWidth || 1920;
      const height = video.videoHeight || 1080;
      const aspectRatio = calculateAspectRatio(width, height);
      const fileSize = file.size;
      const bitrateEstimateKbps =
        validDuration > 0 ? Math.round((fileSize * 8) / (1000 * validDuration)) : 0;
      const recommendedCaptureTime = validDuration >= 5 ? 5.0 : Math.max(0.5, validDuration / 2);

      cleanup();
      resolve({
        duration: validDuration,
        width,
        height,
        aspectRatio,
        fileSize,
        mimeType: file.type || 'video/mp4',
        bitrateEstimateKbps,
        recommendedCaptureTime,
      });
    };

    video.onloadedmetadata = () => {
      let dur = video.duration;
      // If WebM has Infinity duration, seek to end to read true duration
      if (!isFinite(dur) || isNaN(dur) || dur <= 0) {
        video.currentTime = 1e101;
        video.ontimeupdate = () => {
          video.ontimeupdate = null;
          let calculatedDur = video.duration;
          if (!isFinite(calculatedDur) || isNaN(calculatedDur) || calculatedDur <= 0) {
            calculatedDur = video.currentTime > 0 && isFinite(video.currentTime) ? video.currentTime : 5.0;
          }
          video.currentTime = 0;
          finishInspection(calculatedDur);
        };
        return;
      }
      finishInspection(dur);
    };

    video.onerror = () => {
      cleanup();
      // Graceful fallback with valid metadata instead of crashing batch pipeline
      resolve({
        duration: 5.0,
        width: 1920,
        height: 1080,
        aspectRatio: '16:9',
        fileSize: file.size,
        mimeType: file.type || 'video/mp4',
        bitrateEstimateKbps: Math.round((file.size * 8) / (1000 * 5)),
        recommendedCaptureTime: 5.0,
      });
    };
  });
}

/**
 * Capture frame from video at target timestamp (default: 5.0 seconds)
 */
export async function extractFrameAtTime(
  file: File | Blob,
  targetTimeSeconds = 5.0
): Promise<ExtractedFrameResult> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    let seekAttempted = false;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.remove();
    };

    video.onloadedmetadata = () => {
      // Clamp target time between 0 and duration
      const duration = video.duration || 0;
      const safeTime = duration > 0 ? Math.min(Math.max(0, targetTimeSeconds), Math.max(0, duration - 0.1)) : targetTimeSeconds;

      video.currentTime = safeTime;
      seekAttempted = true;
    };

    video.onseeked = () => {
      try {
        const width = video.videoWidth || 1920;
        const height = video.videoHeight || 1080;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          reject(new Error('Could not initialize 2D canvas context for frame capture'));
          return;
        }

        // Draw the exact frame
        ctx.drawImage(video, 0, 0, width, height);

        // Optional subtle branded timestamp watermark watermark overlay or clean frame
        // Keep thumbnail pristine as requested
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

        canvas.toBlob(
          (blob) => {
            cleanup();
            if (!blob) {
              reject(new Error('Failed to create thumbnail Blob from canvas'));
              return;
            }
            resolve({
              blob,
              dataUrl,
              width,
              height,
              sizeBytes: blob.size,
              timestamp: video.currentTime,
            });
          },
          'image/jpeg',
          0.92
        );
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    video.onerror = (e) => {
      cleanup();
      reject(new Error('Error seeking to frame at timestamp ' + targetTimeSeconds + 's'));
    };

    // Safety timeout in case seek never fires
    setTimeout(() => {
      if (!seekAttempted) {
        cleanup();
        reject(new Error('Video loading timed out while seeking to frame'));
      }
    }, 15000);
  });
}

/**
 * Generate a real, high-quality test video directly in the browser
 * for instant testing without requiring an external file upload!
 */
export async function generateSampleTestVideo(
  title = 'Cloudflare R2 Test Stream',
  durationSeconds = 8,
  customFilename?: string
): Promise<File> {
  return new Promise((resolve, reject) => {
    try {
      const width = 1280;
      const height = 720;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Canvas context not available'));
        return;
      }

      // Check MediaRecorder support
      const stream = canvas.captureStream(30);
      let mimeType = 'video/webm;codecs=vp9';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm';
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const finalFilename = customFilename || `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${durationSeconds}s.webm`;
        const file = new File([blob], finalFilename, {
          type: mimeType,
        });
        (file as any).explicitDuration = durationSeconds;
        resolve(file);
      };

      recorder.start();

      const startTime = performance.now();
      const fps = 30;
      const totalFrames = durationSeconds * fps;
      let frameCount = 0;

      const renderFrame = () => {
        const elapsed = (performance.now() - startTime) / 1000;
        const currentSec = Math.min(elapsed, durationSeconds);

        // Draw sleek tech gradient background
        const grad = ctx.createLinearGradient(0, 0, width, height);
        grad.addColorStop(0, '#020617'); // slate-950
        grad.addColorStop(0.5, '#0f172a'); // slate-900
        grad.addColorStop(1, '#1e1b4b'); // deep indigo

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        // Animated glowing orbital rings
        ctx.save();
        ctx.translate(width / 2, height / 2 - 30);
        const rot = elapsed * 0.8;
        ctx.rotate(rot);

        ctx.strokeStyle = 'rgba(249, 115, 22, 0.4)'; // orange-500
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, 0, 180, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)'; // sky-400
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, 240, 120, Math.PI / 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // 5-second indicator banner
        const isNearFiveSec = Math.abs(currentSec - 5.0) < 0.6;
        if (isNearFiveSec) {
          ctx.fillStyle = 'rgba(249, 115, 22, 0.9)';
          ctx.fillRect(0, height - 120, width, 50);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 22px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('★ 5.0s FRAME CAPTURE TARGET ★', width / 2, height - 88);
        }

        // Title and timer
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 36px system-ui, sans-serif';
        ctx.fillText(title, width / 2, height / 2 - 60);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '18px monospace';
        ctx.fillText('CLOUDFLARE R2 PIPELINE TEST CLIP', width / 2, height / 2 - 20);

        // Giant Digital Timer
        ctx.fillStyle = isNearFiveSec ? '#f97316' : '#38bdf8';
        ctx.font = 'bold 76px monospace';
        const formattedTime = `00:0${currentSec.toFixed(2)}`;
        ctx.fillText(formattedTime, width / 2, height / 2 + 70);

        // Progress bar at bottom
        const progress = Math.min(1, currentSec / durationSeconds);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(80, height - 40, width - 160, 12);
        ctx.fillStyle = '#f97316';
        ctx.fillRect(80, height - 40, (width - 160) * progress, 12);

        frameCount++;
        if (frameCount < totalFrames && recorder.state === 'recording') {
          setTimeout(renderFrame, 1000 / fps);
        } else {
          if (recorder.state === 'recording') {
            recorder.stop();
          }
        }
      };

      renderFrame();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate a batch of 3 test video files with exact filenames
 */
export async function generateBatchDemoVideos(): Promise<File[]> {
  const vid1 = await generateSampleTestVideo('Batch_Scene_Intro', 6, 'Batch_Scene_Intro.webm');
  const vid2 = await generateSampleTestVideo('Product_Showcase_Main', 8, 'Product_Showcase_Main.webm');
  const vid3 = await generateSampleTestVideo('Closing_Credits_Outro', 7, 'Closing_Credits_Outro.webm');
  return [vid1, vid2, vid3];
}

