import React from 'react';
import {
  CheckCircle2,
  Loader2,
  AlertOctagon,
  Ban,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { PipelineProgress, VerificationStep } from '../types';

interface ProcessingProgressProps {
  progress: PipelineProgress;
}

export const ProcessingProgress: React.FC<ProcessingProgressProps> = ({ progress }) => {
  const defaultSteps: { name: string; desc: string }[] = [
    {
      name: '1. Video File Integrity',
      desc: 'Verify container format, duration, dimensions & byte buffer',
    },
    {
      name: '2. 5s Frame Thumbnail Verification',
      desc: 'Seek to 5.0s, draw to canvas & verify JPEG thumbnail blob',
    },
    {
      name: '3. Cloudflare R2 Connection Pre-Flight',
      desc: 'Authenticate S3 credentials & verify bucket accessibility via HeadBucket',
    },
    {
      name: '4. Video Upload & Read-after-Write Verification',
      desc: 'Stream to R2 & verify object presence via HeadObject (Size & ETag)',
    },
    {
      name: '5. Thumbnail Upload & Storage Verification',
      desc: 'Upload 5s JPEG to R2 & verify ContentType image/jpeg via HeadObject',
    },
    {
      name: '6. Playback URL Resolution & Schema Formatting',
      desc: 'Verify playback URL, resolve thumbnail & structure metadata object',
    },
  ];

  // Determine status for each step
  const getStepStatus = (
    stepName: string
  ): { status: 'VERIFIED' | 'RUNNING' | 'FAILED' | 'ABORTED' | 'PENDING' | 'SKIPPED'; details?: string; error?: string } => {
    // If audit trail is provided from backend
    if (progress.auditTrail && progress.auditTrail.length > 0) {
      const match = progress.auditTrail.find(
        (a) => a.step.toLowerCase() === stepName.toLowerCase() || a.step.includes(stepName.split('.')[0])
      );
      if (match) {
        return {
          status: match.status,
          details: match.details,
          error: match.error,
        };
      }
    }

    if (progress.failedStep && progress.failedStep.includes(stepName.split('.')[0])) {
      return { status: 'FAILED', error: progress.error };
    }

    // Check by active progress stage
    const stepIndexMap: Record<string, number> = {
      '1. Video File Integrity': 1,
      '2. 5s Frame Thumbnail Verification': 2,
      '3. Cloudflare R2 Connection Pre-Flight': 3,
      '4. Video Upload & Read-after-Write Verification': 4,
      '5. Thumbnail Upload & Storage Verification': 5,
      '6. Playback URL Resolution & Schema Formatting': 6,
    };

    const thisStepNum = stepIndexMap[stepName] || 1;

    let activeStepNum = 1;
    if (progress.stage === 'validating_video') activeStepNum = 1;
    if (progress.stage === 'extracting_frame') activeStepNum = 2;
    if (progress.stage === 'preflight_r2') activeStepNum = 3;
    if (progress.stage === 'uploading_video' || progress.stage === 'verifying_video') activeStepNum = 4;
    if (progress.stage === 'uploading_thumbnail' || progress.stage === 'verifying_thumbnail') activeStepNum = 5;
    if (progress.stage === 'complete') activeStepNum = 7;

    if (progress.stage === 'error') {
      if (thisStepNum === activeStepNum) return { status: 'FAILED', error: progress.error };
      if (thisStepNum < activeStepNum) return { status: 'VERIFIED' };
      return { status: 'ABORTED' };
    }

    if (progress.stage === 'complete') {
      return { status: 'VERIFIED' };
    }

    if (thisStepNum < activeStepNum) return { status: 'VERIFIED' };
    if (thisStepNum === activeStepNum) return { status: 'RUNNING' };
    return { status: 'PENDING' };
  };

  const isError = progress.stage === 'error';

  return (
    <div
      className={`p-6 bg-slate-900/90 border rounded-2xl shadow-xl space-y-6 transition-all ${
        isError ? 'border-rose-900/80' : 'border-slate-800'
      }`}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {isError ? (
              <ShieldAlert className="w-5 h-5 text-rose-400" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-orange-400" />
            )}
            <h3 className="text-base font-semibold text-white">
              Strict Step-by-Step Verification Pipeline
            </h3>
          </div>
          <p className="text-xs text-slate-400">
            {isError ? (
              <span className="text-rose-400 font-medium">
                Pipeline strictly halted on failure. Subsequent upload steps were aborted to protect data integrity.
              </span>
            ) : (
              progress.message || 'Verifying each step prior to advancing...'
            )}
          </p>
        </div>

        <div className="text-right">
          <span
            className={`text-xl font-bold font-mono tabular-nums ${
              isError ? 'text-rose-400' : 'text-orange-400'
            }`}
          >
            {progress.percent}%
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
        <div
          className={`h-full transition-all duration-300 ease-out ${
            isError
              ? 'bg-rose-600'
              : 'bg-gradient-to-r from-orange-500 via-amber-500 to-emerald-500'
          }`}
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      {/* Step by Step Breakdown */}
      <div className="space-y-2.5 pt-1">
        {defaultSteps.map((s, idx) => {
          const stepInfo = getStepStatus(s.name);

          return (
            <div
              key={s.name}
              className={`p-3.5 rounded-xl border text-xs transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                stepInfo.status === 'VERIFIED'
                  ? 'bg-emerald-950/20 border-emerald-900/50 text-slate-300'
                  : stepInfo.status === 'RUNNING'
                  ? 'bg-orange-500/10 border-orange-500/40 text-white shadow-sm'
                  : stepInfo.status === 'FAILED'
                  ? 'bg-rose-950/40 border-rose-800 text-rose-200'
                  : stepInfo.status === 'ABORTED'
                  ? 'bg-slate-950/40 border-slate-800/80 text-slate-500 opacity-70'
                  : 'bg-slate-950/30 border-slate-800/40 text-slate-500'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="shrink-0">
                  {stepInfo.status === 'VERIFIED' && (
                    <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                      <CheckCircle2 className="w-4 h-4" />
                    </div>
                  )}
                  {stepInfo.status === 'RUNNING' && (
                    <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  )}
                  {stepInfo.status === 'FAILED' && (
                    <div className="w-6 h-6 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center">
                      <AlertOctagon className="w-4 h-4" />
                    </div>
                  )}
                  {stepInfo.status === 'ABORTED' && (
                    <div className="w-6 h-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center">
                      <Ban className="w-3.5 h-3.5" />
                    </div>
                  )}
                  {stepInfo.status === 'PENDING' && (
                    <div className="w-6 h-6 rounded-full bg-slate-800 text-slate-500 flex items-center justify-center font-mono text-[10px]">
                      0{idx + 1}
                    </div>
                  )}
                </div>

                <div>
                  <div className="font-semibold text-xs flex items-center gap-2">
                    <span className={stepInfo.status === 'FAILED' ? 'text-rose-300' : 'text-slate-200'}>
                      {s.name}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {stepInfo.details || s.desc}
                  </div>
                  {stepInfo.error && (
                    <div className="text-[11px] text-rose-400 font-mono mt-1 font-medium">
                      Error: {stepInfo.error}
                    </div>
                  )}
                </div>
              </div>

              {/* Status Badge */}
              <div className="shrink-0 text-right">
                {stepInfo.status === 'VERIFIED' && (
                  <span className="text-[11px] font-mono text-emerald-400 font-semibold tracking-wider">
                    VERIFIED ✓
                  </span>
                )}
                {stepInfo.status === 'RUNNING' && (
                  <span className="text-[11px] font-mono text-orange-400 font-semibold tracking-wider animate-pulse">
                    VERIFYING...
                  </span>
                )}
                {stepInfo.status === 'FAILED' && (
                  <span className="text-[11px] font-mono text-rose-400 font-bold tracking-wider">
                    FAILED ✕
                  </span>
                )}
                {stepInfo.status === 'ABORTED' && (
                  <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                    ABORTED (NOT EXECUTED)
                  </span>
                )}
                {stepInfo.status === 'PENDING' && (
                  <span className="text-[10px] font-mono text-slate-600 uppercase tracking-wider">
                    QUEUED
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
