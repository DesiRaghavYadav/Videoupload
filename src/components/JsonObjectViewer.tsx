import React, { useState } from 'react';
import { Copy, Check, Download, Code2, AlignLeft, Layers } from 'lucide-react';

interface JsonObjectViewerProps {
  data: any;
  title?: string;
}

export const JsonObjectViewer: React.FC<JsonObjectViewerProps> = ({
  data,
  title = 'Metadata Object Response',
}) => {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'pretty' | 'raw' | 'table'>('pretty');

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `video-metadata-${data?.id || 'record'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Syntax highlighting for JSON
  const renderHighlightedJson = (json: string) => {
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'text-amber-300'; // number
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'text-sky-300 font-semibold'; // key
          } else {
            cls = 'text-emerald-300'; // string value
          }
        } else if (/true|false/.test(match)) {
          cls = 'text-purple-300'; // boolean
        } else if (/null/.test(match)) {
          cls = 'text-rose-400'; // null
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  };

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
      {/* Header bar with controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-800/80 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <Code2 className="w-4 h-4 text-orange-400" />
          <span className="text-xs font-semibold text-white tracking-wide">{title}</span>
          <span className="text-[11px] font-mono text-slate-400">({jsonString.length} bytes)</span>
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Tabs */}
          <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => setViewMode('pretty')}
              className={`px-2.5 py-1 rounded font-medium transition-colors ${
                viewMode === 'pretty'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              JSON Syntax
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`px-2.5 py-1 rounded font-medium transition-colors ${
                viewMode === 'raw'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Raw Text
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`px-2.5 py-1 rounded font-medium transition-colors ${
                viewMode === 'table'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Key-Value
            </button>
          </div>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
            title="Copy JSON to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>Copy Object</span>
              </>
            )}
          </button>

          <button
            onClick={handleDownload}
            className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
            title="Download JSON File"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content View */}
      <div className="p-5 max-h-[500px] overflow-y-auto">
        {viewMode === 'pretty' && (
          <pre
            className="font-mono text-xs leading-relaxed text-slate-200 whitespace-pre font-normal"
            dangerouslySetInnerHTML={{
              __html: renderHighlightedJson(jsonString),
            }}
          />
        )}

        {viewMode === 'raw' && (
          <textarea
            readOnly
            value={jsonString}
            rows={18}
            className="w-full bg-transparent font-mono text-xs text-slate-300 focus:outline-none resize-none leading-relaxed selection:bg-orange-500/30"
          />
        )}

        {viewMode === 'table' && (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2 font-medium">Property</th>
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {Object.entries(data).map(([key, val]) => {
                    const isObj = typeof val === 'object' && val !== null;
                    return (
                      <tr key={key} className="hover:bg-slate-900/40">
                        <td className="py-2.5 font-semibold text-sky-400">{key}</td>
                        <td className="py-2.5 text-slate-500">{typeof val}</td>
                        <td className="py-2.5 text-slate-200 max-w-md truncate">
                          {isObj ? (
                            <span className="text-amber-400 font-sans">
                              {JSON.stringify(val)}
                            </span>
                          ) : (
                            String(val)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
