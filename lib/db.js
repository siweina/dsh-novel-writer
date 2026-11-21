/**
 * dsh-novel-writer — 本地 SQLite 缓存层（Wave 1A）
 *
 * 使用 Node 22.13+ 内置 `node:sqlite`（`DatabaseSync`）管理 `<root>/.novel-writer/cache.sqlite`。
 * 架构边界：只依赖 Node 内置模块与 `./log.js`（事件日志），绝不导入 `core/state.js` 或业务模块，
 * 避免与 core 层产生循环依赖。
 *
 * 隐私与安全约束：
 * - `readOnly: true`（或只读 helper）在库文件不存在时不创建目录或空数据库，损坏时安全返回 `null`。
 * - 读写模式启用 WAL + `busy_timeout = 5000` + `synchronous = NORMAL`，并在检测到 `SQLITE_CORRUPT` /
 *   `SQLITE_NOTADB` 时自动清理损坏文件、通过 `logEvent("cache", ...)` 记录脱敏告警并重建后重试一次。
 * - `inspectLibraryDb` / `inspectCaliberCache` / 日志均只暴露计数、版本与口径等元数据，绝不泄漏书名或正文。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logEvent } from "./log.js";

export const LIBRARY_DB_SCHEMA_VERSION = 1;

const REQUIRED_TABLES = Object.freeze([
  "meta",
  "chapter_metrics",
  "analysis_cache",
  "embedding_meta",
  "embedding_chunks",
  "audit_vectors"
]);

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chapter_metrics (
    book TEXT NOT NULL,
    chapter TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    caliber TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    scene_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book, chapter)
  );
  CREATE TABLE IF NOT EXISTS analysis_cache (
    cache_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    book TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    caliber TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS embedding_meta (
    book TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS embedding_chunks (
    book TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    chapter TEXT NOT NULL,
    offset INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (book, chunk_idx)
  );
  CREATE TABLE IF NOT EXISTS audit_vectors (
    vec_key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    last_used INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chapter_metrics_caliber ON chapter_metrics(caliber);
  CREATE INDEX IF NOT EXISTS idx_analysis_cache_book ON analysis_cache(book);
  CREATE INDEX IF NOT EXISTS idx_analysis_cache_caliber ON analysis_cache(caliber);
  CREATE INDEX IF NOT EXISTS idx_audit_vectors_last_used ON audit_vectors(last_used);
`;

/**
 * 返回书库 SQLite 缓存文件路径：`<resolvedRoot>/.novel-writer/cache.sqlite`。
 */
export function libraryDbPath(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("libraryDbPath: root 必须是非空路径字符串");
  }
  return join(resolve(root), ".novel-writer", "cache.sqlite");
}

/**
 * 将 `Float32Array` 或 `number[]` 编码为紧凑的 `Uint8Array` BLOB。
 */
export function encodeFloat32Blob(vec) {
  if (vec instanceof Float32Array) {
    return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  }
  if (Array.isArray(vec) || ArrayBuffer.isView(vec)) {
    const f32 = Float32Array.from(vec);
    return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  }
  throw new TypeError("encodeFloat32Blob: vec 必须是 Float32Array 或 number[]");
}

/**
 * 将 SQLite BLOB（`Uint8Array` / `Buffer` / TypedArray）解码为 `Float32Array`。
 * 处理非 4 字节对齐的 `byteOffset`，校验字节长度与期望维度，非法时返回 `null`。
 */
