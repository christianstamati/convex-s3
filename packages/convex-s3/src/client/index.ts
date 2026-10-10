/**
 * The app's side of the component: `new S3(components.s3)` for server code,
 * and `s3.clientApi()` for the functions browsers call (with `useUploadFile`
 * from `convex-s3/react`). Names follow the R2 component's.
 */
import {
  actionGeneric,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  type PaginationOptions,
  type PaginationResult,
  paginationOptsValidator,
  paginationResultValidator,
  queryGeneric,
} from "convex/server"
import { type Infer, v } from "convex/values"
import type { ComponentApi } from "../component/_generated/component"
import {
  type ObjectInfoValue,
  type ObjectMetadata,
  type PutOptionsValue,
  type SyncResult,
  type UploadTicket,
  vObjectMetadata,
  vPart,
  vUploadTicket,
} from "../component/validators"
import { newKey, normalizePrefix } from "../shared/keys"

export { cleanFileName, newKey, normalizePrefix } from "../shared/keys"
export type {
  ObjectInfoValue as ObjectInfo,
  ObjectMetadata,
  PutOptionsValue as PutOptions,
  SyncResult,
  UploadTicket,
}
export { vObjectMetadata, vUploadTicket }

// The least each method needs, so query, mutation and action contexts of
// any app all fit.
type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: FunctionArgs<Query>
  ) => Promise<FunctionReturnType<Query>>
}
type RunMutationCtx = RunQueryCtx & {
  runMutation: <Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>
  ) => Promise<FunctionReturnType<Mutation>>
}
type RunActionCtx = RunMutationCtx & {
  runAction: <Action extends FunctionReference<"action", "internal">>(
    action: Action,
    args: FunctionArgs<Action>
  ) => Promise<FunctionReturnType<Action>>
}

/** Where and how an object is uploaded. */
export type UploadOptions = PutOptionsValue & {
  /** The whole key. Without it, one is made: `<prefix><uuid>/<fileName>`. */
  key?: string
  prefix?: string
  fileName?: string
  /** The exact size in bytes, signed into the upload so S3 refuses others. */
  size?: number
  maxSize?: number
  /** Above this size the ticket is a multipart upload (64 MB by default). */
  multipartThreshold?: number
  partSize?: number
  /** Seconds the upload URL stays valid (5 minutes by default). */
  expiresIn?: number
}

export type GetUrlOptions = {
  /** Seconds (15 minutes by default, 7 days at most). */
  expiresIn?: number
  versionId?: string
  /** Such as `attachment; filename="report.pdf"` to download, not display. */
  responseContentDisposition?: string
  responseContentType?: string
  responseCacheControl?: string
}

/** What a browser asks for when it wants to upload a file. */
export type UploadRequest = {
  fileName?: string | undefined
  contentType?: string | undefined
  size?: number | undefined
  prefix?: string | undefined
}

/**
 * What `checkUpload` decides. Return nothing to accept the request as it
 * is; throw to refuse it.
 */
export type UploadPolicy = {
  /** Where the key goes, whatever prefix the browser asked for. */
  prefix?: string
  /** The whole key, instead of `<prefix><uuid>/<fileName>`. */
  key?: string
  maxSize?: number
  contentType?: string
  /** More headers and metadata to store the object with. */
  put?: PutOptionsValue
  multipartThreshold?: number
  partSize?: number
}

