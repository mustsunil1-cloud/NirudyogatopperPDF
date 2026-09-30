"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const Busboy = require("busboy");
const { PDFParse } = require("pdf-parse");
const { uploadPdf, downloadPdf, deletePdf, saveSession, getSession } = require("./supabase.js");

const PUBLIC_DIR = path.join(__dirname, "public");
const LEGAL_PAGES = {
  "/privacy-policy": "privacy-policy.html",
  "/privacy-policy.html": "privacy-policy.html",
  "/terms": "terms.html",
  "/terms.html": "terms.html",
};

function sendHtmlFile(response, filename) {
  const filePath = path.join(PUBLIC_DIR, filename);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
    response.end(data);
  });
}

const {
  estimateTokens,
  chunkText,
  createChunkPrompt,
  parseQuizResponse,
  parseExplainResponse,
  explanationToMarkdown,
  mergeExplanations,
  QUESTIONS_PER_CHUNK,
} = require("./chunking.js");
const { identifyPdf, modeKey, safeObjectName } = require("./sessions.js");

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-max-age", "86400");
}

const PORT = Number(process.env.PORT || 3000);
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MIN_TEXT_CHARS = 50;
const PROVIDER_REQUEST_TIMEOUT_MS = 60_000;
const ANALYSIS_TIMEOUT_MS = 180_000;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
  GEMINI_MODEL
)}:generateContent`;

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

function isPlaceholder(value) {
  return !value || /^your_/i.test(value.trim());
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function hasGemini() {
  return !isPlaceholder(process.env.GEMINI_API_KEY);
}

function hasGroq() {
  return !isPlaceholder(process.env.GROQ_API_KEY);
}

function buildObjectKey(filename, contentHash) {
  const safeName = safeObjectName(filename);
  return contentHash ? `uploads/${contentHash}/${safeName}` : `uploads/${safeName}`;
}

const inflight = new Map();

function runExclusive(sessionId, fn) {
  const previous = inflight.get(sessionId) || Promise.resolve();
  const current = previous.then(() => fn(), () => fn());
  inflight.set(sessionId, current);
  return current.finally(() => {
    if (inflight.get(sessionId) === current) inflight.delete(sessionId);
  });
}

async function getSessionData(identity) {
  const data = await getSession(identity.sessionId);
  if (!data) return null;
  return {
    sessionId: data.session_id,
    pdfName: data.pdf_name,
    pdfNameKey: data.pdf_name_key,
    contentHash: data.content_hash,
    storagePath: data.storage_path,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    results: data.results,
  };
}

async function persistSession(session) {
  await saveSession(session);
}

async function putResult(identity, key, record) {
  const now = new Date().toISOString();
  const existing = await getSessionData(identity);
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
    await persistSession(session);
  }

  return session;
}

const sessionStore = { get: getSessionData, putResult, runExclusive };

async function uploadToBucket(key, buffer) {
  try {
    await uploadPdf(key, buffer);
    console.log(`[supabase] uploaded ${key} (${buffer.length} bytes)`);
    return true;
  } catch (error) {
    console.error("[supabase] upload failed:", error.message);
    return false;
  }
}

async function deleteFromBucket(key) {
  if (!key) return false;
  try {
    await deletePdf(key);
    console.log(`[supabase] deleted ${key}`);
    return true;
  } catch (error) {
    console.error("[supabase] delete failed:", error.message);
    return false;
  }
}

async function checkFileExists(key) {
  try {
    await downloadPdf(key);
    console.log(`[Supabase] File already exists, skipping upload.`);
    return true;
  } catch (error) {
    return false;
  }
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result?.text || "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(prompt, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetchWithTimeout(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  }, timeoutMs);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw httpError(502, `Gemini request failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw httpError(502, "Gemini returned an empty response.");
  }
  return text;
}

