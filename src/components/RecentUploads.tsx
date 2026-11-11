import React from 'react';
import { Film, Camera, Copy, ExternalLink, Trash2, Calendar, ArrowUpRight } from 'lucide-react';
import { ProcessedVideoResponse } from '../types';
import { formatDateTime } from '../utils/formatters';

interface RecentUploadsProps {
  records: ProcessedVideoResponse[];
  onSelectRecord: (record: ProcessedVideoResponse) => void;
  onDeleteRecord: (id: string) => void;
}

export const RecentUploads: React.FC<RecentUploadsProps> = ({
  records,
  onSelectRecord,
  onDeleteRecord,
}) => {
  if (records.length === 0) {
    return (
      <div className="p-12 text-center bg-slate-900/40 border border-slate-800 rounded-2xl">
        <Film className="w-12 h-12 text-slate-600 mx-auto mb-3" />
        <h3 className="text-sm font-semibold text-white">No Processed Videos Yet</h3>
        <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
          Upload a video or generate a demo clip to process 5-second frame thumbnails and view structured metadata objects.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">
          Processed Vault Records ({records.length})
        </h3>
        <span className="text-xs text-slate-400">Click any card to inspect full metadata object</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {records.map((rec) => (
          <div
            key={rec.id}
            onClick={() => onSelectRecord(rec)}
            className="group p-4 bg-slate-900/70 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl transition-all cursor-pointer shadow-lg flex flex-col justify-between space-y-3"
          >
            {/* Thumbnail Header */}
            <div className="relative aspect-video rounded-lg overflow-hidden bg-black border border-slate-800">
              <img
                src={rec.thumbnailUrl}
                alt={rec.metadata.filename}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
              <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[10px] font-mono text-orange-400 border border-white/10">
                {rec.metadata.durationFormatted}
              </div>
              <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[10px] font-mono text-white border border-white/10">
                {rec.captureTimestamp.toFixed(1)}s Frame
              </div>
            </div>

            {/* Info */}
            <div>
              <h4 className="text-xs font-semibold text-white truncate group-hover:text-orange-400 transition-colors">
                {rec.metadata.filename}
              </h4>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-1 font-mono">
                <span>{rec.metadata.fileSizeFormatted}</span>
                <span aria-hidden="true">·</span>
                <span>{rec.metadata.resolution}</span>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-400">
                  {rec.cloudflareR2.uploadedToCloudflareR2 ? 'R2 Live' : 'Emulator'}
                </span>
              </div>
            </div>

            {/* Footer Actions */}
            <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
              <span className="text-[10px] font-mono text-slate-500">
                {formatDateTime(rec.metadata.uploadedAt)}
              </span>

              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <a
                  href={rec.videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1 hover:text-white transition-colors"
                  title="Open video URL"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  onClick={() => onDeleteRecord(rec.id)}
                  className="p-1 hover:text-rose-400 transition-colors"
                  title="Remove record"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