type Callbacks<DataModel extends GenericDataModel> = {
  /**
   * Runs before a ticket is handed out. Throw to refuse; return an
   * `UploadPolicy` to decide the prefix, the size limit and more. Each
   * check is required for its function: without it, the function refuses.
   */
  checkUpload?: (
    ctx: GenericMutationCtx<DataModel>,
    bucket: string,
    request: UploadRequest
    // biome-ignore lint/suspicious/noConfusingVoidType: a check may return nothing
  ) => void | UploadPolicy | Promise<void | UploadPolicy>
  /**
   * Runs after an upload arrived and was recorded. Throw to refuse the
   * file: the object is then deleted.
   */
  onUpload?: (
    ctx: GenericMutationCtx<DataModel>,
    bucket: string,
    key: string,
    metadata: ObjectMetadata
  ) => void | Promise<void>
  /** Runs after every sync, with whether the key was new. */
  onSyncMetadata?: (
    ctx: GenericMutationCtx<DataModel>,
    args: { bucket: string; key: string; isNew: boolean }
  ) => void | Promise<void>
  checkReadKey?: (
    ctx: GenericQueryCtx<DataModel>,
    bucket: string,
    key: string
  ) => void | Promise<void>
  checkReadBucket?: (
    ctx: GenericQueryCtx<DataModel>,
    bucket: string,
    prefix: string | undefined
  ) => void | Promise<void>
  checkDelete?: (
    ctx: GenericMutationCtx<DataModel>,
    bucket: string,
    key: string
  ) => void | Promise<void>
  onDelete?: (
    ctx: GenericMutationCtx<DataModel>,
    bucket: string,
    key: string
  ) => void | Promise<void>
}

const vOnSyncArgs = {
  bucket: v.string(),
  key: v.string(),
  isNew: v.boolean(),
  metadata: vObjectMetadata,
}
const vOnSync = v.object(vOnSyncArgs)

export type ClientApiOptions<DataModel extends GenericDataModel> =
  Callbacks<DataModel> & {
    /**
     * Where this API's `onSyncMetadata` is exported, so uploads can run
     * `onUpload` and `onSyncMetadata` in a mutation. Required with them.
     * Either the module's path (`"files"`, `"storage/files"`), which works
     * from inside that module, or a reference such as `internal.files` from
     * any other module (inside it, TypeScript sees a circular type).
     */
    callbacks?:
      | string
      | {
          onSyncMetadata: FunctionReference<
            "mutation",
            "internal",
            Infer<typeof vOnSync>
          >
        }
  }

export class S3 {
  constructor(readonly component: ComponentApi) {}

  /** The bucket this installation serves. */
  async bucket(ctx: RunQueryCtx) {
    return (await ctx.runQuery(this.component.lib.config, {})).bucket
  }

  /**
   * A ticket to upload one object from a browser (`useUploadFile` follows
   * it): one presigned PUT, or multipart above `multipartThreshold`.
   */
  async generateUploadUrl(
    ctx: RunMutationCtx,
    options: UploadOptions = {}
  ): Promise<UploadTicket> {
    const {
      key,
      prefix,
      fileName,
      size,
      maxSize,
      multipartThreshold,
      partSize,
      expiresIn,
      ...put
    } = options
    return await ctx.runMutation(this.component.uploads.generateUploadUrl, {
      key: key ?? newKey(prefix, fileName),
      size,
      maxSize,
      put: definedOnly(put),
      expiresIn,
      multipartThreshold,
      partSize,
    })
  }

  /**
   * A ticket for an HTML form upload whose policy caps the size: S3 refuses
   * a bigger file. Not supported by Cloudflare R2.
   */
  async generateUploadPost(
    ctx: RunMutationCtx,
    options: Omit<UploadOptions, "size" | "multipartThreshold" | "partSize"> & {
      maxSize: number
      minSize?: number
    }
  ): Promise<UploadTicket> {
    const { key, prefix, fileName, maxSize, minSize, expiresIn, ...put } =
      options
    return await ctx.runMutation(this.component.uploads.generateUploadPost, {
      key: key ?? newKey(prefix, fileName),
      maxSize,
      minSize,
      put: definedOnly(put),
      expiresIn,
    })
  }

