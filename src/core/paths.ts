import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Store a media path the way the manifest wants it: relative to the project
 * root with forward slashes when the file is inside the project, absolute
 * when it lives elsewhere (renders often do).
 */
export function toManifestPath(root: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

/** Turn a manifest path back into an absolute path on disk. */
export function fromManifestPath(root: string, file: string): string {
  return isAbsolute(file) ? file : resolve(root, ...file.split("/"));
}
