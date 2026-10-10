import rateLimiter from "@convex-dev/rate-limiter/convex.config.js"
import { defineApp } from "convex/server"
import { v } from "convex/values"
import s3 from "convex-s3/convex.config"

// Deployment env vars, validated on every push. Set them with
// `bunx convex env set` in packages/backend (see README.md).
const app = defineApp({
  env: {
    S3_BUCKET: v.string(),
    S3_REGION: v.string(),
    S3_ACCESS_KEY_ID: v.string(),
    S3_SECRET_ACCESS_KEY: v.string(),
    S3_SESSION_TOKEN: v.optional(v.string()),
    S3_ENDPOINT: v.optional(v.string()),
    S3_FORCE_PATH_STYLE: v.optional(v.string()),
    S3_PUBLIC_URL: v.optional(v.string()),
  },
})

// The bucket, through the convex-s3 component. Its credentials stay in the
// component: the app only binds the env vars.
app.use(s3, {
  env: {
    S3_BUCKET: app.env.S3_BUCKET,
    S3_REGION: app.env.S3_REGION,
    S3_ACCESS_KEY_ID: app.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: app.env.S3_SECRET_ACCESS_KEY,
    S3_SESSION_TOKEN: app.env.S3_SESSION_TOKEN,
    S3_ENDPOINT: app.env.S3_ENDPOINT,
    S3_FORCE_PATH_STYLE: app.env.S3_FORCE_PATH_STYLE,
    S3_PUBLIC_URL: app.env.S3_PUBLIC_URL,
  },
})

// Caps on the public examples (convex/lib/rateLimits.ts).
app.use(rateLimiter)

export default app
