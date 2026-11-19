# Agent continuation across time slices

A hosting request limit is not a task-completion signal. Agent mode hands off
saved progress to a new request after a recoverable time/context/output stop.
It does not remove platform timeouts or run a request indefinitely.

## Fixes

- `useAutoContinue` keeps an already-queued handoff alive through trailing
  stream metadata. Previously an effect cleanup cancelled the timer after the
  pending signal had been consumed, leaving no resumption scheduled.
- Duplicate signals before dispatch cannot queue duplicate requests.
- Dispatch rechecks the live mode, user-stop flag and request status, so a
  cancellation, mode change or new user submission wins over an old timer.
- Cleared/replaced stream buffers reset their processed cursor. Chat changes
  and unmount still cancel pending timers.
- Both the in-process backend and Trigger worker classify elapsed timeouts as
  resumable. Budget/spending caps, user cancellation and loop-detection stops
  take precedence, even when a timeout/context flag was also set.

## Boundaries

- Natural model completion without a resume signal does not create more work.
  An unfinished response that incorrectly reports completion cannot be reliably
  identified just by increasing timeouts or counting pending todos.
- The finite chain ceiling and bounded error retries remain. Persistent failures,
  usage limits, expired login and approval requirements must surface instead of
  causing a runaway retry loop or unauthorized spending.
- Browser-driven handoffs require an active client. Tab closure, browser sleep,
  deployment and process/host restarts cannot be made durable by a React timer.
  Unattended restart-safe execution requires a persisted background worker and
  job ownership/checkpoint lifecycle; this change does not provision one.
- In personal in-process mode, deploy the frontend and `/api/chat` on Vercel.
  Non-personal deployments using Trigger must also deploy the updated Trigger
  worker through their existing deployment process; Vercel alone does not
  update a running Trigger worker.

## Verification

Run:

```sh
pnpm exec jest app/hooks/__tests__/useAutoContinue.test.ts lib/chat/__tests__/stop-conditions.test.ts lib/api/__tests__/agent-long-contracts.test.ts --runInBand
pnpm exec tsc --noEmit
```

The regression suite uses fake timers and mock sends, including the existing
10,000-handoff ceiling test. It consumes no model/provider credits. It covers
trailing metadata, duplicate signals, delayed manual stop, mode changes, new
user submissions, unmount, cleared buffers, natural completion, and safety stops.

For a live validation, use a disposable authorized task and watch an automatic
handoff retain the selected model/environment and saved progress. Stop must
cancel further handoffs. Do not call a short UI smoke test proof of surviving
hours of execution, browser closure or a server restart.
