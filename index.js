const express = require('express');
const cors = require('cors');
const ytSearch = require('youtube-sr').default;
const youtubedl = require('youtube-dl-exec');
const play = require('play-dl');

const app = express();
const PORT = 3000;

app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.send('JerryTunes Proxy Server is running!');
});

// Diagnostic Health Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'JerryTunes Proxy Server',
    timestamp: new Date().toISOString(),
    clientIP: req.ip
  });
});

// Search Endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const requestId = Math.random().toString(36).substring(7);
  const startTimestamp = Date.now();
  
  console.log(`\n==================================================`);
  console.log(`[FORENSICS] REQUEST RECEIVED`);
  console.log(`- Request ID: ${requestId}`);
  console.log(`- Timestamp: ${new Date(startTimestamp).toISOString()}`);
  console.log(`- Query: "${query}"`);
  console.log(`- Client IP: ${req.ip}`);

  if (!query) {
    console.log(`[FORENSICS] Error: Query parameter missing`);
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const providerStart = Date.now();
    console.log(`\n[FORENSICS] PROVIDER REQUEST`);
    console.log(`- Provider: play-dl (YouTube)`);
    console.log(`- Start Timestamp: ${new Date(providerStart).toISOString()}`);
    
    // Switch to play-dl because youtube-sr and yt-search both crash on new YouTube HTML
    const results = await play.search(query, { limit: 30, source: { youtube: 'video' } });
    
    const providerElapsed = Date.now() - providerStart;
    console.log(`\n[FORENSICS] PROVIDER RESPONSE`);
    console.log(`- Status: SUCCESS`);
    console.log(`- Elapsed: ${providerElapsed}ms`);
    console.log(`- Result Count: ${results.length}`);
    
    // Normalize play-dl output to precisely match JerryTunes schema
    const tracks = results.map(video => ({
      id: video.id,
      title: video.title,
      artist: video.channel?.name || 'Unknown',
      channelId: video.channel?.id || undefined,
      artworkUrl: video.thumbnails?.[video.thumbnails.length - 1]?.url || '',
      duration: video.durationRaw,
    }));

    const totalElapsed = Date.now() - startTimestamp;
    const responsePayload = JSON.stringify(tracks);
    console.log(`\n[FORENSICS] BACKEND RESPONSE`);
    console.log(`- Status: 200 OK`);
    console.log(`- Elapsed (Total): ${totalElapsed}ms`);
    console.log(`- Response Size: ${Buffer.byteLength(responsePayload, 'utf8')} bytes`);
    console.log(`==================================================\n`);

    res.json(tracks);
  } catch (error) {
    console.error(`\n[FORENSICS] PROVIDER/BACKEND ERROR:`, error.message || error);
    // Return explicit 502 with error details instead of crashing generic 500
    res.status(502).json({ 
      error: 'Search Provider Error', 
      details: error.message || String(error)
    });
  }
});

// Search Playlists Endpoint (for Artist/Channel pages)
app.get('/api/search/playlists', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const results = await play.search(query, { limit: 20, source: { youtube: 'playlist' } });
    
    const playlists = results.map(playlist => ({
      id: playlist.id,
      title: playlist.title,
      artist: playlist.channel?.name || 'Unknown',
      channelId: playlist.channel?.id || undefined,
      artworkUrl: playlist.thumbnails?.[playlist.thumbnails.length - 1]?.url || '',
      videoCount: playlist.videoCount || 0,
    }));

    res.json(playlists);
  } catch (error) {
    console.error('Playlist search error:', error);
    res.status(502).json({ error: 'Failed to search YouTube playlists' });
  }
});

// Stream cache to avoid resolving the same track repeatedly (URLs expire, so 45m TTL)
const streamCache = new Map();
const STREAM_CACHE_TTL = 45 * 60 * 1000; 

// Stream URL Extraction Endpoint
app.get('/api/stream', async (req, res) => {
  const videoId = req.query.id;
  
  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  // Check cache first for fast playback and seek restarts
  if (streamCache.has(videoId)) {
    const cached = streamCache.get(videoId);
    if (Date.now() - cached.timestamp < STREAM_CACHE_TTL) {
      console.log(`[FORENSICS] STREAM CACHE HIT for ${videoId}`);
      return res.json(cached.data);
    }
    // Delete expired cache
    streamCache.delete(videoId);
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const startTimestamp = Date.now();
    console.log(`[FORENSICS] RESOLVING STREAM for ${videoId}`);
    const output = await youtubedl(videoUrl, {
      dumpJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true
    });
    console.log(`[FORENSICS] RESOLVED STREAM in ${Date.now() - startTimestamp}ms`);

    if (!output || !output.formats) {
      return res.status(500).json({ error: 'Failed to parse YouTube formats' });
    }

    // Find best audio format (m4a/mp3)
    const audioFormats = output.formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none');
    
    // Sort all m4a first (for iOS compatibility), then by abr
    const bestAudio = audioFormats.sort((a, b) => {
      const aIsM4a = a.ext === 'm4a';
      const bIsM4a = b.ext === 'm4a';
      if (aIsM4a && !bIsM4a) return -1;
      if (!aIsM4a && bIsM4a) return 1;
      return (b.abr || 0) - (a.abr || 0);
    })[0];

    // Find pre-muxed video formats (with audio)
    const videoFormats = output.formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');
    
    // Sort descending by height
    videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
    
    const video1080 = videoFormats.find(f => f.height === 1080 || f.height === 1440) || videoFormats[0];
    const video720 = videoFormats.find(f => f.height === 720) || videoFormats[0];
    const bestVideo = videoFormats[0];

    const responseData = {
      audioUrl: bestAudio?.url || output.url || null,
      videoUrl: bestVideo?.url || output.url || null,
      video720Url: video720?.url || bestVideo?.url || null,
      video1080Url: video1080?.url || bestVideo?.url || null,
    };

    streamCache.set(videoId, {
      timestamp: Date.now(),
      data: responseData
    });

    res.json(responseData);

  } catch (error) {
    console.error('Stream extraction error:', error.message);
    res.status(500).json({ error: 'Failed to extract stream URLs' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 JerryTunes Proxy Server listening on http://0.0.0.0:${PORT}`);
});