export function decodeFloat32Blob(blob, expectedDim) {
  if (!blob) return null;
  let u8;
  if (blob instanceof Uint8Array) {
    u8 = blob;
  } else if (ArrayBuffer.isView(blob)) {
    u8 = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  } else if (blob instanceof ArrayBuffer) {
    u8 = new Uint8Array(blob);
  } else {
    return null;
  }
  if (u8.byteLength % 4 !== 0) return null;
  if (expectedDim !== undefined && expectedDim !== null) {
    if (!Number.isInteger(expectedDim) || expectedDim < 0 || u8.byteLength !== expectedDim * 4) {
      return null;
    }
  }
  if (u8.byteOffset % 4 !== 0) {
    u8 = new Uint8Array(u8);
  }
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function isSqliteCorruptionError(err) {
  if (!err || typeof err !== "object") return false;
  const baseErrcode = typeof err.errcode === "number" ? (err.errcode & 0xff) : null;
  // SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26
  if (baseErrcode === 11 || baseErrcode === 26) return true;
  const text = [err.code, err.errstr, err.message]
    .filter((v) => typeof v === "string")
    .join(" ");
  return /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database|malformed database schema/i.test(text);
}

function isSchemaReady(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set(rows.map((r) => r.name));
  for (const required of REQUIRED_TABLES) {
    if (!names.has(required)) return false;
  }
  const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return metaRow?.value === String(LIBRARY_DB_SCHEMA_VERSION);
}

function ensureSchema(db) {
  if (isSchemaReady(db)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (isSchemaReady(db)) {
      db.exec("COMMIT");
      return;
    }
    const hasMeta = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (hasMeta) {
      const verRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      if (verRow && verRow.value !== String(LIBRARY_DB_SCHEMA_VERSION)) {
        // 缓存库 schema 版本不匹配：全部重建（cache.sqlite 只存可再生派生数据）
        for (const table of [...REQUIRED_TABLES].reverse()) {
          db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
      }
    }
    db.exec(SCHEMA_DDL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(LIBRARY_DB_SCHEMA_VERSION)
    );
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
    throw err;
  }
}

function removeDbFiles(dbPath) {
  for (const target of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + "-journal"]) {
    try {
      rmSync(target, { force: true });
    } catch {
      /* 清理损坏残留尽力而为 */
    }
  }
}

function openAndRunRw(dbPath, fn) {
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    ensureSchema(db);
    return fn(db);
  } finally {
    if (db) {
      try { db.close(); } catch { /* 忽略关闭错误 */ }
    }
  }
}

/**
 * 打开书库 SQLite 缓存并执行同步回调 `fn(db)`，确保 `db.close()` 在 `finally` 中释放。
 *
 * - `opts.readOnly === true`：库不存在、schema 不匹配或文件损坏时直接返回 `null`，绝不创建目录或修改磁盘。
 * - 默认（读写模式）：自动建目录、配置 WAL / busy_timeout / synchronous、建表并校验 schema；
 *   遇到损坏错误时删除损坏库及 `-wal`/`-shm` 伴随文件，记录隐私安全日志后重建并重试一次。
 */
export function withLibraryDb(root, fn, opts = {}) {
  const dbPath = libraryDbPath(root);

  if (opts?.readOnly === true) {
    if (!existsSync(dbPath)) return null;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      if (!isSchemaReady(db)) return null;
      return fn(db);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    } finally {
      if (db) {
        try { db.close(); } catch { /* 忽略关闭错误 */ }
      }
    }
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    return openAndRunRw(dbPath, fn);
  } catch (err) {
    if (!isSqliteCorruptionError(err)) throw err;
    removeDbFiles(dbPath);
    const reason = String(err?.errstr || err?.message || err?.code || "corrupt")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 100);
    logEvent("cache", {
      action: "sqlite_recover",
      level: "warn",
      source: "lib/db",
      file: dbPath,
      code: typeof err?.code === "string" ? err.code : undefined,
      detail: `sqlite_recover (${reason})`
    });
    return openAndRunRw(dbPath, fn);
  }
}

/**
 * 读取指定作品的逐章量化缓存。默认 `readOnly: true`（库不存在时不创建文件）。
 * 返回 `{ rows, byChapter }`，每条含 `chapter, content_hash, size, caliber, metrics_json, scene_json, updated_at`。
 */
export function readChapterMetrics(root, book, opts = {}) {
  const empty = () => ({ rows: [], byChapter: new Map() });
  if (typeof book !== "string" || book === "") return empty();
  const readOnly = opts?.readOnly !== false;
  const caliber = typeof opts?.caliber === "string" && opts.caliber !== "" ? opts.caliber : null;

  const result = withLibraryDb(root, (db) => {
    const rawRows = caliber !== null
      ? db.prepare(
        "SELECT chapter, content_hash, size, caliber, metrics_json, scene_json, updated_at "
        + "FROM chapter_metrics WHERE book = ? AND caliber = ? ORDER BY chapter ASC"
      ).all(book, caliber)
      : db.prepare(
        "SELECT chapter, content_hash, size, caliber, metrics_json, scene_json, updated_at "
        + "FROM chapter_metrics WHERE book = ? ORDER BY chapter ASC"
      ).all(book);

    const rows = [];
    const byChapter = new Map();
    for (const r of rawRows) {
      const row = {
        chapter: r.chapter,
        content_hash: r.content_hash,
        size: r.size,
        caliber: r.caliber,
        metrics_json: r.metrics_json,
        scene_json: r.scene_json ?? null,
        updated_at: r.updated_at
      };
      rows.push(row);
      byChapter.set(row.chapter, row);
    }
    return { rows, byChapter };
  }, { readOnly });

  return result ?? empty();
}

