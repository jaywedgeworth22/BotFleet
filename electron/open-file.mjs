import { resolveSavablePath } from "./save-file.mjs";

const OUTSIDE_MESSAGE = "Only files created by your bots can be opened";

// Same ~/.botfleet root as save-file.  Renderer-supplied paths (markdown
// links, file:// URLs) must not reach shell.openPath / showItemInFolder
// unless they resolve inside that tree as a regular file.
export async function resolveOpenablePath(rawPath, options = {}) {
  return resolveSavablePath(rawPath, { ...options, outsideMessage: OUTSIDE_MESSAGE });
}
