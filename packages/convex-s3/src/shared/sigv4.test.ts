import { describe, expect, test } from "vitest"
import {
  amzDate,
  EMPTY_SHA256,
  presignUrl,
  sha256Hex,
  signRequest,
  uriEncode,
} from "./sigv4"

// The worked examples from AWS's SigV4 documentation for S3:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
}
const date = new Date("2013-05-24T00:00:00Z")

describe("sigv4", () => {
  test("formats dates", () => {
    expect(amzDate(date)).toBe("20130524T000000Z")
  })

  test("encodes like RFC 3986", () => {
    expect(uriEncode("a b+c!'()*~")).toBe("a%20b%2Bc%21%27%28%29%2A~")
    expect(uriEncode("dir/file name.txt", false)).toBe("dir/file%20name.txt")
  })

  test("hashes an empty payload", async () => {
    expect(await sha256Hex("")).toBe(EMPTY_SHA256)
  })

  test("signs a GET with a Range header", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
      credentials,
      region: "us-east-1",
      date,
    })
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )
  })

  test("signs a PUT with a body and extra headers", async () => {
    const body = "Welcome to Amazon S3."
    const headers = await signRequest({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: await sha256Hex(body),
      credentials,
      region: "us-east-1",
      date,
    })
    expect(headers.authorization).toContain(
      "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
    )
  })

  test("presigns a GET", async () => {
    const url = await presignUrl({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      credentials,
      region: "us-east-1",
      expiresIn: 86400,
      date,
    })
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    )
  })
})
