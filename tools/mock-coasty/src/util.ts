/**
 * Shared helpers for the mock Coasty server: ids, the documented error
 * envelope, HMAC signatures, and an in-process PNG generator (node:zlib only)
 * for machine screenshots.
 */
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { FastifyReply } from 'fastify';

export const hex = (n: number): string => randomBytes(n).toString('hex');
export const requestId = (): string => `req_${hex(4)}`;
export const nowIso = (): string => new Date().toISOString();

export function bodyHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/** `t=<unix>,v1=<hmacSha256Hex(secret, t + '.' + body)>` per the docs. */
export function buildSignature(secret: string, body: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

const ERROR_TYPES: Record<number, string> = {
  400: 'validation_error',
  401: 'auth_error',
  402: 'billing_error',
  403: 'auth_error',
  404: 'not_found_error',
  409: 'state_error',
  413: 'validation_error',
  422: 'validation_error',
  429: 'rate_limit_error',
  500: 'server_error',
  503: 'server_error',
  504: 'server_error',
};

/** Send the documented error envelope. Returns reply for chaining/return. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extras: Record<string, unknown> = {},
): FastifyReply {
  const rid = requestId();
  void reply.header('X-Coasty-Request-Id', rid);
  if (status === 401) void reply.header('WWW-Authenticate', 'Bearer');
  return reply.status(status).send({
    error: {
      code,
      message,
      type: ERROR_TYPES[status] ?? 'server_error',
      request_id: rid,
      suggestion: suggestionFor(code),
      docs_url: `https://coasty.ai/api-docs#errors`,
      ...extras,
    },
  });
}

function suggestionFor(code: string): string {
  switch (code) {
    case 'INVALID_API_KEY':
      return 'Send a raw sk-coasty-live-/sk-coasty-test- key in X-API-Key, or Authorization: Bearer <key>.';
    case 'INSUFFICIENT_CREDITS':
      return "Top up at https://coasty.ai/credits, or switch to a sandbox key 'sk-coasty-test-...' for free testing.";
    case 'WALLET_EXHAUSTED':
      return 'Top up, then start a new run.';
    default:
      return 'See the docs for details.';
  }
}

/**
 * Generate a real, decodable PNG (8-bit RGB) entirely in-process. A moving
 * color band keyed on `frame` makes consecutive screenshots differ, so live
 * screen views visibly update.
 */
export function generatePng(width: number, height: number, frame: number): Buffer {
  const bytesPerRow = width * 3 + 1; // +1 filter byte
  const raw = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      const band = Math.floor(((x + frame * 7) % width) / (width / 8));
      raw[i] = (band * 32 + y) & 0xff; // R
      raw[i + 1] = (60 + band * 20) & 0xff; // G
      raw[i + 2] = (160 - band * 12 + frame * 3) & 0xff; // B
    }
  }

  const chunks: Buffer[] = [];
  const png = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(png('IHDR', ihdr));
  chunks.push(png('IDAT', deflateSync(raw)));
  chunks.push(png('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
