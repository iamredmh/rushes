import { open } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { RushesError } from "../core/errors.js";
import { imageSize } from "../core/imageSize.js";
import { isPictureSize } from "../core/formats.js";
import type { PictureInput } from "../core/visuals.js";
import { viaLink } from "./links.js";

// §25.5: the pictures a visual is made of are read here, and only here: a picture is a real file inside the project, of a
// type a browser shows inline, whose size can be read from its first bytes. Everything else is refused, naming the file.

const PICTURE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** A jpeg's frame header can sit behind large metadata, so more than a few kilobytes are read. */
const HEAD_BYTES = 262_144;

const refuse = (code: string, message: string, file: string): never => {
  throw new RushesError(message, 400, code, { file });
};

/** `file` as a project-relative path with forward slashes, or null when it is outside the project. */
function inProject(root: string, file: string): string | null {
  const abs = isAbsolute(file) ? normalize(file) : resolve(root, file);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export async function readPicture(root: string, file: string): Promise<PictureInput> {
  const rel = inProject(root, file.trim());
  if (rel === null || (await viaLink(root, rel))) return refuse("not_in_project", `${file} is not a plain file inside the project folder. Visuals are made of pictures kept in the project (not links, and not elsewhere).`, file);
  if (!PICTURE_EXT.test(rel)) return refuse("not_an_image", `${file} is not a png, jpg, webp or gif picture.`, file);
  let head: Buffer;
  try {
    const fh = await open(resolve(root, ...rel.split("/")), "r");
    try {
      if (!(await fh.stat()).isFile()) return refuse("not_an_image", `${file} is not a file.`, file);
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch (e) {
    if (e instanceof RushesError) throw e;
    return refuse("unreadable", `${file} could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}).`, file);
  }
  const size = imageSize(head);
  if (!size || !isPictureSize(size.width, size.height)) return refuse("not_an_image", `${file} is not a picture Rushes can read the size of.`, file);
  return { file: rel, width: size.width, height: size.height };
}
