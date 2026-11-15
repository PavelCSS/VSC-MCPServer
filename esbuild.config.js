const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['src/extension.ts', 'src/proxy.ts'],
    bundle: true,
    outdir: 'dist',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: !isWatch,
};

async function build() {
    if (isWatch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('Watching for changes...');
    } else {
        await esbuild.build(buildOptions);
        console.log('Build complete');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
