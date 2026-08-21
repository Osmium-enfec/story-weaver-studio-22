export function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      // Screen recordings are video; audio-only webm is rare in this app.
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

export function extFromUrl(url: string, fallback: string): string {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+)/);
    if (m) {
      const mime = m[1];
      if (mime.includes("png")) return "png";
      if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
      if (mime.includes("webp")) return "webp";
      if (mime.includes("mpeg")) return "mp3";
      if (mime.includes("wav")) return "wav";
      if (mime.includes("webm")) return "webm";
      if (mime.includes("ogg")) return "ogg";
      if (mime.includes("mp4")) return "mp4";
      if (mime.includes("quicktime")) return "mov";
    }
  }
  return fallback;
}
