"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, ArrowUp, Home, RefreshCw, Search, Folder, AlertCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFileExplorer } from "@/app/hooks/useFileExplorer";
import { FileExplorerItem } from "./FileExplorerItem";
import type { FileTreeEntry } from "@/lib/file-explorer/types";
import { toast } from "sonner";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function FileExplorer({
  initialPath,
  onSelectFile,
  className,
}: {
  initialPath?: string;
  onSelectFile?: (entry: FileTreeEntry) => void;
  className?: string;
}) {
  const explorer = useFileExplorer({ initialPath });
  const [query, setQuery] = React.useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  const [preview, setPreview] = React.useState<{ path: string; text: string; loading: boolean; error?: string } | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    if (!debouncedQuery.trim()) return explorer.entries;
    const q = debouncedQuery.toLowerCase();
    return explorer.entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [explorer.entries, debouncedQuery]);

  const handlePreview = React.useCallback(async (entry: FileTreeEntry) => {
    if (entry.type === "directory") return;
    setPreview({ path: entry.path, text: "", loading: true });
    try {
      const res = await fetch(`/api/sandbox/file?path=${encodeURIComponent(entry.path)}&preview=1`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const text = await res.text();
      setPreview({ path: entry.path, text, loading: false });
    } catch (e) {
      setPreview({ path: entry.path, text: "", loading: false, error: e instanceof Error ? e.message : String(e) });
    }
    onSelectFile?.(entry);
  }, [onSelectFile]);

  const handleDownload = React.useCallback((entry: FileTreeEntry) => {
    const url = `/api/sandbox/file?path=${encodeURIComponent(entry.path)}&download=1`;
    window.open(url, "_blank", "noopener");
  }, []);

  const handleOpenInNewTab = React.useCallback((entry: FileTreeEntry) => {
    // PDFs open inline (new tab), other files download or preview inline
    const isPdf = entry.name.toLowerCase().endsWith(".pdf");
    const url = isPdf
      ? `/api/sandbox/file?path=${encodeURIComponent(entry.path)}`
      : `/api/sandbox/file?path=${encodeURIComponent(entry.path)}&download=1`;
    window.open(url, "_blank", "noopener");
  }, []);

  const handleOpen = React.useCallback(
    (entry: FileTreeEntry) => {
      if (entry.type === "directory") {
        explorer.openEntry(entry);
        return;
      }
      const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "pdf") {
        handleOpenInNewTab(entry);
        return;
      }
      void handlePreview(entry);
    },
    [explorer, handlePreview, handleOpenInNewTab],
  );

  const handleUploadClick = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    setIsUploading(true);

    try {
      // Upload to current directory in sandbox
      const targetPath = `${explorer.currentPath}/${file.name}`;
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/sandbox/upload?path=${encodeURIComponent(targetPath)}`, {
        method: "POST",
        body: file,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(errorData.error || "Upload failed");
      }

      toast.success("File uploaded successfully", {
        description: `${file.name} uploaded to ${explorer.currentPath}`,
      });

      // Refresh the file explorer to show the new file
      explorer.refresh();
    } catch (error) {
      toast.error("Upload failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [explorer]);

  return (
    <div className={className ?? "flex h-full flex-col border-r bg-background"}>
      {/* Header */}
      <div className="flex items-center gap-1 border-b p-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={explorer.goBack} disabled={!explorer.canGoBack} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={explorer.goForward} disabled={!explorer.canGoForward} title="Forward">
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={explorer.goParent} title="Up">
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => explorer.navigate("/tmp")} title="Home">
          <Home className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={explorer.refresh} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${explorer.isLoading ? "animate-spin" : ""}`} />
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleUploadClick}
          disabled={isUploading}
          title="Upload file to current directory"
        >
          <Upload className={`h-4 w-4 ${isUploading ? "animate-pulse" : ""}`} />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
          disabled={isUploading}
        />
      </div>

      {/* Path breadcrumb / input */}
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground hover:text-foreground"
          title={explorer.currentPath}
          onClick={() => {
            const next = window.prompt("Go to path:", explorer.currentPath);
            if (next?.trim()) explorer.navigate(next.trim());
          }}
        >
          {explorer.currentPath}
        </button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter files…" className="h-7 pl-7 text-sm" />
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-auto px-1 py-1">
        {explorer.isLoading && explorer.entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : explorer.error ? (
          <div className="flex items-start gap-2 px-3 py-4 text-sm text-amber-600">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-all">{explorer.error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">No files</div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((entry) => (
              <FileExplorerItem
                key={entry.path}
                entry={entry}
                selected={explorer.selectedPath === entry.path}
                onOpen={handleOpen}
                onPreview={handlePreview}
                onDownload={handleDownload}
                onOpenInNewTab={handleOpenInNewTab}
              />
            ))}
          </div>
        )}
      </div>

      {/* Inline preview drawer */}
      {preview && (
        <div className="border-t bg-muted/20">
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="truncate text-xs font-medium" title={preview.path}>
              {preview.path.split("/").pop()}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => handleOpenInNewTab({ name: preview.path.split("/").pop() ?? "", path: preview.path, type: "file", size: 0 })}>
                Open in new tab
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setPreview(null)}>
                ×
              </Button>
            </div>
          </div>
          <div className="max-h-[40vh] overflow-auto p-2">
            {preview.loading ? (
              <div className="py-6 text-center text-xs text-muted-foreground">Loading preview…</div>
            ) : preview.error ? (
              <div className="text-xs text-red-600 break-all">{preview.error}</div>
            ) : (
              <pre className="whitespace-pre-wrap break-words text-xs font-mono leading-relaxed">{preview.text}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
