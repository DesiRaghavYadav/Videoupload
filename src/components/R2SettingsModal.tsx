import React, { useState, useEffect } from 'react';
import {
  X,
  Key,
  Database,
  Globe,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  Trash2,
  Lock,
} from 'lucide-react';
import { R2Credentials, R2StatusResponse } from '../types';
import {
  getSavedR2Credentials,
  saveR2Credentials,
  clearR2Credentials,
  testR2Connection,
  fetchR2Status,
} from '../utils/r2Service';

interface R2SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const R2SettingsModal: React.FC<R2SettingsModalProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const [formData, setFormData] = useState<R2Credentials>({
    accountId: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucketName: '',
    publicUrlPrefix: '',
  });

  const [serverStatus, setServerStatus] = useState<R2StatusResponse | null>(null);
  const [checkingSecrets, setCheckingSecrets] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const loadStatus = async () => {
    setCheckingSecrets(true);
    try {
      const status = await fetchR2Status();
      setServerStatus(status);
    } catch (e) {
      console.warn('Failed to load R2 status:', e);
    } finally {
      setCheckingSecrets(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      const saved = getSavedR2Credentials();
      if (saved) {
        setFormData(saved);
      }
      setTestResult(null);
      loadStatus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setTestResult(null);
  };

  const handleTest = async () => {
    // If user has entered credentials in form, test those.
    // If not, test the server secrets credentials!
    const credsToTest =
      formData.accountId && formData.accessKeyId && formData.secretAccessKey && formData.bucketName
        ? formData
        : null;

    setTesting(true);
    setTestResult(null);
    try {
      const res = await testR2Connection(credsToTest);
      setTestResult({
        success: res.success,
        message: res.message || res.error || 'Connection failed',
      });
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.message || 'Network error testing R2 connection',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    if (formData.accountId && formData.accessKeyId && formData.secretAccessKey && formData.bucketName) {
      saveR2Credentials(formData);
    }
    onSaved();
    onClose();
  };

  const handleClear = () => {
    clearR2Credentials();
    setFormData({
      accountId: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucketName: '',
      publicUrlPrefix: '',
    });
    setTestResult(null);
    onSaved();
  };

  const detected = serverStatus?.detectedSecrets;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="relative w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-500/10 text-orange-400 flex items-center justify-center border border-orange-500/20">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Cloudflare R2 Credentials &amp; Secrets</h2>
              <p className="text-xs text-slate-400">Direct S3-compatible API credentials for video &amp; thumbnail storage</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-md"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {/* Secrets Auto-Detection Status Banner */}
          <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Lock className="w-4 h-4 text-orange-400" />
                <span>Server Secrets Status (Environment Variables)</span>
              </div>
              <button
                type="button"
                onClick={loadStatus}
                disabled={checkingSecrets}
                className="text-[11px] text-orange-400 hover:underline flex items-center gap-1"
              >
                <RefreshCw className={`w-3 h-3 ${checkingSecrets ? 'animate-spin' : ''}`} />
                <span>Re-check Secrets</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 rounded bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                <span className="text-slate-400 font-mono text-[11px]">R2_ACCOUNT_ID</span>
                {detected?.accountId ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1 text-[11px]">
                    <CheckCircle className="w-3 h-3" /> Detected
                  </span>
                ) : (
                  <span className="text-slate-500 text-[11px]">Not Found</span>
                )}
              </div>

              <div className="p-2 rounded bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                <span className="text-slate-400 font-mono text-[11px]">R2_ACCESS_KEY_ID</span>
                {detected?.accessKeyId ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1 text-[11px]">
                    <CheckCircle className="w-3 h-3" /> Detected
                  </span>
                ) : (
                  <span className="text-slate-500 text-[11px]">Not Found</span>
                )}
              </div>

              <div className="p-2 rounded bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                <span className="text-slate-400 font-mono text-[11px]">R2_SECRET_ACCESS_KEY</span>
                {detected?.secretAccessKey ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1 text-[11px]">
                    <CheckCircle className="w-3 h-3" /> Detected
                  </span>
                ) : (
                  <span className="text-slate-500 text-[11px]">Not Found</span>
                )}
              </div>

              <div className="p-2 rounded bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                <span className="text-slate-400 font-mono text-[11px]">R2_BUCKET_NAME</span>
                {detected?.bucketName ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1 text-[11px]">
                    <CheckCircle className="w-3 h-3" /> Detected
                  </span>
                ) : (
                  <span className="text-slate-500 text-[11px]">Not Found</span>
                )}
              </div>
            </div>

            {serverStatus?.allSecretsFound ? (
              <div className="p-2 bg-emerald-950/30 border border-emerald-800/60 rounded text-[11px] text-emerald-300 flex items-center gap-2">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>
                  All Cloudflare R2 secrets are active in server memory (Bucket: <strong>{serverStatus.bucket}</strong>). You do not need to enter credentials below!
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-slate-400 leading-relaxed">
                If you set secrets in the AI Studio Secrets panel, ensure variable names match <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>, <code>R2_SECRET_ACCESS_KEY</code>, and <code>R2_BUCKET_NAME</code>. You can also paste them directly into the fields below for instant use.
              </p>
            )}
          </div>

          {/* Manual Input Fields (Optional Override) */}
          <div className="space-y-4">
            <div className="text-xs font-semibold text-slate-200">
              Browser Credential Overrides <span className="text-slate-500 font-normal">(Optional if set in Secrets)</span>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Cloudflare Account ID
              </label>
              <input
                type="text"
                name="accountId"
                value={formData.accountId}
                onChange={handleChange}
                placeholder="e.g. 8f6b2c4e1a0d9e8f7a6b5c4d3e2f1a0b"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 font-mono text-xs"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  R2 Access Key ID
                </label>
                <input
                  type="text"
                  name="accessKeyId"
                  value={formData.accessKeyId}
                  onChange={handleChange}
                  placeholder="e.g. 74b8f0d8a1c93e2b"
                  className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  R2 Bucket Name
                </label>
                <input
                  type="text"
                  name="bucketName"
                  value={formData.bucketName}
                  onChange={handleChange}
                  placeholder="e.g. video-vault-bucket"
                  className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 font-mono text-xs"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                R2 Secret Access Key
              </label>
              <input
                type="password"
                name="secretAccessKey"
                value={formData.secretAccessKey}
                onChange={handleChange}
                placeholder="Enter secret access key"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 font-mono text-xs"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Public Custom Domain or r2.dev Prefix <span className="text-slate-500 font-normal">(Optional)</span>
              </label>
              <input
                type="url"
                name="publicUrlPrefix"
                value={formData.publicUrlPrefix}
                onChange={handleChange}
                placeholder="https://pub-xxxxxx.r2.dev or https://media.yourdomain.com"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                If left blank, the app's streaming proxy automatically serves playback and thumbnails seamlessly!
              </p>
            </div>
          </div>

          {testResult && (
            <div
              className={`p-3 rounded-lg text-xs flex items-start gap-2.5 ${
                testResult.success
                  ? 'bg-emerald-950/40 border border-emerald-800 text-emerald-300'
                  : 'bg-rose-950/40 border border-rose-800 text-rose-300'
              }`}
            >
              {testResult.success ? (
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              )}
              <div className="leading-snug">{testResult.message}</div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950/70">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {testing ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-orange-400" />
              )}
              <span>{testing ? 'Testing R2 API...' : 'Test R2 Connection'}</span>
            </button>

            {formData.accountId && (
              <button
                type="button"
                onClick={handleClear}
                className="px-2.5 py-1.5 text-xs text-rose-400 hover:text-rose-300 transition-colors flex items-center gap-1"
                title="Remove credentials from local session"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-500 rounded-lg transition-colors shadow-sm"
            >
              Apply Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
