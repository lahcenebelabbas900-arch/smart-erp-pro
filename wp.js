const https = require('https');
const http  = require('http');
const { URL } = require('url');

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,x-wp-site',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  const h    = req.headers || {};
  const site = (h['x-wp-site'] || process.env.WP_URL || '').replace(/\/+$/, '');

  if (!site) {
    Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'x-wp-site header missing' });
  }

  // ✅ استخراج المسار الصحيح من query param _path (يُضاف من vercel.json rewrite)
  let reqUrl;
  try { reqUrl = new URL(req.url, 'http://localhost'); } catch(e) { reqUrl = new URL('/', 'http://localhost'); }

  // المسار الحقيقي = _path param (مثال: wp-admin/admin-ajax.php?action=xxx)
  // أو req.url بعد حذف /api/wp
  let rawPath = reqUrl.searchParams.get('_path') || '';
  if (rawPath && !rawPath.startsWith('/')) rawPath = '/' + rawPath;

  // إعادة بناء query string بدون _path
  reqUrl.searchParams.delete('_path');
  const qs = reqUrl.search || '';   // ما تبقى من query params

  const target = site + (rawPath || '/') + qs;

  // بناء headers
  const reqH = {
    'Accept'    : 'application/json',
    'User-Agent': 'Mozilla/5.0 VercelProxy/1.0',
  };
  try { reqH['Host'] = new URL(site).hostname; } catch(e) {}
  if (h['authorization'])  reqH['Authorization']  = h['authorization'];
  reqH['Content-Type'] = h['content-type'] || 'application/x-www-form-urlencoded';

  // قراءة body
  const bodyStr = await new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString() : null));
    req.on('error', () => resolve(null));
  });
  if (bodyStr) reqH['Content-Length'] = String(Buffer.byteLength(bodyStr));

  return new Promise((resolve) => {
    try {
      const u   = new URL(target);
      const lib = u.protocol === 'https:' ? https : http;

      const reqOpts = {
        hostname : u.hostname,
        port     : u.port || (u.protocol === 'https:' ? 443 : 80),
        path     : u.pathname + u.search,
        method   : req.method,
        headers  : reqH,
        timeout  : 28000,
        agent    : u.protocol === 'https:' ? httpsAgent : undefined,
      };

      const proxyReq = lib.request(reqOpts, (proxyRes) => {
        const buf = [];
        proxyRes.on('data', c => buf.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(buf).toString();
          const ct2  = proxyRes.headers['content-type'] || 'application/json';
          Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
          res.setHeader('Content-Type', ct2);
          ['x-wp-total','x-wp-totalpages','x-wp-nonce'].forEach(h2 => {
            if (proxyRes.headers[h2]) res.setHeader(h2, proxyRes.headers[h2]);
          });
          res.status(proxyRes.statusCode).end(body);
          resolve();
        });
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
        res.status(504).json({ error: 'timeout', target });
        resolve();
      });

      proxyReq.on('error', (e) => {
        Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
        res.status(502).json({ error: e.message, code: e.code, target });
        resolve();
      });

      if (bodyStr) proxyReq.write(bodyStr);
      proxyReq.end();

    } catch (e) {
      Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
      res.status(500).json({ error: e.message, target });
      resolve();
    }
  });
};
