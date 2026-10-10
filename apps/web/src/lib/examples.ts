import {
  IconCloudUpload,
  IconFolders,
  type TablerIcon,
} from "@tabler/icons-react"

export type Example = {
  slug: "uploads" | "drive"
  to: "/examples/uploads" | "/examples/drive"
  title: string
  description: string
  /** What of the component it exercises. */
  shows: string[]
  icon: TablerIcon
}

/** Every example, in the order the home and examples pages list them. */
export const EXAMPLES: Example[] = [
  {
    slug: "drive",
    to: "/examples/drive",
    title: "Drive",
    description:
      "A Google Drive clone where folders are S3 prefixes: browse, create, rename, move and delete them, and drop files in.",
    shows: [
      "Live folder listings (listFolder)",
      "Folder markers",
      "Moving a prefix key by key",
      "Deleting a prefix",
      "Uploads under their own names",
    ],
    icon: IconFolders,
  },
  {
    slug: "uploads",
    to: "/examples/uploads",
    title: "Uploads",
    description:
      "Files go from the browser straight to S3, in parts above 8 MB, with progress and cancel.",
    shows: [
      "Single and multipart uploads",
      "Resume and cancel",
      "onUpload into an app table",
      "Presigned downloads",
    ],
    icon: IconCloudUpload,
  },
]
