/**
 * `useUploadFile`: uploads a file through the functions `s3.clientApi()`
 * exports, straight from the browser to S3. One PUT for small files; above
 * the server's threshold, a multipart upload with parallel parts that
 * resumes after a reload. Progress comes from the browser's upload events.
 */
import { useConvex } from "convex/react"
import { type FunctionReference, getFunctionName } from "convex/server"
import { useCallback } from "react"
import type { ObjectMetadata, UploadTicket } from "../component/validators.js"

type KeyToken = { key: string; token: string }

/** The functions `s3.clientApi()` exports, as `api.<module>`. */
export type UploadApi = {
  generateUploadUrl: FunctionReference<
    "mutation",
    "public",
    {
      fileName?: string
      contentType?: string
      size?: number
      prefix?: string
    },
    UploadTicket
  >
  syncMetadata: FunctionReference<"action", "public", KeyToken, ObjectMetadata>
  createMultipartUpload?: FunctionReference<
    "action",
    "public",
    KeyToken,
    { uploadId: string; partSize: number; partCount: number }
  >
  signUploadParts?: FunctionReference<
    "mutation",
    "public",
    KeyToken & { partNumbers: number[] },
    { partNumber: number; url: string }[]
  >
  listUploadedParts?: FunctionReference<
    "action",
    "public",
    KeyToken,
    { partNumber: number; etag: string; size: number }[]
  >
  completeMultipartUpload?: FunctionReference<
    "action",
    "public",
    KeyToken & { parts: { partNumber: number; etag: string }[] },
    ObjectMetadata
  >
  abortUpload?: FunctionReference<"action", "public", KeyToken, null>
}

export type UploadProgress = {
  loaded: number
  total: number
  /** 0 to 1. */
  fraction: number
}

export type UploadFileOptions = {
  /** The prefix to ask for. `checkUpload` decides. */
  prefix?: string
  onProgress?: (progress: UploadProgress) => void
  /** Aborting cancels the upload and removes what arrived. */
  signal?: AbortSignal
  /** Parts uploaded at once (4 by default). */
  concurrency?: number
  /** Resume an interrupted multipart upload of the same file (default true). */
  resume?: boolean
}

/** Part URLs signed per request. */
const SIGN_BATCH = 20
const PART_ATTEMPTS = 3

/**
 * Returns `uploadFile(file, options)`, which resolves to the new object's
 * key once S3 has it and the server recorded it.
 */
export function useUploadFile(api: UploadApi) {
  const convex = useConvex()
  return useCallback(
    async (file: File, options: UploadFileOptions = {}) => {
      return await uploadFile(
        {
          mutation: (ref, args) => convex.mutation(ref, args),
          action: (ref, args) => convex.action(ref, args),
        },
        api,
        file,
        options
      )
    },
    [convex, api]
  )
}

type Client = {
  mutation: <F extends FunctionReference<"mutation", "public">>(
    ref: F,
    args: F["_args"]
  ) => Promise<F["_returnType"]>
  action: <F extends FunctionReference<"action", "public">>(
    ref: F,
    args: F["_args"]
  ) => Promise<F["_returnType"]>
}

