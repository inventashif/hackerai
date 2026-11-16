"use node";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import {
  getS3UrlLifetimeSeconds,
  S3_USER_FILES_PREFIX,
} from "../lib/constants/s3";

/**
 * Get environment variable with validation
 */
function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Get S3 client with credentials from environment variables
 */
export function getS3Client(): S3Client {
  const accessKeyId = getRequiredEnvVar("AWS_S3_ACCESS_KEY_ID");
  const secretAccessKey = getRequiredEnvVar("AWS_S3_SECRET_ACCESS_KEY");
  const region = getRequiredEnvVar("AWS_S3_REGION");
  // Optional S3-compatible endpoint (Cloudflare R2, Backblaze B2, MinIO).
  // Path-style addressing is required by R2/B2/MinIO.
  const endpoint = process.env.AWS_S3_ENDPOINT?.trim();

  return new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * Whether S3 is fully configured. When AWS env vars are missing (e.g. local
 * personal mode), file storage falls back to the local filesystem.
 */
export function isS3Configured(): boolean {
  return Boolean(
    process.env.AWS_S3_ACCESS_KEY_ID &&
    process.env.AWS_S3_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_REGION &&
    process.env.AWS_S3_BUCKET_NAME,
  );
}

/**
 * Azure Blob Storage support.
 *
 * Azure has no S3 API, so it gets a first-class adapter instead of the
 * presigned-S3 path. Selected when AZURE_STORAGE_CONNECTION_STRING and
 * AZURE_STORAGE_CONTAINER are both present; otherwise S3, then local disk.
 */
export function isAzureStorageConfigured(): boolean {
  return Boolean(
    process.env.AZURE_STORAGE_CONNECTION_STRING?.trim() &&
    process.env.AZURE_STORAGE_CONTAINER?.trim(),
  );
}

function getAzureConnectionString(): string {
  return getRequiredEnvVar("AZURE_STORAGE_CONNECTION_STRING");
}

function getAzureContainerName(): string {
  return getRequiredEnvVar("AZURE_STORAGE_CONTAINER");
}

function parseAzureAccount(connectionString: string): {
  accountName: string;
  accountKey: string;
} {
  const parts = new Map<string, string>();
  for (const segment of connectionString.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    parts.set(
      segment.slice(0, separator).trim().toLowerCase(),
      segment.slice(separator + 1).trim(),
    );
  }

  const accountName = parts.get("accountname");
  const accountKey = parts.get("accountkey");
  if (!accountName || !accountKey) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING must contain AccountName and AccountKey",
    );
  }
  return { accountName, accountKey };
}

function getAzureServiceClient(): BlobServiceClient {
  return BlobServiceClient.fromConnectionString(getAzureConnectionString());
}

function getAzureBlobClient(s3Key: string) {
  return getAzureServiceClient()
    .getContainerClient(getAzureContainerName())
    .getBlockBlobClient(s3Key);
}

/**
 * Mint a short-lived SAS URL for a blob. `permissions: "cw"` for uploads
 * (create + write), `"r"` for downloads.
 */
function createAzureSasUrl(s3Key: string, permissions: string): string {
  const { accountName, accountKey } = parseAzureAccount(
    getAzureConnectionString(),
  );
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date(Date.now() + getS3UrlLifetimeSeconds() * 1000);
  const blobUrl = getAzureBlobClient(s3Key).url;
  // Match the SAS protocol to the endpoint so Azurite (http) also works.
  const protocol = blobUrl.startsWith("https:")
    ? SASProtocol.Https
    : SASProtocol.HttpsAndHttp;

  const sas = generateBlobSASQueryParameters(
    {
      containerName: getAzureContainerName(),
      blobName: s3Key,
      permissions: BlobSASPermissions.parse(permissions),
      expiresOn,
      protocol,
    },
    credential,
  ).toString();

  return `${blobUrl}?${sas}`;
}

/**
 * Base URL used by local-storage upload/download endpoints. Overridable via
 * LOCAL_STORAGE_BASE_URL.
 */
function getLocalStorageBaseUrl(): string {
  return process.env.LOCAL_STORAGE_BASE_URL || "http://127.0.0.1:3000";
}

/**
 * Local storage root directory. Uses LOCAL_STORAGE_DIR when set, otherwise
 * resolves ".local-storage" relative to the repository root (walking up from
 * the current working directory, since Convex's Node runtime may chdir).
 */
function getLocalStorageDir(): string {
  if (process.env.LOCAL_STORAGE_DIR) {
    return process.env.LOCAL_STORAGE_DIR;
  }
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(current, "convex"))) {
      return path.join(current, ".local-storage");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(process.cwd(), ".local-storage");
}

/**
 * Matches keys generated by generateS3Key: users/{userId}/{timestamp}-{uuid}.{ext}
 * Strict validation prevents path traversal on the local filesystem.
 */
const LOCAL_STORAGE_KEY_PATTERN =
  /^users\/[A-Za-z0-9_.-]{1,128}\/\d{1,20}-[0-9a-fA-F-]{1,64}(\.[A-Za-z0-9]{1,20})?$/;

