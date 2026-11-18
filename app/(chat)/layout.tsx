"use client";

import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ChatLayout } from "@/app/components/ChatLayout";
import Loading from "@/components/ui/loading";
import { useHasAuthenticatedBefore } from "@/app/hooks/useHasAuthenticatedBefore";
import { ChatRoutePresentationProvider } from "@/app/contexts/ChatRoutePresentationContext";

const fullWidthShell = (
  <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
    <div className="flex-1 flex items-center justify-center min-h-0">
      <Loading />
    </div>
  </div>
);

/**
 * Shared layout for / and /c/[id]. Requires authentication.
 * Unauthenticated users are redirected to the secure login page.
 */
export default function ChatRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const hasAuthHint = useHasAuthenticatedBefore();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/inventashif-login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !isAuthenticated) {
    return fullWidthShell;
  }

  return (
    <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
      <ChatRoutePresentationProvider>
        <ChatLayout>{children}</ChatLayout>
      </ChatRoutePresentationProvider>
    </div>
  );
}
