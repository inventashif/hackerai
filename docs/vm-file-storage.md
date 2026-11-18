# VM-only file storage

The app and Convex do not share a filesystem with the sandbox VM. Hosted file
operations must never fall back to Vercel/Convex disk. `/upload` on the VM is the
only upload destination; existing reports elsewhere on that VM remain browsable.

## Transport

- Directory listings, uploads, downloads, size checks and deletion use `scripts/vm-file-gateway.mjs`.
  It listens on loopback port 9002, behind the existing HTTPS reverse proxy.
- The application/Convex sign exact-path, operation-specific, expiring tickets.
  The browser receives a ticket, never a long-lived VM key. File bytes stream
  directly between the browser and VM, avoiding Vercel's body limits.
- The gateway caps uploads at 500 MiB (the UI's 500 MB limit), checks the expected
  byte count, writes a temporary file, and renames it before acknowledging success.
  Failed transfers remove temporary files. Convex verifies VM size before saving.
- Upload/delete paths stay under `/upload`; parent symlinks are rejected. Reads
  are restricted by the app's authenticated file-browser path policy. Preview
  responses are plain text and capped at 2 MiB; downloads stream without buffering.

## Deployment

1. Create `/upload`, owned by the VM agent's OS user.
2. Install `vm-file-gateway.mjs` and adapt `scripts/hackerai-files.service` to the
   host's username, Node path and install directory. Use a mode-600 `gateway.env`:
   `CENTRIFUGO_TOKEN_SECRET` must match Convex and Vercel; `VM_APP_ORIGIN` is the
   exact application HTTPS origin. Never commit that environment file.
3. Enable the service. Forward only `/vm-files` to `127.0.0.1:9002` in the existing
   HTTPS reverse proxy. Keep port 9002 private. Do not log ticket query strings.
4. Set `VM_STORAGE_URL` to the VM HTTPS origin, or use the existing
   `CENTRIFUGO_WS_URL` (its origin is converted from `wss` to `https`).
5. Vercel's `CONVEX_SERVICE_ROLE_KEY` must match Convex; the relay signing key must
   also match the VM. Redeploy after changing Vercel variables.
6. Deploy Convex and the app. No bucket or new compute resource is needed.

## Verification

```sh
node --test scripts/vm-file-gateway.test.mjs
VERIFY_ENV_FILE=/secure/path/production.env npx tsx scripts/verify-vm-files.mts
VERIFY_ENV_FILE=/secure/path/production.env npx tsx scripts/verify-vm-transfer.mts --large
```

The transfer verifier checks a full 500 MiB upload and streamed download against
SHA-256, rejects a larger ticket, and deletes only its generated test files.
The report verifier lists and reads the existing report directory; it never runs
PoC scripts or prints report contents. Keep local report copies and ad hoc
credential-bearing scripts out of commits and deployment bundles.

Manual browser checks: open **Files**, browse `/upload/gbbp18-recon/bug-reports`,
preview a Markdown report and download a PoC as a file (do not execute it).
Upload a harmless file and confirm it appears under `/upload`; attach a harmless
file in chat and confirm it finishes without an upload-error toast. Agent mode
permits 500 MiB; Ask mode retains its smaller processing limit.
