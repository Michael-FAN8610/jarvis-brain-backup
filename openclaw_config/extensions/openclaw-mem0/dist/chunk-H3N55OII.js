// fs-safe.ts
import * as fs from "fs";
function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}
function exists(filePath) {
  return fs.existsSync(filePath);
}
function writeText(filePath, content, opts) {
  fs.writeFileSync(filePath, content, opts);
}
function mkdirp(dirPath, mode) {
  fs.mkdirSync(dirPath, { mode, recursive: true });
}
function unlink(filePath) {
  fs.unlinkSync(filePath);
}
function bootstrapTelemetryFlag() {
  const val = process.env.MEM0_TELEMETRY;
  if (val !== void 0) {
    globalThis.__mem0_telemetry_override = val;
  }
}

export {
  readText,
  exists,
  writeText,
  mkdirp,
  unlink,
  bootstrapTelemetryFlag
};
//# sourceMappingURL=chunk-H3N55OII.js.map