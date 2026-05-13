import http from 'node:http';

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4220);

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Customer Success Console</title><style>
body{font-family:Arial,sans-serif;margin:32px;color:#172033}nav{display:flex;gap:16px;margin-bottom:24px}section,form{border:1px solid #d8dee8;border-radius:8px;padding:16px;max-width:720px}label{display:block;margin-top:12px;font-weight:700}input,select,button{margin-top:6px;padding:9px 11px}li{margin:10px 0}
</style></head><body>${body}</body></html>`;

function shell(content) {
  return `<main><h1>Customer Success Console</h1><nav aria-label="Primary navigation"><a href="/">Overview</a><a href="/accounts">Accounts</a><a href="/plan">Success Plan</a></nav>${content}</main>`;
}

const routes = {
  '/': html(shell(`<section aria-label="Renewal Risk Queue"><h2>Renewal Risk Queue</h2><p>Northwind Robotics requires executive sponsor follow-up.</p><p>Expansion Pipeline: 1.2M dollars</p><button type="button">Review Queue</button></section>`)),
  '/accounts': html(shell(`<h2>At Risk Accounts</h2><label for="risk-filter">Risk Filter</label><select id="risk-filter"><option>All</option><option>High Risk</option><option>Medium Risk</option><option>Healthy</option></select><ul><li><strong>Northwind Robotics</strong> <span>High Risk</span> <span>Maya Chen</span></li><li><strong>Acme Analytics</strong> <span>Healthy</span> <span>Jordan Lee</span></li><li><strong>Globex Logistics</strong> <span>Medium Risk</span> <span>Priya Nair</span></li></ul>`)),
  '/plan': html(shell(`<h2>Success Plan</h2><form aria-label="Success plan form" novalidate onsubmit="event.preventDefault(); document.getElementById('account-name').setAttribute('aria-invalid','true'); document.getElementById('renewal-owner').setAttribute('aria-invalid','true'); document.getElementById('plan-alert').hidden=false;"><label for="account-name">Account Name</label><input id="account-name" name="accountName" placeholder="Northwind Robotics" required><label for="renewal-owner">Renewal Owner</label><input id="renewal-owner" name="renewalOwner" placeholder="Maya Chen" required><button type="submit">Save Plan</button></form><p id="plan-alert" role="alert" hidden>Account Name and Renewal Owner are required.</p><p role="status">Plan Saved</p>`)),
};

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(routes[url.pathname] || routes['/']);
}).listen(port, '127.0.0.1', () => {
  console.log(`React Vite compatibility fixture listening on http://127.0.0.1:${port}`);
});
