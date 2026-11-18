// WBI uses MD5, which WebCrypto does not expose. This small implementation hashes UTF-8 input.
const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32));
const permutation = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
export function md5(value: string): string {
  const input = new TextEncoder().encode(value), size = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(size); bytes.set(input); bytes[input.length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(size - 8, input.length * 8, true);
  view.setUint32(size - 4, Math.floor(input.length / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < size; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16);
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c)
        : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const word = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (a + f + constants[i] + view.getUint32(offset + word * 4, true)) | 0;
      const shift = shifts[round * 4 + i % 4], old = d;
      d = c; c = b; b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0; a = old;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].flatMap(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0'))).join('');
}
export function wbiKey(img: unknown, sub: unknown): string {
  const part = (value: unknown) => {
    if (typeof value !== 'string') return '';
    try { return /^([a-f0-9]{32})\.[a-z0-9]+$/i.exec(new URL(value).pathname.split('/').pop() ?? '')?.[1] ?? ''; }
    catch { return ''; }
  };
  const source = part(img) + part(sub);
  if (source.length !== 64) throw new Error('B站签名信息暂不可用');
  return permutation.map(index => source[index]).join('');
}
export function signWbi(params: Record<string, string | number>, key: string, now: number): URLSearchParams {
  const values = { ...params, wts: Math.floor(now / 1000) };
  const query = new URLSearchParams(Object.keys(values).sort().map(name =>
    [name, String(values[name as keyof typeof values]).replace(/[!'()*]/g, '')]));
  query.set('w_rid', md5(query.toString() + key));
  return query;
}
