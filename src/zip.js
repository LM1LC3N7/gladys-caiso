// -----------------------------------------------------------------------------
// The one file of an OASIS ZIP (pure): read from the central directory,
// stored or deflated, never inflated beyond a cap (a ZIP bomb is cut), its
// length and CRC-32 checked. Anything else is a FormatError: never a guess.
// -----------------------------------------------------------------------------

import { inflateRawSync } from 'node:zlib';
import { FormatError } from './outlook.js';

export const EOCD = 0x06054b50;
export const CENTRAL = 0x02014b50;
export const LOCAL = 0x04034b50;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Buffer} zip
 * @param {number} maxBytes the cap of the unpacked file
 * @returns {{ name: string, data: Buffer }}
 */
export function unzipOne(zip, maxBytes) {
  if (!Buffer.isBuffer(zip) || zip.length < 22) throw new FormatError('not a ZIP');
  // The end of central directory record: the last 22 bytes, or before a comment (64 KB at most).
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new FormatError('not a ZIP');
  const entries = zip.readUInt16LE(end + 10);
  const cdOffset = zip.readUInt32LE(end + 16);
  if (entries !== 1) throw new FormatError(`${entries} files in the ZIP`);
  if (cdOffset + 46 > end || zip.readUInt32LE(cdOffset) !== CENTRAL) {
    throw new FormatError('bad central directory');
  }
  const flags = zip.readUInt16LE(cdOffset + 8);
  const method = zip.readUInt16LE(cdOffset + 10);
  const crc = zip.readUInt32LE(cdOffset + 16);
  const packed = zip.readUInt32LE(cdOffset + 20);
  const size = zip.readUInt32LE(cdOffset + 24);
  const nameLength = zip.readUInt16LE(cdOffset + 28);
  const localOffset = zip.readUInt32LE(cdOffset + 42);
  if (cdOffset + 46 + nameLength > end) throw new FormatError('bad central directory');
  const name = zip.toString('latin1', cdOffset + 46, cdOffset + 46 + nameLength);
  if (flags & 0x1) throw new FormatError('protected entry');
  if (size > maxBytes) throw new FormatError('file too large');
  if (localOffset + 30 > cdOffset || zip.readUInt32LE(localOffset) !== LOCAL) {
    throw new FormatError('bad local header');
  }
  const start =
    localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  if (start + packed > cdOffset) throw new FormatError('truncated entry');
  const body = zip.subarray(start, start + packed);
  let data;
  if (method === 0) {
    data = Buffer.from(body);
  } else if (method === 8) {
    try {
      data = inflateRawSync(body, { maxOutputLength: maxBytes });
    } catch {
      throw new FormatError('cannot inflate');
    }
  } else {
    throw new FormatError(`method ${method}`);
  }
  if (data.length !== size || crc32(data) !== crc) throw new FormatError('bad length or CRC');
  return { name, data };
}
