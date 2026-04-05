const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads')
);
const QUARANTINE_ROOT = path.resolve(
  process.env.RETENTION_ATTACHMENTS_QUARANTINE_DIR ||
    path.join(UPLOAD_ROOT, '_retention_quarantine')
);

function buildOrphanQuarantineRunPaths(runId) {
  const runRoot = path.join(QUARANTINE_ROOT, 'orphans', String(runId || '').trim());
  const filesRoot = path.join(runRoot, 'files');
  const manifestPath = path.join(runRoot, 'manifest.json');
  return {
    runRoot,
    filesRoot,
    manifestPath,
  };
}

function normalizeFsPath(value) {
  return path.resolve(String(value || ''));
}

function relativeFrom(basePath, targetPath) {
  return path.relative(basePath, targetPath);
}

function isPathInside(basePath, targetPath) {
  const relative = relativeFrom(basePath, normalizeFsPath(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isWithinUploadRoot(filePath) {
  return isPathInside(UPLOAD_ROOT, filePath);
}

function isWithinQuarantineRoot(filePath) {
  return isPathInside(QUARANTINE_ROOT, filePath);
}

async function ensureDirectory(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function walkFilesRecursively(rootPath, options = {}) {
  const cutoff = options.cutoff instanceof Date ? options.cutoff : new Date();
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 10000;
  const excludeRoots = Array.isArray(options.excludeRoots)
    ? options.excludeRoots.map((value) => normalizeFsPath(value))
    : [];

  const collected = [];
  let truncated = false;
  let skippedExcludedDirs = 0;

  async function visit(currentPath) {
    if (truncated) {
      return;
    }

    const normalizedCurrent = normalizeFsPath(currentPath);
    if (excludeRoots.some((value) => isPathInside(value, normalizedCurrent))) {
      skippedExcludedDirs += 1;
      return;
    }

    const entries = await fs.promises.readdir(normalizedCurrent, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) {
        return;
      }

      const absolutePath = path.join(normalizedCurrent, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.promises.stat(absolutePath);
      if (stat.mtime.getTime() > cutoff.getTime()) {
        continue;
      }

      collected.push({
        absolute_path: absolutePath,
        relative_path: relativeFrom(UPLOAD_ROOT, absolutePath),
        mtime: stat.mtime,
        size_bytes: stat.size,
      });

      if (collected.length >= limit) {
        truncated = true;
      }
    }
  }

  if (!fs.existsSync(rootPath)) {
    return {
      files: [],
      truncated: false,
      skippedExcludedDirs: 0,
      uploadRootMissing: true,
    };
  }

  await visit(rootPath);

  return {
    files: collected,
    truncated,
    skippedExcludedDirs,
    uploadRootMissing: false,
  };
}

module.exports = {
  QUARANTINE_ROOT,
  UPLOAD_ROOT,
  buildOrphanQuarantineRunPaths,
  ensureDirectory,
  isPathInside,
  isWithinQuarantineRoot,
  isWithinUploadRoot,
  normalizeFsPath,
  relativeFrom,
  walkFilesRecursively,
};
