/**
 * Storage URL helpers shared by the client upload path.
 */

/**
 * Detect an Azure Blob SAS URL. Azure signs with a `sig` query parameter;
 * S3-compatible presigned URLs use `X-Amz-Signature` instead, so this lets the
 * uploader add Azure-only headers without affecting S3/R2/B2/MinIO.
 */
export function isAzureSasUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.has("sig");
  } catch {
    return false;
  }
}
