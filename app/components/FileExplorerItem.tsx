"use client";

import * as React from "react";
import { FileText, Folder, FolderOpen, FileImage, FileJson, FileCode, Link2, FileWarning } from "lucide-react";
import type { FileTreeEntry } from "@/lib/file-explorer/types";
import { cn } from "@/lib/utils";

function iconForEntry(entry: FileTreeEntry): React.ReactNode {
  if (entry.type === "directory") return <Folder className="h-4 w-4 shrink-0 text-sky-500" />;
  if (entry.type === "symlink") return <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return <FileImage className="h-4 w-4 shrink-0 text-fuchsia-500" />;
  }
  if (["json", "yaml", "yml", "toml", "xml", "csv"].includes(ext)) {
    return <FileJson className="h-4 w-4 shrink-0 text-amber-500" />;
  }
  if (["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "rb", "php", "sh"].includes(ext)) {
    return <FileCode className="h-4 w-4 shrink-0 text-emerald-500" />;
  }
  if (["pdf"].includes(ext)) return <FileWarning className="h-4 w-4 shrink-0 text-red-500" />;
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileExplorerItem({
  entry,
  selected,
  onOpen,
  onPreview,
  onDownload,
  onOpenInNewTab,
}: {
  entry: FileTreeEntry;
  selected?: boolean;
  onOpen: (e: FileTreeEntry) => void;
  onPreview?: (e: FileTreeEntry) => void;
  onDownload?: (e: FileTreeEntry) => void;
  onOpenInNewTab?: (e: FileTreeEntry) => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const isDir = entry.type === "directory";
  const Icon = isDir ? <FolderOpen className="h-4 w-4 shrink-0 text-sky-500 hidden group-data-[selected=true]:block" /> : null;

  return (
    <div
      ref={ref}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60 cursor-pointer select-none",
        selected && "bg-primary/10 ring-1 ring-primary/20",
      )}
      onClick={() => onOpen(entry)}
      onContextMenu={(ev) => {
        if (entry.type === "file") {
          ev.preventDefault();
          setMenuOpen((v) => !v);
        }
      }}
      title={entry.path}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen(entry);
        }
      }}
    >
      {iconForEntry(entry)}
      <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
      {entry.type === "file" && entry.size > 0 && (
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0">{formatSize(entry.size)}</span>
      )}

      {menuOpen && entry.type === "file" && (
        <div className="absolute right-2 z-20 mt-8 min-w-[180px] rounded-md border bg-popover p-1 shadow-md">
          <button
            className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={(ev) => {
              ev.stopPropagation();
              setMenuOpen(false);
              onPreview?.(entry);
            }}
          >
            View
          </button>
          <button
            className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={(ev) => {
              ev.stopPropagation();
              setMenuOpen(false);
              onOpenInNewTab?.(entry);
            }}
          >
            Open in new tab {entry.name.toLowerCase().endsWith(".pdf") ? "(PDF)" : ""}
          </button>
          <button
            className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={(ev) => {
              ev.stopPropagation();
              setMenuOpen(false);
              onDownload?.(entry);
            }}
          >
            Download
          </button>
        </div>
      )}
    </div>
  );
}
