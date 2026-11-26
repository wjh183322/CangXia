import { defineConfig } from 'vite';
import { fixturePlugin } from './tests/ui-fixture.mjs';
import {serverIdentity} from './shared/server-identity.mjs';
const {version,productName}=serverIdentity;
const versionTitle={name:'cangxia-version-title',transformIndexHtml:html=>html.replaceAll('__CANGXIA_VERSION__',version).replaceAll('__CANGXIA_PRODUCT_NAME__',productName)};
export default defineConfig({ base: './', plugins:[fixturePlugin(),versionTitle], server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/.test-output/**', '**/release/**', '**/*.log'] }, fs:{deny:['**/.git/**','**/.env*','**/.test-output/**']} }, build: { outDir: 'dist' } });
