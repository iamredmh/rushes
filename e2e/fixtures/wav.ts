// Audio fixtures are generated in code, never downloaded: a mono 16-bit PCM sine WAV.

export interface WavOptions {
  seconds: number;
  /** Tone frequency in Hz. */
  freq: number;
  /** Defaults to 22050 Hz, which keeps fixtures small. */
  sampleRate?: number;
  /** Peak level, 0..1. Defaults to 0.5. */
  amplitude?: number;
}

/** A deterministic mono 16-bit PCM WAV of a sine tone. */
export function makeWav({ seconds, freq, sampleRate = 22050, amplitude = 0.5 }: WavOptions): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + i * 2);
  }
  return buf;
}