export function isLocalStorageKey(s3Key: string): boolean {
  return LOCAL_STORAGE_KEY_PATTERN.test(s3Key);
}

/**
 * Resolve an s3Key to a safe absolute path under the local storage dir.
 */
export function localStorageFilePath(s3Key: string): string {
  if (!isLocalStorageKey(s3Key)) {
    throw new Error(`Invalid storage key: ${s3Key}`);
  }
  return path.join(/* turbopackIgnore: true */ getLocalStorageDir(), s3Key);
}

/**
 * Generate unique S3 key with user prefix
 * Format: users/{userId}/{timestamp}-{uuid}.{ext}
 * Only uses file extension from fileName, UUID ensures uniqueness
 */
export function generateS3Key(userId: string, fileName: string): string {
  const timestamp = Date.now();
  const uuid = uuidv4();

  // Extract file extension, default to empty string if none
  const lastDotIndex = fileName.lastIndexOf(".");
  const extension = lastDotIndex !== -1 ? fileName.substring(lastDotIndex) : "";

  return `${S3_USER_FILES_PREFIX}/${userId}/${timestamp}-${uuid}${extension}`;
}

/**
 * Generate upload URL for a file. Uses S3 presigned URLs when S3 is
 * configured, otherwise returns a local-storage endpoint URL.
 */
export async function generateS3UploadUrl(
  fileName: string,
  contentType: string,
  userId: string,
  contentLength?: number,
): Promise<{ uploadUrl: string; s3Key: string }> {
  const s3Key = generateS3Key(userId, fileName);

  // Azure Blob Storage takes precedence when configured; it has no S3 API.
  // The client PUT must also send `x-ms-blob-type: BlockBlob`.
  if (isAzureStorageConfigured()) {
    try {
      return { uploadUrl: createAzureSasUrl(s3Key, "cw"), s3Key };
    } catch (error) {
      console.error("Failed to generate Azure upload URL:", error);
      throw new Error(
        "Failed to generate upload URL: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  }

  if (!isS3Configured()) {
    const uploadUrl = `${getLocalStorageBaseUrl()}/api/local-storage/upload?key=${encodeURIComponent(s3Key)}`;
    return { uploadUrl, s3Key };
  }

  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ContentType: contentType,
      ContentLength: contentLength,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: getS3UrlLifetimeSeconds(),
    });

    return { uploadUrl, s3Key };
  } catch (error) {
    console.error("Failed to generate S3 upload URL:", error);
    throw new Error(
      "Failed to generate upload URL: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}

/**
 * Generate download URL for a file. Uses S3 presigned URLs when S3 is
 * configured, otherwise returns a local-storage endpoint URL.
 */
export async function generateS3DownloadUrl(s3Key: string): Promise<string> {
  if (isAzureStorageConfigured()) {
    try {
      return createAzureSasUrl(s3Key, "r");
    } catch (error) {
      console.error("Failed to generate Azure download URL:", error);
      throw new Error(
        "Failed to generate download URL: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  }

  if (!isS3Configured()) {
    return `${getLocalStorageBaseUrl()}/api/local-storage/file?key=${encodeURIComponent(s3Key)}`;
  }

  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: getS3UrlLifetimeSeconds(),
    });

    return downloadUrl;
  } catch (error) {
    console.error("Failed to generate S3 download URL:", error);
    throw new Error(
      "Failed to generate download URL: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}

/**
 * Delete object from storage (S3 or local fallback).
 */
export async function deleteS3Object(s3Key: string): Promise<void> {
  if (isAzureStorageConfigured()) {
    try {
      await getAzureBlobClient(s3Key).deleteIfExists();
      return;
    } catch (error) {
      console.error("Failed to delete Azure blob:", error);
      throw new Error(
        "Failed to delete S3 object: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  }

  if (!isS3Configured()) {
    if (!isLocalStorageKey(s3Key)) {
      return;
    }
    await fs.rm(localStorageFilePath(s3Key), { force: true });
    return;
  }

  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    await s3Client.send(command);
  } catch (error) {
    console.error("Failed to delete S3 object:", error);
    throw new Error(
      "Failed to delete S3 object: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}

/**
 * Get object size in bytes (S3 or local fallback).
 */
export async function getS3ObjectSizeBytes(s3Key: string): Promise<number> {
  if (isAzureStorageConfigured()) {
    try {
      const properties = await getAzureBlobClient(s3Key).getProperties();
      if (typeof properties.contentLength !== "number") {
        throw new Error("Azure blob contentLength is missing");
      }
      return properties.contentLength;
    } catch (error) {
      console.error("Failed to fetch Azure blob metadata:", error);
      throw new Error(
        "Failed to fetch S3 object metadata: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  }

  if (!isS3Configured()) {
    const stat = await fs.stat(
      /* turbopackIgnore: true */ localStorageFilePath(s3Key),
    );
    return stat.size;
  }

  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const result = await s3Client.send(command);
    if (typeof result.ContentLength !== "number") {
      throw new Error("S3 object ContentLength is missing");
    }
    return result.ContentLength;
  } catch (error) {
    console.error("Failed to fetch S3 object metadata:", error);
    throw new Error(
      "Failed to fetch S3 object metadata: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}
