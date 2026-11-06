/** Saves `text` as a file download in the browser. */
export function downloadText(text: string, fileName: string, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves `data` as a pretty-printed JSON file download. */
export function downloadJson(data: unknown, fileName: string) {
  downloadText(JSON.stringify(data, null, 2), fileName);
}
