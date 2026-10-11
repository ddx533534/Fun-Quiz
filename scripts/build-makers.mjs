// Copy only audited runtime sources into the function bundle; never local data/secrets.
import { cp, mkdir, writeFile } from 'node:fs/promises';
await mkdir('cloud-functions/api', {recursive:true});
await cp('api/main.py','cloud-functions/quiz_api.py');
await cp('engine','cloud-functions/engine',{recursive:true,filter:p=>!p.includes('__pycache__')});
await cp('content','cloud-functions/content',{recursive:true});
await cp('api/requirements.txt','cloud-functions/requirements.txt');
const {readFile}=await import('node:fs/promises');
// Runtime sources live at bundle root rather than repository/api.
let source=await readFile('cloud-functions/quiz_api.py','utf8');
source=source.replace("ROOT = Path(__file__).resolve().parents[1]", "ROOT = Path(__file__).resolve().parent");
await writeFile('cloud-functions/quiz_api.py',source);
await writeFile('cloud-functions/api/index.py',`from fastapi import FastAPI\nfrom quiz_api import app as quiz_app\n\n# Makers strips /api before ASGI dispatch. Add it back for the shared API.\nclass RestorePrefix:\n    async def __call__(self, scope, receive, send):\n        scope = dict(scope)\n        scope['path'] = '/api' + scope.get('path', '/')\n        scope['raw_path'] = scope['path'].encode()\n        await quiz_app(scope, receive, send)\n\napp = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)\napp.mount('/', RestorePrefix())\n`);
console.log('Makers runtime bundle prepared (no credentials).');