/**
 * 事务性批量 upsert 指定作品的逐章缓存，并可选清理已从正文中删除的章节行。
 */
export function writeChapterMetrics(root, book, rows, pruneMissingChapters = true) {
  if (typeof book !== "string" || book === "") {
    throw new Error("writeChapterMetrics: book 必须是非空字符串");
  }
  const list = Array.isArray(rows) ? rows : [];
  const now = Date.now();
  const normalized = list.map((r) => ({
    chapter: String(r.chapter),
    content_hash: String(r.content_hash ?? ""),
    size: Number.isFinite(r.size) ? Math.trunc(r.size) : 0,
    caliber: String(r.caliber ?? ""),
    metrics_json: typeof r.metrics_json === "string"
      ? r.metrics_json
      : JSON.stringify(r.metrics_json ?? r.metrics ?? {}),
    scene_json: r.scene_json === undefined || r.scene_json === null
      ? null
      : (typeof r.scene_json === "string" ? r.scene_json : JSON.stringify(r.scene_json)),
    updated_at: Number.isFinite(r.updated_at) ? Math.trunc(r.updated_at) : now
  }));

  return withLibraryDb(root, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = db.prepare(
        "INSERT INTO chapter_metrics (book, chapter, content_hash, size, caliber, metrics_json, scene_json, updated_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        + "ON CONFLICT(book, chapter) DO UPDATE SET "
        + "content_hash = excluded.content_hash, "
        + "size = excluded.size, "
        + "caliber = excluded.caliber, "
        + "metrics_json = excluded.metrics_json, "
        + "scene_json = excluded.scene_json, "
        + "updated_at = excluded.updated_at"
      );
      for (const item of normalized) {
        upsert.run(
          book,
          item.chapter,
          item.content_hash,
          item.size,
          item.caliber,
          item.metrics_json,
          item.scene_json,
          item.updated_at
        );
      }

      let pruned = 0;
      if (pruneMissingChapters) {
        if (normalized.length === 0) {
          pruned = db.prepare("DELETE FROM chapter_metrics WHERE book = ?").run(book).changes;
        } else {
          const keep = new Set(normalized.map((item) => item.chapter));
          const existing = db.prepare("SELECT chapter FROM chapter_metrics WHERE book = ?").all(book);
          const del = db.prepare("DELETE FROM chapter_metrics WHERE book = ? AND chapter = ?");
          for (const row of existing) {
            if (!keep.has(row.chapter)) {
              pruned += del.run(book, row.chapter).changes;
            }
          }
        }
      }

      db.exec("COMMIT");
      return { written: normalized.length, pruned };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
      throw err;
    }
  });
}

/**
 * 按 `cacheKey` 读取全书分析缓存（默认 `readOnly: true`）。
 * 支持可选 `opts.kind` / `opts.book` / `opts.fingerprint` / `opts.caliber` 过滤；不命中或 JSON 损坏返回 `null`。
 */
export function readAnalysisCache(root, cacheKey, opts = {}) {
  if (typeof cacheKey !== "string" || cacheKey === "") return null;
  const readOnly = opts?.readOnly !== false;

  return withLibraryDb(root, (db) => {
    const row = db.prepare(
      "SELECT kind, book, fingerprint, caliber, payload_json, updated_at FROM analysis_cache WHERE cache_key = ?"
    ).get(cacheKey);
    if (!row) return null;
    if (typeof opts?.kind === "string" && row.kind !== opts.kind) return null;
    if (typeof opts?.book === "string" && row.book !== opts.book) return null;
    if (typeof opts?.fingerprint === "string" && row.fingerprint !== opts.fingerprint) return null;
    if (typeof opts?.caliber === "string" && row.caliber !== opts.caliber) return null;

    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      return null;
    }
    return {
      kind: row.kind,
      book: row.book,
      fingerprint: row.fingerprint,
      caliber: row.caliber,
      payload,
      updated_at: row.updated_at
    };
  }, { readOnly });
}

