# Scenario -> research terms

These are query seeds, not evidence or tests to execute automatically.

| Observed scenario | Focused starting query | Prerequisites to compare |
| --- | --- | --- |
| Export/download by object ID | `idor export authorization` | Object owner, tenant, download token scope, async-job checks |
| Hidden privileged API operation | `broken function authorization api` | Server-side role checks, actual reachability, intended permissions |
| OAuth account connection | `oauth account linking csrf` | State/nonce, initiating session, IdP trust, link confirmation |
| Recovery/session anomaly | `password reset session invalidation` | Token purpose, reuse, logout/revocation, session rotation |
| Webhook/URL preview | `ssrf webhook redirect validation` | Server-side fetch, allowed destinations, redirect handling |
| User text rendered by browser | `stored xss html sanitization` | HTML context, sink, sanitizer/version, CSP, other-user reachability |
| postMessage consumer | `postmessage origin validation writeup` | Source window, exact origin, message shape, reachable privileged action |
| Merge/update endpoint | `mass assignment role authorization` | Writable schema, ignored/internal fields, authoritative side effect |
| Template/document preview | `ssti template preview` | Actual template evaluation, trust separation, engine/version |
| Download/archive extraction | `path traversal archive extraction` | Canonicalization, containment, symlinks, writable/readable canary |
| Duplicate workflow transition | `race condition idempotency workflow` | State machine, atomic invariant, replay scope, disposable objects |
| Next.js middleware gate | `nextjs middleware authorization writeup` | Exact deployment/version, middleware vs application checks |
| Spring Actuator path | `spring actuator exposure impact` | Which endpoint is reachable, sensitivity, policy—not banner alone |
| RAG document retrieval | `rag cross tenant document authorization` | Index ownership, retrieval filter, controlled tenant markers |
| Signed file upload/download | `signed url path scope upload validation` | Ticket method/path/expiry, actual byte count, storage ownership |

Refine broad terms with a known feature or version. Do not paste private endpoint
paths or tenant names. A tutorial with the same acronym but a different sink or
attacker model is often less useful than a different-stack write-up with the
same trust-boundary failure.
