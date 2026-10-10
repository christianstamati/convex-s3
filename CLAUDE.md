# Project conventions

Bun + Turborepo monorepo. See README.md for commands, and `packages/convex-s3/README.md` for the component's API.

- `packages/convex-s3`: the component, published to npm as `@cstack-dev/convex-s3` (always import it by that name). `bun run build` compiles `src` to `dist`, which its `exports` point at; Turbo builds it before anything that depends on it, and `bun dev` rebuilds it on change. Its README is the user docs and `llms.txt` the guide for coding agents: keep both in step with the API. `src/component` is the Convex component (`convex.config.ts` declares its env vars; `uploads.ts` the upload flow, `lib.ts` metadata, URLs and deletes, `objects.ts` actions), `src/shared` plain TypeScript with no Convex imports (`sigv4.ts` signing on Web Crypto, `s3.ts` one function per S3 operation, `config.ts`, `keys.ts`, `xml.ts`, `md5.ts`), `src/client` the app-side `S3` class and `clientApi()`, `src/react` `useUploadFile`, `src/testing` `FakeS3` and `register`.
- `packages/backend`: the examples' Convex functions, each a module using the shared `S3` instance (`convex/lib/s3.ts`): `files.ts` (Uploads) and `drive.ts` (Drive: folders are prefixes under `drive/`, path rules in `convex/lib/drivePaths.ts`, pure and tested). `convex/e2e.ts` runs end-to-end checks against the real bucket (`bunx convex run e2e:run`). Imported by the web app as `@workspace/backend/api`.
- `apps/web`: the examples' web app, TanStack Start (React 19), file routes in `src/routes`. Each example is a route under `/examples/<slug>` and an entry in `src/lib/examples.ts`, which the home page and `/examples` list; add both for a new one.
- `packages/ui`: shadcn/ui components (Base UI primitives, Tailwind CSS 4), imported as `@workspace/ui/components/<name>`

Before finishing a change, run `bun run check:fix`, `bun run typecheck` and `bun run test`, and fix every error. Changes to the component that touch S3's behaviour also run `bun run --cwd packages/convex-s3 test:providers` against a real bucket (CI runs it on MinIO).

## Backend (Convex)

- Every public or internal function declares `args` and `returns` validators. Use `doc(schema, "table")` from `convex-helpers/validators` for document return types.
- Query with indexes (`withIndex`), never `filter` over a whole table.
- Throw `ConvexError("message")` for errors the user should see; other errors are redacted in production.
- Test with convex-test: `setup()` from `convex/test.setup.ts`. Test files are `*.test.ts` next to the code.
- Deployment env vars are validated in `convex/convex.config.ts`. Add new required ones there.

## The component

- Credentials live only in the component's env (bound by the app with `app.use(s3, { env })`), and every signature is made inside component functions. Never pass secrets as arguments, store them in tables or log presigned URLs.
- Keep `src/shared` free of Convex imports, so it stays testable on its own. Signing is SigV4 on Web Crypto (`sigv4.test.ts` checks AWS's worked examples); don't add the AWS SDK.
- S3 operations that touch the network run in actions; presigning runs anywhere. Component functions that call their own module through `ctx.run*` need explicit return types (circular types otherwise).
- The browser never picks a key: `clientApi()` builds `<prefix><uuid>/<file name>` after `checkUpload`, and each public function refuses to run without its check callback.
- Test with `FakeS3` (`vi.stubGlobal("fetch", s3.fetch)` and its `env()`): it checks signatures, expiry, signed sizes and policies like S3. Change a behaviour, add a test there and, when it depends on S3 itself, a check in `packages/backend/convex/e2e.ts`.
- After changing component functions, run `bun run --cwd packages/convex-s3 codegen` (regenerates `src/component/_generated`), then `bunx convex codegen` in `packages/backend`.

## Web

- Read data with `useSuspenseQuery(convexQuery(api.module.fn, args))` or `useQuery(...)`: these are live subscriptions.
- Write with `useMutation({ mutationFn: useConvexMutation(api.module.fn), onError: toastError })` (`toastError` is in `@/lib/errors`).
- Confirm creates and deletes with a short `toast.success("File deleted")`. Put the callback on `useMutation` when the component unmounts on success (a deleted row), since `mutate()` callbacks don't run after unmount.
- Show empty states (no data, not found) with `Empty` from `@workspace/ui/components/empty`.
- Add UI components with `bun run ui:add <name>` rather than writing them by hand. Files in `packages/ui/src/components` are vendored from shadcn; keep edits minimal.
- Import app code with the `@/` alias (`apps/web/src`).

### Components

- One component per file in `apps/web/src/components/<feature>/`, and the file is named after the component in PascalCase: `FileList.tsx` exports `FileList`. Biome enforces the file names. Feature folders are lowercase (`drive`, `files`, `uploads`, `examples`, `layout`).
- Name components after what they render: `FileList` renders files, `UploadCard` uploads them, `InvoiceTable` renders a table.
- Components fetch their own data and own their mutations, so a page doesn't pass query results or callbacks down.
- Route files in `src/routes` keep route config (search params, `head`, `ssr`) and a page component that only lays out feature components.
- shadcn primitives in `packages/ui` keep their kebab-case names.

## Design system

- Style a component through its props (`variant`, `size`), not `className`. Call sites may only add layout classes (margin, width, flex, position). `Card`, and any component whose name ends in `Content`, `Header` or `Footer` (`CardContent`, `DialogFooter`), also accepts spacing.
- Colors come from theme tokens (`bg-primary`, `text-muted-foreground`), never the Tailwind palette (`bg-zinc-100`).
- No arbitrary values (`p-[13px]`, `w-[420px]`). Use the scale (`p-3.25`, `w-105`).
- No inline `style`, and no class strings built at runtime on components.
- When a design needs a look no variant provides, add a variant (or a token in `packages/ui/src/styles/globals.css`) and call it out as a design decision.

## Tooling

- TypeScript 7: `tsc` is the Go-based compiler. There is no TypeScript JS API, so avoid tools that need one.
- Biome replaces ESLint and Prettier. lefthook runs it on staged files before each commit.
- Generated files, don't edit: `apps/web/src/routeTree.gen.ts`, `packages/backend/convex/_generated/`, `packages/convex-s3/src/component/_generated/`.