  /** Uploads bytes from an action and records them. Returns the key. */
  async store(
    ctx: RunActionCtx,
    data: Blob | ArrayBuffer | Uint8Array,
    options: Omit<UploadOptions, "size" | "multipartThreshold" | "partSize"> & {
      type?: string
    } = {}
  ): Promise<string> {
    const { type, ...rest } = options
    const body =
      data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data)
    const contentType =
      rest.contentType ?? type ?? (data instanceof Blob ? data.type : undefined)
    const ticket = await this.generateUploadUrl(ctx, {
      ...rest,
      contentType: contentType || undefined,
      size: body.byteLength,
      multipartThreshold: Number.MAX_SAFE_INTEGER,
    })
    if (ticket.method !== "single") throw new Error("Expected a single upload")
    const response = await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body: body as BodyInit,
    })
    if (!response.ok) {
      await this.abortUpload(ctx, ticket.key, ticket.token)
      throw new Error(
        `S3 refused the upload (${response.status}): ${(await response.text()).slice(0, 300)}`
      )
    }
    await ctx.runAction(this.component.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    return ticket.key
  }

  /** HEADs the key and records what's there. */
  async syncMetadata(ctx: RunActionCtx, key: string): Promise<SyncResult> {
    return await ctx.runAction(this.component.uploads.syncMetadata, { key })
  }

  async abortUpload(ctx: RunActionCtx, key: string, token: string) {
    await ctx.runAction(this.component.uploads.abortUpload, { key, token })
  }

  /** A presigned download URL (15 minutes by default). */
  async getUrl(
    ctx: RunQueryCtx,
    key: string,
    options: GetUrlOptions = {}
  ): Promise<string> {
    return await ctx.runQuery(this.component.lib.getUrl, { key, ...options })
  }

  /** The URL under `S3_PUBLIC_URL`, or null without one. */
  async getPublicUrl(ctx: RunQueryCtx, key: string): Promise<string | null> {
    return await ctx.runQuery(this.component.lib.getPublicUrl, { key })
  }

  async getMetadata(
    ctx: RunQueryCtx,
    key: string
  ): Promise<ObjectMetadata | null> {
    return await ctx.runQuery(this.component.lib.getMetadata, { key })
  }

  /** Up to `limit` recorded objects (100 by default), by key. */
  async listMetadata(
    ctx: RunQueryCtx,
    limit = 100,
    cursor: string | null = null,
    prefix?: string
  ): Promise<PaginationResult<ObjectMetadata>> {
    return await this.pageMetadata(ctx, { numItems: limit, cursor }, prefix)
  }

  /** A page of recorded objects, for `usePaginatedQuery`. */
  async pageMetadata(
    ctx: RunQueryCtx,
    paginationOpts: PaginationOptions,
    prefix?: string
  ): Promise<PaginationResult<ObjectMetadata>> {
    return await ctx.runQuery(this.component.lib.listMetadata, {
      paginationOpts,
      prefix,
    })
  }

  /** Deletes the row now and the object in the background, with retries. */
  async deleteObject(ctx: RunMutationCtx, key: string) {
    await ctx.runMutation(this.component.lib.deleteObject, { key })
  }

  async deleteObjects(ctx: RunMutationCtx, keys: string[]) {
    await ctx.runMutation(this.component.lib.deleteObjects, { keys })
  }

  /** Deletes everything under a non-empty prefix, in scheduled steps. */
  async deletePrefix(ctx: RunMutationCtx, prefix: string) {
    await ctx.runMutation(this.component.lib.deletePrefix, { prefix })
  }

  async headObject(ctx: RunActionCtx, key: string, versionId?: string) {
    return await ctx.runAction(this.component.objects.headObject, {
      key,
      versionId,
    })
  }

  /** The bytes of a small object, or of a range (`bytes=0-1023`). */
  async getObject(
    ctx: RunActionCtx,
    key: string,
    options: { range?: string; versionId?: string } = {}
  ) {
    return await ctx.runAction(this.component.objects.getObject, {
      key,
      ...options,
    })
  }

  /** One page of what's in the bucket itself (`ListObjectsV2`). */
  async listObjects(
    ctx: RunActionCtx,
    options: {
      prefix?: string
      delimiter?: string
      cursor?: string | null
      limit?: number
    } = {}
  ) {
    return await ctx.runAction(this.component.objects.listObjects, options)
  }

  async copyObject(
    ctx: RunActionCtx,
    sourceKey: string,
    destinationKey: string,
    put?: PutOptionsValue
  ): Promise<SyncResult> {
    return await ctx.runAction(this.component.objects.copyObject, {
      sourceKey,
      destinationKey,
      put,
    })
  }

  async moveObject(
    ctx: RunActionCtx,
    sourceKey: string,
    destinationKey: string,
    put?: PutOptionsValue
  ): Promise<SyncResult> {
    return await ctx.runAction(this.component.objects.moveObject, {
      sourceKey,
      destinationKey,
      put,
    })
  }

  async putObjectTagging(
    ctx: RunActionCtx,
    key: string,
    tags: Record<string, string>
  ) {
    await ctx.runAction(this.component.objects.putObjectTagging, { key, tags })
  }

  /**
   * The functions browsers call, guarded by your callbacks. Export them from
   * a module and name that module as `callbacks`:
   *
   * ```ts
   * // convex/files.ts
   * export const { generateUploadUrl, syncMetadata, onSyncMetadata, ... } =
   *   s3.clientApi<DataModel>({ checkUpload, onUpload, callbacks: "files" })
   * ```
   */
  clientApi<DataModel extends GenericDataModel>(
    options: ClientApiOptions<DataModel> = {}
  ) {
    const component = this.component
    const needsCallbacks =
      options.onUpload !== undefined || options.onSyncMetadata !== undefined
    const bucketOf = async (ctx: RunQueryCtx) =>
      (await ctx.runQuery(component.lib.config, {})).bucket

    /** Runs the app's callbacks; a refused file is deleted. */
    const afterUpload = async (
      ctx: GenericActionCtx<DataModel>,
      result: SyncResult
    ) => {
      if (!needsCallbacks) return
      if (options.callbacks === undefined) {
        throw new Error(
          'convex-s3: pass `callbacks: "<module path>"` to clientApi() to run onUpload or onSyncMetadata'
        )
      }
      const onSyncMetadata =
        typeof options.callbacks === "string"
          ? makeFunctionReference<"mutation", Infer<typeof vOnSync>, null>(
              `${options.callbacks}:onSyncMetadata`
            )
          : options.callbacks.onSyncMetadata
      try {
        await ctx.runMutation(onSyncMetadata, {
          bucket: result.metadata.bucket,
          key: result.metadata.key,
          isNew: result.isNew,
          metadata: result.metadata,
        })
      } catch (error) {
        await ctx.runMutation(component.lib.deleteObject, {
          key: result.metadata.key,
        })
        throw error
      }
    }

    const vKeyToken = { key: v.string(), token: v.string() }

    return {
      generateUploadUrl: mutationGeneric({
        args: {
          fileName: v.optional(v.string()),
          contentType: v.optional(v.string()),
          size: v.optional(v.number()),
          prefix: v.optional(v.string()),
        },
        returns: vUploadTicket,
        handler: async (ctx, request): Promise<UploadTicket> => {
          const policy =
            (await required(options.checkUpload, "checkUpload")(
              ctx as GenericMutationCtx<DataModel>,
              await bucketOf(ctx),
              request
            )) ?? undefined
          const prefix = normalizePrefix(policy?.prefix ?? request.prefix)
          const contentType = policy?.contentType ?? request.contentType
          return await ctx.runMutation(component.uploads.generateUploadUrl, {
            key: policy?.key ?? newKey(prefix, request.fileName),
            size: request.size,
            maxSize: policy?.maxSize,
            put: definedOnly({
              ...policy?.put,
              contentType: contentType || undefined,
            }),
            multipartThreshold: policy?.multipartThreshold,
            partSize: policy?.partSize,
          })
        },
      }),

      syncMetadata: actionGeneric({
        args: vKeyToken,
        returns: vObjectMetadata,
        handler: async (ctx, args): Promise<ObjectMetadata> => {
          const result: SyncResult = await ctx.runAction(
            component.uploads.syncMetadata,
            args
          )
          await afterUpload(ctx as GenericActionCtx<DataModel>, result)
          return result.metadata
        },
      }),

      createMultipartUpload: actionGeneric({
        args: vKeyToken,
        returns: v.object({
          uploadId: v.string(),
          partSize: v.number(),
          partCount: v.number(),
        }),
        handler: async (ctx, args) =>
          await ctx.runAction(component.uploads.createMultipartUpload, args),
      }),

      signUploadParts: mutationGeneric({
        args: { ...vKeyToken, partNumbers: v.array(v.number()) },
        returns: v.array(v.object({ partNumber: v.number(), url: v.string() })),
        handler: async (ctx, args) =>
          await ctx.runMutation(component.uploads.signUploadParts, args),
      }),

      listUploadedParts: actionGeneric({
        args: vKeyToken,
        returns: v.array(
          v.object({
            partNumber: v.number(),
            etag: v.string(),
            size: v.number(),
          })
        ),
        handler: async (ctx, args) =>
          await ctx.runAction(component.uploads.listUploadedParts, args),
      }),

      completeMultipartUpload: actionGeneric({
        args: { ...vKeyToken, parts: v.array(vPart) },
        returns: vObjectMetadata,
        handler: async (ctx, args): Promise<ObjectMetadata> => {
          const result: SyncResult = await ctx.runAction(
            component.uploads.completeMultipartUpload,
            args
          )
          await afterUpload(ctx as GenericActionCtx<DataModel>, result)
          return result.metadata
        },
      }),

      abortUpload: actionGeneric({
        args: vKeyToken,
        returns: v.null(),
        handler: async (ctx, args) => {
          await ctx.runAction(component.uploads.abortUpload, args)
          return null
        },
      }),

      getMetadata: queryGeneric({
        args: { key: v.string() },
        returns: v.union(vObjectMetadata, v.null()),
        handler: async (ctx, { key }) => {
          await required(options.checkReadKey, "checkReadKey")(
            ctx as GenericQueryCtx<DataModel>,
            await bucketOf(ctx),
            key
          )
          return await ctx.runQuery(component.lib.getMetadata, { key })
        },
      }),

      listMetadata: queryGeneric({
        args: {
          prefix: v.optional(v.string()),
          paginationOpts: paginationOptsValidator,
        },
        returns: paginationResultValidator(vObjectMetadata),
        handler: async (ctx, { prefix, paginationOpts }) => {
          await required(options.checkReadBucket, "checkReadBucket")(
            ctx as GenericQueryCtx<DataModel>,
            await bucketOf(ctx),
            prefix
          )
          return await ctx.runQuery(component.lib.listMetadata, {
            prefix,
            paginationOpts,
          })
        },
      }),

      deleteObject: mutationGeneric({
        args: { key: v.string() },
        returns: v.null(),
        handler: async (ctx, { key }) => {
          const bucket = await bucketOf(ctx)
          const appCtx = ctx as GenericMutationCtx<DataModel>
          await required(options.checkDelete, "checkDelete")(
            appCtx,
            bucket,
            key
          )
          await ctx.runMutation(component.lib.deleteObject, { key })
          await options.onDelete?.(appCtx, bucket, key)
          return null
        },
      }),

      onSyncMetadata: internalMutationGeneric({
        args: vOnSyncArgs,
        returns: v.null(),
        handler: async (ctx, { bucket, key, isNew, metadata }) => {
          const appCtx = ctx as GenericMutationCtx<DataModel>
          await options.onSyncMetadata?.(appCtx, { bucket, key, isNew })
          await options.onUpload?.(appCtx, bucket, key, metadata)
          return null
        },
      }),
    }
  }
}

/**
 * A check callback, or one that refuses: without a check, browsers could
 * upload, read or delete any key. Pass `() => {}` to allow everything.
 */
function required<F>(check: F | undefined, name: string): F {
  if (check !== undefined) return check
  return (() => {
    throw new Error(
      `convex-s3: this function is off until clientApi() gets ${name}`
    )
  }) as F
}

/** Drops undefined fields, and returns undefined for an empty object. */
function definedOnly<T extends Record<string, unknown>>(value: T) {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T)
}
