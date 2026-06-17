/** Trigger a browser download of an in-memory string as a file. Client-only. */
export function downloadString(filename: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
