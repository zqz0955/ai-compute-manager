import pkg from '../package.json' with {type:'json'};
import lock from '../package-lock.json' with {type:'json'};

const sections=['dependencies','devDependencies','optionalDependencies','peerDependencies','overrides'];
const root=lock.packages?.[''];
if (lock.lockfileVersion!==3 || !root || Object.keys(lock.packages).length!==1 ||
    pkg.name!==lock.name || pkg.version!==lock.version || pkg.version!==root.version ||
    sections.some(key=>Object.keys(pkg[key]??{}).length || Object.keys(root[key]??{}).length))
  throw Error('DEPENDENCY_REVIEW_REQUIRED');
if (!process.versions.sqlite || !/^24\./.test(process.versions.node)) throw Error('REVIEW_RUNTIME_REQUIRED');
console.log(JSON.stringify({status:'NO_NPM_DEPENDENCIES',node:process.versions.node,sqlite:process.versions.sqlite}));
