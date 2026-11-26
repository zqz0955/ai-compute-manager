import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseLegacyHistory} from '../src/legacy-history.mjs';
import {readBytes,digest,writeFresh} from './files.mjs';
import {verifyInstallationManifest,marker} from './manifest.mjs';
import {acquireInstallationLock,assertPinned,assertPrivateInstallation,pinPath} from './lock.mjs';

export function importHistory(root,source,expectedSha){
  if (typeof expectedSha!=='string'||! /^[a-f0-9]{64}$/i.test(expectedSha)) throw Error('EXPECTED_SOURCE_SHA256');
  const {contents}=readBytes(source,1024*1024);
  const sha256=digest(contents);
  if (sha256!==expectedSha.toLowerCase()) throw Error('LEGACY_SOURCE_HASH_MISMATCH');
  const parsed=parseLegacyHistory(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contents)));
  const base=pinPath(root,'directory');
  const config=join(base.path,'config.json'),data=pinPath(join(base.path,'data'),'directory');
  assertPrivateInstallation(base.path,[config,join(base.path,marker),data.path]);
  const release=acquireInstallationLock(config);
  try {
    verifyInstallationManifest(base.path);
    assertPinned(base);
    assertPinned(data);
    const path=join(data.path,'legacy-history.json');
    writeFresh(path,fd=>writeFileSync(fd,contents));
    assertPrivateInstallation(base.path,[path]);
    return {sha256,source:parsed.source,tasks:parsed.tasks.length,duals:parsed.duals.length,
      holdsCount:parsed.holdsCount,requestsCount:parsed.requestsCount};
  } finally {release();}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url){
  try{
    if (process.argv.length!==5) throw Error('USAGE_IMPORT_HISTORY_INSTALL_FILE_SHA256');
    console.log(JSON.stringify(importHistory(...process.argv.slice(2))));
  }catch(cause){
    console.error('ACM_IMPORT_HOLD '+(/^[A-Z0-9_]+$/.test(cause.message)?cause.message:'IMPORT_FAILED'));
    process.exitCode=1;
  }
}
