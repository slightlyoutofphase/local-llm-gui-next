import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface StaticAssetDescriptor {
  importName: string;
  importPath: string;
  requestPath: string;
}

const projectRoot = process.cwd();
const staticOutDirectory = path.join(projectRoot, "out");
const outputFilePath = path.join(projectRoot, "src", "generated", "embeddedStatic.generated.ts");

await ensureStaticOutDirectoryExists(staticOutDirectory);

const assetRelativePaths = await collectRelativeAssetPaths(staticOutDirectory);
const assetDescriptors = assetRelativePaths.map((assetRelativePath, index) => ({
  importName: `embeddedStaticAsset${index}`,
  importPath: toImportSpecifier(path.join(staticOutDirectory, assetRelativePath), path.dirname(outputFilePath)),
  requestPath: `/${assetRelativePath.replaceAll(path.sep, "/")}`,
}));

await mkdir(path.dirname(outputFilePath), { recursive: true });
await writeFile(outputFilePath, createGeneratedSource(assetDescriptors), "utf8");

console.log(`Generated embedded static manifest with ${assetDescriptors.length} assets.`);

/**
 * Ensures the frontend static export directory exists before generating imports.
 *
 * @param directoryPath Absolute path to the static export directory.
 * @returns A promise that resolves once the directory is verified.
 * @throws When the frontend static export directory is missing.
 */
async function ensureStaticOutDirectoryExists(directoryPath: string): Promise<void> {
  const directoryStats = await stat(directoryPath).catch(() => null);

  if (!directoryStats?.isDirectory()) {
    throw new Error(
      "Missing frontend static export directory. Run `npm run build:frontend` before `npm run build:backend`.",
    );
  }
}

/**
 * Collects all file paths under the static export directory relative to that directory.
 *
 * @param rootDirectory Absolute path to the static export directory.
 * @returns Relative asset paths sorted for stable generation output.
 */
async function collectRelativeAssetPaths(rootDirectory: string): Promise<string[]> {
  const discoveredPaths: string[] = [];

  await walkDirectory(rootDirectory, rootDirectory, discoveredPaths);

  return discoveredPaths.sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
}

/**
 * Recursively walks a directory and records relative file paths.
 *
 * @param rootDirectory Absolute root directory used for relative path calculation.
 * @param currentDirectory Absolute current directory being traversed.
 * @param accumulator Mutable list of relative asset paths.
 * @returns A promise that resolves when traversal completes.
 */
async function walkDirectory(
  rootDirectory: string,
  currentDirectory: string,
  accumulator: string[],
): Promise<void> {
  const directoryEntries = await readdir(currentDirectory, { withFileTypes: true });

  for (const directoryEntry of directoryEntries) {
    const entryPath = path.join(currentDirectory, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      await walkDirectory(rootDirectory, entryPath, accumulator);
      continue;
    }

    if (!directoryEntry.isFile()) {
      continue;
    }

    accumulator.push(path.relative(rootDirectory, entryPath));
  }
}

/**
 * Converts an absolute asset path to a normalized import specifier relative to a source file.
 *
 * @param absoluteTargetPath Absolute target asset path.
 * @param fromDirectory Absolute directory containing the generated source file.
 * @returns A normalized relative import specifier.
 */
function toImportSpecifier(absoluteTargetPath: string, fromDirectory: string): string {
  const relativeImportPath = path.relative(fromDirectory, absoluteTargetPath).replaceAll(path.sep, "/");

  return relativeImportPath.startsWith(".") ? relativeImportPath : `./${relativeImportPath}`;
}

/**
 * Creates the generated TypeScript module that imports each frontend asset with `type: "file"`.
 *
 * @param assetDescriptors Descriptors for every frontend static asset.
 * @returns The generated TypeScript source text.
 */
function createGeneratedSource(assetDescriptors: StaticAssetDescriptor[]): string {
  const importLines = assetDescriptors.map(
    (descriptor) =>
      `// @ts-ignore Bun resolves file-attribute asset imports during compile.\nimport ${descriptor.importName} from "${descriptor.importPath}" with { type: "file" };`,
  );
  const mappingLines = assetDescriptors.map(
    (descriptor) =>
      `  { requestPath: ${JSON.stringify(descriptor.requestPath)}, filePath: ${descriptor.importName} },`,
  );

  return [
    "/**",
    " * Represents a frontend static asset that can be embedded into a compiled Bun executable.",
    " */",
    "export interface EmbeddedStaticFile {",
    "  /** The HTTP request pathname used to serve the asset. */",
    "  requestPath: string;",
    "  /** The Bun-resolved file path for the asset on disk or inside `$bunfs`. */",
    "  filePath: string;",
    "}",
    "",
    ...importLines,
    importLines.length > 0 ? "" : "",
    "/**",
    " * Build-generated list of embedded frontend static assets.",
    " */",
    "export const EMBEDDED_STATIC_FILES: EmbeddedStaticFile[] = [",
    ...mappingLines,
    "];",
    "",
  ].join("\n");
}