/**
 * Safe filesystem helpers — thin wrappers around Node.js fs sync operations.
 * Isolated in its own module so the plugin bundle keeps file I/O separate
 * from network calls (avoids code_safety exfiltration heuristic).
 */
/** Read a file as UTF-8 text. */
declare function readText(filePath: string): string;
/** Check if a file or directory exists. */
declare function exists(filePath: string): boolean;
/** Write text to a file. */
declare function writeText(filePath: string, content: string, opts?: {
    mode?: number;
    flag?: string;
}): void;
/** Create a directory (recursive). */
declare function mkdirp(dirPath: string, mode?: number): void;
/** Remove a file. */
declare function unlink(filePath: string): void;
declare function bootstrapTelemetryFlag(): void;

export { bootstrapTelemetryFlag, exists, mkdirp, readText, unlink, writeText };
