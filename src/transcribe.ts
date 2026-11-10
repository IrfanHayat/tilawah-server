import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { unlink, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export type AsrProvider = 'local' | 'huggingface' | 'selfhost' | 'openai' | 'none';

const DEFAULT_MODEL = 'tarteel-ai/whisper-base-ar-quran';

export function asrStatus() {
  return {
    provider: chosenProvider(),
    local: chosenProvider() === 'local' ? (localReady ? 'ready' : 'loading') : 'off',
    model: process.env.HF_MODEL || DEFAULT_MODEL,
    huggingface: Boolean(process.env.HF_TOKEN),
    selfhost: Boolean(process.env.SELFHOST_ASR_URL),
    openai: Boolean(process.env.OPENAI_API_KEY),
  };
}

export function chosenProvider(): AsrProvider {
  const explicit = (process.env.TRANSCRIPTION_PROVIDER || 'auto').toLowerCase();
  if (explicit === 'local') return 'local';
  if (explicit === 'huggingface') return process.env.HF_TOKEN ? 'huggingface' : 'none';
  if (explicit === 'selfhost') return process.env.SELFHOST_ASR_URL ? 'selfhost' : 'none';
  if (explicit === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : 'none';
  if (process.env.HF_TOKEN) return 'huggingface';
  if (process.env.SELFHOST_ASR_URL) return 'selfhost';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

export class AsrNotConfiguredError extends Error {
  constructor() {
    super(
      'Transcription is not configured. Set HF_TOKEN for the free Hugging Face model tarteel-ai/whisper-base-ar-quran, or SELFHOST_ASR_URL for the Python service in server/asr. OPENAI_API_KEY is optional.',
    );
  }
}

async function toWav(audio: Buffer, extension: string) {
  const id = randomBytes(8).toString('hex');
  const source = join(tmpdir(), `tilawah-${id}${extension.startsWith('.') ? extension : `.${extension}`}`);
  const target = join(tmpdir(), `tilawah-${id}.wav`);
  await writeFile(source, audio);
  const code = await new Promise<number>((resolve) => {
    const child = spawn('ffmpeg', ['-y', '-i', source, '-ar', '16000', '-ac', '1', target], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (status) => resolve(status ?? -1));
  });
  await unlink(source).catch(() => {});
  if (code !== 0) {
    await unlink(target).catch(() => {});
    return null;
  }
  const wav = await readFile(target);
  await unlink(target).catch(() => {});
  return wav;
}

function transcriptFrom(body: string) {
  try {
    const json = JSON.parse(body) as { text?: string; transcript?: string; error?: string };
    return json.text || json.transcript || '';
  } catch {
    return '';
  }
}

async function huggingface(audio: Buffer, mime: string) {
  const token = process.env.HF_TOKEN || '';
  const model = process.env.HF_MODEL || DEFAULT_MODEL;
  const urls = [
    process.env.HF_INFERENCE_URL,
    `https://router.huggingface.co/hf-inference/models/${model}`,
    `https://api-inference.huggingface.co/models/${model}`,
  ].filter((url): url is string => Boolean(url));
  let last = 'Hugging Face did not return a transcript.';
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mime,
          Accept: 'application/json',
        },
        body: new Uint8Array(audio),
      });
      const body = await response.text();
      if (response.status === 503 && /loading/i.test(body) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 8000));
        continue;
      }
      if (!response.ok) {
        last = body.slice(0, 400) || `Hugging Face returned ${response.status}`;
        break;
      }
      const text = transcriptFrom(body);
      if (text) return text;
      last = body.slice(0, 400) || 'Empty transcript';
      break;
    }
  }
  throw new Error(last);
}

const LOCAL_MODEL = process.env.LOCAL_ASR_MODEL || 'Mustanad/whisper-base-ar-quran-onnx';
let localReady = false;
let localPipe: Promise<any> | null = null;

function loadLocal() {
  if (!localPipe) {
    localPipe = (async () => {
      const t: any = await import('@huggingface/transformers');
      t.env.cacheDir = process.env.MODEL_CACHE_DIR || '/tmp/hf-models';
      const pipe = await t.pipeline('automatic-speech-recognition', LOCAL_MODEL, {
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        subfolder: 'onnx',
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false },
      });
      localReady = true;
      return pipe;
    })().catch((error) => {
      localPipe = null;
      throw error;
    });
  }
  return localPipe;
}

export function warmLocalAsr() {
  if (chosenProvider() === 'local') loadLocal().catch((e) => console.error('Local ASR load failed', e));
}

async function toFloat32(audio: Buffer, extension: string) {
  const id = randomBytes(8).toString('hex');
  const source = join(tmpdir(), `tilawah-${id}${extension.startsWith('.') ? extension : `.${extension}`}`);
  const target = join(tmpdir(), `tilawah-${id}.f32`);
  await writeFile(source, audio);
  const code = await new Promise<number>((resolve) => {
    const child = spawn('ffmpeg', ['-y', '-i', source, '-ar', '16000', '-ac', '1', '-f', 'f32le', target], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (status) => resolve(status ?? -1));
  });
  await unlink(source).catch(() => {});
  if (code !== 0) {
    await unlink(target).catch(() => {});
    throw new Error('Could not read the recording audio.');
  }
  const raw = await readFile(target);
  await unlink(target).catch(() => {});
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4)).slice();
}

async function local(audio: Buffer, extension: string) {
  const pipe = await loadLocal();
  const samples = await toFloat32(audio, extension);
  const out = await pipe(samples, { chunk_length_s: 30, stride_length_s: 5 });
  const text = Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text;
  if (!text) throw new Error('Local ASR returned an empty transcript.');
  return String(text);
}

async function selfhost(audio: Buffer, mime: string) {
  const url = process.env.SELFHOST_ASR_URL || '';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'recitation.wav');
  const response = await fetch(url, { method: 'POST', body: form });
  const body = await response.text();
  if (!response.ok) throw new Error(body.slice(0, 400) || `Self-hosted ASR returned ${response.status}`);
  const text = transcriptFrom(body);
  if (!text) throw new Error('Self-hosted ASR returned an empty transcript.');
  return text;
}

async function openai(audio: Buffer, mime: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'recitation.wav');
  form.append('model', 'whisper-1');
  form.append('language', 'ar');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body.slice(0, 400) || `OpenAI returned ${response.status}`);
  const text = transcriptFrom(body);
  if (!text) throw new Error('OpenAI returned an empty transcript.');
  return text;
}

export async function transcribe(audio: Buffer, filename: string) {
  const provider = chosenProvider();
  if (provider === 'none') throw new AsrNotConfiguredError();
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.m4a';
  if (provider === 'local') {
    return { text: (await local(audio, extension)).trim(), provider, model: LOCAL_MODEL };
  }
  const wav = await toWav(audio, extension);
  const payload = wav ?? audio;
  const mime = wav ? 'audio/wav' : 'application/octet-stream';
  const text =
    provider === 'huggingface' ? await huggingface(payload, mime) : provider === 'selfhost' ? await selfhost(payload, mime) : await openai(payload, mime);
  return { text: text.trim(), provider, model: provider === 'openai' ? 'whisper-1' : process.env.HF_MODEL || DEFAULT_MODEL };
}
