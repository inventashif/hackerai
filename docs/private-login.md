# Private owner login

Personal mode is private by default. There is no signup or visitor session.
The owner signs in at `/inventashif-login`; `/login` redirects there. A hidden
path is not an authentication mechanism.

## Security boundary

- A successful POST to `/api/auth/login` must match the server-side owner email
  and salted scrypt password hash (N=65536, r=8, p=2). There is no default password.
- Atomic Convex counters limit attempts to 10/client and 100/global per five
  minutes. Only HMAC client identifiers are stored, not raw IPs or credentials.
  Missing backend/configuration fails closed; counters are shared across instances.
- Eight-hour browser sessions use an HttpOnly, Secure, SameSite=Lax `__Host-`
  cookie in production. The session JWT has a separate audience and a random
  server-tracked identifier. Expiry/revocation is checked server-side.
- Logout is a same-origin POST and revokes the stored session. GET `/logout`
  only displays confirmation; cross-site navigation cannot silently log out.
- Convex receives a separate five-minute access token only after checking a
  valid browser session. An already-issued Convex bearer token can remain valid
  until its short expiry after logout; it cannot be used as a browser session.
- Proxy and handler checks reject missing/invalid cookies; custom auth headers
  cannot grant access. Pages, chat, share links, downloads and APIs are private.
  Extension-like URLs also go through the proxy. Only login, required static
  assets and public JWT verification keys are anonymously available.
- State-changing cookie-authenticated requests require the configured same
  origin. Login accepts JSON only and bounds input. Errors do not reveal whether
  the account exists. Responses are not shared-cacheable and frames are denied.
- Signup paths return 404, including the former `/signup/auth` endpoint.

## Initial setup / deployment

Run `node scripts/setup-private-login.mjs` on a trusted owner machine. It performs
no network requests. It saves generated owner credentials and fresh RSA keys to
`~/.config/hackerai/private-login/` with directory mode 700 and files mode 600.
It refuses to overwrite an existing setup. Never commit these files or print
passwords/keys in logs. Transfer the password to the owner's password manager.

Configure server-only Vercel values from `server.env`:

- `PERSONAL_LOGIN_EMAIL`, `PERSONAL_LOGIN_PASSWORD_HASH`
- `PERSONAL_JWT_PRIVATE_KEY`, `PERSONAL_JWT_PUBLIC_KEY`, `PERSONAL_JWT_KEY_ID`

Keep `PERSONAL_JWT_ISSUER=https://inventashif.tech` and
`PERSONAL_JWT_AUDIENCE=hackerai-personal` aligned with Convex. The configured
issuer's origin is the accepted login/CSRF origin. Alternative site aliases
should use the canonical site to sign in.

Deploy the `personalLogin` tables/functions first. Deploy Vercel with the new
values; then refresh Convex's JWKS configuration to the new public key source
and redeploy Convex. Rotating the old RSA key invalidates legacy public-issued
tokens; merely changing the cookie name or hiding the login page does not.
All old visitor sessions must be rejected after the rollout.

The Convex service key is server-only and must match on both services. Exports
from Vercel mask sensitive values; placeholders are not usable credentials.
No registration, password reset by email, or MFA enrollment is offered. This is
a single-owner password login, not a claim of MFA protection.

## Checks

Run `pnpm exec jest lib/auth/__tests__/private-login.test.ts --runInBand` and
`pnpm exec tsc --noEmit`. Verify with a fresh browser (not an existing logged-in
profile): anonymous home/chat requests redirect, APIs return 401, signup returns
404, wrong passwords fail, valid login permits chat, tampered/expired sessions
fail, and replaying the cookie after logout is rejected. Test throttling with
disposable local requests rather than deliberately locking the owner's live IP.

Scope: login/session and the site-wide authentication gate only. This is not a
general audit of the rest of the application or the VM.
