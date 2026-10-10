import {
  IconDotsVertical,
  IconFolder,
  IconFolderSymlink,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { useState } from "react"
import { DeleteFolderDialog } from "@/components/drive/DeleteFolderDialog"
import { MoveDialog } from "@/components/drive/MoveDialog"
import { RenameDialog } from "@/components/drive/RenameDialog"

type Dialog = "rename" | "move" | "delete" | null

/** A subfolder: opens on click, with rename, move and delete. */
export function DriveFolderRow({
  folder,
}: {
  folder: { name: string; path: string }
}) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const target = {
    kind: "folder" as const,
    path: folder.path,
    name: folder.name,
  }
  const onOpenChange = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <li className="flex items-center gap-3 py-2">
      <Link
        to="/examples/drive"
        search={{ path: folder.path }}
        className="flex min-w-0 flex-1 items-center gap-3 text-sm hover:underline"
      >
        <IconFolder className="size-5 shrink-0 text-muted-foreground" />
        <span className="truncate">{folder.name}</span>
      </Link>
      <span className="hidden w-20 text-right text-muted-foreground text-sm sm:block">
        —
      </span>
      <span className="hidden w-28 text-muted-foreground text-sm sm:block">
        —
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${folder.name}`}
            />
          }
        >
          <IconDotsVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDialog("rename")}>
            <IconPencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("move")}>
            <IconFolderSymlink />
            Move to…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDialog("delete")}
          >
            <IconTrash />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        target={target}
        open={dialog === "rename"}
        onOpenChange={onOpenChange}
      />
      <MoveDialog
        target={target}
        open={dialog === "move"}
        onOpenChange={onOpenChange}
      />
      <DeleteFolderDialog
        folder={folder}
        open={dialog === "delete"}
        onOpenChange={onOpenChange}
      />
    </li>
  )
}
