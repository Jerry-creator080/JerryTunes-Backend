const { spawn } = require('child_process');
const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (err) {
          resolve({ status: res.statusCode, raw: data, error: err.message });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('--- STARTING JERRYTUNES SERVER ---');
  const server = spawn('node', ['index.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverStarted = false;
  server.stdout.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('listening on')) {
      serverStarted = true;
    }
    // Print logs cleanly
    process.stdout.write('[SERVER] ' + msg);
  });

  server.stderr.on('data', (d) => {
    process.stderr.write('[SERVER ERR] ' + d.toString());
  });

  // Wait up to 5s for server to start
  for (let i = 0; i < 25; i++) {
    if (serverStarted) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const results = [];

  try {
    // Test 1: Health
    console.log('\n[TEST 1] Testing /api/health ...');
    const health = await fetchJson('http://127.0.0.1:3000/api/health');
    const healthPass = health.status === 200 && health.data?.ok === true;
    results.push({ name: 'GET /api/health', passed: healthPass, details: health.data });
    console.log(healthPass ? '  --> PASS' : '  --> FAIL', health);

    // Test 2: Search
    console.log('\n[TEST 2] Testing /api/search?q=coldplay ...');
    const search = await fetchJson('http://127.0.0.1:3000/api/search?q=coldplay');
    const searchPass = search.status === 200 && Array.isArray(search.data) && search.data.length > 0;
    const firstTrack = searchPass ? search.data[0] : null;
    results.push({ 
      name: 'GET /api/search', 
      passed: searchPass, 
      details: firstTrack ? `Found ${search.data.length} tracks. First: "${firstTrack.title}" (${firstTrack.duration})` : search 
    });
    console.log(searchPass ? `  --> PASS: Found ${search.data.length} tracks. First: ${firstTrack.title}` : '  --> FAIL', search);

    // Test 3: Home recommendations
    console.log('\n[TEST 3] Testing /api/home ...');
    const home = await fetchJson('http://127.0.0.1:3000/api/home');
    const homePass = home.status === 200 && Array.isArray(home.data?.trending) && Array.isArray(home.data?.quickPicks);
    results.push({ 
      name: 'GET /api/home', 
      passed: homePass, 
      details: homePass ? `Trending: ${home.data.trending.length}, QuickPicks: ${home.data.quickPicks.length}` : home 
    });
    console.log(homePass ? `  --> PASS: Trending (${home.data.trending.length}), QuickPicks (${home.data.quickPicks.length})` : '  --> FAIL', home);

    // Test 4: Lyrics
    console.log('\n[TEST 4] Testing /api/lyrics?title=Yellow&artist=Coldplay ...');
    const lyrics = await fetchJson('http://127.0.0.1:3000/api/lyrics?title=Yellow&artist=Coldplay');
    const lyricsPass = lyrics.status === 200 && (lyrics.data?.syncedLyrics || lyrics.data?.plainLyrics);
    results.push({ 
      name: 'GET /api/lyrics', 
      passed: lyricsPass, 
      details: lyricsPass ? `Matched: "${lyrics.data.trackName}" by "${lyrics.data.artistName}". Has synced lyrics: ${!!lyrics.data.syncedLyrics}` : lyrics 
    });
    console.log(lyricsPass ? `  --> PASS: Matched track "${lyrics.data.trackName}". Has synced lyrics: ${!!lyrics.data.syncedLyrics}` : '  --> FAIL', lyrics);

    // Test 5: Stream (sample YouTube ID: dQw4w9WgXcQ or from search result)
    const testVideoId = firstTrack?.id || 'dQw4w9WgXcQ';
    console.log(`\n[TEST 5] Testing /api/stream?id=${testVideoId} ...`);
    const stream = await fetchJson(`http://127.0.0.1:3000/api/stream?id=${testVideoId}`);
    const streamPass = stream.status === 200 && typeof stream.data?.audioUrl === 'string' && stream.data.audioUrl.length > 0;
    results.push({ 
      name: 'GET /api/stream', 
      passed: streamPass, 
      details: streamPass ? `Audio URL extracted (length: ${stream.data.audioUrl.length}, format: ${stream.data.audioUrl.slice(0, 40)}...)` : stream 
    });
    console.log(streamPass ? `  --> PASS: Audio URL obtained!` : '  --> FAIL', stream);

  } catch (err) {
    console.error('Test error:', err);
  } finally {
    console.log('\n--- STOPPING SERVER ---');
    server.kill();
  }

  console.log('\n=======================================');
  console.log('            TEST SUMMARY');
  console.log('=======================================');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.passed ? '✅ [PASS]' : '❌ [FAIL]'} ${r.name}`);
    console.log(`   Details:`, r.details);
    if (!r.passed) allPass = false;
  }
  console.log('=======================================');
  console.log(allPass ? '🎉 ALL TESTS PASSED!' : '⚠️ SOME TESTS FAILED');
  process.exit(allPass ? 0 : 1);
}

runTests();

