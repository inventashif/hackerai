"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ChatStatus, MessageMetadata, Todo } from "@/types";
import {
  useDataStreamState,
  useDataStreamDispatch,
  type ScopedDataUIPart,
} from "@/app/components/DataStreamProvider";
import { useLatestRef } from "./useLatestRef";

/**
 * Auto-continue chain cap. Personal single-user deployment: the agent must
 * keep chaining turns until the work is done, never stop at an arbitrary
 * count and wait for a manual Continue press. 10000 chained turns is
 * effectively unlimited (each turn runs up to ~4 min under the platform
 * cap). The real safety backstops stay server-side: doom-loop detection,
 * the per-run spend cap, and token/context exhaustion.
 */
export const MAX_AUTO_CONTINUES = 10000;
export const AUTO_CONTINUE_PROMPT =
  "Continue from the latest saved progress. Do not restart the original task or repeat completed work.";
/**
 * Consecutive chains fired after a stream error WITHOUT the server's
 * auto-continue signal. A broken stream never delivers the signal (it is
 * emitted in onFinish), so without this the run strands on a manual
 * Continue button every time a mobile connection drops mid-turn. Capped
 * low: a persistent server failure must surface instead of looping.
 * Reset by any clean turn end or signal-based chain.
 */
export const MAX_SIGNALLESS_ERROR_CONTINUES = 3;
/** A run alive this long was progressing, even if no parts were seen. */
const ERROR_RESUME_MIN_RUN_MS = 30_000;
const AUTO_CONTINUE_SETTLE_DELAY_MS = 250;

export interface UseAutoContinueParams {
  chatId: string;
  status: ChatStatus;
  chatMode: string;
  sendMessage: (
    message: { text: string; metadata?: MessageMetadata },
    options?: { body?: Record<string, unknown> },
  ) => void;
  hasManuallyStoppedRef: React.RefObject<boolean>;
  todos: Todo[];
  sandboxPreference: string;
  agentPermissionMode: string;
  selectedModel: string;
}

