import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonBytes, readJson, writeFresh } from './files.mjs';
import { assertPinned, fileIdentity, pinPath } from './lock.mjs';

export const marker = 'install-manifest.json';
export const installationId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export function writeInstallationManifest(root) {
  const rootPin = pinPath(root, 'directory');
  const data = pinPath(join(root, 'data'), 'directory');
  writeFresh(join(root, marker), (fd, manifest) => writeFileSync(fd, jsonBytes({
    version: 1, kind: 'ACM_INSTALLATION', id: randomUUID(),
    rootIdentity: fileIdentity(rootPin.id), dataIdentity: fileIdentity(data.id),
    manifestIdentity: fileIdentity(manifest.id),
  })));
  assertPinned(rootPin);
  assertPinned(data);
}

export function verifyInstallationManifest(root) {
  const rootPin = pinPath(root, 'directory');
  const data = pinPath(join(root, 'data'), 'directory');
  const snapshot = readJson(join(root, marker));
  const entry = snapshot.value;
  if (!entry || entry.version !== 1 || entry.kind !== 'ACM_INSTALLATION' ||
      !installationId.test(entry.id) || Object.keys(entry).length !== 6 ||
      entry.rootIdentity !== fileIdentity(rootPin.id) || entry.dataIdentity !== fileIdentity(data.id) ||
      entry.manifestIdentity !== fileIdentity(snapshot.pin.id)) {
    throw new Error('INSTALLATION_IDENTITY_UNVERIFIED');
  }
  assertPinned(rootPin);
  assertPinned(data);
  return snapshot;
}
