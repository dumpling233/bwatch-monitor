/** The public live Dm protobuf projection; identity and other business data are deliberately not decoded. */
export interface DanmakuV2Emoticon {
  unique?: string;
  url?: string;
  is_dynamic?: boolean;
  in_player_area?: number;
  bulge_display?: number;
  height?: number;
  width?: number;
}

export interface DecodedDanmakuV2 {
  content?: string;
  dmType?: number;
  emoticons: Record<string, DanmakuV2Emoticon>;
}

export const DANMAKU_V2_LIMITS = Object.freeze({
  bytes: 64 * 1024,
  fields: 512,
  emoticons: 32,
  strings: 16 * 1024,
  content: 2048,
  key: 256,
  unique: 128,
  url: 1024,
  dimension: 4096,
});

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
type Budget = { fields: number; strings: number };

class WireReader {
  private position: number;
  constructor(private bytes: Uint8Array, start: number, private end: number, private budget: Budget) {
    this.position = start;
  }
  get done(): boolean { return this.position === this.end; }
  private invalid(): never { throw new Error('Invalid live Dm projection'); }
  private take(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.end - this.position) this.invalid();
    const start = this.position;
    this.position += length;
    return start;
  }
  unsigned(max?: number): number {
    let result = 0, factor = 1;
    for (let index = 0; index < 10; index++) {
      const byte = this.bytes[this.take(1)];
      if (index === 9 && byte > 1) this.invalid();
      if (max !== undefined) {
        result += (byte & 0x7f) * factor;
        if (!Number.isSafeInteger(result) || result > max) this.invalid();
        factor *= 128;
      }
      if (!(byte & 0x80)) {
        if (index && byte === 0) this.invalid();
        return result;
      }
    }
    return this.invalid();
  }
  field(): { number: number; wire: number } {
    if (++this.budget.fields > DANMAKU_V2_LIMITS.fields) this.invalid();
    const tag = this.unsigned(0xffffffff), number = tag >>> 3, wire = tag & 7;
    if (!number || ![0, 1, 2, 5].includes(wire)) this.invalid();
    return { number, wire };
  }
  expect(actual: number, wanted: number): void { if (actual !== wanted) this.invalid(); }
  string(max: number): string {
    const length = this.unsigned(this.end - this.position);
    if (length > max || (this.budget.strings += length) > DANMAKU_V2_LIMITS.strings) this.invalid();
    const start = this.take(length);
    return utf8.decode(this.bytes.subarray(start, start + length));
  }
  child(): WireReader {
    const length = this.unsigned(this.end - this.position), start = this.take(length);
    return new WireReader(this.bytes, start, start + length, this.budget);
  }
  skip(wire: number): void {
    if (wire === 0) this.unsigned();
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.take(this.unsigned(this.end - this.position));
    else if (wire === 5) this.take(4);
    else this.invalid();
  }
}

function emoticon(reader: WireReader): DanmakuV2Emoticon {
  const result: DanmakuV2Emoticon = {}, seen = new Set<number>();
  while (!reader.done) {
    const { number, wire } = reader.field();
    if (number < 1 || number > 7) { reader.skip(wire); continue; }
    if (seen.has(number)) throw new Error('Duplicate live emoticon field');
    seen.add(number);
    reader.expect(wire, number <= 2 ? 2 : 0);
    if (number === 1) result.unique = reader.string(DANMAKU_V2_LIMITS.unique);
    else if (number === 2) result.url = reader.string(DANMAKU_V2_LIMITS.url);
    else if (number === 3) result.is_dynamic = Boolean(reader.unsigned(1));
    else if (number === 4) result.in_player_area = reader.unsigned(1);
    else if (number === 5) result.bulge_display = reader.unsigned(1);
    else if (number === 6) result.height = reader.unsigned(DANMAKU_V2_LIMITS.dimension);
    else result.width = reader.unsigned(DANMAKU_V2_LIMITS.dimension);
  }
  return result;
}

function entry(reader: WireReader): [string, DanmakuV2Emoticon] {
  let key: string | undefined, value: DanmakuV2Emoticon | undefined;
  while (!reader.done) {
    const { number, wire } = reader.field();
    if (number === 1) {
      reader.expect(wire, 2);
      if (key !== undefined) throw new Error('Duplicate live emoticon key');
      key = reader.string(DANMAKU_V2_LIMITS.key);
    } else if (number === 2) {
      reader.expect(wire, 2);
      if (value !== undefined) throw new Error('Duplicate live emoticon value');
      value = emoticon(reader.child());
    } else reader.skip(wire);
  }
  if (!key || forbiddenKeys.has(key) || !value) throw new Error('Invalid live emoticon entry');
  return [key, value];
}

/** Decode atomically: malformed or over-budget data cannot partially replace the legacy message. */
export function decodeDanmakuV2(value: unknown): DecodedDanmakuV2 | undefined {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(DANMAKU_V2_LIMITS.bytes / 3) * 4 || value.length % 4) return undefined;
  if (/[^A-Za-z0-9+/=]/.test(value)) return undefined;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.indexOf('=') !== (padding ? value.length - padding : -1)) return undefined;
  if (value.length / 4 * 3 - padding > DANMAKU_V2_LIMITS.bytes) return undefined;
  // Reject alternate encodings with non-zero unused bits before allocating.
  if (padding && (alphabet.indexOf(value[value.length - padding - 1]) & (padding === 2 ? 15 : 3))) return undefined;
  try {
    const binary = atob(value), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const reader = new WireReader(bytes, 0, bytes.length, { fields: 0, strings: 0 });
    const result: DecodedDanmakuV2 = { emoticons: Object.create(null) as Record<string, DanmakuV2Emoticon> };
    let count = 0;
    while (!reader.done) {
      const { number, wire } = reader.field();
      if (number === 6) {
        reader.expect(wire, 2);
        if (result.content !== undefined) return undefined;
        result.content = reader.string(DANMAKU_V2_LIMITS.content);
      } else if (number === 13) {
        reader.expect(wire, 0);
        if (result.dmType !== undefined) return undefined;
        result.dmType = reader.unsigned(255);
      } else if (number === 14) {
        reader.expect(wire, 2);
        if (++count > DANMAKU_V2_LIMITS.emoticons) return undefined;
        const [key, image] = entry(reader.child());
        if (Object.hasOwn(result.emoticons, key)) return undefined;
        result.emoticons[key] = image;
      } else reader.skip(wire);
    }
    return result;
  } catch { return undefined; }
}
