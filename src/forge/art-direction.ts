/** The default size an Art Direction declares on a `Default size: WxH` line, or null when it has none. */
export function parseDefaultSize(artDirection: string): { width: number; height: number } | null {
  const m = /^[ \t>*_-]*Default size\**[ \t]*:[ \t]*\**[ \t]*(\d+)[ \t]*[x×][ \t]*(\d+)/im.exec(artDirection);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 1 && height >= 1 ? { width, height } : null;
}

/**
 * The repository paths of PNG images an Art Direction mentions (its reference images), once each, in order of
 * appearance. Links, absolute paths and paths that leave the repository are not repository paths. The caller keeps the
 * ones that exist.
 */
export function parseReferences(artDirection: string): string[] {
  const found: string[] = [];
  for (const m of artDirection.matchAll(/(?:^|[\s`(\[<"'])((?:[\w.-]+\/)*[\w.-]+\.png)(?![\w-]|\.\w)/gim)) {
    const path = m[1]!;
    if (path.split("/").some((part) => part === ".." || part === ".") || found.includes(path)) continue;
    found.push(path);
  }
  return found;
}
