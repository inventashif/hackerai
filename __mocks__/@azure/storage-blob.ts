/**
 * Minimal `@azure/storage-blob` double for Jest.
 *
 * The real package ships an ESM-only browser build, which jsdom cannot load.
 * SAS signing and blob I/O are verified end-to-end against Azurite instead
 * (see `.verify-azure.ts`); these doubles only exercise our provider wiring.
 */

export const __state = {
  accountName: "hackeraitest",
  container: "",
  blobName: "",
  sasOptions: null as Record<string, unknown> | null,
  credential: null as StorageSharedKeyCredential | null,
};

export class StorageSharedKeyCredential {
  constructor(
    public accountName: string,
    public accountKey: string,
  ) {
    __state.credential = this;
  }
}

export const SASProtocol = {
  Https: "https",
  HttpsAndHttp: "https,http",
} as const;

export const BlobSASPermissions = {
  parse: (permissions: string) => ({ permissions }),
};

export const generateBlobSASQueryParameters = (
  options: {
    containerName: string;
    blobName: string;
    permissions: { permissions: string };
    protocol: string;
  },
  credential: StorageSharedKeyCredential,
) => {
  __state.sasOptions = options;
  return {
    toString: () =>
      new URLSearchParams({
        sv: "2022-11-02",
        sp: options.permissions.permissions,
        spr: options.protocol,
        se: "2099-01-01T00:00:00Z",
        sig: "fakesignature",
        account: credential.accountName,
        container: options.containerName,
        blob: options.blobName,
      }).toString(),
  };
};

const parseConnectionString = (connectionString: string) => {
  const parts = new Map<string, string>();
  for (const segment of connectionString.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    parts.set(
      segment.slice(0, separator).trim().toLowerCase(),
      segment.slice(separator + 1).trim(),
    );
  }
  return parts;
};

export const BlobServiceClient = {
  fromConnectionString: (connectionString: string) => {
    const parts = parseConnectionString(connectionString);
    const accountName = parts.get("accountname") ?? "hackeraitest";
    const endpoint =
      parts.get("blobendpoint") ??
      `https://${accountName}.blob.core.windows.net`;

    return {
      getContainerClient: (container: string) => ({
        getBlockBlobClient: (blobName: string) => {
          __state.container = container;
          __state.blobName = blobName;
          return {
            url: `${endpoint.replace(/\/$/, "")}/${container}/${blobName}`,
            getProperties: async () => ({ contentLength: 0 }),
            deleteIfExists: async () => ({ succeeded: true }),
          };
        },
      }),
    };
  },
};
