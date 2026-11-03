// Builds a paste-ready version of the project: a few flat files, no folders.
// The modular src/ stays the source of truth; dist-standalone/ is generated.
//   node tools/build-standalone.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist-standalone');

// Output file → source modules (in this order). Every .gs in src/ must appear once.
const BUNDLES = {
  'Setup.gs':    ['setup/Setup', 'setup/SheetFormatter', 'setup/Seed'],
  'Core.gs':     ['core/Schema', 'core/Errors', 'core/Codec', 'core/DateUtil', 'core/Repository', 'core/Db'],
  'Services.gs': ['services/Config', 'services/Audit', 'services/Directory', 'services/Catalog', 'services/Auth', 'services/Identity',
                  'services/BalanceService', 'services/ApprovalRouter', 'services/DecisionPolicy', 'services/RequestView',
                  'services/LeaveService', 'services/ApprovalService', 'services/ReportService', 'services/AdminService'],
  'Notify.gs':   ['notify/Messages', 'notify/SlackChannel', 'notify/EmailChannel', 'notify/Notifier'],
  'Code.gs':     ['Api', 'WebApp'],
};

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const banner = (title) => '/* ' + '='.repeat(74) + '\n * ' + title + '\n * ' + '='.repeat(74) + ' */\n';

function listGs(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = base ? base + '/' + d.name : d.name;
    return d.isDirectory() ? listGs(path.join(dir, d.name), rel) : rel.endsWith('.gs') ? [rel.slice(0, -3)] : [];
  });
}

// Safety: every module bundled exactly once.
const all = listGs(SRC).sort();
const used = Object.values(BUNDLES).flat().sort();
if (JSON.stringify(all) !== JSON.stringify(used)) {
  throw new Error('Bundle list out of date.\nIn src: ' + all.join(', ') + '\nBundled: ' + used.join(', '));
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const header = (file) => '/**\n * Leave Desk · ' + file + ' (generated from src/ by tools/build-standalone.js)\n' +
  ' * Paste as-is into Apps Script. Edit the modular files in src/ and rebuild.\n */\n\n';

Object.entries(BUNDLES).forEach(([file, modules]) => {
  let body = modules.map((m) => banner(m + '.gs') + read(m + '.gs').trim() + '\n').join('\n');
  if (file === 'Code.gs') body = body.replace("createTemplateFromFile('ui/Index')", "createTemplateFromFile('Index')");
  fs.writeFileSync(path.join(OUT, file), header(file) + body);
});

// Index.html: inline every include so the page is one file.
let html = read('ui/Index.html');
html = html.replace(/<\?!= include\('([^']+)'\); \?>/g, (_, f) => '<!-- ' + f + ' -->\n' + read(f + '.html').trim());
if (/include\(/.test(html)) throw new Error('Unresolved include in Index.html');
fs.writeFileSync(path.join(OUT, 'Index.html'), html);

fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(OUT, 'appsscript.json'));

fs.readdirSync(OUT).forEach((f) => {
  const lines = fs.readFileSync(path.join(OUT, f), 'utf8').split('\n').length;
  console.log(f.padEnd(18), String(lines).padStart(5), 'lines');
});
