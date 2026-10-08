// Génère la démo autonome (demo/plan-vivant-demo.html) à partir de l'application :
// même interface (public/), backend remplacé par la base partagée de claude.ai.
//   node tools/build-demo.js
const fs = require('node:fs');
const path = require('node:path');
const pub = p => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');

const html = pub('index.html');
const body = html.slice(html.indexOf('<!--BODY-->') + 11, html.indexOf('<!--/BODY-->'))
  .replace(/<div class="login"[\s\S]*?<\/form>\s*<\/div>/, '')
  .replace('<button type="button" class="link" id="logout">Déconnexion</button>', '<button type="button" class="link" id="logout" hidden>Déconnexion</button>');
const css = pub('styles.css').replace(/@font-face[^\n]*\n/g, '');
const appJs = pub('app.js').replace(/\/\* =+ Backend « serveur »[\s\S]*$/, '');
const plan = pub('plan.json');
const backend = fs.readFileSync(path.join(__dirname, 'backend-artifact.js'), 'utf8');

const out = `<title>Plan Vivant</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;600&display=swap">
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
${css}</style>
${body}
<script>
window.PV_BACKEND = 'external';
window.PV_PLAN = ${plan.trim()};
${appJs}
${backend}</script>
`;
const dest = path.join(__dirname, '..', '..', 'demo', 'plan-vivant-demo.html');
fs.writeFileSync(dest, out);
console.log('demo écrite :', dest, out.length, 'octets');
