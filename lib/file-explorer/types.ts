export interface FileTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtime?: number;
}

export interface FileExplorerState {
  currentPath: string;
  entries: FileTreeEntry[];
  history: string[];
  historyIndex: number;
  selectedPath: string | null;
  isLoading: boolean;
  error: string | null;
}
