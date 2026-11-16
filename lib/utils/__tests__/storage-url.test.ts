import { isAzureSasUrl } from "../storage-url";

describe("isAzureSasUrl", () => {
  it("recognises an Azure Blob SAS URL", () => {
    expect(
      isAzureSasUrl(
        "https://acct.blob.core.windows.net/uploads/users/u/1-a.txt?sv=2022-11-02&sp=cw&sig=abc",
      ),
    ).toBe(true);
  });

  it("does not treat S3-compatible presigned URLs as Azure", () => {
    expect(
      isAzureSasUrl(
        "https://bucket.s3.amazonaws.com/users/u/1-a.txt?X-Amz-Signature=abc&X-Amz-Credential=x",
      ),
    ).toBe(false);
    expect(
      isAzureSasUrl(
        "https://acct.r2.cloudflarestorage.com/bucket/users/u/1-a.txt?X-Amz-Signature=abc",
      ),
    ).toBe(false);
  });

  it("returns false for the local fallback and malformed URLs", () => {
    expect(
      isAzureSasUrl("http://127.0.0.1:3000/api/local-storage/upload?key=x"),
    ).toBe(false);
    expect(isAzureSasUrl("not a url")).toBe(false);
  });
});