/**
 * 写入或更新全书分析缓存条目（自动刷新 `updated_at`）。
 */
export function writeAnalysisCache(root, entry) {
  if (!entry || typeof entry.cache_key !== "string" || entry.cache_key === "") {
    throw new Error("writeAnalysisCache: entry.cache_key 必须是非空字符串");
  }
  const updatedAt = Number.isFinite(entry.updated_at) ? Math.trunc(entry.updated_at) : Date.now();
  const payloadJson = typeof entry.payload_json === "string"
    ? entry.payload_json
    : JSON.stringify(entry.payload ?? null);

  return withLibraryDb(root, (db) => {
    db.prepare(
      "INSERT INTO analysis_cache (cache_key, kind, book, fingerprint, caliber, payload_json, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?) "
      + "ON CONFLICT(cache_key) DO UPDATE SET "
      + "kind = excluded.kind, "
      + "book = excluded.book, "
      + "fingerprint = excluded.fingerprint, "
      + "caliber = excluded.caliber, "
      + "payload_json = excluded.payload_json, "
      + "updated_at = excluded.updated_at"
    ).run(
      entry.cache_key,
      String(entry.kind ?? ""),
      String(entry.book ?? ""),
      String(entry.fingerprint ?? ""),
      String(entry.caliber ?? ""),
      payloadJson,
      updatedAt
    );
    return { cache_key: entry.cache_key, updated_at: updatedAt };
  });
}

/**
 * 读取指定作品的语义嵌入索引（默认 `readOnly: true`）。
 * 支持 `{ metaOnly: true }` 仅查元数据以快速比对指纹；完整读取时会用 `decodeFloat32Blob` 解码并校验向量维度。
 */
export function readEmbeddingIndex(root, book, opts = {}) {
  if (typeof book !== "string" || book === "") return null;
  const readOnly = opts?.readOnly !== false;

  return withLibraryDb(root, (db) => {
    const metaRow = db.prepare(
      "SELECT book, model, dim, fingerprint, chunk_count, updated_at FROM embedding_meta WHERE book = ?"
    ).get(book);
    if (!metaRow) return null;

    const meta = {
      book: metaRow.book,
      model: metaRow.model,
      dim: metaRow.dim,
      fingerprint: metaRow.fingerprint,
      chunk_count: metaRow.chunk_count,
      updated_at: metaRow.updated_at
    };
    if (typeof opts?.model === "string" && meta.model !== opts.model) return null;
    if (typeof opts?.fingerprint === "string" && meta.fingerprint !== opts.fingerprint) return null;

    if (opts?.metaOnly === true) {
      return { meta, chunks: null };
    }

    const chunkRows = db.prepare(
      "SELECT book, chunk_idx, chapter, offset, text_hash, vec FROM embedding_chunks WHERE book = ? ORDER BY chunk_idx ASC"
    ).all(book);
    if (chunkRows.length !== meta.chunk_count) return null;

    const chunks = [];
    for (const r of chunkRows) {
      const vec = decodeFloat32Blob(r.vec, meta.dim);
      if (!vec) return null;
      chunks.push({
        book: r.book,
        chunk_idx: r.chunk_idx,
        chapter: r.chapter,
        offset: r.offset,
        text_hash: r.text_hash,
        vec
      });
    }
    return { meta, chunks };
  }, { readOnly });
}

/**
 * 事务性整本替换作品的嵌入索引元数据与分块向量（BLOB 经 `encodeFloat32Blob` 编码）。
 */
