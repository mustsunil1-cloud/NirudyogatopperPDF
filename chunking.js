"use strict";

const MAX_TOKENS_PER_CHUNK = 8000;
const OVERLAP_TOKENS = 200;
const AVG_CHARS_PER_TOKEN = 4;
const QUESTIONS_PER_CHUNK = 5;

function estimateTokens(text) {
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

function chunkText(text, maxTokens = MAX_TOKENS_PER_CHUNK, overlapTokens = OVERLAP_TOKENS) {
  const maxChars = maxTokens * AVG_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * AVG_CHARS_PER_TOKEN;

  if (text.length <= maxChars) {
    return [{ text, index: 0, total: 1 }];
  }

  const chunks = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      const sentenceEnd = text.lastIndexOf(". ", end);
      const paragraphEnd = text.lastIndexOf("\n\n", end);
      const breakPoint = Math.max(sentenceEnd, paragraphEnd);

      if (breakPoint > start + maxChars * 0.5) {
        end = breakPoint + 1;
      }
    }

    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({ text: chunkText, index, total: 0 });
      index++;
    }

    const newStart = end - overlapChars;
    if (newStart <= start) break;
    start = newStart;
    if (start >= text.length) break;
  }

  chunks.forEach((c) => (c.total = chunks.length));
  return chunks;
}

const NOT_IN_DOCUMENT = "This information is not available in the uploaded document.";

function languageInstruction(language, action) {
  const languageName = language === "te" ? "clear Telugu" : "clear English";
  if (action === "explain") {
    return `Write the summary, headings, points, and takeaways in ${languageName}.`;
  }
  return `Write every question, option, answer and explanation in ${languageName}.`;
}

function groundingRules() {
  return [
    "STRICT CONTEXT RULES:",
    "- Use only the document text in this prompt.",
    "- Do not use outside knowledge, the internet, or assumptions.",
    `- If the document does not contain the information, write exactly: "${NOT_IN_DOCUMENT}"`,
  ].join("\n");
}

function createChunkPrompt(action, language, chunkText, chunkIndex, totalChunks) {
  const context = totalChunks > 1
    ? `This is part ${chunkIndex + 1} of ${totalChunks} of the document. `
    : "";

  if (action === "explain") {
    return `${languageInstruction(language, action)}
${groundingRules()}
${context}Explain the document text for a student. Respond with a raw JSON object and nothing else. No markdown fences and no commentary.

{
  "summary": "short summary grounded in the text",
  "sections": [
    { "heading": "section title", "points": ["bullet grounded in the text"] }
  ],
  "takeaways": ["key takeaway grounded in the text"]
}

Rules:
- Every statement must come from the document text.
- Use short, clear headings and bullet points.
- If the text has too little readable content, set summary to exactly "${NOT_IN_DOCUMENT}", sections to [], and takeaways to [].

DOCUMENT TEXT:
${chunkText}`;
  }

  return `${languageInstruction(language, action)}
${groundingRules()}
${context}Create exactly ${QUESTIONS_PER_CHUNK} multiple-choice questions based only on the document text below.

You must respond with a raw JSON array and nothing else. No markdown, no code fences, no commentary.

The exact required format is:
[
  {
    "question": "the question text",
    "options": ["option A text", "option B text", "option C text", "option D text"],
    "correctAnswer": "the exact text of the correct option",
    "explanation": "a short explanation of why that option is correct"
  }
]

Rules:
- Output a valid JSON array with ${QUESTIONS_PER_CHUNK} objects.
- Each object must have exactly the keys "question", "options", "correctAnswer", "explanation".
- "options" must contain exactly 4 strings.
- "correctAnswer" must be copied verbatim from one of the "options" entries.
- Every question and explanation must be supported by the document text. Do not invent facts.
- If an explanation cannot be grounded in the text, set it to exactly "${NOT_IN_DOCUMENT}".
- Output only the JSON array.

DOCUMENT TEXT:
${chunkText}`;
}

/**
 * Strips markdown code fences and any prose around a JSON payload.
 * Handles ```json ... ```, ``` ... ```, and bare arrays/objects.
 */
function stripCodeFences(raw) {
  if (typeof raw !== "string") return "";

  let text = raw.trim();

  // Remove a leading fenced block (with optional language tag).
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    // Remove any stray inline fence markers.
    text = text.replace(/^```[a-zA-Z0-9_-]*/gm, "").replace(/```$/gm, "");
    text = text.trim();
  }

  return text;
}

