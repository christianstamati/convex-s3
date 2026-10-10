# convex-s3

[![npm version](https://img.shields.io/npm/v/@cstack-dev/convex-s3)](https://www.npmjs.com/package/@cstack-dev/convex-s3)

The repository of [`@cstack-dev/convex-s3`](https://www.npmjs.com/package/@cstack-dev/convex-s3), a [Convex](https://convex.dev) component for S3-compatible storage with the [R2 component](https://www.convex.dev/components/cloudflare-r2)'s API and the rest of S3: multipart uploads with resume, prefixes and folders, enforced size limits, batch and prefix deletes, copies, tags, checksums and conditional writes. Browsers upload straight to the bucket; Convex signs and records.

```sh
npm install @cstack-dev/convex-s3
```

- **How to use it:** [packages/convex-s3/README.md](packages/convex-s3/README.md).
- **With a coding agent:** point it at [`packages/convex-s3/llms.txt`](packages/convex-s3/llms.txt) (also in the npm package), a step-by-step integration guide.

```
packages/convex-s3   the package: src/component (Convex functions), src/client
                     (the S3 class), src/react (useUploadFile), src/testing (FakeS3);
                     built to dist, published as @cstack-dev/convex-s3
packages/backend     the examples' Convex functions, and end-to-end checks
apps/web             the examples' web app: the home page lists them
packages/ui          shadcn/ui components for the example
```

## Develop

```bash
bun install
bun dev
```

`bun dev` runs `convex dev` and Vite together; the examples are on
http://localhost:3000:

- **Drive** (`/examples/drive`): a Google Drive clone where folders are S3
  prefixes. Folder listings use `listFolder`, a new folder is a zero-byte
  marker object, uploads keep their names (numbered when taken), renaming or
  moving a folder moves every key under its prefix, and deleting one is
  `deletePrefix`. Drop files or whole folder trees on it.
- **Uploads** (`/examples/uploads`): single and multipart uploads with
  progress, cancel and resume, recorded in an app table by `onUpload`.

The backend needs a bucket: set the component's env vars on the Convex
deployment, in `packages/backend`:

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
| `bun run --cwd packages/convex-s3 test:providers` | The provider suite: the component's flows against any S3-compatible endpoint named by the `S3_*` env vars (CI runs it on MinIO, and on R2 when the repo has `R2_*` secrets) |
| `bun run typecheck` | `tsc` (TypeScript 7) in every package |
| `bun run check` / `check:fix` | Biome lint and format |
| `bun run build` | Production build of the example app |
| `bun run --cwd packages/convex-s3 codegen` | Regenerate the component's `_generated` after changing its functions |
| `bun run --cwd packages/convex-s3 build` | Build the package to `dist` (Turbo does it before tests, typechecks and `bun dev`) |

A lefthook pre-commit hook runs Biome on staged files.

## Stack

Bun and Turborepo; TypeScript 7; Convex; TanStack Start with React 19 for the
example; shadcn/ui on Base UI with Tailwind CSS 4; Vitest with convex-test;
Biome. Started from [cstack](https://github.com/christianstamati/cstack).

The examples use the package from the workspace (`workspace:*`), built to
`dist` like the published one. Releasing: bump `version` in
`packages/convex-s3/package.json`, then `npm publish` there (`prepack`
builds it).
