import { execSync } from "node:child_process";
import os from "node:os";

const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
const API_TIMEOUT_MS = 30000;

let cachedOpenAIKey = undefined;

function cleanTranscribedText(text) {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\t+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function getOpenAIApiKey() {
  if (cachedOpenAIKey !== undefined) return cachedOpenAIKey;

  if (process.env.OPENAI_API_KEY) {
    cachedOpenAIKey = process.env.OPENAI_API_KEY;
    return cachedOpenAIKey;
  }

  try {
    const shell = process.env.SHELL || process.env.ComSpec || "cmd.exe";
    const cmd = shell.includes("cmd")
      ? `${shell} /c "echo %OPENAI_API_KEY%"`
      : `${shell} -ilc 'echo $OPENAI_API_KEY'`;
    const result = execSync(cmd, { encoding: "utf8", timeout: 5000, env: { ...process.env, HOME: os.homedir() } });
    const key = result.trim();
    if (key && key.startsWith("sk-")) {
      cachedOpenAIKey = key;
      return cachedOpenAIKey;
    }
  } catch {}

  cachedOpenAIKey = null;
  return null;
}

export function isAvailable() {
  return !!getOpenAIApiKey();
}

export async function transcribe(audioBase64, format = "webm", language) {
  const key = getOpenAIApiKey();
  if (!key) throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY.");

  const audioBuffer = Buffer.from(audioBase64, "base64");
  if (audioBuffer.length > MAX_AUDIO_SIZE) {
    throw new Error(`Audio too large (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 25MB.`);
  }

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: `audio/${format}` });
  formData.append("file", blob, `audio.${format}`);
  formData.append("model", "whisper-1");
  formData.append("response_format", "text");
  if (language) formData.append("language", language);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      if (response.status === 401) throw new Error("Invalid OpenAI API key");
      if (response.status === 429) throw new Error("Rate limit exceeded");
      throw new Error(`Transcription failed (${response.status}): ${err}`);
    }

    const text = await response.text();
    return cleanTranscribedText(text);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Transcription timed out");
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}
