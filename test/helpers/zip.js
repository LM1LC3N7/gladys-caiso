// A ZIP of one file, as OASIS sends (tests only): stored, or deflated with
// zlib's raw deflate. Built by hand so that the tests can also break it.
import { deflateRawSync } from 'node:zlib';
import { CENTRAL, EOCD, LOCAL, crc32 } from '../../src/zip.js';

/** `data`: a Buffer or a string; `deflate: false` stores it. */
export function zipOne(name, input, { deflate = true } = {}) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const nameBytes = Buffer.from(name, 'latin1');
  const body = deflate ? deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const cdOffset = 30 + nameBytes.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}
