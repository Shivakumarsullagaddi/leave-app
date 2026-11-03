// Builds the real Index.html (includes resolved) with google.script.run stubbed by
// responses computed from the real backend, then screenshots each view.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { load } = require('./load');

const SRC = path.join(__dirname, '../src');
const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

function buildPage(boot, fixtures) {
  let html = process.env.LD_SRC ? fs.readFileSync(path.join(__dirname, '..', process.env.LD_SRC, 'Index.html'), 'utf8') : fs.readFileSync(path.join(SRC, 'ui/Index.html'), 'utf8');
  html = html.replace(/<\?!= include\('([^']+)'\); \?>/g, (_, f) => fs.readFileSync(path.join(SRC, f + '.html'), 'utf8'));
  html = html.replace('<?!= boot ?>', JSON.stringify(boot));
  const stub = `<script>
    const FX = ${JSON.stringify(fixtures)};
    window.google = { script: { get run() {
      let ok, fail; const api = new Proxy({}, { get: (t, k) => {
        if (k === 'withSuccessHandler') return (f) => { ok = f; return api; };
        if (k === 'withFailureHandler') return (f) => { fail = f; return api; };
        return (...args) => setTimeout(() => ok(FX[k] || { ok: true, data: true }), 30);
      }}); return api; } } };
  </script>`;
  return html.replace('<script>window.LD', stub + '<script>window.LD');
}

(async () => {
  const P = load({ user: 'shivakumar.u@darukaa.com', now: '2026-11-03T05:00:00Z' });
  const run = P.run;
  run('setupDatabase()'); run('setupTestTeam()'); P.env.webapp = true;
  run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-11-19',end_date:'2026-11-23',reason:'Trip home for a family function'})`);
  const shiva = run("apiBootstrap('')");
  const preview = run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-12-14',end_date:'2026-12-16'})`);
  run(`apiSetViewAs('', 'E004')`);
  const jaya = run("apiBootstrap('')");
  run(`apiSetViewAs('', 'E006')`);
  const arshadPreview = run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-12-16',end_date:'2026-12-18'})`);
  const arshad = run("apiBootstrap('')");

  const P2 = load({ user: '', now: '2026-11-03T05:00:00Z' });
  P2.run('setupDatabase()'); P2.env.webapp = true;
  P2.run(`PropertiesService.getScriptProperties().setProperty('OAUTH_CLIENT_ID','x'); PropertiesService.getScriptProperties().setProperty('OAUTH_CLIENT_SECRET','y');`);
  const signedOut = P2.run("apiBootstrap('')");
  const shots = [
    { name: 'signin', boot: { view: 'overview' }, fx: { apiBootstrap: signedOut } },
    { name: 'overview', boot: { view: 'overview' }, fx: { apiBootstrap: shiva } },
    { name: 'apply', boot: { view: 'apply' }, fx: { apiBootstrap: shiva, apiPreview: preview }, fill: true },
    { name: 'apply-overquota', boot: { view: 'apply' }, fx: { apiBootstrap: arshad, apiPreview: arshadPreview }, fill: true },
    { name: 'requests', boot: { view: 'requests' }, fx: { apiBootstrap: shiva } },
    { name: 'approvals', boot: { view: 'approvals' }, fx: { apiBootstrap: jaya } },
  ];
  const browser = await chromium.launch();
  for (const s of shots) {
    for (const vp of [{ w: 1280, h: 900, tag: 'desktop' }, { w: 400, h: 860, tag: 'phone' }]) {
      if (vp.tag === 'phone' && !['overview', 'approvals', 'signin'].includes(s.name)) continue;
      const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.setContent(buildPage(s.boot, s.fx), { waitUntil: 'load' });
      await page.waitForTimeout(250);
      if (s.fill) {
        await page.fill('#f-start', '2026-12-14');
        await page.dispatchEvent('#f-start', 'change');
        await page.fill('#f-end', '2026-12-16');
        await page.dispatchEvent('#f-end', 'change');
        await page.waitForTimeout(600);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      await page.screenshot({ path: path.join(OUT, `${s.name}-${vp.tag}.png`), fullPage: true });
      console.log(s.name, vp.tag, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'ok', overflow ? 'HORIZONTAL OVERFLOW' : '');
      await page.close();
    }
  }
  await browser.close();
})();