/** The upload itself, usable outside React with any Convex client. */
export async function uploadFile(
  client: Client,
  api: UploadApi,
  file: File,
  options: UploadFileOptions = {}
): Promise<string> {
  const progress = progressReporter(file.size, options.onProgress)
  const saved =
    options.resume === false ? null : loadResumable(api, file, options)
  if (saved !== null && api.createMultipartUpload) {
    try {
      return await uploadParts(client, api, file, saved, options, progress)
    } catch (error) {
      if (isAbort(error)) throw error
      forgetResumable(api, file, options)
      // The saved upload expired or broke: start over.
    }
  }

  const ticket = await client.mutation(api.generateUploadUrl, {
    fileName: file.name,
    contentType: file.type || undefined,
    size: file.size,
    prefix: options.prefix,
  })
  const keyToken = { key: ticket.key, token: ticket.token }

  if (ticket.method === "multipart") {
    saveResumable(api, file, options, keyToken, ticket.expiresAt)
    return await uploadParts(client, api, file, keyToken, options, progress)
  }

  try {
    if (ticket.method === "single") {
      await send(
        "PUT",
        ticket.url,
        file,
        ticket.headers,
        progress.part(0),
        options.signal
      )
    } else {
      const form = new FormData()
      for (const [name, value] of Object.entries(ticket.fields)) {
        form.append(name, value)
      }
      form.append("file", file)
      await send("POST", ticket.url, form, {}, progress.part(0), options.signal)
    }
    await client.action(api.syncMetadata, keyToken)
    return ticket.key
  } catch (error) {
    if (api.abortUpload) {
      await client.action(api.abortUpload, keyToken).catch(() => undefined)
    }
    throw error
  }
}

async function uploadParts(
  client: Client,
  api: UploadApi,
  file: File,
  keyToken: KeyToken,
  options: UploadFileOptions,
  progress: ReturnType<typeof progressReporter>
) {
  const { createMultipartUpload, signUploadParts, completeMultipartUpload } =
    api
  if (!createMultipartUpload || !signUploadParts || !completeMultipartUpload) {
    throw new Error(
      "convex-s3: export createMultipartUpload, signUploadParts and completeMultipartUpload from clientApi() for large files"
    )
  }
  try {
    const { partSize, partCount } = await client.action(
      createMultipartUpload,
      keyToken
    )
    const done = new Map<number, string>()
    if (api.listUploadedParts) {
      for (const part of await client.action(api.listUploadedParts, keyToken)) {
        done.set(part.partNumber, part.etag)
        progress.part(part.partNumber)(part.size)
      }
    }
    const queue = Array.from({ length: partCount }, (_, i) => i + 1).filter(
      (n) => !done.has(n)
    )

    const urls = new Map<number, Promise<string>>()
    const urlFor = (partNumber: number, fresh = false) => {
      if (fresh) urls.delete(partNumber)
      const existing = urls.get(partNumber)
      if (existing) return existing
      // Sign this part and the next few waiting ones in one call.
      const batch = [
        partNumber,
        ...queue.filter((n) => !urls.has(n) && n !== partNumber),
      ].slice(0, SIGN_BATCH)
      const signed = client.mutation(signUploadParts, {
        ...keyToken,
        partNumbers: batch,
      })
      for (const n of batch) {
        urls.set(
          n,
          signed.then((parts) => {
            const url = parts.find((p) => p.partNumber === n)?.url
            if (!url) throw new Error(`No URL for part ${n}`)
            return url
          })
        )
      }
      return urls.get(partNumber) as Promise<string>
    }

    const uploadPart = async (partNumber: number) => {
      const start = (partNumber - 1) * partSize
      const blob = file.slice(start, Math.min(start + partSize, file.size))
      for (let attempt = 1; ; attempt++) {
        try {
          const url = await urlFor(partNumber, attempt > 1)
          const etag = await send(
            "PUT",
            url,
            blob,
            {},
            progress.part(partNumber),
            options.signal
          )
          if (!etag) {
            throw new Error(
              "S3 sent no ETag: the bucket's CORS rule must expose the ETag header"
            )
          }
          done.set(partNumber, etag)
          return
        } catch (error) {
          progress.part(partNumber)(0)
          if (isAbort(error) || attempt >= PART_ATTEMPTS) throw error
        }
      }
    }

    const workers = Array.from(
      { length: Math.max(1, Math.min(options.concurrency ?? 4, queue.length)) },
      async () => {
        for (
          let next = queue.shift();
          next !== undefined;
          next = queue.shift()
        ) {
          await uploadPart(next)
        }
      }
    )
    await Promise.all(workers)

    await client.action(completeMultipartUpload, {
      ...keyToken,
      parts: Array.from(done, ([partNumber, etag]) => ({ partNumber, etag })),
    })
    forgetResumable(api, file, options)
    return keyToken.key
  } catch (error) {
    if (isAbort(error)) {
      forgetResumable(api, file, options)
      if (api.abortUpload) {
        await client.action(api.abortUpload, keyToken).catch(() => undefined)
      }
    }
    throw error
  }
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

/** One request with upload progress. Resolves to the ETag, if any. */
function send(
  method: "PUT" | "POST",
  url: string,
  body: Blob | FormData,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal | undefined
) {
  // What a finished request reports: the file's size, even inside a form.
  const sentSize =
    body instanceof Blob
      ? body.size
      : Array.from(body.values()).reduce(
          (n, value) => n + (value instanceof Blob ? value.size : 0),
          0
        )
  return new Promise<string | null>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The upload was cancelled", "AbortError"))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    for (const [name, value] of Object.entries(headers)) {
      if (name !== "content-length" && name !== "host") {
        xhr.setRequestHeader(name, value)
      }
    }
    xhr.upload.onprogress = (event) => onProgress(event.loaded)
    xhr.onload = () => {
      signal?.removeEventListener("abort", abort)
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(sentSize)
        resolve(xhr.getResponseHeader("ETag"))
      } else {
        const code = /<Code>([^<]+)<\/Code>/.exec(xhr.responseText)?.[1]
        reject(
          new Error(
            `S3 refused the upload (${xhr.status}${code ? ` ${code}` : ""})`
          )
        )
      }
    }
    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort)
      reject(new Error("The upload failed: network error or blocked by CORS"))
    }
    const abort = () => {
      xhr.abort()
      reject(new DOMException("The upload was cancelled", "AbortError"))
    }
    signal?.addEventListener("abort", abort, { once: true })
    xhr.send(body)
  })
}

