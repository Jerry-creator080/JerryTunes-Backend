const { spawn } = require('child_process');
const http = require('http');

const TEST_PORT = 3099;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (err) {
          resolve({ status: res.statusCode, raw: data, error: err.message });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('--- STARTING JERRYTUNES SERVER ON PORT', TEST_PORT, '---');
  const server = spawn('node', ['index.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverStarted = false;
  server.stdout.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('listening on')) serverStarted = true;
    process.stdout.write('[SERVER] ' + msg);
  });
  server.stderr.on('data', (d) => {
    process.stderr.write('[SERVER ERR] ' + d.toString());
  });

  for (let i = 0; i < 30; i++) {
    if (serverStarted) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const results = [];

  try {
    const health = await fetchJson(`${BASE_URL}/api/health`);
    results.push({
      name: 'GET /api/health',
      passed: health.status === 200 && health.data?.ok === true,
      details: health.data,
    });

    const search1 = await fetchJson(`${BASE_URL}/api/search?q=coldplay+yellow`);
    const track1 = Array.isArray(search1.data) ? search1.data[0] : null;
    results.push({
      name: 'GET /api/search (coldplay yellow)',
      passed: search1.status === 200 && Boolean(track1?.id),
      details: track1 ? `Found ${search1.data.length}, first=${track1.id} "${track1.title}"` : search1,
    });

    const search2 = await fetchJson(`${BASE_URL}/api/search?q=the+weeknd+blinding+lights`);
    const track2 = Array.isArray(search2.data) ? search2.data[0] : null;
    results.push({
      name: 'GET /api/search (blinding lights)',
      passed: search2.status === 200 && Boolean(track2?.id),
      details: track2 ? `Found ${search2.data.length}, first=${track2.id} "${track2.title}"` : search2,
    });

    for (const [label, t] of [['Track 1', track1], ['Track 2', track2]]) {
      const id = t?.id || '4NRXx6U8ABQ';
      const st = await fetchJson(`${BASE_URL}/api/stream?id=${encodeURIComponent(id)}&quality=high`);
      let audioOk = false;
      let audioMeta = {};
      if (st.status === 200 && st.data?.audioUrl) {
        const probe = await fetch(st.data.audioUrl, {
          headers: { ...(st.data.headers || {}), Range: 'bytes=0-2047' },
        });
        const buf = await probe.arrayBuffer();
        audioOk = (probe.status === 200 || probe.status === 206) && buf.byteLength > 512;
        audioMeta = {
          http: probe.status,
          contentType: probe.headers.get('content-type'),
          bytes: buf.byteLength,
          source: st.data.source,
        };
      }
      results.push({
        name: `GET /api/stream + Audio Range Fetch (${label}: ${id})`,
        passed: st.status === 200 && audioOk,
        details: { streamStatus: st.status, ...audioMeta },
      });
    }

    const dl = await fetchJson(`${BASE_URL}/api/resolve-download?id=4NRXx6U8ABQ&quality=ultra`);
    results.push({
      name: 'GET /api/resolve-download',
      passed: dl.status === 200 && typeof dl.data?.audioUrl === 'string' && dl.data.audioUrl.length > 0,
      details: { status: dl.status, source: dl.data?.source, mimeType: dl.data?.mimeType },
    });

    const proxyRes = await fetch(`${BASE_URL}/api/proxy-stream?id=4NRXx6U8ABQ&quality=high`, {
      headers: { Range: 'bytes=0-2047' },
    });
    const proxyBuf = await proxyRes.arrayBuffer();
    results.push({
      name: 'GET /api/proxy-stream (Range 206)',
      passed: (proxyRes.status === 206 || proxyRes.status === 200) && proxyBuf.byteLength > 512,
      details: {
        status: proxyRes.status,
        contentType: proxyRes.headers.get('content-type'),
        contentRange: proxyRes.headers.get('content-range'),
        bytes: proxyBuf.byteLength,
      },
    });

    const lyrics = await fetchJson(`${BASE_URL}/api/lyrics?title=Blinding+Lights&artist=The+Weeknd`);
    results.push({
      name: 'GET /api/lyrics',
      passed: lyrics.status === 200 && Boolean(lyrics.data?.syncedLyrics || lyrics.data?.plainLyrics),
      details: { status: lyrics.status, track: lyrics.data?.trackName },
    });

    const album = await fetchJson(`${BASE_URL}/api/album?id=1499378108`);
    results.push({
      name: 'GET /api/album',
      passed: album.status === 200 && Array.isArray(album.data?.tracks) && album.data.tracks.length > 0,
      details: { status: album.status, tracks: album.data?.tracks?.length },
    });

    const home = await fetchJson(`${BASE_URL}/api/home`);
    results.push({
      name: 'GET /api/home',
      passed: home.status === 200 && Array.isArray(home.data?.topAlbums) && home.data.topAlbums.length > 0,
      details: {
        status: home.status,
        trending: home.data?.trending?.length,
        topAlbums: home.data?.topAlbums?.length,
      },
    });
  } catch (err) {
    console.error('Test error:', err);
  } finally {
    server.kill();
  }

  console.log('\n=======================================');
  console.log('         BACKEND TEST SUMMARY');
  console.log('=======================================');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.passed ? '[PASS]' : '[FAIL]'} ${r.name}`);
    console.log('  ', JSON.stringify(r.details));
    if (!r.passed) allPass = false;
  }
  console.log('=======================================');
  process.exit(allPass ? 0 : 1);
}

runTests();
