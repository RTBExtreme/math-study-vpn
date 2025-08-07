const express = require('express');
const { URL } = require('url');
const fs = require('fs');
const compression = require('compression');
const https = require('https');

const app = express();
const PORT = 80;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let config;
try {
  config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
  if (typeof config.logRequests !== 'boolean') {
    throw new Error("Missing or invalid 'logRequests' boolean in config.json");
  }
} catch (err) {
  console.error('❌ Failed to load config.json:', err.message);
  process.exit(1);
}

app.use(compression());
app.use(express.static('public'));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Relax CORS
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

const RATE_LIMIT = 2; 
const WINDOW_SIZE = 10 * 1000; 
const rateLimitMap = new Map(); 

function getProxyBase(req) {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/proxy?url=`;
}

function rewriteUrls(html, baseUrl, proxyBase) {
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, value) => {
    if (
      value.startsWith('#') ||
      value.startsWith('javascript:') ||
      value.startsWith('data:')
    ) return match;
    try {
      const fullUrl = new URL(value, baseUrl).href;
      return `${attr}="${proxyBase}${encodeURIComponent(fullUrl)}"`;
    } catch {
      return match;
    }
  });

  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
    return `<style>${rewriteCss(css, baseUrl, proxyBase)}</style>`;
  });

  html = html.replace(/style=["']([^"']+)["']/gi, (match, css) => {
    return `style="${rewriteCss(css, baseUrl, proxyBase)}"`;
  });

  const interceptorScript = `
  <script>
  (function () {
    const proxyBase = location.origin + "/proxy?url=";
    const originalFetch = window.fetch;
    window.fetch = function(resource, init) {
      try {
        const url = typeof resource === "string" ? resource : resource.url;
        if (!url.startsWith(proxyBase) && /^https?:\\/\\//.test(url)) {
          resource = proxyBase + encodeURIComponent(url);
        }
      } catch (e) {}
      return originalFetch.call(this, resource, init);
    };
    const OriginalXHR = window.XMLHttpRequest;
    function ProxyXHR() {
      const xhr = new OriginalXHR();
      const open = xhr.open;
      xhr.open = function(method, url, ...args) {
        if (!url.startsWith(proxyBase) && /^https?:\\/\\//.test(url)) {
          url = proxyBase + encodeURIComponent(url);
        }
        return open.call(this, method, url, ...args);
      };
      return xhr;
    }
    window.XMLHttpRequest = ProxyXHR;
  })();
  </script>
  `;

  html = html.replace(/<\/body>/i, `${interceptorScript}</body>`);
  return html;
}

function rewriteCss(css, baseUrl, proxyBase) {
  return css.replace(/url\(["']?(.*?)["']?\)/gi, (match, value) => {
    if (value.startsWith('data:')) return match;
    try {
      const fullUrl = new URL(value, baseUrl).href;
      return `url("${proxyBase}${encodeURIComponent(fullUrl)}")`;
    } catch {
      return match;
    }
  });
}

app.get('/proxy', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const targetUrlRaw = req.query.url;

  if (!targetUrlRaw) return res.status(400).send('Missing url');

  let normalizedUrl;
  try {
    const parsedUrl = new URL(targetUrlRaw);
    
    parsedUrl.hash = '';
    normalizedUrl = parsedUrl.href;
  } catch {
    return res.status(400).send('Invalid url');
  }

  const key = `${ip}|${normalizedUrl}`;
  const now = Date.now();

  let timestamps = rateLimitMap.get(key) || [];
  
  timestamps = timestamps.filter(ts => now - ts < WINDOW_SIZE);

  if (timestamps.length >= RATE_LIMIT) {
    return res.status(429).send('Rate limit exceeded for this URL. Please wait before retrying.');
  }

  timestamps.push(now);
  rateLimitMap.set(key, timestamps);

  if (config.logRequests) {
    console.log(`[PROXY] ${targetUrlRaw} (normalized: ${normalizedUrl})`);
  }

  try {
    const response = await fetch(targetUrlRaw, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const contentType = response.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType);
    const proxyBase = getProxyBase(req);

    if (contentType.includes('text/html')) {
      const html = await response.text();
      res.send(rewriteUrls(html, targetUrlRaw, proxyBase));
    } else if (contentType.includes('text/css')) {
      const css = await response.text();
      res.send(rewriteCss(css, targetUrlRaw, proxyBase));
    } else if (
      contentType.includes('application/javascript') ||
      contentType.includes('text/javascript')
    ) {
      const js = await response.text();
      res.send(js);
    } else if (contentType.includes('application/wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    }
  } catch (err) {
    res.status(500).send('Failed to fetch: ' + err.message);
  }
});


app.listen(PORT, () => {
  console.log(`Proxy running without HTTPS`);
});
