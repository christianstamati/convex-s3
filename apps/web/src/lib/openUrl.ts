/**
 * Opens a URL that is still being fetched in a new tab. The tab opens now,
 * inside the click, so popup blockers allow it; the URL follows.
 */
export async function openInNewTab(url: Promise<string>) {
  const tab = window.open("", "_blank")
  try {
    const resolved = await url
    if (tab) {
      tab.opener = null
      tab.location.href = resolved
    } else {
      window.location.assign(resolved)
    }
  } catch (error) {
    tab?.close()
    throw error
  }
}

/** Downloads from a URL whose response is an attachment. */
export async function download(url: Promise<string>) {
  window.location.assign(await url)
}
