import React from 'react';
import {
  Cloud,
  Settings,
  Database,
  HardDrive,
  CheckCircle2,
  Film,
  PlaySquare,
  BookOpen,
  Headphones,
  Tv,
  LayoutDashboard,
  FolderTree,
  FileCode,
  Zap,
  Globe,
  Link2,
} from 'lucide-react';
import { R2StatusResponse } from '../types';

export type AppTabType =
  | 'dashboard'
  | 'webprocessor'
  | 'linkextractor'
  | 'batchvideo'
  | 'reels'
  | 'comics'
  | 'stories'
  | 'channels'
  | 'categories'
  | 'upload'
  | 'database'
  | 'history'
  | 'docs';

interface HeaderProps {
  r2Status: R2StatusResponse | null;
  onOpenSettings: () => void;
  activeTab: AppTabType;
  setActiveTab: (tab: AppTabType) => void;
}

export const Header: React.FC<HeaderProps> = ({
  r2Status,
  onOpenSettings,
  activeTab,
  setActiveTab,
}) => {
  const isR2Live = Boolean(r2Status?.configured);

  const navItems = [
    { id: 'dashboard', label: 'Dashboard & Stats', icon: LayoutDashboard },
    { id: 'webprocessor', label: 'Web Processor', icon: Globe },
    { id: 'linkextractor', label: 'URL Extractor', icon: Link2 },
    { id: 'batchvideo', label: 'Batch Videos', icon: Film },
    { id: 'database', label: 'App Database (JSON)', icon: Database },
    { id: 'reels', label: 'Short Reels', icon: PlaySquare },
    { id: 'comics', label: 'Comics', icon: BookOpen },
    { id: 'stories', label: 'Audio Stories', icon: Headphones },
    { id: 'channels', label: 'Live TV', icon: Tv },
    { id: 'categories', label: 'Categories', icon: FolderTree },
    { id: 'upload', label: 'R2 Video Vault', icon: Cloud },
    { id: 'docs', label: 'API Specs', icon: FileCode },
  ];

  return (
    <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur-md border-b border-slate-800">
      {/* Top Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Brand */}
        <div
          onClick={() => setActiveTab('dashboard')}
          className="flex items-center gap-3 shrink-0 cursor-pointer group"
        >
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 via-amber-500 to-rose-600 flex items-center justify-center shadow-lg shadow-orange-500/20 text-white group-hover:scale-105 transition-transform">
            <Zap className="w-5 h-5 fill-current" />
          </div>
          <div>
            <span className="text-base font-bold tracking-tight text-white block leading-tight">
              Cloudflare OTT Admin
            </span>
            <span className="text-[11px] text-orange-400 font-medium block">
              D1 Worker REST API &amp; R2 Storage
            </span>
          </div>
        </div>

        {/* Status Indicators & R2 Config */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Worker REST API Status Badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-semibold text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Worker API Live</span>
          </div>

          {/* R2 Storage Indicator */}
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-400">
            {isR2Live ? (
              <span className="flex items-center gap-1.5 text-emerald-400/90 bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-800">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span className="font-mono text-[11px]">R2: {r2Status?.bucket}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-amber-400/90 bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-800">
                <HardDrive className="w-3.5 h-3.5" />
                <span className="text-[11px]">Local R2 Emulator</span>
              </span>
            )}
          </div>

          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-900 border border-slate-700/80 rounded-xl hover:bg-slate-800 hover:text-white transition-all shadow-sm"
            title="Configure Cloudflare R2 Credentials"
          >
            <Settings className="w-3.5 h-3.5 text-orange-400" />
            <span className="hidden sm:inline">R2 Vault Config</span>
          </button>
        </div>
      </div>

      {/* Navigation Sub-Bar */}
      <div className="border-t border-slate-800/80 bg-slate-950/60 overflow-x-auto scrollbar-none">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center gap-1 py-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as AppTabType)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 shrink-0 ${
                  isActive
                    ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/20'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
};
