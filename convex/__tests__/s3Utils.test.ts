import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { promises as fs } from "node:fs";
import path from "node:path";

// Mock the local storage directory for tests
const TEST_STORAGE_DIR = "/tmp/hackerai-test-storage";

describe("s3Utils (local storage only)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCAL_STORAGE_DIR = TEST_STORAGE_DIR;
    process.env.LOCAL_STORAGE_BASE_URL = "http://localhost:3000";
  });

  afterEach(async () => {
    // Clean up test storage directory
    try {
      await fs.rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("generateS3Key", () => {
    it("should generate S3 key with correct format", async () => {
      const { generateS3Key } = await import("../s3Utils");
      const userId = "user123";
      const fileName = "test.pdf";

      const s3Key = generateS3Key(userId, fileName);

      expect(s3Key).toMatch(/^users\/user123\/\d+-testuuid\d+\.pdf$/);
    });

    it("should generate unique keys for same user and filename", async () => {
      const { generateS3Key } = await import("../s3Utils");
      const userId = "user123";
      const fileName = "test.pdf";

      const key1 = generateS3Key(userId, fileName);
      const key2 = generateS3Key(userId, fileName);

      expect(key1).not.toBe(key2);
    });

    it("should sanitize userId", async () => {
      const { generateS3Key } = await import("../s3Utils");
      const userId = "user@domain.com";
      const fileName = "test.pdf";

      const s3Key = generateS3Key(userId, fileName);

      expect(s3Key).toMatch(/^users\/user_domain\.com\//);
    });
  });

  describe("isLocalStorageKey", () => {
    it("should validate correct keys", async () => {
      const { isLocalStorageKey } = await import("../s3Utils");
      expect(isLocalStorageKey("users/user123/1234567890-abcdef123456.pdf")).toBe(true);
      expect(isLocalStorageKey("users/user_123/1234567890-abcdef123456.txt")).toBe(true);
    });

    it("should reject invalid keys", async () => {
      const { isLocalStorageKey } = await import("../s3Utils");
      expect(isLocalStorageKey("")).toBe(false);
      expect(isLocalStorageKey("../etc/passwd")).toBe(false);
      expect(isLocalStorageKey("users/user123/../../etc/passwd")).toBe(false);
      expect(isLocalStorageKey("invalid/key/format")).toBe(false);
    });
  });

  describe("localStorageFilePath", () => {
    it("should resolve valid keys to absolute paths", async () => {
      const { localStorageFilePath } = await import("../s3Utils");
      const filePath = localStorageFilePath("users/user123/1234567890-abcdef123456.pdf");
      expect(filePath).toBe(path.join(TEST_STORAGE_DIR, "users/user123/1234567890-abcdef123456.pdf"));
    });

    it("should throw for invalid keys", async () => {
      const { localStorageFilePath } = await import("../s3Utils");
      expect(() => localStorageFilePath("invalid")).toThrow("Invalid storage key");
    });
  });

  describe("generateS3UploadUrl", () => {
    it("should generate local storage upload URL and S3 key", async () => {
      const { generateS3UploadUrl } = await import("../s3Utils");

      const result = await generateS3UploadUrl(
        "test.pdf",
        "application/pdf",
        "user123",
        1024,
      );

      expect(result).toHaveProperty("uploadUrl");
      expect(result).toHaveProperty("s3Key");
      expect(result.uploadUrl).toContain("/api/local-storage/upload?key=");
      expect(result.s3Key).toMatch(/^users\/user123\/\d+-testuuid\d+\.pdf$/);
    });
  });

  describe("generateS3DownloadUrl", () => {
    it("should generate local storage download URL", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");

      const url = await generateS3DownloadUrl("users/user123/1234567890-abcdef123456.pdf");

      expect(url).toContain("/api/local-storage/file?key=");
    });
  });

  describe("deleteS3Object", () => {
    it("should delete local storage file", async () => {
      const { deleteS3Object, localStorageFilePath } = await import("../s3Utils");
      const filePath = localStorageFilePath("users/user123/1234567890-abcdef123456.pdf");
      
      // Create the file first
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "test content");

      await deleteS3Object("users/user123/1234567890-abcdef123456.pdf");

      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("should not throw for non-existent files", async () => {
      const { deleteS3Object } = await import("../s3Utils");
      await expect(
        deleteS3Object("users/user123/1234567890-abcdef123456.pdf"),
      ).resolves.not.toThrow();
    });

    it("should not delete for invalid keys", async () => {
      const { deleteS3Object } = await import("../s3Utils");
      await expect(deleteS3Object("invalid")).resolves.not.toThrow();
    });
  });

  describe("getS3ObjectSizeBytes", () => {
    it("should return file size for existing files", async () => {
      const { getS3ObjectSizeBytes, localStorageFilePath } = await import("../s3Utils");
      const filePath = localStorageFilePath("users/user123/1234567890-abcdef123456.pdf");
      
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "hello world"); // 11 bytes

      const size = await getS3ObjectSizeBytes("users/user123/1234567890-abcdef123456.pdf");
      expect(size).toBe(11);
    });

    it("should throw for non-existent files", async () => {
      const { getS3ObjectSizeBytes } = await import("../s3Utils");
      await expect(
        getS3ObjectSizeBytes("users/user123/1234567890-abcdef123456.pdf"),
      ).rejects.toThrow();
    });
  });

  describe("isS3Configured / isAzureStorageConfigured", () => {
    it("should always return false for S3", async () => {
      const { isS3Configured } = await import("../s3Utils");
      expect(isS3Configured()).toBe(false);
    });

    it("should always return false for Azure", async () => {
      const { isAzureStorageConfigured } = await import("../s3Utils");
      expect(isAzureStorageConfigured()).toBe(false);
    });
  });
});