import {readFileSync} from 'node:fs';
import pkg from '../package.json' with {type:'json'};
import lock from '../package-lock.json' with {type:'json'};

const self='acm-rc-source';
const relation=[
  {type:'framework','bom-ref':'controller-node',name:'Node.js',version:'24.22.3',scope:'required',
    externalReferences:[{type:'distribution',url:'https://nodejs.org/en/blog/release/v24.22.3'}],
    properties:[{name:'acm:role',value:'Reference runtime for Windows and Linux controller, externally installed'}]},
  {type:'library','bom-ref':'embedded-sqlite',name:'SQLite',version:'3.54.1',scope:'required',
    properties:[{name:'acm:role',value:'Included by the reference Node.js controller runtime'}]},
  {type:'framework','bom-ref':'agent-node',name:'Node.js',version:'22.23.5',scope:'optional',
    externalReferences:[{type:'distribution',url:'https://nodejs.org/en/blog/release/v22.23.5/'}],
    properties:[{name:'acm:role',value:'Alternative Node.js major for the Linux ARM64 read-only Agent, externally installed'}]},
  {type:'application','bom-ref':'isolated-r1-ollama',name:'Ollama',version:'0.40.16',scope:'optional',
    externalReferences:[{type:'distribution',url:'https://github.com/ollama/ollama/releases/tag/v0.40.16'}],
    properties:[{name:'acm:role',value:'Separate fixed R1 qualification only, excluded from this package'}]},
];
if (lock.lockfileVersion!==3||!lock.packages?.['']||Object.keys(lock.packages).length!==1 ||
    lock.version!==pkg.version) throw Error('DEPENDENCY_INVENTORY_DRIFT');
const bom={bomFormat:'CycloneDX',specVersion:'1.6',version:1,metadata:{
  component:{type:'application','bom-ref':self,name:pkg.name,version:pkg.version},
  properties:[{name:'acm:bundled-npm-components',value:'0'},{name:'acm:distribution-license',value:'Apache-2.0 for project-owned code'}]},
  components:relation,dependencies:[{ref:self,dependsOn:['controller-node','agent-node','isolated-r1-ollama']},
    {ref:'controller-node',dependsOn:['embedded-sqlite']},
    ...['embedded-sqlite','agent-node','isolated-r1-ollama'].map(ref=>({ref,dependsOn:[]}))]};
const output=JSON.stringify(bom,null,2)+'\n';
if (process.argv.length===2) process.stdout.write(output);
else if (process.argv.length===3&&process.argv[2]==='--check'){
  if (readFileSync(new URL('../docs/sbom.cdx.json',import.meta.url),'utf8')!==output) throw Error('SBOM_DRIFT');
  console.log('SBOM_MATCH');
}else throw Error('SBOM_USAGE');
