/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      config: FunctionReference<
        "query",
        "internal",
        {},
        { bucket: string; publicUrl: string | null; region: string },
        Name
      >;
      deleteObject: FunctionReference<
        "mutation",
        "internal",
        { key: string },
        null,
        Name
      >;
      deleteObjects: FunctionReference<
        "mutation",
        "internal",
        { keys: Array<string> },
        null,
        Name
      >;
      deletePrefix: FunctionReference<
        "mutation",
        "internal",
        { prefix: string },
        null,
        Name
      >;
      getMetadata: FunctionReference<
        "query",
        "internal",
        { expiresIn?: number; key: string },
        {
          bucket: string;
          checksumSha256?: string;
          contentType?: string;
          etag?: string;
          key: string;
          lastModified: number;
          metadata?: Record<string, string>;
          publicUrl: string | null;
          size: number;
          url: string;
          versionId?: string;
        } | null,
        Name
      >;
      getPublicUrl: FunctionReference<
        "query",
        "internal",
        { key: string },
        string | null,
        Name
      >;
      getUrl: FunctionReference<
        "query",
        "internal",
        {
          expiresIn?: number;
          key: string;
          responseCacheControl?: string;
          responseContentDisposition?: string;
          responseContentType?: string;
          versionId?: string;
        },
        string,
        Name
      >;
      listFolder: FunctionReference<
        "query",
        "internal",
        {
          delimiter?: string;
          expiresIn?: number;
          limit?: number;
          prefix?: string;
        },
        {
          folders: Array<string>;
          isTruncated: boolean;
          objects: Array<{
            bucket: string;
            checksumSha256?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata?: Record<string, string>;
            publicUrl: string | null;
            size: number;
            url: string;
            versionId?: string;
          }>;
        },
        Name
      >;
      listMetadata: FunctionReference<
        "query",
        "internal",
        {
          expiresIn?: number;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          prefix?: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            bucket: string;
            checksumSha256?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata?: Record<string, string>;
            publicUrl: string | null;
            size: number;
            url: string;
            versionId?: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
    objects: {
      copyObject: FunctionReference<
        "action",
        "internal",
        {
          destinationKey: string;
          put?: {
            cacheControl?: string;
            checksumSha256?: string;
            contentDisposition?: string;
            contentEncoding?: string;
            contentLanguage?: string;
            contentType?: string;
            ifNoneMatch?: boolean;
            kmsKeyId?: string;
            metadata?: Record<string, string>;
            serverSideEncryption?: string;
            storageClass?: string;
            tagging?: Record<string, string>;
          };
          sourceKey: string;
        },
        {
          isNew: boolean;
          metadata: {
            bucket: string;
            checksumSha256?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata?: Record<string, string>;
            publicUrl: string | null;
            size: number;
            url: string;
            versionId?: string;
          };
        },
        Name
      >;
      getObject: FunctionReference<
        "action",
        "internal",
        { key: string; range?: string; versionId?: string },
        {
          contentRange?: string;
          data: ArrayBuffer;
          info: {
            cacheControl?: string;
            checksumSha256?: string;
            contentDisposition?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata: Record<string, string>;
            size: number;
            storageClass?: string;
            versionId?: string;
          };
        } | null,
        Name
      >;
      headObject: FunctionReference<
        "action",
        "internal",
        { key: string; versionId?: string },
        {
          cacheControl?: string;
          checksumSha256?: string;
          contentDisposition?: string;
          contentType?: string;
          etag?: string;
          key: string;
          lastModified: number;
          metadata: Record<string, string>;
          size: number;
          storageClass?: string;
          versionId?: string;
        } | null,
        Name
      >;
      listObjects: FunctionReference<
        "action",
        "internal",
        {
          cursor?: string | null;
          delimiter?: string;
          limit?: number;
          prefix?: string;
        },
        {
          cursor: string | null;
          isDone: boolean;
          objects: Array<{
            etag?: string;
            key: string;
            lastModified: number;
            size: number;
            storageClass?: string;
          }>;
          prefixes: Array<string>;
        },
        Name
      >;
      moveObject: FunctionReference<
        "action",
        "internal",
        {
          destinationKey: string;
          put?: {
            cacheControl?: string;
            checksumSha256?: string;
            contentDisposition?: string;
            contentEncoding?: string;
            contentLanguage?: string;
            contentType?: string;
            ifNoneMatch?: boolean;
            kmsKeyId?: string;
            metadata?: Record<string, string>;
            serverSideEncryption?: string;
            storageClass?: string;
            tagging?: Record<string, string>;
          };
          sourceKey: string;
        },
        {
          isNew: boolean;
          metadata: {
            bucket: string;
            checksumSha256?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata?: Record<string, string>;
            publicUrl: string | null;
            size: number;
            url: string;
            versionId?: string;
          };
        },
        Name
      >;
      putObjectTagging: FunctionReference<
        "action",
        "internal",
        { key: string; tags: Record<string, string> },
        null,
        Name
      >;
    };
    uploads: {
      abortUpload: FunctionReference<
        "action",
        "internal",
        { key: string; token: string },
        null,
        Name
      >;
      completeMultipartUpload: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          parts: Array<{ etag: string; partNumber: number }>;
          token: string;
        },
        {
          isNew: boolean;
          metadata: {
            bucket: string;
            checksumSha256?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata?: Record<string, string>;
            publicUrl: string | null;
            size: number;
            url: string;
            versionId?: string;
          };
        },
        Name
      >;
      createMultipartUpload: FunctionReference<
        "action",
        "internal",
        { key: string; token: string },
        { partCount: number; partSize: number; uploadId: string },
        Name
      >;
      generateUploadPost: FunctionReference<
        "mutation",
        "internal",
        {
          expiresIn?: number;
          key: string;
          maxSize: number;
          minSize?: number;
          put?: {
            cacheControl?: string;
            checksumSha256?: string;
            contentDisposition?: string;
            contentEncoding?: string;
            contentLanguage?: string;
            contentType?: string;
            ifNoneMatch?: boolean;
            kmsKeyId?: string;
            metadata?: Record<string, string>;
            serverSideEncryption?: string;
            storageClass?: string;
            tagging?: Record<string, string>;
          };
        },
        | {
            expiresAt: number;
            headers: Record<string, string>;
            key: string;
            method: "single";
            token: string;
            url: string;
          }
        | {
            expiresAt: number;
            key: string;
            method: "multipart";
            partCount: number;
            partSize: number;
            token: string;
          }
        | {
            expiresAt: number;
            fields: Record<string, string>;
            key: string;
            method: "post";
            token: string;
            url: string;
          },
        Name
      >;
      generateUploadUrl: FunctionReference<
        "mutation",
        "internal",
        {
          expiresIn?: number;
          key: string;
          maxSize?: number;
          multipartThreshold?: number;
          partSize?: number;
          put?: {
            cacheControl?: string;
            checksumSha256?: string;
            contentDisposition?: string;
            contentEncoding?: string;
            contentLanguage?: string;
            contentType?: string;
            ifNoneMatch?: boolean;
            kmsKeyId?: string;
            metadata?: Record<string, string>;
            serverSideEncryption?: string;
            storageClass?: string;
            tagging?: Record<string, string>;
          };
          size?: number;
        },
        | {
            expiresAt: number;
            headers: Record<string, string>;
            key: string;
            method: "single";
            token: string;
            url: string;
          }
        | {
            expiresAt: number;
            key: string;
            method: "multipart";
            partCount: number;
            partSize: number;
            token: string;
          }
        | {
            expiresAt: number;
            fields: Record<string, string>;
            key: string;
            method: "post";
            token: string;
            url: string;
          },
        Name
      >;
      listUploadedParts: FunctionReference<
        "action",
        "internal",
        { key: string; token: string },
        Array<{ etag: string; partNumber: number; size: number }>,
        Name
      >;
      signUploadParts: FunctionReference<
        "mutation",
        "internal",
        { key: string; partNumbers: Array<number>; token: string },
        Array<{ partNumber: number; url: string }>,
        Name
      >;
      syncMetadata: FunctionReference<
        "action",
        "internal",
        { key: string; token?: string },
        {
          isNew: boolean;
          metadata: {
            bucket: string;
            checksumSha256?: string;
            contentType?: string;
            etag?: string;
            key: string;
            lastModified: number;
            metadata?: Record<string, string>;
            publicUrl: string | null;
            size: number;
            url: string;
            versionId?: string;
          };
        },
        Name
      >;
    };
  };
