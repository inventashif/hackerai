#!/usr/bin/env node
/**
 * Prepare an Azure Blob Storage account for direct browser uploads.
 *
 * Creates the container when missing and installs the CORS rule the app needs
 * (browser PUT with Content-Type + x-ms-blob-type, plus GET/HEAD for previews).
 * Azure rejects cross-origin browser requests when no CORS rule matches, which
 * surfaces as an opaque "Upload failed" in the UI.
 *
 * Required env:
 *   AZURE_STORAGE_CONNECTION_STRING
 *   AZURE_STORAGE_CONTAINER
 * Optional env:
 *   AZURE_CORS_ORIGINS  comma-separated, defaults to production + localhost
 *
 * Never prints the connection string or account key.
 */
import { BlobServiceClient } from "@azure/storage-blob";

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
const containerName = process.env.AZURE_STORAGE_CONTAINER?.trim();
const origins = (
  process.env.AZURE_CORS_ORIGINS ??
  "https://inventashif.tech,https://www.inventashif.tech,http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!connectionString || !containerName) {
  console.error(
    "Missing AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_CONTAINER.",
  );
  process.exit(1);
}

const service = BlobServiceClient.fromConnectionString(connectionString);
console.log(`account=${service.accountName} container=${containerName}`);

const container = service.getContainerClient(containerName);
const created = await container.createIfNotExists();
console.log(`container_created=${created.succeeded}`);

const properties = await service.getProperties();
const existingRules = properties.cors ?? [];
// Replace any rule covering our origins so reruns stay idempotent.
const otherRules = existingRules.filter(
  (rule) =>
    !(rule.allowedOrigins ?? [])
      .split(",")
      .some((origin) => origins.includes(origin.trim())),
);

await service.setProperties({
  cors: [
    ...otherRules,
    {
      allowedOrigins: origins.join(","),
      allowedMethods: "GET,HEAD,PUT,DELETE,OPTIONS",
      allowedHeaders: "*",
      exposedHeaders: "*",
      maxAgeInSeconds: 3600,
    },
  ],
});

const updated = await service.getProperties();
console.log(`cors_rules=${updated.cors?.length ?? 0}`);
console.log(`cors_origins=${origins.join(",")}`);
