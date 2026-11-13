import zlib from 'node:zlib';
import crypto from 'node:crypto';

const BLOCK_SIZE = 512;

/**
 * Creates a standard POSIX ustar tar header buffer.
 */
function createHeader(filename, size, mtime = Math.floor(Date.now() / 1000), mode = 0o644) {
  const buf = Buffer.alloc(BLOCK_SIZE, 0);

  let prefix = '';
  let name = filename;

  if (Buffer.byteLength(filename, 'utf8') > 100) {
    const slashIdx = filename.indexOf('/');
    if (slashIdx !== -1 && slashIdx <= 155) {
      prefix = filename.slice(0, slashIdx);
      name = filename.slice(slashIdx + 1);
    }
  }

  // 0..99: name
  buf.write(name, 0, 100, 'utf8');

  // 100..107: mode (6 octal + null + space)
  buf.write(mode.toString(8).padStart(6, '0') + '\0 ', 100, 8, 'ascii');

  // 108..115: uid
  buf.write('000000\0 ', 108, 8, 'ascii');

  // 116..123: gid
  buf.write('000000\0 ', 116, 8, 'ascii');

  // 124..135: size (11 octal digits + space)
  buf.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');

  // 136..147: mtime (11 octal digits + space)
  buf.write(mtime.toString(8).padStart(11, '0') + ' ', 136, 12, 'ascii');

  // 148..155: chksum placeholder (8 spaces)
  buf.write('        ', 148, 8, 'ascii');

  // 156: typeflag ('0' = regular file)
  buf[156] = 0x30;

  // 257..262: magic ("ustar\0")
  buf.write('ustar\0', 257, 6, 'ascii');

  // 263..264: version ("00")
  buf.write('00', 263, 2, 'ascii');

  // 265..296: uname
  buf.write('root\0', 265, 32, 'ascii');

  // 297..328: gname
  buf.write('root\0', 297, 32, 'ascii');

  // 345..499: prefix
  if (prefix) {
    buf.write(prefix, 345, 155, 'utf8');
  }

  // Calculate checksum
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += buf[i];
  }

  // 148..155: 6 octal digits + null + space
  const chksumStr = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(chksumStr, 148, 8, 'ascii');

  return buf;
}

/**
 * Packs an array of files into a .tar.gz Buffer.
 * @param {Array<{path: string, content: string|Buffer, mtime?: number}>} files
 * @returns {Buffer} Compressed .tar.gz buffer
 */
export function createTarGz(files) {
  const buffers = [];

  for (const file of files) {
    const contentBuf = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content || '', 'utf8');

    const header = createHeader(file.path, contentBuf.length, file.mtime);
    buffers.push(header);
    buffers.push(contentBuf);

    // Padding to 512 bytes boundary
    const remainder = contentBuf.length % BLOCK_SIZE;
    if (remainder > 0) {
      buffers.push(Buffer.alloc(BLOCK_SIZE - remainder, 0));
    }
  }

  // End of archive: two 512-byte zero blocks
  buffers.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  const tarBuffer = Buffer.concat(buffers);
  return zlib.gzipSync(tarBuffer);
}

/**
 * Extracts raw tar buffer if gzipped, else returns input buffer.
 */
function toTarBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return zlib.gunzipSync(buffer);
  }
  return buffer;
}

/**
 * Extracts and inspects files in a .tar or .tar.gz Buffer.
 * @param {Buffer} archiveBuffer
 * @returns {Array<{path: string, sizeBytes: number, isUci: boolean, content?: Buffer}>}
 */
export function extractTarGz(archiveBuffer, includeContent = false) {
  const tarBuf = toTarBuffer(archiveBuffer);
  const files = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + BLOCK_SIZE);

    // Check for two consecutive empty blocks (end of archive)
    let isAllZero = true;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) {
      break;
    }

    // Read filename
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '').trim();
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '').trim();
    if (prefix) {
      name = `${prefix}/${name}`;
    }

    // Clean leading slashes or ./
    name = name.replace(/^(\.\/|\/)+/, '');

    // Read size
    const sizeStr = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Read type flag
    const typeflag = header[156];
    const isDir = typeflag === 0x35 || name.endsWith('/');

    const dataOffset = offset + BLOCK_SIZE;
    if (!isDir && name) {
      const isUci = name.startsWith('etc/config/');
      const fileEntry = {
        path: name,
        sizeBytes: size,
        isUci,
      };
      if (includeContent) {
        fileEntry.content = tarBuf.subarray(dataOffset, dataOffset + size);
      }
      files.push(fileEntry);
    }

    // Advance offset
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    offset = dataOffset + paddedSize;
  }

  return files;
}

/**
 * Reads a single file from a .tar or .tar.gz Buffer without extracting everything.
 * @param {Buffer} archiveBuffer
 * @param {string} targetPath
 * @returns {string|null} UTF-8 text content or null if not found
 */
export function getFileContentFromTarGz(archiveBuffer, targetPath) {
  const normalizedTarget = targetPath.replace(/^(\.\/|\/)+/, '');
  const files = extractTarGz(archiveBuffer, true);
  const match = files.find((f) => f.path === normalizedTarget);
  if (!match || !match.content) {
    return null;
  }
  return match.content.toString('utf8');
}

/**
 * Computes SHA-256 hash of a buffer.
 */
export function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
