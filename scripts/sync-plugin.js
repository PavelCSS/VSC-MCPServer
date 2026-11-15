const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pluginDir = path.resolve(root, '..', 'my-claude-marketplace', 'plugins', 'vsc-mcp');

if (!fs.existsSync(pluginDir)) {
    console.error(`Plugin directory not found: ${pluginDir}`);
    process.exit(1);
}

fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(pluginDir, 'extension'), { recursive: true });

fs.copyFileSync(path.join(root, 'dist', 'proxy.js'), path.join(pluginDir, 'dist', 'proxy.js'));

const vsixSrc = path.join(root, 'releases', `${pkg.name}-${pkg.version}.vsix`);
const vsixDst = path.join(pluginDir, 'extension', 'vsc-mcpserver.vsix');
fs.copyFileSync(vsixSrc, vsixDst);

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(vsixDst)).digest('hex');
const meta = {
    id: `${pkg.publisher.toLowerCase()}.${pkg.name.toLowerCase()}`,
    version: pkg.version,
    sha256,
};
fs.writeFileSync(path.join(pluginDir, 'extension', 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`Synced VSC-MCPServer ${pkg.version} (${sha256.slice(0, 12)}) to ${pluginDir}`);
