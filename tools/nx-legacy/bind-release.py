"""Create a root-policy payload from the reviewed desktop projection and explicit consent."""
import hashlib
import json
from pathlib import Path
import re
import sys
import time

MODE='LEGACY_KERNEL_BOUNDED_CPU_V1'


def need(condition,code):
    if not condition:
        raise RuntimeError(code)


def bind(snapshot, approval, manifest, device, now):
    need(set(snapshot)=={'schema','profile','boot','session','holders','approval'} and snapshot['schema']==1 and
         snapshot['profile']=='ORIN_NX' and snapshot['approval'] is None and
         [h['role'] for h in snapshot['holders']]==['Xorg','gnome-shell','xdg-desktop-portal-gnome'] and
         sum(len(h['fds']) for h in snapshot['holders'])==24,'NX_SNAPSHOT_SHAPE')
    need(set(approval)=={'ref','managerConsent','workWindowConfirmed','purpose','notBefore','expires',
                        'acceptForceCharge','acceptNonPSI','acceptParentCPUDelegation'} and
         approval['purpose']==MODE and all(approval[x] is True for x in ('managerConsent','workWindowConfirmed',
              'acceptForceCharge','acceptNonPSI','acceptParentCPUDelegation')) and
         isinstance(approval['ref'],str) and 0<len(approval['ref'].strip())<=160 and
         type(approval['notBefore']) is int and type(approval['expires']) is int and
         approval['notBefore']<=now<=approval['expires']-375 and
         approval['expires']-approval['notBefore']<=1800,'NX_APPROVAL_REQUIRED')
    need(set(device)=={'hostKeyFingerprint','machineSha256','boot'} and device['boot']==snapshot['boot'] and
         re.fullmatch('[a-f0-9]{64}',device['machineSha256']) and
         re.fullmatch('SHA256:[A-Za-z0-9+/]{43}',device['hostKeyFingerprint']),'NX_DEVICE_BINDING')
    need(manifest['mode']==MODE,'NX_RELEASE_MODE')
    risk=('acceptForceCharge','acceptNonPSI','acceptParentCPUDelegation')
    return {'mode':MODE,'machineSha256':device['machineSha256'],'hostKeyFingerprint':device['hostKeyFingerprint'],
            'desktop':{**snapshot,'approval':{k:v for k,v in approval.items() if k not in risk}},
            **{k:approval[k] for k in risk}}


if __name__=='__main__':
    need(len(sys.argv)==6,'USAGE desktop.json approval.json files.json device.json new-release.json')
    snapshot,approval,manifest,device,output=map(Path,sys.argv[1:])
    raw=manifest.read_bytes()
    value=bind(json.loads(snapshot.read_bytes()),json.loads(approval.read_bytes()),json.loads(raw),
               json.loads(device.read_bytes()),time.time())
    value['manifestSha256']=hashlib.sha256(raw).hexdigest()
    body=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    with output.open('xb') as file:
        file.write(body)
    print(json.dumps({'status':'LOCAL_BOUND_POLICY','policySha256':hashlib.sha256(body).hexdigest(),
                      'manifestSha256':value['manifestSha256']}))
