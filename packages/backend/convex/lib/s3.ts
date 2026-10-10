import { S3 } from "convex-s3"
import { components } from "../_generated/api"

/** The bucket, through the convex-s3 component. Shared by the examples. */
export const s3 = new S3(components.s3)
