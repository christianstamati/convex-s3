/** A file to upload, and the folder it goes in relative to the open one. */
export type FolderFile = { file: File; folder: string }

function readEntries(reader: FileSystemDirectoryReader) {
  return new Promise<FileSystemEntry[]>((resolve, reject) =>
    reader.readEntries(resolve, reject)
  )
}

function fileOf(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject))
}

async function walk(entry: FileSystemEntry, folder: string, out: FolderFile[]) {
  if (entry.isFile) {
    out.push({ file: await fileOf(entry as FileSystemFileEntry), folder })
    return
  }
  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const inside = `${folder}${entry.name}/`
  // readEntries returns batches until an empty one.
  for (
    let batch = await readEntries(reader);
    batch.length > 0;
    batch = await readEntries(reader)
  ) {
    for (const child of batch) await walk(child, inside, out)
  }
}

/** The files of a drop, folders walked so their structure is kept. */
export async function droppedFiles(data: DataTransfer): Promise<FolderFile[]> {
  const entries = Array.from(data.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => entry != null)
  if (entries.length === 0) {
    return Array.from(data.files, (file) => ({ file, folder: "" }))
  }
  const out: FolderFile[] = []
  for (const entry of entries) await walk(entry, "", out)
  return out
}

/** The files of an `<input webkitdirectory>`: their folders from the path. */
export function pickedFiles(files: FileList): FolderFile[] {
  return Array.from(files, (file) => {
    const relative = file.webkitRelativePath
    const cut = relative.lastIndexOf("/")
    return { file, folder: cut === -1 ? "" : relative.slice(0, cut + 1) }
  })
}
