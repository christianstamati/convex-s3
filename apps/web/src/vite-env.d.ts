interface ImportMetaEnv {
  /** Convex deployment URL, written by `convex dev` / injected by `convex deploy`. */
  readonly VITE_CONVEX_URL: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
