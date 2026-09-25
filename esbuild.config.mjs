import * as esbuild from 'esbuild';

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'main.js',
  logLevel: 'info',
  minify: !process.argv.includes('--watch'),
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