export function writeEmbeddingIndex(root, book, meta, chunks) {
  if (typeof book !== "string" || book === "") {
    throw new Error("writeEmbeddingIndex: book 必须是非空字符串");
  }
  const list = Array.isArray(chunks) ? chunks : [];
  const encodedChunks = list.map((chunk, idx) => ({
    chunk_idx: Number.isInteger(chunk.chunk_idx) ? chunk.chunk_idx : idx,
    chapter: String(chunk.chapter ?? ""),
    offset: Number.isFinite(chunk.offset) ? Math.trunc(chunk.offset) : 0,
    text_hash: String(chunk.text_hash ?? ""),
    blob: encodeFloat32Blob(chunk.vec)
  }));
  const inferredDim = encodedChunks.length > 0 ? encodedChunks[0].blob.byteLength / 4 : 0;
  const dim = Number.isInteger(meta?.dim) ? meta.dim : inferredDim;
  const updatedAt = Number.isFinite(meta?.updated_at) ? Math.trunc(meta.updated_at) : Date.now();
  const chunkCount = encodedChunks.length;

  return withLibraryDb(root, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM embedding_chunks WHERE book = ?").run(book);
      db.prepare(
        "INSERT INTO embedding_meta (book, model, dim, fingerprint, chunk_count, updated_at) "
        + "VALUES (?, ?, ?, ?, ?, ?) "
        + "ON CONFLICT(book) DO UPDATE SET "
        + "model = excluded.model, "
        + "dim = excluded.dim, "
        + "fingerprint = excluded.fingerprint, "
        + "chunk_count = excluded.chunk_count, "
        + "updated_at = excluded.updated_at"
      ).run(
        book,
        String(meta?.model ?? ""),
        dim,
        String(meta?.fingerprint ?? ""),
        chunkCount,
        updatedAt
      );

      const insertChunk = db.prepare(
        "INSERT INTO embedding_chunks (book, chunk_idx, chapter, offset, text_hash, vec) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const item of encodedChunks) {
        insertChunk.run(book, item.chunk_idx, item.chapter, item.offset, item.text_hash, item.blob);
      }
      db.exec("COMMIT");
      return { book, chunkCount, updated_at: updatedAt };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
      throw err;
    }
  });
}

/**
 * 批量读取跨会话审计向量缓存，返回 `Map<string, Float32Array>`。
 * 当库不存在或传 `{ readOnly: true }` / `{ touchLastUsed: false }` 时不写盘；
 * 否则在命中条目存在时刷新其 `last_used` 时间戳以支持 LRU 淘汰。
 */
export function readAuditVectors(root, keys, expectedModel, expectedDim, opts = {}) {
  const keyList = [...new Set(Array.isArray(keys) ? keys : (keys ? [...keys] : []))]
    .filter((k) => typeof k === "string" && k !== "");
  if (keyList.length === 0) return new Map();

  const dbPath = libraryDbPath(root);
  if (!existsSync(dbPath)) return new Map();

  const readOnly = opts?.readOnly === true || opts?.touchLastUsed === false;
  const result = withLibraryDb(root, (db) => {
    const out = new Map();
    const stmt = db.prepare("SELECT vec_key, model, dim, vec FROM audit_vectors WHERE vec_key = ?");
    const hitKeys = [];
    for (const key of keyList) {
      const row = stmt.get(key);
      if (!row) continue;
      if (typeof expectedModel === "string" && expectedModel !== "" && row.model !== expectedModel) continue;
      if (Number.isInteger(expectedDim) && row.dim !== expectedDim) continue;
      const vec = decodeFloat32Blob(row.vec, Number.isInteger(expectedDim) ? expectedDim : row.dim);
      if (!vec) continue;
      out.set(key, vec);
      hitKeys.push(key);
    }

    if (!readOnly && hitKeys.length > 0) {
      const now = Date.now();
      const touch = db.prepare("UPDATE audit_vectors SET last_used = ? WHERE vec_key = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const key of hitKeys) touch.run(now, key);
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
        throw err;
      }
    }
    return out;
  }, { readOnly });

  return result ?? new Map();
}

/**
 * 批量写入审计向量并按 `last_used DESC` 保留最近 `maxRows` 条记录（默认 2000）。
 */
