"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileTreeEntry } from "@/lib/file-explorer/types";

const DEFAULT_ROOTS = ["/tmp", "/home/user", "/workspace", "/app/workspace"] as string[];

function initialPath(): string {
  if (typeof window === "undefined") return DEFAULT_ROOTS[0];
  // Try to use a directory that exists, fallback to first option
  return DEFAULT_ROOTS[0];
}

export function useFileExplorer(opts?: { initialPath?: string }) {
  const root = opts?.initialPath ?? initialPath();
  const [currentPath, setCurrentPath] = useState(root);
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [history, setHistory] = useState<string[]>([root]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const triedRootsRef = useRef<Set<string>>(new Set());

  const fetchEntries = useCallback(async (path: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsLoading(true);
    setError(null);
    triedRootsRef.current.add(path);

    try {
      const res = await fetch(`/api/sandbox/files?path=${encodeURIComponent(path)}`, {
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = json as { path: string; entries: FileTreeEntry[] };
      if (ctrl.signal.aborted) return;
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setCurrentPath(data.path ?? path);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const errorMessage = e instanceof Error ? e.message : String(e);
      setError(errorMessage);
      setEntries([]);

      // If directory doesn't exist, try to fallback to a default directory
      if (errorMessage.includes("no such file or directory") || errorMessage.includes("ENOENT")) {
        // Try the next available root that hasn't been tried yet
        for (const nextRoot of DEFAULT_ROOTS) {
          if (!triedRootsRef.current.has(nextRoot)) {
            void fetchEntries(nextRoot);
            return;
          }
        }
      }
    } finally {
      if (!ctrl.signal.aborted) setIsLoading(false);
    }
  }, []);

  const navigate = useCallback(
    (path: string, opts?: { replace?: boolean }) => {
      const nextHistory = opts?.replace
        ? [...history.slice(0, historyIndex + 1)]
        : [...history.slice(0, historyIndex + 1), path];
      const nextIndex = opts?.replace ? historyIndex : historyIndex + 1;
      if (!opts?.replace) {
        setHistory(nextHistory);
        setHistoryIndex(nextIndex);
      }
      setSelectedPath(null);
      void fetchEntries(path);
    },
    [history, historyIndex, fetchEntries],
  );

  const openEntry = useCallback(
    (entry: FileTreeEntry) => {
      if (entry.type === "directory") {
        navigate(entry.path);
        return { action: "navigate" as const, entry };
      }
      setSelectedPath(entry.path);
      return { action: "select" as const, entry };
    },
    [navigate],
  );

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return;
    const prev = history[historyIndex - 1];
    setHistoryIndex((i) => i - 1);
    setSelectedPath(null);
    void fetchEntries(prev);
  }, [history, historyIndex, fetchEntries]);

  const goForward = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const next = history[historyIndex + 1];
    setHistoryIndex((i) => i + 1);
    setSelectedPath(null);
    void fetchEntries(next);
  }, [history, historyIndex, fetchEntries]);

  const goParent = useCallback(() => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    if (parent === currentPath) return;
    navigate(parent);
  }, [currentPath, navigate]);

  const refresh = useCallback(() => {
    // Reset tried roots on manual refresh
    triedRootsRef.current.clear();
    void fetchEntries(currentPath);
  }, [currentPath, fetchEntries]);

  useEffect(() => {
    void fetchEntries(root);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    currentPath,
    entries,
    history,
    historyIndex,
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex < history.length - 1,
    selectedPath,
    setSelectedPath,
    isLoading,
    error,
    navigate,
    openEntry,
    goBack,
    goForward,
    goParent,
    refresh,
  };
}
