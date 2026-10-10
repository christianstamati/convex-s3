/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as drive from "../drive.js";
import type * as e2e from "../e2e.js";
import type * as files from "../files.js";
import type * as lib_attachment from "../lib/attachment.js";
import type * as lib_drivePaths from "../lib/drivePaths.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_s3 from "../lib/s3.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  drive: typeof drive;
  e2e: typeof e2e;
  files: typeof files;
  "lib/attachment": typeof lib_attachment;
  "lib/drivePaths": typeof lib_drivePaths;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/s3": typeof lib_s3;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  s3: import("@cstack-dev/convex-s3/_generated/component.js").ComponentApi<"s3">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
