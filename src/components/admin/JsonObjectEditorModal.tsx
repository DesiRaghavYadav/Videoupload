import React, { useState, useEffect } from 'react';
import {
  FileJson,
  Save,
  Trash2,
  Copy,
  Check,
  X,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Sliders,
  Code2,
  RotateCcw,
} from 'lucide-react';

interface JsonObjectEditorModalProps {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  initialData: any;
  onClose: () => void;
  onSave: (updatedObject: any) => Promise<void>;
  onDelete?: () => Promise<void>;
  saveLabel?: string;
  deleteLabel?: string;
  accentColor?: 'orange' | 'amber' | 'rose' | 'violet' | 'emerald' | 'sky' | 'yellow' | 'cyan';
}

export const JsonObjectEditorModal: React.FC<JsonObjectEditorModalProps> = ({
  isOpen,
  title,
  subtitle,
  initialData,
  onClose,
  onSave,
  onDelete,
  saveLabel = 'Save Changes',
  deleteLabel = 'Delete Item',
  accentColor = 'orange',
}) => {
  const [editMode, setEditMode] = useState<'fields' | 'json'>('json');
  const [workingObj, setWorkingObj] = useState<any>(initialData ?? {});
  const [jsonText, setJsonText] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen && initialData !== undefined) {
      const cloned = JSON.parse(JSON.stringify(initialData));
      setWorkingObj(cloned);
      setJsonText(JSON.stringify(cloned, null, 2));
      setParseError(null);
      setSaveError(null);
      setSaveSuccess(null);
      setConfirmDelete(false);
      // Default to fields view if it's a flat-ish plain object with primitive fields, otherwise json
      const isPlainObj = cloned && typeof cloned === 'object' && !Array.isArray(cloned);
      const keys = isPlainObj ? Object.keys(cloned) : [];
      const hasOnlySmallPrimitives =
        isPlainObj &&
        keys.length > 0 &&
        keys.length <= 16 &&
        keys.every((k) => typeof cloned[k] !== 'object' || cloned[k] === null);
      setEditMode(hasOnlySmallPrimitives ? 'fields' : 'json');
    }
  }, [isOpen, initialData]);

  if (!isOpen) return null;

  const handleJsonChange = (val: string) => {
    setJsonText(val);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const parsed = JSON.parse(val);
      setWorkingObj(parsed);
      setParseError(null);
    } catch (err: any) {
      setParseError(err?.message || 'Invalid JSON syntax');
    }
  };

  const handleFieldChange = (key: string, newValue: any) => {
    setSaveError(null);
    setSaveSuccess(null);
    const updated = { ...(workingObj || {}), [key]: newValue };
    setWorkingObj(updated);
    setJsonText(JSON.stringify(updated, null, 2));
    setParseError(null);
  };

  const handleNestedJsonFieldChange = (key: string, rawVal: string) => {
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const parsedVal = JSON.parse(rawVal);
      const updated = { ...(workingObj || {}), [key]: parsedVal };
      setWorkingObj(updated);
      setJsonText(JSON.stringify(updated, null, 2));
      setParseError(null);
    } catch {
      // Allow editing intermediate text only in JSON tab
      setEditMode('json');
    }
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setWorkingObj(parsed);
      setJsonText(JSON.stringify(parsed, null, 2));
      setParseError(null);
    } catch (err: any) {
      setParseError(err?.message || 'Cannot format invalid JSON');
    }
  };

  const handleReset = () => {
    const cloned = JSON.parse(JSON.stringify(initialData ?? {}));
    setWorkingObj(cloned);
    setJsonText(JSON.stringify(cloned, null, 2));
    setParseError(null);
    setSaveError(null);
    setSaveSuccess(null);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleSaveClick = async () => {
    setSaveError(null);
    setSaveSuccess(null);
    let payloadToSave = workingObj;
    if (editMode === 'json') {
      try {
        payloadToSave = JSON.parse(jsonText);
      } catch (err: any) {
        setParseError(err?.message || 'Fix invalid JSON before saving');
        return;
      }
    }
    setIsSaving(true);
    try {
      await onSave(payloadToSave);
      setSaveSuccess('Saved changes successfully.');
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteClick = async () => {
    if (!onDelete) return;
    setSaveError(null);
    setIsDeleting(true);
    try {
      await onDelete();
      onClose();
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to delete item');
      setConfirmDelete(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const isObjectEditableInFields =
    workingObj && typeof workingObj === 'object' && !Array.isArray(workingObj);

  const buttonAccentClass =
    accentColor === 'rose'
      ? 'from-rose-500 to-pink-600 hover:from-rose-400 hover:to-pink-500'
      : accentColor === 'violet'
      ? 'from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500'
      : accentColor === 'emerald'
      ? 'from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500'
      : accentColor === 'sky'
      ? 'from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500'
      : accentColor === 'yellow'
      ? 'from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 text-slate-950'
      : accentColor === 'cyan'
      ? 'from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500'
      : 'from-orange-500 to-amber-600 hover:from-orange-400 hover:to-amber-500';

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/95">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <FileJson className="w-4 h-4 text-orange-400 shrink-0" />
              <h3 className="font-bold text-white text-sm truncate">{title}</h3>
            </div>
            {subtitle && (
              <p className="text-[11px] text-slate-400 font-mono truncate">{subtitle}</p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {isObjectEditableInFields && (
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-0.5 flex text-[11px]">
                <button
                  type="button"
                  onClick={() => setEditMode('fields')}
                  className={`px-2.5 py-1 rounded-md font-semibold flex items-center gap-1 transition-colors ${
                    editMode === 'fields'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Sliders className="w-3 h-3" />
                  <span>Fields</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditMode('json')}
                  className={`px-2.5 py-1 rounded-md font-semibold flex items-center gap-1 transition-colors ${
                    editMode === 'json'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Code2 className="w-3 h-3" />
                  <span>JSON Object</span>
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={handleCopy}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1 border border-slate-700"
              title="Copy JSON"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700"
              title="Close editor"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Status / Validation Banners */}
        {(parseError || saveError || saveSuccess) && (
          <div className="px-4 pt-3 space-y-2">
            {parseError && (
              <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2 font-mono">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>JSON Syntax Error: {parseError}</span>
              </div>
            )}
            {saveError && (
              <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{saveError}</span>
              </div>
            )}
            {saveSuccess && (
              <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                <span>{saveSuccess}</span>
              </div>
            )}
          </div>
        )}

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1 space-y-3 bg-slate-950/60">
          {editMode === 'fields' && isObjectEditableInFields ? (
            <div className="space-y-3">
              {Object.entries(workingObj).map(([key, val]) => {
                const isComplex = typeof val === 'object' && val !== null;
                const isBool = typeof val === 'boolean';
                const isNum = typeof val === 'number';
                const strVal = typeof val === 'string' ? val : String(val ?? '');
                const isLongText = typeof val === 'string' && (val.length > 95 || val.includes('\n'));

                return (
                  <div
                    key={key}
                    className="p-3 bg-slate-900/90 border border-slate-800 rounded-xl space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] font-bold font-mono text-sky-300">
                        {key}
                      </label>
                      <span className="text-[10px] font-mono text-slate-500">
                        {Array.isArray(val) ? `array[${val.length}]` : val === null ? 'null' : typeof val}
                      </span>
                    </div>

                    {isBool ? (
                      <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer pt-0.5">
                        <input
                          type="checkbox"
                          checked={val}
                          onChange={(e) => handleFieldChange(key, e.target.checked)}
                          className="rounded accent-orange-500 w-4 h-4"
                        />
                        <span className="font-mono">{val ? 'true' : 'false'}</span>
                      </label>
                    ) : isNum ? (
                      <input
                        type="number"
                        step="any"
                        value={Number.isNaN(val) ? 0 : val}
                        onChange={(e) => {
                          const parsed = Number(e.target.value);
                          handleFieldChange(key, Number.isNaN(parsed) ? 0 : parsed);
                        }}
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-amber-300 font-mono text-xs outline-none"
                      />
                    ) : isComplex ? (
                      <div className="space-y-1.5">
                        <textarea
                          rows={Math.min(8, Math.max(3, JSON.stringify(val, null, 2).split('\n').length))}
                          defaultValue={JSON.stringify(val, null, 2)}
                          onBlur={(e) => handleNestedJsonFieldChange(key, e.target.value)}
                          className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-emerald-300 font-mono text-[11px] outline-none"
                        />
                        <p className="text-[10px] text-slate-500">
                          Edit valid JSON array/object (applies on blur) or switch to &ldquo;JSON Object&rdquo; view above.
                        </p>
                      </div>
                    ) : isLongText ? (
                      <textarea
                        rows={3}
                        value={strVal}
                        onChange={(e) => handleFieldChange(key, e.target.value)}
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 text-xs outline-none"
                      />
                    ) : (
                      <input
                        type="text"
                        value={val === null || val === undefined ? '' : strVal}
                        onChange={(e) => handleFieldChange(key, e.target.value)}
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-slate-100 font-mono text-xs outline-none"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2 h-full flex flex-col">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>
                  Direct JSON Editor ({jsonText.length.toLocaleString()} bytes) — edit any fields, nested arrays, or IDs:
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleFormat}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 font-medium"
                  >
                    Format JSON
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 font-medium flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset</span>
                  </button>
                </div>
              </div>
              <textarea
                value={jsonText}
                onChange={(e) => handleJsonChange(e.target.value)}
                rows={18}
                spellCheck={false}
                className="w-full flex-1 min-h-[340px] p-3.5 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-xl font-mono text-xs text-emerald-300 leading-relaxed outline-none resize-y"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/95 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div>
            {onDelete && (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-rose-300 font-semibold">Confirm delete?</span>
                  <button
                    type="button"
                    onClick={handleDeleteClick}
                    disabled={isDeleting}
                    className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold rounded-lg flex items-center gap-1"
                  >
                    {isDeleting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    <span>{isDeleting ? 'Deleting...' : 'Yes, Delete'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 font-semibold rounded-xl flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{deleteLabel}</span>
                </button>
              )
            )}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-xl border border-slate-700"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={isSaving || Boolean(parseError)}
              className={`px-5 py-2 bg-gradient-to-r ${buttonAccentClass} disabled:opacity-50 text-white font-bold rounded-xl shadow-lg flex items-center gap-1.5 transition-all`}
            >
              {isSaving ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{isSaving ? 'Saving...' : saveLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
