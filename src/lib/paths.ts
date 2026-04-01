import path from "node:path";

const root = process.cwd();

export const storageRoot = path.join(root, "storage");
export const uploadDir = path.join(storageRoot, "uploads");
export const outputDir = path.join(storageRoot, "outputs");
export const tempDir = path.join(storageRoot, "tmp");
export const sourcesDir = path.join(storageRoot, "sources");
export const jobsDir = path.join(storageRoot, "jobs");
export const framesDir = path.join(storageRoot, "frames");
export const benchmarksDir = path.join(storageRoot, "benchmarks");
export const longformDir = path.join(storageRoot, "longform");
