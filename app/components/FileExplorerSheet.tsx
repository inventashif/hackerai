"use client";

import * as React from "react";
import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { FileExplorer } from "./FileExplorer";
import type { FileTreeEntry } from "@/lib/file-explorer/types";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useProject } from "@/app/hooks/useProjects";
import type { Id } from "@/convex/_generated/dataModel";

export function FileExplorerSheet({
  triggerClassName,
}: {
  triggerClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { activeProjectId } = useGlobalState();

  // Get the active project to determine the initial path
  const activeProject = useProject(activeProjectId as Id<"projects"> | null);

  // Determine the initial path based on the active project
  const initialPath = React.useMemo(() => {
    // If the project has a folder_path, use it
    if (activeProject?.folder_path) {
      return activeProject.folder_path;
    }
    // Otherwise default to /tmp (more likely to exist than /home/user)
    return "/tmp";
  }, [activeProject?.folder_path]);

  const handleSelectFile = React.useCallback((entry: FileTreeEntry) => {
    // Keep sheet open; preview is inside FileExplorer
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={triggerClassName ?? "h-7 px-2 gap-1.5 text-xs"}
        title="Browse sandbox files"
        aria-label="Browse files"
      >
        <Folder className="h-3.5 w-3.5" />
        Files
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-[360px] max-w-[90vw] flex-col p-0 sm:w-[420px]">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-sm">Sandbox Files</SheetTitle>
            <SheetDescription className="sr-only">Browse files in the current sandbox</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            <FileExplorer initialPath={initialPath} onSelectFile={handleSelectFile} className="h-full border-0" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
