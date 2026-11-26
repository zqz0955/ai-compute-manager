import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { absoluteLocalPath, assertPinned, pinPath, readFlags, sameIdentity } from './lock.mjs';

const jsonLimit = 1_048_576;
export const digest = contents => createHash('sha256').update(contents).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export function consumeFile(input, limit, consume) {
  const pin = pinPath(input, 'file');
  if (pin.id.size > BigInt(limit)) throw new Error('LOCAL_FILE_SIZE_LIMIT');
  const fd = openSync(pin.path, readFlags);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(pin.id, opened) || opened.nlink !== 1n) throw new Error('FILE_IDENTITY_CHANGED');
    const result = consume(fd, Number(pin.id.size), pin);
    const current = assertPinned(pin);
    if (current.nlink !== 1n || current.size !== pin.id.size ||
        current.mtimeNs !== pin.id.mtimeNs || current.ctimeNs !== pin.id.ctimeNs) throw new Error('FILE_CHANGED_DURING_READ');
    return result;
  } finally {
    closeSync(fd);
  }
}

export function writeFresh(input, write) {
  const path = absoluteLocalPath(input);
  const parent = pinPath(dirname(path), 'directory');
  const fd = openSync(path, 'wx', 0o600);
  const id = fstatSync(fd, { bigint: true });
  let complete = false;
  try {
    assertPinned(parent);
    const pin = pinPath(path, 'file');
    if (!sameIdentity(id, pin.id)) throw new Error('FILE_IDENTITY_CHANGED');
    write(fd, pin);
    fsyncSync(fd);
    assertPinned(pin);
    complete = true;
    return pin;
  } finally {
    closeSync(fd);
    if (!complete) {
      assertPinned(parent);
      if (sameIdentity(id, pinPath(path, 'file').id)) unlinkSync(path);
    }
  }
}

function readChunks(fd, size, consume) {
  const buffer = Buffer.allocUnsafe(Math.min(65_536, size));
  let remaining = size;
  while (remaining > 0) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
    if (count === 0) throw new Error('FILE_CHANGED_DURING_READ');
    consume(buffer.subarray(0, count));
    remaining -= count;
  }
}

export function snapshotFile(source, limit, destination) {
  const read = target => consumeFile(source, limit, (fd, size, pin) => {
    const hash = createHash('sha256');
    readChunks(fd, size, chunk => {
      hash.update(chunk);
      if (target !== undefined) writeFileSync(target, chunk);
    });
    return { pin, bytes: size, sha256: hash.digest('hex') };
  });
  if (destination === undefined) return read();
  let result;
  writeFresh(destination, fd => { result = read(fd); });
  return result;
}

export function readBytes(input, limit) {
  return consumeFile(input, limit, (fd, size, pin) => {
    const chunks = [];
    readChunks(fd, size, chunk => chunks.push(Buffer.from(chunk)));
    return { pin, contents: Buffer.concat(chunks, size) };
  });
}

export function readJson(input) {
  const { pin, contents } = readBytes(input, jsonLimit);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  } catch {
    throw new Error('INVALID_JSON_FILE');
  }
  return { pin, value, sha256: digest(contents) };
}

export function writeNewJson(input, value) {
  const bytes = jsonBytes(value);
  if (bytes.length > jsonLimit) throw new Error('LOCAL_FILE_SIZE_LIMIT');
  return writeFresh(input, fd => writeFileSync(fd, bytes));
}

export function replaceJson(previous, value) {
  const path = previous.pin.path;
  const temp = join(dirname(path), '.replacement-' + randomUUID());
  const staged = writeNewJson(temp, value);
  let renamed = false;
  try {
    assertPinned(staged);
    assertPinned(previous.pin);
    if (snapshotFile(path, jsonLimit).sha256 !== previous.sha256) throw new Error('FILE_CONTENT_CHANGED');
    renameSync(temp, path);
    renamed = true;
    if (!sameIdentity(staged.id, pinPath(path, 'file').id)) throw new Error('FILE_IDENTITY_CHANGED');
  } finally {
    if (!renamed) {
      assertPinned(staged);
      unlinkSync(temp);
    }
  }
}