function progressReporter(
  total: number,
  onProgress: UploadFileOptions["onProgress"]
) {
  const loaded = new Map<number, number>()
  return {
    part: (partNumber: number) => (bytes: number) => {
      loaded.set(partNumber, bytes)
      if (!onProgress) return
      let sum = 0
      for (const value of loaded.values()) sum += value
      const clamped = Math.min(sum, total)
      onProgress({
        loaded: clamped,
        total,
        fraction: total === 0 ? 1 : clamped / total,
      })
    },
  }
}

// Resuming: the ticket of a multipart upload, kept per file until it ends.

/** Per API (module) and file, so a ticket never resumes in another API. */
function storageKey(api: UploadApi, file: File, options: UploadFileOptions) {
  const module = getFunctionName(api.generateUploadUrl)
  return `convex-s3:${module}:${options.prefix ?? ""}:${file.name}:${file.size}:${file.lastModified}`
}

function loadResumable(
  api: UploadApi,
  file: File,
  options: UploadFileOptions
): KeyToken | null {
  try {
    const raw = localStorage.getItem(storageKey(api, file, options))
    if (!raw) return null
    const saved = JSON.parse(raw) as KeyToken & { expiresAt: number }
    return saved.expiresAt > Date.now()
      ? { key: saved.key, token: saved.token }
      : null
  } catch {
    return null
  }
}

function saveResumable(
  api: UploadApi,
  file: File,
  options: UploadFileOptions,
  keyToken: KeyToken,
  expiresAt: number
) {
  if (options.resume === false) return
  try {
    localStorage.setItem(
      storageKey(api, file, options),
      JSON.stringify({ ...keyToken, expiresAt })
    )
  } catch {
    // Storage unavailable: the upload just won't resume.
  }
}

function forgetResumable(
  api: UploadApi,
  file: File,
  options: UploadFileOptions
) {
  try {
    localStorage.removeItem(storageKey(api, file, options))
  } catch {
    // Nothing saved.
  }
}