/**
 * Extracts the first balanced JSON array or object from a string.
 * Brace/bracket matching is string-aware so braces inside quotes do not break it.
 */
function extractJsonPayload(raw) {
  const text = stripCodeFences(raw);
  if (!text) return null;

  const arrayStart = text.indexOf("[");
  const objectStart = text.indexOf("{");

  let start = -1;
  let openChar;
  let closeChar;

  if (arrayStart === -1 && objectStart === -1) return null;

  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    start = arrayStart;
    openChar = "[";
    closeChar = "]";
  } else {
    start = objectStart;
    openChar = "{";
    closeChar = "}";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === openChar) depth++;
    else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return null;

  const cleaned = options
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter((option) => option.length > 0);

  return cleaned.length === 4 ? cleaned : null;
}

/**
 * Coerces a model response into the strict quiz array contract.
 * Returns null when the payload cannot satisfy the schema.
 */
function parseQuizResponse(raw) {
  const payload = extractJsonPayload(raw);
  if (!payload) return null;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  // Accept either a bare array or an object wrapping one (e.g. { "questions": [...] }).
  let items = null;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object") {
    const candidate = parsed.questions || parsed.quiz || parsed.data;
    if (Array.isArray(candidate)) items = candidate;
  }

  if (!items || items.length === 0) return null;

  const questions = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const question = typeof item.question === "string" ? item.question.trim() : "";
    const explanation = typeof item.explanation === "string" ? item.explanation.trim() : "";
    const options = normalizeOptions(item.options);

    if (!question || !options) continue;

    // Accept "B" style answers by mapping them onto the matching option index.
    let correctAnswer = typeof item.correctAnswer === "string" ? item.correctAnswer.trim() : "";
    const exactMatch = options.find(
      (option) => option.toLowerCase() === correctAnswer.toLowerCase()
    );
    if (exactMatch) {
      correctAnswer = exactMatch;
    } else if (/^[a-d]$/i.test(correctAnswer)) {
      correctAnswer = options[correctAnswer.toLowerCase().charCodeAt(0) - 97];
    } else {
      // Last resort: look for a distinctive option quoted in the explanation.
      // Options shorter than 3 chars are ignored because naive substring
      // matching would produce spurious hits (e.g. "a" inside "matches").
      const needle = explanation.toLowerCase();
      const hinted = options.find((option) => {
        if (option.length < 3) return false;
        return needle.includes(option.toLowerCase());
      });
      if (!hinted) continue;
      correctAnswer = hinted;
    }

    questions.push({ question, options, correctAnswer, explanation });
  }

  return questions.length > 0 ? questions : null;
}

function cleanStringList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

/**
 * Coerces a model response into the explanation object used by the app.
 * Returns null when the payload is not that object.
 */
function parseExplainResponse(raw) {
  const payload = extractJsonPayload(raw);
  if (!payload) return null;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const sections = [];

  if (Array.isArray(parsed.sections)) {
    for (const section of parsed.sections) {
      if (!section || typeof section !== "object") continue;
      const heading = typeof section.heading === "string" ? section.heading.trim() : "";
      const points = cleanStringList(section.points);
      if (!heading || points.length === 0) continue;
      sections.push({ heading, points });
    }
  }

  const takeaways = cleanStringList(parsed.takeaways);
  if (!summary && sections.length === 0 && takeaways.length === 0) return null;

  return { summary, sections, takeaways };
}

function explanationToMarkdown(explanation) {
  if (!explanation) return "";

  const lines = [];
  if (explanation.summary) {
    lines.push("### Summary", "", explanation.summary, "");
  }

  for (const section of explanation.sections || []) {
    lines.push(`### ${section.heading}`, "");
    for (const point of section.points) lines.push(`- ${point}`);
    lines.push("");
  }

  if (explanation.takeaways && explanation.takeaways.length > 0) {
    lines.push("### Key takeaways", "");
    for (const item of explanation.takeaways) lines.push(`- ${item}`);
  }

  return lines.join("\n").trim();
}

function mergeExplanations(parts) {
  return {
    summary: parts.map((part) => part.summary).filter(Boolean).join("\n\n"),
    sections: parts.flatMap((part) => part.sections),
    takeaways: parts.flatMap((part) => part.takeaways),
  };
}

module.exports = {
  estimateTokens,
  chunkText,
  createChunkPrompt,
  stripCodeFences,
  extractJsonPayload,
  parseQuizResponse,
  parseExplainResponse,
  explanationToMarkdown,
  mergeExplanations,
  NOT_IN_DOCUMENT,
  QUESTIONS_PER_CHUNK,
};
