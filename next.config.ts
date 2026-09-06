import type { NextConfig } from "next";
import path from "node:path";

const postHogSourceMapApiKey = process.env.POSTHOG_CLI_API_KEY?.trim();
const postHogSourceMapProjectId = process.env.POSTHOG_CLI_PROJECT_ID?.trim();
const hasPostHogSourceMapApiKey = Boolean(postHogSourceMapApiKey);
const hasPostHogSourceMapProjectId = Boolean(postHogSourceMapProjectId);
const hasPostHogSourceMapConfig =
  hasPostHogSourceMapApiKey && hasPostHogSourceMapProjectId;
const isVercelPreview = process.env.VERCEL_ENV === "preview";
const isVercelProduction = process.env.VERCEL_ENV === "production";
const posthogSourceMapsEnabled =
  isVercelProduction && hasPostHogSourceMapConfig;

if (
  (hasPostHogSourceMapApiKey || hasPostHogSourceMapProjectId) &&
  !hasPostHogSourceMapConfig
) {
  console.warn(
    "[PostHog] Source maps are disabled. Set both POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID to enable upload.",
  );
}

const isPersonalMode =
  process.env.PERSONAL_MODE === "true" ||
  process.env.NEXT_PUBLIC_PERSONAL_MODE === "true";

const personalAuthkitAliases = {
  "@workos-inc/authkit-nextjs": "./lib/auth/personal-authkit.ts",
  "@workos-inc/authkit-nextjs/components":
    "./lib/auth/personal-authkit-components.tsx",
};

const personalAuthkitWebpackAliases = {
  "@workos-inc/authkit-nextjs": path.resolve(
    "./lib/auth/personal-authkit.ts",
  ),
  "@workos-inc/authkit-nextjs/components": path.resolve(
    "./lib/auth/personal-authkit-components.tsx",
  ),
};

const nextConfig: NextConfig = {
  // Emit a minimal self-contained server at `.next/standalone` for container
  // hosts (Render, Fly, self-hosted Docker). `docker/Dockerfile.web:28` copies
  // that directory; without this the image build fails. Vercel ignores this
  // setting, so leaving it on is safe for any target.
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "10.126.148.254", "*.trycloudflare.com"],
  devIndicators: false,
  productionBrowserSourceMaps: posthogSourceMapsEnabled,
  typescript: {
    // Pull request CI runs pnpm typecheck while the preview builds in parallel.
    ignoreBuildErrors: isVercelPreview,
  },
  async headers() {
    const iconCacheHeaders = [
      {
        key: "Cache-Control",
        value: "public, max-age=86400, stale-while-revalidate=604800",
      },
    ];

    return [
      {
        source: "/manifest.json",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
      { source: "/favicon.ico", headers: iconCacheHeaders },
      { source: "/apple-touch-icon.png", headers: iconCacheHeaders },
      { source: "/icon-192x192.png", headers: iconCacheHeaders },
      { source: "/icon-256x256.png", headers: iconCacheHeaders },
      { source: "/icon-512x512.png", headers: iconCacheHeaders },
    ];
  },
  // Stable since Next 15 (was experimental.serverComponentsExternalPackages).
  // Keeping it nested under `experimental` is a type error in Next 16.
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
  // Next 16 uses Turbopack for production builds by default. An explicit
  // config is required when a `webpack` callback also exists; without it,
  // hosted builds fail before compilation with "webpack config and no
  // turbopack config". Hosted mode needs no aliases, while personal mode
  // swaps WorkOS for the local auth shim.
  turbopack: isPersonalMode
    ? { resolveAlias: personalAuthkitAliases }
    : {},
  webpack: (config) => {
    if (isPersonalMode) {
      config.resolve.alias = {
        ...config.resolve.alias,
        ...personalAuthkitWebpackAliases,
      };
    }
    return config;
  },
  ...(process.env.NODE_ENV === "development" && {
    logging: {
      serverFunctions: false,
    },
  }),
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
      },
      // Convex storage domains (more specific patterns for better performance)
      {
        protocol: "https",
        hostname: "*.convex.cloud",
      },
      {
        protocol: "https",
        hostname: "*.convex.dev",
      },
      // Fallback for other external images
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
