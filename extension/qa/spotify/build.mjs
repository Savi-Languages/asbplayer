import { build } from 'esbuild';
await build({
    entryPoints: ['extension/qa/spotify/fixture.ts'],
    bundle: true,
    outfile: 'extension/qa/spotify/fixture.js',
    platform: 'browser',
});
