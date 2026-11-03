// Loads every .gs file into one shared global scope, like Apps Script does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv } = require('./gas-mock');

function listGs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listGs(p) : p.endsWith('.gs') ? [p] : [];
  });
}

function load(opts) {
  const { env, ctx, props } = makeEnv(opts);
  vm.createContext(ctx);
  // Apps Script load order is not guaranteed: shuffle to prove no file depends on it.
  const files = listGs(path.join(__dirname, '..', process.env.LD_SRC || 'src')).sort(() => Math.random() - 0.5);
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n;\n');
  vm.runInContext(src, ctx, { filename: 'project.gs' });
  return { env, ctx, props, run: (code) => vm.runInContext(code, ctx) };
}

module.exports = { load };
