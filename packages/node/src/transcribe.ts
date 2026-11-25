// Speech to text for the app's voice input: OpenAI's transcription (gpt-4o-transcribe) with the
// node user's OpenAI login from ~/.harness/auth.json (an OpenAI Codex subscription or an OpenAI
// API key). HARNESS_TRANSCRIBE_URL and HARNESS_TRANSCRIBE_MODEL point it elsewhere (tests).

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { HarnessError } from "#protocol/errors.ts";

const EXTENSIONS: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-m4a": "m4a" };

async function openaiToken(dataDir: string): Promise<string> {
  const runtime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), refreshOnCreate: false });
  for (const provider of ["openai-codex", "openai"]) {
    const auth = await runtime.getAuth(provider).catch(() => undefined);
    if (auth?.auth.apiKey !== undefined) {
      return auth.auth.apiKey;
    } else {
      // not this one
    }
  }
  throw new HarnessError("not_found", "voice input needs an OpenAI login on this node: /login → OpenAI");
}

export async function transcribe(dataDir: string, audio: Buffer, mime: string): Promise<string> {
  const token = await openaiToken(dataDir);
  const type = mime.split(";")[0] ?? mime;
  const form = new FormData();
  form.set("model", process.env.HARNESS_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe");
  form.set("file", new Blob([new Uint8Array(audio)], { type }), `voice.${EXTENSIONS[type] ?? "webm"}`);
  const response = await fetch(process.env.HARNESS_TRANSCRIBE_URL ?? "https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new HarnessError("agent_failed", `transcription failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  } else {
    const { text } = (await response.json()) as { text?: string };
    return (text ?? "").trim();
  }
}
