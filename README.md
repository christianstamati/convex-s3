# convex-s3

A [Convex](https://convex.dev) component for S3-compatible object storage, with
the [R2 component](https://www.convex.dev/components/cloudflare-r2)'s API and
the rest of S3: multipart uploads with resume, prefixes, enforced size limits,
batch and prefix deletes, copies, tags, checksums and conditional writes.
Browsers upload straight to the bucket; Convex signs and records.

**How to use it: [packages/convex-s3/README.md](packages/convex-s3/README.md).**

```
packages/convex-s3   the component: src/component (Convex functions), src/client
                     (the S3 class), src/react (useUploadFile), src/testing (FakeS3)
packages/backend     an example Convex app using it, and its end-to-end checks
apps/web             the example's web app: uploads with progress, list, delete
packages/ui          shadcn/ui components for the example
```

## Develop

```bash
bun install
bun dev
```

`bun dev` runs `convex dev` and Vite together; the example is on
http://localhost:3000. The backend needs a bucket: set the component's env vars
on the Convex deployment, in `packages/backend`:

```bash
bunx convex env set S3_BUCKET my-bucket
bunx convex env set S3_REGION eu-west-1
bunx convex env set S3_ACCESS_KEY_ID
bunx convex env set S3_SECRET_ACCESS_KEY
```

(`env set NAME` without a value asks for it, which keeps secrets out of your
shell history.) Configure the bucket's CORS, lifecycle rule and IAM user as
the [package README](packages/convex-s3/README.md#the-bucket) describes.

| Command | What it does |
| --- | --- |
| `bun dev` | Backend and example app in watch mode |
| `bun run test` | The component's tests and the example's, against `FakeS3` |
| `bunx convex run e2e:run` | In `packages/backend`: end-to-end checks against the deployment's real bucket, under `e2e/<run>/`, deleted afterwards |
| `bun run typecheck` | `tsc` (TypeScript 7) in every package |
| `bun run check` / `check:fix` | Biome lint and format |
| `bun run build` | Production build of the example app |
| `bun run --cwd packages/convex-s3 codegen` | Regenerate the component's `_generated` after changing its functions |

A lefthook pre-commit hook runs Biome on staged files.

## Stack

Bun and Turborepo; TypeScript 7; Convex; TanStack Start with React 19 for the
example; shadcn/ui on Base UI with Tailwind CSS 4; Vitest with convex-test;
Biome. Started from [cstack](https://github.com/christianstamati/cstack).

The package is exported as TypeScript sources and installs straight from the
workspace; it isn't published yet.
