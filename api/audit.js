const dns = require('dns').promises;
const net = require('net');

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] >= 224) return true; // multicast/reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateIP(lower.replace('::ffff:', ''));
  return false;
}

async function assertSafeHost(hostname) {
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('no_dns');
  for (const a of addrs) {
    if (isPrivateIP(a.address)) throw new Error('private_ip');
  }
}

async function safeFetch(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad_protocol');
  await assertSafeHost(u.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'GetForceSEOAuditBot/1.0 (+https://seo.getforce.org)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    chunks.push(value);
    if (received > maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf-8');
}

const AI_BOTS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'Google-Extended', 'PerplexityBot', 'ClaudeBot', 'anthropic-ai'];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  let target = String((req.query && req.query.url) || '').trim();
  if (!target) return res.status(400).json({ error: 'missing_url' });
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let origin;
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad_protocol');
    origin = u.origin;
  } catch {
    return res.status(400).json({ error: 'invalid_url' });
  }

  let title = null, titleLen = 0, descLen = 0, hasCanonical = false, jsonLdTypes = [], htmlLang = null;

  try {
    const homeRes = await safeFetch(origin + '/');
    if (!homeRes.ok && homeRes.status >= 400) {
      return res.status(200).json({ url: target, error: 'fetch_failed' });
    }
    const html = await readLimited(homeRes, 2_000_000);

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    title = titleMatch ? titleMatch[1].trim() : null;
    titleLen = title ? title.length : 0;

    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
    descLen = descMatch ? descMatch[1].length : 0;

    hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);

    const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ldMatches) {
      try {
        const d = JSON.parse(m[1]);
        const arr = Array.isArray(d) ? d : [d];
        for (const item of arr) if (item && item['@type']) jsonLdTypes.push(item['@type']);
      } catch {}
    }

    const langMatch = html.match(/<html[^>]+lang=["']([a-zA-Z-]+)["']/i);
    htmlLang = langMatch ? langMatch[1] : null;
  } catch {
    return res.status(200).json({ url: target, error: 'fetch_failed' });
  }

  let robotsExists = false, sitemapUrl = null, aiBlocked = [];
  try {
    const r = await safeFetch(origin + '/robots.txt');
    if (r.status === 200) {
      robotsExists = true;
      const text = await readLimited(r, 200_000);
      const sm = text.match(/Sitemap:\s*(\S+)/i);
      if (sm) sitemapUrl = sm[1];
      const blocks = text.split(/\n(?=User-agent:)/i);
      for (const block of blocks) {
        const uaMatch = block.match(/User-agent:\s*(\S+)/i);
        if (!uaMatch) continue;
        const ua = uaMatch[1];
        if (AI_BOTS.some((b) => b.toLowerCase() === ua.toLowerCase()) && /Disallow:\s*\/\s*(\n|$)/im.test(block)) {
          aiBlocked.push(ua);
        }
      }
    }
  } catch {}

  let sitemapOk = false, sitemapCount = null;
  try {
    const smUrl = sitemapUrl || origin + '/sitemap.xml';
    const sres = await safeFetch(smUrl);
    if (sres.status === 200) {
      const text = await readLimited(sres, 500_000);
      sitemapCount = (text.match(/<loc>/g) || []).length;
      sitemapOk = true;
    }
  } catch {}

  const checks = [
    { id: 'title', status: !title ? 'fail' : titleLen > 60 ? 'warn' : 'pass', meta: { length: titleLen } },
    { id: 'description', status: descLen === 0 ? 'fail' : descLen > 160 ? 'warn' : 'pass', meta: { length: descLen } },
    { id: 'canonical', status: hasCanonical ? 'pass' : 'warn', meta: { present: hasCanonical } },
    { id: 'structured_data', status: jsonLdTypes.length ? 'pass' : 'fail', meta: { types: jsonLdTypes } },
    { id: 'robots', status: robotsExists ? 'pass' : 'warn', meta: { present: robotsExists } },
    { id: 'ai_crawlers', status: aiBlocked.length ? 'fail' : 'pass', meta: { blocked: aiBlocked } },
    { id: 'sitemap', status: sitemapOk ? 'pass' : 'warn', meta: { present: sitemapOk, count: sitemapCount } },
    { id: 'lang', status: htmlLang ? 'pass' : 'warn', meta: { value: htmlLang } },
  ];

  const score = checks.filter((c) => c.status === 'pass').length;
  res.status(200).json({ url: target, score, total: checks.length, checks });
};
