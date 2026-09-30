"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const memory = new Map();
const inflight = new Map();

function sessionDirectory() {
  return process.env.SESSION_DIR || path.join(__dirname, "data", "sessions");
}

function baseName(filename) {
  const cleaned = String(filename || "upload.pdf").replace(/\\/g, "/").trim();
  const base = cleaned.split("/").pop() || "upload.pdf";
  return base.trim() || "upload.pdf";
}

function safeObjectName(filename) {
  return baseName(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.pdf";
}

/**
 * A PDF is the same document only when both the file name and the SHA-256
 * of its bytes match. Either difference is a different session.
 */
function identifyPdf(filename, buffer) {
  const pdfName = baseName(filename);
  const pdfNameKey = pdfName.toLowerCase();
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const sessionId = crypto
    .createHash("sha256")
    .update(`${pdfNameKey}\n${contentHash}`)
    .digest("hex");

  return {
    pdfName,
    pdfNameKey,
    contentHash,
    sessionId,
    storagePath: `uploads/${contentHash}/${safeObjectName(pdfName)}`,
  };
}

function modeKey(action, language) {
  return `${action}:${language}`;
}

function isSession(value, identity) {
  return Boolean(
    value &&
      value.sessionId === identity.sessionId &&
      value.contentHash === identity.contentHash &&
      value.pdfNameKey === identity.pdfNameKey &&
      value.results &&
      typeof value.results === "object"
  );
}

function diskPath(sessionId) {
  return path.join(sessionDirectory(), `${sessionId}.json`);
}

async function readDisk(sessionId) {
  try {
    const raw = await fs.readFile(diskPath(sessionId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeDisk(session) {
  const filePath = diskPath(session.sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session), "utf8");
}

/**
 * Serializes work for one session so two identical uploads cannot both
 * start a new analysis.
 */
function runExclusive(sessionId, fn) {
  const previous = inflight.get(sessionId) || Promise.resolve();
  const current = previous.then(() => fn(), () => fn());
  inflight.set(sessionId, current);
  return current.finally(() => {
    if (inflight.get(sessionId) === current) inflight.delete(sessionId);
  });
}

function createSessionStore({ readCloud, writeCloud } = {}) {
  async function get(identity) {
    const cached = memory.get(identity.sessionId);
    if (isSession(cached, identity)) return cached;

    const fromDisk = await readDisk(identity.sessionId);
    if (isSession(fromDisk, identity)) {
      memory.set(identity.sessionId, fromDisk);
      return fromDisk;
    }

    if (typeof readCloud === "function") {
      try {
        const fromCloud = await readCloud(identity.sessionId);
        if (isSession(fromCloud, identity)) {
          memory.set(identity.sessionId, fromCloud);
          await writeDisk(fromCloud).catch(() => {});
          return fromCloud;
        }
      } catch (error) {
        console.error("[session] cloud read failed:", error.message);
      }
    }

    return null;
  }

  async function persist(session) {
    memory.set(session.sessionId, session);
    try {
      await writeDisk(session);
    } catch (error) {
      console.error("[session] disk write failed:", error.message);
    }
    if (typeof writeCloud === "function") {
      try {
        await writeCloud(session);
      } catch (error) {
        console.error("[session] cloud write failed:", error.message);
      }
    }
  }

  async function putResult(identity, key, record) {
    const now = new Date().toISOString();
    const existing = await get(identity);
    const session = existing || {
      sessionId: identity.sessionId,
      pdfName: identity.pdfName,
      pdfNameKey: identity.pdfNameKey,
      contentHash: identity.contentHash,
      storagePath: identity.storagePath,
      createdAt: now,
      updatedAt: now,
      results: {},
    };

    if (!session.results[key]) {
      session.results[key] = record;
      session.updatedAt = now;
      await persist(session);
    }

    return session;
  }

  function reset() {
    memory.clear();
    inflight.clear();
  }

  return { get, putResult, runExclusive, reset };
}

module.exports = {
  identifyPdf,
  modeKey,
  safeObjectName,
  createSessionStore,
};
