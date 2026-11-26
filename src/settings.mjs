import {existsSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {validateConfig,validateTokens} from '../tools/config.mjs';
import {readJson,snapshotFile} from '../tools/files.mjs';
import {inventoryData,storageSealName,writeStorageSeal} from '../tools/storage.mjs';
import {verifyInstallationManifest,marker} from '../tools/manifest.mjs';
import {acquireInstallationLock,assertPinned,assertPrivateInstallation,pinPath,sameIdentity} from '../tools/lock.mjs';
import {parseLegacyHistory} from './legacy-history.mjs';

const snapshotLimit=1024*1024;

export function openSettings(configPath,{requiredConfigSha256}={}){
  const config=pinPath(configPath,'file');
  if (basename(config.path)!=='config.json') throw Error('EXPECTED_CONFIG_JSON');
  const root=dirname(config.path);
  const tokenPath=join(root,'tokens.json');
  const data=pinPath(join(root,'data'),'directory');
  const archivePath=join(data.path,'legacy-history.json');
  const paths=[config.path,tokenPath,join(root,marker),data.path];
  assertPrivateInstallation(root,paths);
  const release=acquireInstallationLock(config.path);
  try {
    const manifest=verifyInstallationManifest(root);
    const layout=inventoryData(root);
    const sealPath=join(root,storageSealName);
    const configFile=readJson(config.path),tokenFile=readJson(tokenPath);
    if (!sameIdentity(config.id,configFile.pin.id)) throw Error('INSTALLATION_SETTINGS_CHANGED');
    if (requiredConfigSha256!==undefined&&requiredConfigSha256!==configFile.sha256) throw Error('REVIEWED_CONFIGURATION_CHANGED');
    const options=validateConfig(configFile.value);
    const {tokens}=validateTokens(tokenFile.value);
    const archive=existsSync(archivePath)?readJson(archivePath):null;
    const legacy=archive?parseLegacyHistory(archive.value):null;
    let seal=layout.files.includes(storageSealName)?readJson(sealPath):null;
    const files=[manifest,configFile,tokenFile,...(archive?[archive]:[])];
    if (seal) files.push(seal);
    function recordStorageReady(){
      if (seal) return;
      // 開始接收請求前，把資料庫曾啟用的證據留在資料目錄之外。
      writeStorageSeal(root);
      seal=readJson(sealPath);
      files.push(seal);
    }
    function verifyRegistry(){
      try {
        assertPinned(data);
        if (existsSync(archivePath)!==Boolean(archive) || existsSync(sealPath)!==Boolean(seal)) return false;
        return files.every(file=>{
          const current=snapshotFile(file.pin.path,snapshotLimit);
          assertPinned(file.pin);
          return sameIdentity(file.pin.id,current.pin.id) && file.sha256===current.sha256;
        });
      } catch {return false;}
    }
    if (!verifyRegistry()) throw Error('INSTALLATION_SETTINGS_CHANGED');
    return {options,tokens,legacy,dataDir:data.path,verifyRegistry,recordStorageReady,release};
  } catch(cause){
    release();
    throw cause;
  }
}