export function writeAuditVectors(root, entries, maxRows = 2000) {
  const list = Array.isArray(entries) ? entries : (entries ? [...entries] : []);
  const now = Date.now();
  const prepared = [];
  for (const entry of list) {
    if (!entry) continue;
    const vecKey = entry.vec_key ?? entry.key;
    if (typeof vecKey !== "string" || vecKey === "") continue;
    const blob = encodeFloat32Blob(entry.vec);
    const dim = Number.isInteger(entry.dim) ? entry.dim : blob.byteLength / 4;
    prepared.push({
      vec_key: vecKey,
      model: String(entry.model ?? ""),
      dim,
      blob,
      last_used: Number.isFinite(entry.last_used) ? Math.trunc(entry.last_used) : now
    });
  }

  if (prepared.length === 0 && !existsSync(libraryDbPath(root))) {
    return { written: 0, pruned: 0 };
  }

  return withLibraryDb(root, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = db.prepare(
        "INSERT INTO audit_vectors (vec_key, model, dim, vec, last_used) VALUES (?, ?, ?, ?, ?) "
        + "ON CONFLICT(vec_key) DO UPDATE SET "
        + "model = excluded.model, "
        + "dim = excluded.dim, "
        + "vec = excluded.vec, "
        + "last_used = excluded.last_used"
      );
      for (const item of prepared) {
        upsert.run(item.vec_key, item.model, item.dim, item.blob, item.last_used);
      }

      let pruned = 0;
      if (Number.isInteger(maxRows) && maxRows >= 0) {
        pruned = db.prepare(
          "DELETE FROM audit_vectors WHERE vec_key NOT IN ("
          + "SELECT vec_key FROM audit_vectors ORDER BY last_used DESC, rowid DESC LIMIT ?"
          + ")"
        ).run(maxRows).changes;
      }
      db.exec("COMMIT");
      return { written: prepared.length, pruned };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
      throw err;
    }
  });
}

/**
 * 删除指定作品在 `cache.sqlite` 中的全部派生缓存（逐章、分析、嵌入元与分块）。
 * 若库文件不存在则直接返回，绝不创建空库。
 */
export function purgeBookCache(root, book) {
  if (typeof book !== "string" || book === "") return { existed: false, deleted: 0 };
  if (!existsSync(libraryDbPath(root))) return { existed: false, deleted: 0 };

  const deleted = withLibraryDb(root, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      let total = 0;
      total += db.prepare("DELETE FROM chapter_metrics WHERE book = ?").run(book).changes;
      total += db.prepare("DELETE FROM analysis_cache WHERE book = ?").run(book).changes;
      total += db.prepare("DELETE FROM embedding_meta WHERE book = ?").run(book).changes;
      total += db.prepare("DELETE FROM embedding_chunks WHERE book = ?").run(book).changes;
      db.exec("COMMIT");
      return total;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
      throw err;
    }
  });
  return { existed: true, deleted };
}

/**
 * 检查 `chapter_metrics` 与 `analysis_cache` 的口径分布元数据（仅口径与计数，绝不含书名/正文）。
 */
export function inspectCaliberCache(root, expectedCaliber) {
  const target = typeof expectedCaliber === "string"
    ? expectedCaliber
    : (typeof expectedCaliber?.caliber === "string" ? expectedCaliber.caliber : null);

  const empty = {
    exists: false,
    expectedCaliber: target,
    chapterMetrics: { total: 0, byCaliber: {} },
    analysisCache: { total: 0, byCaliber: {} },
    calibers: [],
    total: 0,
    stale: 0
  };

  const summary = withLibraryDb(root, (db) => {
    const chRows = db.prepare("SELECT caliber, COUNT(*) AS cnt FROM chapter_metrics GROUP BY caliber").all();
    const anRows = db.prepare("SELECT caliber, COUNT(*) AS cnt FROM analysis_cache GROUP BY caliber").all();

    const chByCaliber = {};
    let chTotal = 0;
    const caliberSet = new Set();
    let stale = 0;

    for (const r of chRows) {
      const c = String(r.caliber ?? "");
      const cnt = Number(r.cnt ?? 0);
      chByCaliber[c] = cnt;
      chTotal += cnt;
      caliberSet.add(c);
      if (target !== null && c !== target) stale += cnt;
    }

    const anByCaliber = {};
    let anTotal = 0;
    for (const r of anRows) {
      const c = String(r.caliber ?? "");
      const cnt = Number(r.cnt ?? 0);
      anByCaliber[c] = cnt;
      anTotal += cnt;
      caliberSet.add(c);
      if (target !== null && c !== target) stale += cnt;
    }

    return {
      exists: true,
      expectedCaliber: target,
      chapterMetrics: { total: chTotal, byCaliber: chByCaliber },
      analysisCache: { total: anTotal, byCaliber: anByCaliber },
      calibers: [...caliberSet].sort(),
      total: chTotal + anTotal,
      stale
    };
  }, { readOnly: true });

  return summary ?? empty;
}