async function callGroq(prompt, timeoutMs) {
  const apiKey = process.env.GROQ_API_KEY;
  const response = await fetchWithTimeout(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_completion_tokens: 4096,
      reasoning_effort: "low",
    }),
  }, timeoutMs);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw httpError(502, `Groq request failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }

  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw httpError(502, "Groq returned an empty response.");
  }
  return text;
}

const PROVIDERS = {
  gemini: { available: hasGemini, call: callGemini },
  groq: { available: hasGroq, call: callGroq },
};

function selectProviderOrder(requested) {
  if (requested === "gemini") return ["gemini", "groq"];
  if (requested === "groq") return ["groq", "gemini"];

  // Default preference: try Groq when available, then fall back to Gemini.
  if (hasGroq()) return ["groq", "gemini"];
  return ["gemini"];
}

async function runProvider(prompt, requested, deadline = Date.now() + ANALYSIS_TIMEOUT_MS) {
  const order = selectProviderOrder(requested);
  const attempted = [];
  let lastError = null;

  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider) continue;

    if (!provider.available()) {
      console.warn(`[ai] ${name} is not configured, skipping.`);
      continue;
    }

    attempted.push(name);
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw httpError(504, "This PDF is taking too long to analyze. Try a shorter PDF.");
      }
      const text = await provider.call(prompt, Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remainingMs));
      return { text, usedProvider: name, attempted, fellBack: name !== requested };
    } catch (error) {
      console.error(`[ai] ${name} failed: ${error.message}`);
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  throw httpError(503, "No AI provider is configured on the server.");
}

async function analyzeWithFallback({ action, language, pdfText, provider }) {
  const chunks = chunkText(pdfText);
  const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
  console.log(
    `[ai] ${pdfText.length} chars (~${estimateTokens(pdfText)} tokens) in ${chunks.length} chunk(s), provider=${provider}`
  );

  if (action === "quiz") {
    const questions = [];
    let usedProvider = provider;
    let fellBack = false;
    const attemptedTotal = [];

    for (const chunk of chunks) {
      const prompt = createChunkPrompt(action, language, chunk.text, chunk.index, chunk.total);
      const result = await runProvider(prompt, provider, deadline);
      attemptedTotal.push(...result.attempted);

      if (result.usedProvider !== usedProvider) {
        usedProvider = result.usedProvider;
        fellBack = true;
      }

      const parsed = parseQuizResponse(result.text);
      if (!parsed) {
        throw httpError(502, "The AI model returned an invalid quiz format.");
      }
      questions.push(...parsed);
    }

    return {
      quiz: questions,
      provider: usedProvider,
      attempted: [...new Set(attemptedTotal)],
      fellBack,
      chunks: chunks.length,
    };
  }

  const parsedParts = [];
  const rawParts = [];
  let usedProvider = provider;
  let fellBack = false;
  const attemptedTotal = [];

  for (const chunk of chunks) {
    const prompt = createChunkPrompt(action, language, chunk.text, chunk.index, chunk.total);
    const result = await runProvider(prompt, provider, deadline);
    attemptedTotal.push(...result.attempted);

    if (result.usedProvider !== usedProvider) {
      usedProvider = result.usedProvider;
      fellBack = true;
    }

    const parsed = parseExplainResponse(result.text);
    if (parsed) {
      parsedParts.push(parsed);
      rawParts.push(explanationToMarkdown(parsed));
    } else {
      rawParts.push(result.text);
    }
  }

  const explanation = parsedParts.length === chunks.length && parsedParts.length > 0
    ? mergeExplanations(parsedParts)
    : null;

  return {
    text: explanation ? explanationToMarkdown(explanation) : rawParts.join("\n\n---\n\n"),
    explanation,
    provider: usedProvider,
    attempted: [...new Set(attemptedTotal)],
    fellBack,
    chunks: chunks.length,
  };
}

function buildAnalysisResponse(session, record, { duplicate, sessionCreated }) {
  const body = {
    ok: true,
    status: duplicate ? "duplicate" : "processed",
    duplicate,
    sessionCreated,
    sessionId: session.sessionId,
    pdfName: session.pdfName,
    contentHash: session.contentHash,
    storagePath: session.storagePath,
    action: record.action,
    mode: record.action,
    language: record.language,
    provider: record.provider,
    fellBack: record.fellBack,
    attempted: record.attempted,
    chunkCount: record.chunkCount,
  };

  if (duplicate) {
    body.message = "Duplicate PDF rejected. Returning the existing session.";
  }

  if (record.action === "quiz") {
    body.questionCount = record.questions.length;
    body.questionsPerChunk = record.questionsPerChunk;
    body.questions = record.questions;
    return body;
  }

  body.text = record.text;
  body.explanation = record.explanation || null;
  return body;
}

function readUploadRequest(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 4 },
      });
    } catch {
      reject(httpError(400, "Expected a multipart PDF upload."));
      return;
    }

    let action = "";
    let language = "en";
    let provider = "";
    let filename = "";
    const pdfChunks = [];
    let pdfSize = 0;
    let fileSeen = false;
    let fileTooLarge = false;
    let fileTypeValid = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.unpipe(parser);
      request.resume();
      reject(error);
    };

    parser.on("field", (name, value) => {
      if (name === "action") action = value;
      if (name === "language") language = value;
      if (name === "provider") provider = value;
    });

    parser.on("file", (fieldName, stream, info) => {
      // The Android client sends the file under the "pdf" key.
      if (fieldName !== "pdf" || fileSeen) {
        stream.resume();
        return;
      }

      fileSeen = true;
      filename = info.filename || "";
      fileTypeValid =
        info.mimeType === "application/pdf" ||
        (info.filename || "").toLowerCase().endsWith(".pdf");

      stream.on("data", (chunk) => {
        pdfSize += chunk.length;
        if (pdfSize <= MAX_PDF_BYTES) pdfChunks.push(chunk);
      });
      stream.on("limit", () => {
        fileTooLarge = true;
      });
      stream.on("error", () => fail(httpError(400, "Could not read the uploaded file.")));
    });

    parser.on("filesLimit", () => {
      fileTooLarge = true;
    });
    parser.on("fieldsLimit", () => {
      fail(httpError(400, "Too many multipart fields."));
    });
    parser.on("partsLimit", () => {
      fail(httpError(400, "Too many multipart parts."));
    });
    parser.on("error", () => fail(httpError(400, "Could not read the uploaded file.")));

    parser.on("finish", () => {
      if (settled) return;

      if (fileTooLarge || pdfSize > MAX_PDF_BYTES) {
        fail(httpError(413, "PDF files must be 12 MB or smaller."));
        return;
      }
      if (!fileSeen) {
        fail(httpError(400, "A PDF file is required."));
        return;
      }
      if (!fileTypeValid) {
        fail(httpError(415, "Please upload a PDF file."));
        return;
      }
      if (action !== "quiz" && action !== "explain") {
        fail(httpError(400, "Action must be quiz or explain."));
        return;
      }
      if (language !== "en" && language !== "te") {
        fail(httpError(400, "Language must be en or te."));
        return;
      }

      const pdf = Buffer.concat(pdfChunks);
      if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        fail(httpError(415, "The uploaded file is not a readable PDF."));
        return;
      }

      settled = true;
      resolve({ action, language, provider, pdf, filename });
    });

    request.pipe(parser);
  });
}

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);
  const pathname = new URL(request.url, "http://localhost").pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (pathname === "/healthz" && request.method === "GET") {
    sendJson(response, 200, {
      status: "ok",
      providers: {
        gemini: hasGemini(),
        groq: hasGroq(),
      },
      storage: "supabase",
    });
    return;
  }

  if (request.method === "GET" && LEGAL_PAGES[pathname]) {
    sendHtmlFile(response, LEGAL_PAGES[pathname]);
    return;
  }

  if (pathname !== "/analyze") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  let objectKey = null;
  let uploaded = false;

  try {
    const upload = await readUploadRequest(request);
    const identity = identifyPdf(upload.filename, upload.pdf);
    const key = modeKey(upload.action, upload.language);
    objectKey = identity.storagePath;

    const body = await sessionStore.runExclusive(identity.sessionId, async () => {
      const existing = await sessionStore.get(identity);
      const cached = existing && existing.results[key];
      if (cached) {
        console.log(`[session] duplicate ${identity.sessionId} mode=${key}`);
        return buildAnalysisResponse(existing, cached, {
          duplicate: true,
          sessionCreated: false,
        });
      }

      if (s3Configured) {
        uploaded = await uploadToBucket(objectKey, upload.pdf);
      }

      const pdfText = await extractPdfText(upload.pdf);
      if (!pdfText || pdfText.trim().length < MIN_TEXT_CHARS) {
        throw httpError(400, "The PDF has too little readable text content.");
      }

      const result = await analyzeWithFallback({
        action: upload.action,
        language: upload.language,
        pdfText,
        provider: upload.provider,
      });

      const record = upload.action === "quiz"
        ? {
            action: "quiz",
            language: upload.language,
            provider: result.provider,
            fellBack: result.fellBack,
            attempted: result.attempted,
            chunkCount: result.chunks,
            questions: result.quiz,
            questionsPerChunk: QUESTIONS_PER_CHUNK,
          }
        : {
            action: "explain",
            language: upload.language,
            provider: result.provider,
            fellBack: result.fellBack,
            attempted: result.attempted,
            chunkCount: result.chunks,
            text: result.text,
            explanation: result.explanation,
          };

      const session = await sessionStore.putResult(identity, key, record);
      console.log(`[session] stored ${identity.sessionId} mode=${key}`);

      return buildAnalysisResponse(session, record, {
        duplicate: false,
        sessionCreated: !existing,
      });
    });

    sendJson(response, 200, body);
  } catch (error) {
    if (uploaded && objectKey) {
      deleteFromBucket(objectKey).catch(() => {});
    }

    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) {
      console.error("[analyze] request failed:", error.message);
    }
    sendJson(response, status, {
      error: status === 500 ? "The PDF analysis request failed." : error.message,
    });
  }
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`PDF analysis server listening on ${PORT}`);
    console.log(`  gemini: ${hasGemini() ? "configured" : "NOT configured"}`);
    console.log(`  groq:    ${hasGroq() ? "configured" : "NOT configured"}`);
    console.log(`  supabase: ${process.env.SUPABASE_SECRET_KEY ? "configured" : "NOT configured (check SUPABASE_SECRET_KEY)"}`);
  });
}

module.exports = {
  server,
  analyzeWithFallback,
  runProvider,
  selectProviderOrder,
  extractPdfText,
  buildObjectKey,
  uploadToBucket,
  deleteFromBucket,
  checkFileExists,
  sessionStore,
  identifyPdf,
};
