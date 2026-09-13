import { defineConfig } from 'vite';
import { fixturePlugin } from './tests/ui-fixture.mjs';
export default defineConfig({ base: './', plugins:[fixturePlugin()], server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/.test-output/**', '**/release/**', '**/*.log'] }, fs:{deny:['**/.git/**','**/.env*','**/.test-output/**']} }, build: { outDir: 'dist' } });