export function useAutoContinue({
  chatId,
  status,
  chatMode,
  sendMessage,
  hasManuallyStoppedRef,
  todos,
  sandboxPreference,
  agentPermissionMode,
  selectedModel,
}: UseAutoContinueParams) {
  const { dataStream } = useDataStreamState();
  const { setIsAutoResuming, setIsAutoContinuing, setAutoContinueCount } =
    useDataStreamDispatch();
  const autoContinueCountRef = useRef(0);
  const pendingAutoContinueRef = useRef(false);
  const autoContinueRunScheduledRef = useRef(false);
  const autoContinueRunStartedRef = useRef(false);
  const autoContinueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastProcessedIndexRef = useRef(0);
  // Signal-less error resume: did the current run show activity / live
  // long enough to prove it was progressing before the stream broke?
  const sawActivityRef = useRef(false);
  const runStartedAtRef = useRef(0);
  const errorChainCountRef = useRef(0);

  const statusRef = useLatestRef(status);
  const todosRef = useLatestRef(todos);
  const sendMessageRef = useLatestRef(sendMessage);
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);
  const agentPermissionModeRef = useLatestRef(agentPermissionMode);
  const selectedModelRef = useLatestRef(selectedModel);
  const isPartForCurrentChat = (part: ScopedDataUIPart) =>
    part.__chatId === undefined || part.__chatId === chatId;

  const clearScheduledAutoContinue = useCallback(() => {
    if (autoContinueTimerRef.current !== null) {
      clearTimeout(autoContinueTimerRef.current);
      autoContinueTimerRef.current = null;
    }
  }, []);

  const clearAutoContinueLifecycle = useCallback(() => {
    clearScheduledAutoContinue();
    pendingAutoContinueRef.current = false;
    autoContinueRunScheduledRef.current = false;
    autoContinueRunStartedRef.current = false;
    setIsAutoContinuing(false);
  }, [clearScheduledAutoContinue, setIsAutoContinuing]);

  useEffect(() => {
    pendingAutoContinueRef.current = false;
    lastProcessedIndexRef.current = 0;
    errorChainCountRef.current = 0;
    clearAutoContinueLifecycle();
  }, [chatId, clearAutoContinueLifecycle]);

  // Detect data-auto-continue signal and immediately mark pending
  useEffect(() => {
    if (!dataStream?.length) return;
    const currentChatDataStream = dataStream.filter(isPartForCurrentChat);
    const newParts = currentChatDataStream.slice(lastProcessedIndexRef.current);
    if (
      newParts.length > 0 &&
      (statusRef.current === "streaming" || statusRef.current === "submitted")
    ) {
      sawActivityRef.current = true;
    }
    if (newParts.some((part) => part.type === "data-auto-continue")) {
      pendingAutoContinueRef.current = true;
      setIsAutoResuming(true);
      setIsAutoContinuing(true);
    }
    lastProcessedIndexRef.current = currentChatDataStream.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataStream, setIsAutoContinuing, setIsAutoResuming]);

  const scheduleAutoContinue = useCallback(() => {
    pendingAutoContinueRef.current = false;
    autoContinueRunScheduledRef.current = true;
    autoContinueRunStartedRef.current = false;
    setIsAutoContinuing(true);
    autoContinueCountRef.current += 1;
    setAutoContinueCount(autoContinueCountRef.current);

    clearScheduledAutoContinue();
    autoContinueTimerRef.current = setTimeout(() => {
      autoContinueTimerRef.current = null;
      if (!autoContinueRunScheduledRef.current) return;
      sendMessageRef.current(
        {
          text: AUTO_CONTINUE_PROMPT,
          metadata: { isAutoContinue: true },
        },
        {
          body: {
            mode: chatMode,
            isAutoContinue: true,
            todos: todosRef.current,
            sandboxPreference: sandboxPreferenceRef.current,
            agentPermissionMode: agentPermissionModeRef.current,
            selectedModel: selectedModelRef.current,
          },
        },
      );
    }, 500);
  }, [
    chatMode,
    clearScheduledAutoContinue,
    setAutoContinueCount,
    setIsAutoContinuing,
    sendMessageRef,
    todosRef,
    sandboxPreferenceRef,
    agentPermissionModeRef,
    selectedModelRef,
  ]);

  // Fire auto-continue when status is ready and signal was detected.
  // Depends on both `status` and `dataStream` so it re-evaluates when
  // the signal arrives after the stream has already ended (status already "ready").
  useEffect(() => {
    if (status !== "ready" || !pendingAutoContinueRef.current) return;
    if (
      hasManuallyStoppedRef.current ||
      chatMode !== "agent" ||
      autoContinueCountRef.current >= MAX_AUTO_CONTINUES
    ) {
      pendingAutoContinueRef.current = false;
      clearAutoContinueLifecycle();
      setIsAutoResuming(false);
      return;
    }

    scheduleAutoContinue();
    // A signal-based chain proves the server is progressing: the
    // signal-less error streak is broken.
    errorChainCountRef.current = 0;

    return clearScheduledAutoContinue;
  }, [
    status,
    dataStream,
    chatMode,
    hasManuallyStoppedRef,
    clearAutoContinueLifecycle,
    setIsAutoResuming,
    scheduleAutoContinue,
    clearScheduledAutoContinue,
  ]);

  useEffect(() => {
    if (status === "error") {
      // The stream broke (mobile network churn, a frozen background tab)
      // AFTER the server already signaled auto-continue: the work is
      // unfinished, so chain anyway instead of dropping the pending signal
      // and stranding the run on a manual Continue button. The next turn
      // needs a fresh signal to chain again, so this cannot loop.
      if (
        pendingAutoContinueRef.current &&
        !hasManuallyStoppedRef.current &&
        chatMode === "agent" &&
        autoContinueCountRef.current < MAX_AUTO_CONTINUES
      ) {
        scheduleAutoContinue();
        return;
      }
      // The stream broke BEFORE the server could signal (the signal is
      // emitted in onFinish, which a mid-flight break never reaches). If
      // the run was visibly progressing — stream activity, or alive past
      // the minimum run time — the work is unfinished and the break was
      // the connection, not the task: resume it. Capped at a few
      // consecutive signal-less resumes so a persistent server failure
      // still surfaces instead of looping forever.
      const ranLongEnough =
        runStartedAtRef.current > 0 &&
        Date.now() - runStartedAtRef.current >= ERROR_RESUME_MIN_RUN_MS;
      if (
        !hasManuallyStoppedRef.current &&
        chatMode === "agent" &&
        autoContinueCountRef.current < MAX_AUTO_CONTINUES &&
        errorChainCountRef.current < MAX_SIGNALLESS_ERROR_CONTINUES &&
        (sawActivityRef.current || ranLongEnough)
      ) {
        errorChainCountRef.current += 1;
        scheduleAutoContinue();
        return;
      }
      clearAutoContinueLifecycle();
      setIsAutoResuming(false);
      return;
    }

    if (status === "submitted") {
      // A new run starts: activity and timing belong to this run only.
      sawActivityRef.current = false;
      runStartedAtRef.current = Date.now();
    }
    if (status === "submitted" || status === "streaming") {
      if (autoContinueRunScheduledRef.current) {
        autoContinueRunStartedRef.current = true;
      }
    }
    if (status === "streaming") {
      setIsAutoResuming(false);
    }
  }, [
    status,
    chatMode,
    hasManuallyStoppedRef,
    clearAutoContinueLifecycle,
    setIsAutoResuming,
    scheduleAutoContinue,
  ]);

  useEffect(() => {
    if (
      status !== "ready" ||
      pendingAutoContinueRef.current ||
      !autoContinueRunScheduledRef.current ||
      !autoContinueRunStartedRef.current
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      if (!pendingAutoContinueRef.current) {
        clearAutoContinueLifecycle();
        // Clean turn end with no pending signal: the run finished
        // normally, so the signal-less error streak is broken.
        errorChainCountRef.current = 0;
      }
    }, AUTO_CONTINUE_SETTLE_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [status, dataStream, clearAutoContinueLifecycle]);

  const resetAutoContinueCount = useCallback(() => {
    autoContinueCountRef.current = 0;
    pendingAutoContinueRef.current = false;
    lastProcessedIndexRef.current = 0;
    errorChainCountRef.current = 0;
    clearAutoContinueLifecycle();
    setIsAutoResuming(false);
    setAutoContinueCount(0);
  }, [clearAutoContinueLifecycle, setAutoContinueCount, setIsAutoResuming]);

  return { resetAutoContinueCount };
}
