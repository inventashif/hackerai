import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterAll,
} from "@jest/globals";

// The S3 SDK is auto-mocked in the shared setup. Azure's SDK is replaced with
// a minimal double because its browser build is ESM-only under jsdom; the real
// adapter (SAS signing, PUT, download, delete, head) is verified end-to-end
// against Azurite by .verify-azure.ts.
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/s3-request-presigner");
jest.mock("@azure/storage-blob");

const ACCOUNT = "hackeraitest";
const ACCOUNT_KEY = Buffer.alloc(64, 7).toString("base64");
const CONNECTION_STRING =
  `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};` +
  `AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`;

const setAzureEnv = () => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = CONNECTION_STRING;
  process.env.AZURE_STORAGE_CONTAINER = "uploads";
};

const clearAzureEnv = () => {
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  delete process.env.AZURE_STORAGE_CONTAINER;
};

describe("s3Utils Azure Blob adapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAzureEnv();
    process.env.AWS_S3_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_S3_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_S3_REGION = "us-east-1";
    process.env.AWS_S3_BUCKET_NAME = "test-bucket";
  });

  afterAll(clearAzureEnv);

  it("reports Azure as configured only with both variables", async () => {
    const { isAzureStorageConfigured } = await import("../s3Utils");

    expect(isAzureStorageConfigured()).toBe(false);
    process.env.AZURE_STORAGE_CONNECTION_STRING = CONNECTION_STRING;
    expect(isAzureStorageConfigured()).toBe(false);
    process.env.AZURE_STORAGE_CONTAINER = "uploads";
    expect(isAzureStorageConfigured()).toBe(true);
  });

  it("prefers Azure over S3 for uploads and signs create/write", async () => {
    setAzureEnv();
    const { generateS3UploadUrl } = await import("../s3Utils");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

    const { uploadUrl, s3Key } = await generateS3UploadUrl(
      "probe.txt",
      "text/plain",
      "user123",
      1024,
    );

    const url = new URL(uploadUrl);
    expect(url.host).toBe(`${ACCOUNT}.blob.core.windows.net`);
    expect(url.pathname).toBe(`/uploads/${s3Key}`);
    expect(url.searchParams.get("sp")).toBe("cw");
    expect(url.searchParams.get("spr")).toBe("https");
    expect(url.searchParams.get("sig")).toBeTruthy();
    // S3 presigning must not run when Azure is selected.
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("mints read-only SAS URLs for downloads", async () => {
    setAzureEnv();
    const { generateS3DownloadUrl } = await import("../s3Utils");

    const url = new URL(
      await generateS3DownloadUrl("users/user123/123-probe.txt"),
    );

    expect(url.pathname).toBe("/uploads/users/user123/123-probe.txt");
    expect(url.searchParams.get("sp")).toBe("r");
    expect(url.searchParams.get("sig")).toBeTruthy();
  });

  it("throws a clear error when the connection string lacks a shared key", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      "DefaultEndpointsProtocol=https;AccountName=hackeraitest;EndpointSuffix=core.windows.net";
    process.env.AZURE_STORAGE_CONTAINER = "uploads";
    const { generateS3UploadUrl } = await import("../s3Utils");

    await expect(
      generateS3UploadUrl("probe.txt", "text/plain", "user123", 1024),
    ).rejects.toThrow(/AccountName and AccountKey/);
  });

  it("keeps the local fallback when no storage provider is configured", async () => {
    delete process.env.AWS_S3_ACCESS_KEY_ID;
    delete process.env.AWS_S3_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_REGION;
    delete process.env.AWS_S3_BUCKET_NAME;
    const { generateS3UploadUrl } = await import("../s3Utils");

    const { uploadUrl } = await generateS3UploadUrl(
      "probe.txt",
      "text/plain",
      "user123",
      1024,
    );

    expect(uploadUrl).toContain("/api/local-storage/upload");
  });
});
