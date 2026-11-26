"""Portable tests for the reviewed window and authority shape, without Linux writes."""
import importlib.util
import unittest
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parents[1]/'tools/nx-legacy'


def module(name):
    spec=importlib.util.spec_from_file_location(name,DIRECTORY/(name+'.py'))
    item=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(item)
    return item


entry=module('nx-entry')
binder=module('bind-release')


class ScopeTests(unittest.TestCase):
    def approval(self):
        return {'ref':'isolated-approval','managerConsent':True,'workWindowConfirmed':True,
                'purpose':entry.MODE,'notBefore':1000,'expires':2800}

    def test_window(self):
        approval=self.approval()
        entry.check_window(approval,2500)
        for bad in ({'expires':2801},{'managerConsent':False},{'workWindowConfirmed':False},
                    {'purpose':'ORIGINAL_R1'},{'notBefore':True}):
            with self.assertRaisesRegex(RuntimeError,'NX_APPROVAL_WINDOW'):
                entry.check_window({**approval,**bad},2500)
        with self.assertRaisesRegex(RuntimeError,'NX_APPROVAL_WINDOW'):
            entry.check_window(approval,2500.001)

    def test_policy_uses_fresh_desktop_and_explicit_risk_acceptance(self):
        window={**self.approval(), 'acceptForceCharge':True,'acceptNonPSI':True,'acceptParentCPUDelegation':True}
        snapshot={'schema':1,'profile':'ORIN_NX','boot':'fixture-boot','session':{},
                  'holders':[{'role':role,'fds':[0]*count} for role,count in
                             [('Xorg',14),('gnome-shell',5),('xdg-desktop-portal-gnome',5)]],'approval':None}
        device={'hostKeyFingerprint':'SHA256:'+'a'*43,'machineSha256':'b'*64,'boot':'fixture-boot'}
        result=binder.bind(snapshot,window,{'mode':entry.MODE},device,2200)
        self.assertEqual(result['desktop']['approval'],self.approval())
        self.assertIsNone(snapshot['approval'])
        with self.assertRaisesRegex(RuntimeError,'NX_DEVICE_BINDING'):
            binder.bind(snapshot,window,{'mode':entry.MODE},{**device,'boot':'different'},2200)
        with self.assertRaisesRegex(RuntimeError,'NX_APPROVAL_REQUIRED'):
            binder.bind(snapshot,{**window,'acceptForceCharge':False},{'mode':entry.MODE},device,2200)


if __name__=='__main__':
    unittest.main()
