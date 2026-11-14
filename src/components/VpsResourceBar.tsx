import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Cpu,
  HardDrive,
  Zap,
  RefreshCw,
  Server,
  Activity,
  Layers,
  ChevronDown,
  ChevronUp,
  Clock,
  Gauge,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { SystemResourcesResponse } from '../types';
import { fetchSystemResources } from '../utils/vpsTelemetryService';

interface VpsResourceBarProps {
  currentConcurrency?: number;
  onApplyOptimalWorkers?: (workerCount: number) => void;
  activeBatchWorkers?: number;
  isBatchRunning?: boolean;
}

export const VpsResourceBar: React.FC<VpsResourceBarProps> = ({
  currentConcurrency,
  onApplyOptimalWorkers,
  activeBatchWorkers = 0,
  isBatchRunning = false,
}) => {
  const [telemetry, setTelemetry] = useState<SystemResourcesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [appliedNotice, setAppliedNotice] = useState(false);
  const isMountedRef = useRef(true);

  const loadMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchSystemResources();
      if (isMountedRef.current) {
        setTelemetry(data);
        setLastUpdated(new Date());
      }
    } catch (err) {
      console.warn('Failed to fetch VPS telemetry:', err);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    loadMetrics();

    // Auto-refresh every 5 seconds while page is visible
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadMetrics();
      }
    }, 5000);

    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
    };
  }, [loadMetrics]);

  const handleApplyOptimal = () => {
    if (!telemetry || !onApplyOptimalWorkers) return;
    onApplyOptimalWorkers(telemetry.vpsRecommendation.recommendedWorkers);
    setAppliedNotice(true);
    setTimeout(() => {
      if (isMountedRef.current) setAppliedNotice(false);
    }, 2500);
  };

  // Helper colors based on percentage
  const getLoadColor = (pct: number) => {
    if (pct < 60) return { text: 'text-emerald-400', bg: 'bg-emerald-500', track: 'bg-emerald-500/20' };
    if (pct < 85) return { text: 'text-amber-400', bg: 'bg-amber-500', track: 'bg-amber-500/20' };
    return { text: 'text-rose-400', bg: 'bg-rose-500', track: 'bg-rose-500/20' };
  };

  const cpuColors = getLoadColor(telemetry?.cpu.usagePercent ?? 0);
  const ramColors = getLoadColor(telemetry?.ram.usedPercent ?? 0);
  const diskColors = getLoadColor(telemetry?.disk.usedPercent ?? 0);

  return (
    <div className="w-full bg-slate-900/90 border-b border-slate-800/90 text-slate-200 text-xs backdrop-blur-md relative z-30 shadow-inner">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Main Resource Cards Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 flex-1">
            {/* 1. CPU & CLOCK SPEED */}
            <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl px-3 py-2 flex items-center justify-between gap-2 hover:border-slate-700/80 transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shrink-0">
                  <Cpu className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-white tracking-tight truncate text-[11px] sm:text-xs">
                      {telemetry ? `${telemetry.cpu.cores} Cores` : 'Detecting...'}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">
                      {telemetry?.cpu.speedFormatted}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <span>Load:</span>
                    <span className={`font-mono font-bold ${cpuColors.text}`}>
                      {telemetry ? `${telemetry.cpu.usagePercent}%` : '--%'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="w-10 sm:w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0">
                <div
                  className={`h-full ${cpuColors.bg} transition-all duration-500`}
                  style={{ width: `${Math.min(100, Math.max(3, telemetry?.cpu.usagePercent ?? 0))}%` }}
                />
              </div>
            </div>

            {/* 2. RAM (MEMORY) */}
            <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl px-3 py-2 flex items-center justify-between gap-2 hover:border-slate-700/80 transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shrink-0">
                  <Activity className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-white tracking-tight text-[11px] sm:text-xs">
                      RAM: {telemetry ? telemetry.ram.usedFormatted : '--'}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">
                      / {telemetry?.ram.totalFormatted}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <span className={`font-mono font-bold ${ramColors.text}`}>
                      {telemetry ? `${telemetry.ram.usedPercent}%` : '--%'}
                    </span>
                    <span className="truncate hidden sm:inline">({telemetry?.ram.freeFormatted} free)</span>
                  </div>
                </div>
              </div>
              <div className="w-10 sm:w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0">
                <div
                  className={`h-full ${ramColors.bg} transition-all duration-500`}
                  style={{ width: `${Math.min(100, Math.max(3, telemetry?.ram.usedPercent ?? 0))}%` }}
                />
              </div>
            </div>

            {/* 3. DISK SPACE */}
            <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl px-3 py-2 flex items-center justify-between gap-2 hover:border-slate-700/80 transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  <HardDrive className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-white tracking-tight text-[11px] sm:text-xs">
                      Disk: {telemetry ? telemetry.disk.usedFormatted : '--'}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">
                      / {telemetry?.disk.totalFormatted}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <span className={`font-mono font-bold ${diskColors.text}`}>
                      {telemetry ? `${telemetry.disk.usedPercent}%` : '--%'}
                    </span>
                    <span className="truncate hidden sm:inline">({telemetry?.disk.freeFormatted} free)</span>
                  </div>
                </div>
              </div>
              <div className="w-10 sm:w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0">
                <div
                  className={`h-full ${diskColors.bg} transition-all duration-500`}
                  style={{ width: `${Math.min(100, Math.max(3, telemetry?.disk.usedPercent ?? 0))}%` }}
                />
              </div>
            </div>

            {/* 4. OPTIMAL WORKER RECOMMENDATION */}
            <div className="bg-gradient-to-r from-orange-500/10 via-amber-500/10 to-cyan-500/10 border border-orange-500/30 rounded-xl px-3 py-2 flex items-center justify-between gap-2 relative overflow-hidden">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-lg bg-orange-500/20 text-orange-400 border border-orange-500/30 shrink-0">
                  <Zap className="w-3.5 h-3.5 fill-current" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-white text-[11px] sm:text-xs">
                      Optimal:{' '}
                      <span className="text-orange-400 font-mono text-sm font-extrabold">
                        {telemetry?.vpsRecommendation.recommendedWorkers ?? 4}
                      </span>{' '}
                      Workers
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 flex items-center gap-1.5">
                    <span>Current:</span>
                    <span className="font-mono font-bold text-cyan-300">
                      {currentConcurrency ?? 3}x
                    </span>
                    {isBatchRunning && (
                      <span className="text-emerald-400 font-mono flex items-center gap-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        {activeBatchWorkers} active
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Action Button: Auto-tune Concurrency */}
              {onApplyOptimalWorkers && telemetry && (
                <button
                  onClick={handleApplyOptimal}
                  disabled={currentConcurrency === telemetry.vpsRecommendation.recommendedWorkers}
                  title={`Apply ${telemetry.vpsRecommendation.recommendedWorkers} optimal workers based on live VPS metrics`}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all shadow-sm shrink-0 flex items-center gap-1 ${
                    appliedNotice
                      ? 'bg-emerald-500 text-slate-950'
                      : currentConcurrency === telemetry.vpsRecommendation.recommendedWorkers
                      ? 'bg-slate-800 text-slate-500 cursor-default'
                      : 'bg-orange-500 hover:bg-orange-400 text-slate-950 hover:scale-105 active:scale-95'
                  }`}
                >
                  {appliedNotice ? (
                    <>
                      <CheckCircle2 className="w-3 h-3" />
                      <span>Applied</span>
                    </>
                  ) : currentConcurrency === telemetry.vpsRecommendation.recommendedWorkers ? (
                    <span>Tuned</span>
                  ) : (
                    <>
                      <Zap className="w-2.5 h-2.5 fill-current" />
                      <span>Apply</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Right Action Controls: Refresh & Details Toggle */}
          <div className="flex items-center justify-end gap-2 shrink-0 pt-1 lg:pt-0 border-t border-slate-800/60 lg:border-t-0">
            {/* Recommendation Reason Tooltip snippet */}
            {telemetry?.vpsRecommendation.reason && (
              <span className="text-[11px] text-slate-400 hidden xl:inline max-w-xs truncate" title={telemetry.vpsRecommendation.reason}>
                {telemetry.vpsRecommendation.reason}
              </span>
            )}

            {/* Refresh Button */}
            <button
              onClick={() => loadMetrics()}
              disabled={isLoading}
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
              title="Refresh live VPS resources"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-orange-400' : ''}`} />
            </button>

            {/* Details Expand Toggle */}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-[10px] font-medium text-slate-300 hover:text-white transition-colors"
              title="Toggle detailed VPS specs and telemetry"
            >
              <Server className="w-3 h-3 text-cyan-400" />
              <span>Details</span>
              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* Expandable Technical Telemetry Drawer */}
        {isExpanded && telemetry && (
          <div className="mt-3 pt-3 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-3 gap-3 animate-fadeIn text-[11px]">
            {/* CPU & Host Details */}
            <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60 space-y-1">
              <div className="text-[10px] uppercase font-bold text-cyan-400 tracking-wider flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                <span>Processor &amp; Architecture</span>
              </div>
              <p className="text-white font-medium truncate">{telemetry.cpu.model}</p>
              <div className="flex justify-between text-slate-400 text-[10px]">
                <span>Speed: {telemetry.cpu.speedFormatted}</span>
                <span>Cores: {telemetry.cpu.cores} vCPU</span>
              </div>
              <div className="text-slate-400 text-[10px]">
                Load Avg (1m, 5m, 15m):{' '}
                <span className="font-mono text-slate-300">
                  {telemetry.cpu.loadAverage.map((l) => l.toFixed(2)).join(', ')}
                </span>
              </div>
            </div>

            {/* Memory & Process RSS */}
            <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60 space-y-1">
              <div className="text-[10px] uppercase font-bold text-indigo-400 tracking-wider flex items-center gap-1">
                <Activity className="w-3 h-3" />
                <span>Memory Allocation</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Total Physical RAM:</span>
                <span className="font-mono font-semibold">{telemetry.ram.totalFormatted}</span>
              </div>
              <div className="flex justify-between text-slate-400 text-[10px]">
                <span>App Process RSS:</span>
                <span className="font-mono text-cyan-300">{telemetry.ram.processRssFormatted}</span>
              </div>
              <div className="flex justify-between text-slate-400 text-[10px]">
                <span>Available Free:</span>
                <span className="font-mono text-emerald-400">{telemetry.ram.freeFormatted}</span>
              </div>
            </div>

            {/* VPS Recommendation Justification */}
            <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60 space-y-1">
              <div className="text-[10px] uppercase font-bold text-orange-400 tracking-wider flex items-center gap-1">
                <Gauge className="w-3 h-3" />
                <span>Worker Scaling Rationale</span>
              </div>
              <p className="text-slate-300 leading-snug">{telemetry.vpsRecommendation.reason}</p>
              <div className="flex items-center justify-between text-slate-400 text-[10px] pt-1 border-t border-slate-800/60">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <span>Uptime: {telemetry.system.uptimeFormatted}</span>
                </span>
                <span className="font-mono text-[9px] text-slate-500">
                  {telemetry.system.platform} ({telemetry.system.arch})
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
