import { defineComponent } from "convex/server"
import { v } from "convex/values"

/**
 * One installation serves one bucket. The app binds these to its own env vars
 * with `app.use(s3, { env: { ... } })`, so credentials never travel as
 * function arguments: every signature is made inside the component.
 */
const component = defineComponent("s3", {
  env: {
    S3_BUCKET: v.string(),
    /** `auto` for Cloudflare R2. */
    S3_REGION: v.string(),
    S3_ACCESS_KEY_ID: v.string(),
    S3_SECRET_ACCESS_KEY: v.string(),
    /** Temporary credentials only. */
    S3_SESSION_TOKEN: v.optional(v.string()),
    /** For S3-compatible providers: R2, MinIO, Tigris, B2. Unset: AWS. */
    S3_ENDPOINT: v.optional(v.string()),
    /**
     * `true` addresses objects as `<endpoint>/<bucket>/<key>`. Defaults to
     * `true` with `S3_ENDPOINT` (MinIO needs it) and `false` on AWS.
     */
    S3_FORCE_PATH_STYLE: v.optional(v.string()),
    /** Base of public URLs, such as a CloudFront distribution. */
    S3_PUBLIC_URL: v.optional(v.string()),
  },
})

export default component
