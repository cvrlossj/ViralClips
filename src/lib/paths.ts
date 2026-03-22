import path from "node:path";

const root = process.cwd();

export const storageRoot = path.join(root, "storage");
export const uploadDir = path.join(storageRoot, "uploads");
export const outputDir = path.join(storageRoot, "outputs");
export const tempDir = path.join(storageRoot, "tmp");