/**
 * 清理过期的口径缓存行（若指定 `expectedCaliber`，仅删 `caliber != expectedCaliber`；否则清空口径表）。
 * 若库文件不存在则直接返回，不创建空库。
 */
export function rebuildCaliberCache(root, expectedCaliber) {
  const target = typeof expectedCaliber === "string"
    ? expectedCaliber
    : (typeof expectedCaliber?.caliber === "string" ? expectedCaliber.caliber : null);

  if (!existsSync(libraryDbPath(root))) {
    return {
      existed: false,
      expectedCaliber: target,
      deleted: 0,
      deletedChapterMetrics: 0,
      deletedAnalysisCache: 0,
      remaining: 0
    };
  }

  return withLibraryDb(root, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      let deletedChapterMetrics = 0;
      let deletedAnalysisCache = 0;
      if (target !== null && target !== "") {
        deletedChapterMetrics = db.prepare("DELETE FROM chapter_metrics WHERE caliber != ?").run(target).changes;
        deletedAnalysisCache = db.prepare("DELETE FROM analysis_cache WHERE caliber != ?").run(target).changes;
      } else {
        deletedChapterMetrics = db.prepare("DELETE FROM chapter_metrics").run().changes;
        deletedAnalysisCache = db.prepare("DELETE FROM analysis_cache").run().changes;
      }
      const remCh = Number(db.prepare("SELECT COUNT(*) AS cnt FROM chapter_metrics").get()?.cnt ?? 0);
      const remAn = Number(db.prepare("SELECT COUNT(*) AS cnt FROM analysis_cache").get()?.cnt ?? 0);
      db.exec("COMMIT");
      return {
        existed: true,
        expectedCaliber: target,
        deleted: deletedChapterMetrics + deletedAnalysisCache,
        deletedChapterMetrics,
        deletedAnalysisCache,
        remaining: remCh + remAn
      };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* 忽略回滚错误 */ }
      throw err;
    }
  });
}

/**
 * 返回 SQLite 缓存库的纯元数据摘要（不含任何正文或书名/章名）。
 */
export function inspectLibraryDb(root) {
  const dbPath = libraryDbPath(root);
  const emptyCounts = {
    chapterMetrics: 0,
    analysisCache: 0,
    embeddingBooks: 0,
    embeddingChunks: 0,
    auditVectors: 0
  };
  if (!existsSync(dbPath)) {
    return {
      exists: false,
      dbPath,
      sizeBytes: 0,
      schemaVersion: null,
      journalMode: null,
      counts: emptyCounts
    };
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(dbPath).size;
  } catch {
    sizeBytes = 0;
  }

  const info = withLibraryDb(root, (db) => {
    const rawVer = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null;
    const schemaVersion = typeof rawVer === "string" && /^\d+$/.test(rawVer) ? Number(rawVer) : rawVer;
    const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? null;
    return {
      exists: true,
      dbPath,
      sizeBytes,
      schemaVersion,
      journalMode,
      counts: {
        chapterMetrics: Number(db.prepare("SELECT COUNT(*) AS c FROM chapter_metrics").get()?.c ?? 0),
        analysisCache: Number(db.prepare("SELECT COUNT(*) AS c FROM analysis_cache").get()?.c ?? 0),
        embeddingBooks: Number(db.prepare("SELECT COUNT(*) AS c FROM embedding_meta").get()?.c ?? 0),
        embeddingChunks: Number(db.prepare("SELECT COUNT(*) AS c FROM embedding_chunks").get()?.c ?? 0),
        auditVectors: Number(db.prepare("SELECT COUNT(*) AS c FROM audit_vectors").get()?.c ?? 0)
      }
    };
  }, { readOnly: true });

  return info ?? {
    exists: true,
    dbPath,
    sizeBytes,
    schemaVersion: null,
    journalMode: null,
    counts: emptyCounts
  };
}
