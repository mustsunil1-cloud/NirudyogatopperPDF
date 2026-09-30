"use strict";

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ghvzcsfxhwfakpyfqxrx.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.warn("[supabase] SUPABASE_SECRET_KEY not set, using publishable key (limited permissions)");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET_NAME = process.env.SUPABASE_BUCKET || "pdfs";

async function ensureBucket() {
  const { data, error } = await supabase.storage.getBucket(BUCKET_NAME);
  if (error && error.message.includes("not found")) {
    await supabase.storage.createBucket(BUCKET_NAME, { public: false });
  }
}

async function uploadPdf(key, buffer) {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET_NAME).upload(key, buffer, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw error;
  return key;
}

async function downloadPdf(key) {
  const { data, error } = await supabase.storage.from(BUCKET_NAME).download(key);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function deletePdf(key) {
  await supabase.storage.from(BUCKET_NAME).remove([key]);
}

async function getPresignedUploadUrl(key, expiresIn = 3600) {
  await ensureBucket();
  const { data, error } = await supabase.storage.from(BUCKET_NAME).createSignedUploadUrl(key);
  if (error) throw error;
  return data.signedUrl;
}

async function getPresignedDownloadUrl(key, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from(BUCKET_NAME).createSignedUrl(key, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

const SESSIONS_TABLE = "pdf_sessions";

async function saveSession(session) {
  const { error } = await supabase.from(SESSIONS_TABLE).upsert({
    session_id: session.sessionId,
    pdf_name: session.pdfName,
    pdf_name_key: session.pdfNameKey,
    content_hash: session.contentHash,
    storage_path: session.storagePath,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    results: session.results,
  });
  if (error) throw error;
}

async function getSession(sessionId) {
  const { data, error } = await supabase.from(SESSIONS_TABLE).select("*").eq("session_id", sessionId).single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return data;
}

module.exports = {
  supabase,
  uploadPdf,
  downloadPdf,
  deletePdf,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  saveSession,
  getSession,
  BUCKET_NAME,
};