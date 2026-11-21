const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const ytSearch = require('youtube-sr').default;
const youtubedl = require('youtube-dl-exec');
const play = require('play-dl');

const app = express();
const PORT = process.env.PORT || 3001;

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

// Shared stream resolution helper
async function resolveStreamHelper(videoId, query, quality = 'high') {
  let targetId = videoId;

  // If ID is missing or is an itunes pseudo-id, resolve via YouTube search query
  if (!targetId || targetId.startsWith('itunes_')) {
    if (query) {
      console.log(`[FORENSICS] Resolving YouTube video ID for query: "${query}"`);
      const searchRes = await play.search(`${query} audio`, { limit: 1, source: { youtube: 'video' } })
        .catch(() => play.search(query, { limit: 1, source: { youtube: 'video' } }))
        .catch(() => []);
      if (searchRes && searchRes.length > 0) {
        targetId = searchRes[0].id;
        console.log(`[FORENSICS] Found YouTube ID: ${targetId} ("${searchRes[0].title}")`);
      }
    }
  }

  if (!targetId || targetId.startsWith('itunes_')) {
    throw new Error('Unable to resolve valid YouTube video ID for track');
  }

  // Check cache
  const cacheKey = `${targetId}_${quality}`;
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    if (Date.now() - cached.timestamp < STREAM_CACHE_TTL) {
      console.log(`[FORENSICS] STREAM CACHE HIT for ${cacheKey}`);
      return cached.data;
    }
    streamCache.delete(cacheKey);
  }

  let videoUrl = `https://www.youtube.com/watch?v=${targetId}`;
  const startTimestamp = Date.now();
  console.log(`[FORENSICS] RESOLVING STREAM for ${targetId}`);

  let output;
  try {
    output = await youtubedl(videoUrl, {
      dumpJson: true,
      noWarnings: true,
      noCheckCertificate: true,
    });
  } catch (err) {
    if (query && (err.message?.includes('Sign in') || err.message?.includes('age'))) {
      console.log(`[FORENSICS] Age gate encountered for ${targetId}, retrying with alternate audio search...`);
      const audioSearch = await play.search(`${query} audio`, { limit: 1, source: { youtube: 'video' } }).catch(() => []);
      if (audioSearch && audioSearch.length > 0 && audioSearch[0].id !== targetId) {
        targetId = audioSearch[0].id;
        videoUrl = `https://www.youtube.com/watch?v=${targetId}`;
        output = await youtubedl(videoUrl, {
          dumpJson: true,
          noWarnings: true,
          noCheckCertificate: true,
        });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  console.log(`[FORENSICS] RESOLVED STREAM in ${Date.now() - startTimestamp}ms`);

  if (!output || !output.formats) {
    throw new Error('Failed to parse YouTube formats');
  }

  // Find audio formats (m4a/mp3/webm)
  const audioFormats = output.formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none');

  let bestAudio;
  if (quality === 'normal') {
    // Normal: prefer around 128 kbps (data-saving)
    const sortedNormal = [...audioFormats].sort((a, b) => Math.abs((a.abr || 128) - 128) - Math.abs((b.abr || 128) - 128));
    bestAudio = sortedNormal[0];
  } else if (quality === 'ultra') {
    // Ultra: highest bitrate available (320k / master)
    const sortedUltra = [...audioFormats].sort((a, b) => (b.abr || 0) - (a.abr || 0));
    bestAudio = sortedUltra[0];
  } else {
    // High (default 256k): prefer m4a format with highest bitrate
    const sortedHigh = [...audioFormats].sort((a, b) => {
      const aIsM4a = a.ext === 'm4a';
      const bIsM4a = b.ext === 'm4a';
      if (aIsM4a && !bIsM4a) return -1;
      if (!aIsM4a && bIsM4a) return 1;
      return (b.abr || 0) - (a.abr || 0);
    });
    bestAudio = sortedHigh[0];
  }
  if (!bestAudio && audioFormats.length > 0) {
    bestAudio = audioFormats[0];
  }

  // Find pre-muxed video formats (with audio)
  const videoFormats = output.formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');
  videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

  const video1080 = videoFormats.find(f => f.height === 1080 || f.height === 1440) || videoFormats[0];
  const video720 = videoFormats.find(f => f.height === 720) || videoFormats[0];
  const bestVideo = videoFormats[0];

  const responseData = {
    id: targetId,
    audioUrl: bestAudio?.url || output.url || null,
    videoUrl: bestVideo?.url || output.url || null,
    video720Url: video720?.url || bestVideo?.url || null,
    video1080Url: video1080?.url || bestVideo?.url || null,
    fallbackVideoUrl: bestVideo?.url || output.url || null,
  };

  streamCache.set(cacheKey, {
    timestamp: Date.now(),
    data: responseData
  });

  return responseData;
}

// Stream URL Extraction Endpoint
app.get('/api/stream', async (req, res) => {
  const { id, query, title, artist, quality } = req.query;
  const searchQuery = query || (title ? `${title} ${artist || ''}`.trim() : null);

  if (!id && !searchQuery) {
    return res.status(400).json({ error: 'Video ID or search query is required' });
  }

  try {
    const data = await resolveStreamHelper(id, searchQuery, quality);
    res.json(data);
  } catch (error) {
    console.error('Stream extraction error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to extract stream URLs' });
  }
});

// Dedicated Single-File Download Resolver Endpoint (used by OfflineContext)
app.get('/api/resolve-download', async (req, res) => {
  const { id, query, title, artist, quality } = req.query;
  const searchQuery = query || (title ? `${title} ${artist || ''}`.trim() : null);

  if (!id && !searchQuery) {
    return res.status(400).json({ error: 'Track ID or search query is required' });
  }

  try {
    const data = await resolveStreamHelper(id, searchQuery, quality || 'ultra');
    res.json(data);
  } catch (error) {
    console.error('Download resolution error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to resolve download URL' });
  }
});

// Format milliseconds to M:SS
function formatDurationMs(ms) {
  if (!ms || isNaN(ms)) return '3:30';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Artist Discovery Endpoint (Popular Songs, Top Albums, All Albums, Singles & EPs)
app.get('/api/artist', async (req, res) => {
  const artistName = req.query.name;
  if (!artistName) {
    return res.status(400).json({ error: 'Query parameter "name" is required' });
  }

  console.log(`[FORENSICS] ARTIST REQUEST for "${artistName}"`);

  try {
    // 1. Fetch official albums and discography from iTunes Search API
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=album&limit=30`;
    const itunesPromise = fetch(itunesUrl)
      .then(r => r.json())
      .catch(() => ({ results: [] }));

    // 2. Fetch popular/top songs via play-dl YouTube search
    const youtubePromise = play.search(`${artistName} top songs`, { limit: 12, source: { youtube: 'video' } })
      .catch(() => []);

    const [itunesData, ytVideos] = await Promise.all([itunesPromise, youtubePromise]);

    // Deduplicate and process albums
    const seenTitles = new Set();
    const rawAlbums = (itunesData.results || []).filter(item => {
      const clean = item.collectionName?.toLowerCase().trim();
      if (!clean || seenTitles.has(clean)) return false;
      seenTitles.add(clean);
      return true;
    });

    const formattedAlbums = rawAlbums.map(item => ({
      id: String(item.collectionId),
      title: item.collectionName,
      artist: item.artistName || artistName,
      artworkUrl: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
      releaseDate: item.releaseDate,
      releaseYear: item.releaseDate ? new Date(item.releaseDate).getFullYear().toString() : '2024',
      trackCount: item.trackCount || 1,
      genre: item.primaryGenreName || 'Music',
      type: (item.trackCount <= 2 || item.collectionName.toLowerCase().includes('single'))
        ? 'Single'
        : (item.trackCount <= 5 || item.collectionName.toLowerCase().includes('ep'))
          ? 'EP'
          : 'Album'
    }));

    // Split into categories
    const topAlbums = formattedAlbums
      .filter(a => a.type === 'Album')
      .slice(0, 8);

    const allAlbums = formattedAlbums
      .filter(a => a.type === 'Album');

    const singlesAndEPs = formattedAlbums
      .filter(a => a.type === 'Single' || a.type === 'EP');

    // Popular songs formatted for JerryTunes
    const popularSongs = ytVideos.map(video => ({
      id: video.id,
      title: video.title,
      artist: video.channel?.name || artistName,
      channelId: video.channel?.id || undefined,
      artworkUrl: video.thumbnails?.[video.thumbnails.length - 1]?.url || '',
      duration: video.durationRaw || '3:45',
      album: formattedAlbums[0]?.title || 'Single',
    }));

    // Artist Profile metadata
    const artistAvatar = formattedAlbums[0]?.artworkUrl || 
      (ytVideos[0]?.thumbnails?.[ytVideos[0]?.thumbnails.length - 1]?.url) || '';

    // Relevant related artists
    const sampleRelated = [
      { id: 'rel-1', name: 'Atif Aslam', artworkUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=300' },
      { id: 'rel-2', name: 'Shreya Ghoshal', artworkUrl: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=300' },
      { id: 'rel-3', name: 'The Weeknd', artworkUrl: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=300' },
      { id: 'rel-4', name: 'Taylor Swift', artworkUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300' },
    ].filter(r => r.name.toLowerCase() !== artistName.toLowerCase());

    res.json({
      artist: {
        name: artistName,
        artworkUrl: artistAvatar,
        genre: formattedAlbums[0]?.genre || 'Pop',
        description: `Top music artist with ${formattedAlbums.length} albums & singles.`,
      },
      popularSongs,
      topAlbums,
      allAlbums,
      singlesAndEPs,
      relatedArtists: sampleRelated
    });

  } catch (error) {
    console.error('Artist endpoint error:', error);
    res.status(502).json({ error: 'Failed to fetch artist details' });
  }
});

// Album Detail Endpoint (Header, Complete Tracklist with Track Numbers, Durations)
app.get('/api/album', async (req, res) => {
  const { id, query } = req.query;

  if (!id && !query) {
    return res.status(400).json({ error: 'Either album "id" or "query" is required' });
  }

  console.log(`[FORENSICS] ALBUM REQUEST: id="${id}", query="${query}"`);

  try {
    let collectionId = id;

    // If query provided instead of ID, search iTunes for the album
    if (!collectionId) {
      const itunesSearch = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=1`;
      const searchRes = await fetch(itunesSearch).then(r => r.json());
      if (searchRes.results && searchRes.results.length > 0) {
        collectionId = searchRes.results[0].collectionId;
      } else {
        return res.status(404).json({ error: 'Album not found' });
      }
    }

    // Lookup full album metadata and tracklist
    const lookupUrl = `https://itunes.apple.com/lookup?id=${collectionId}&entity=song`;
    const lookupRes = await fetch(lookupUrl).then(r => r.json());

    if (!lookupRes.results || lookupRes.results.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const albumInfo = lookupRes.results[0]; // wrapperType: 'collection'
    const songItems = lookupRes.results.filter(r => r.wrapperType === 'track');

    // Calculate total duration in minutes
    const totalMs = songItems.reduce((acc, t) => acc + (t.trackTimeMillis || 0), 0);
    const totalMinutes = Math.round(totalMs / 60000);
    const totalDurationString = totalMinutes > 60 
      ? `${Math.floor(totalMinutes / 60)} hr ${totalMinutes % 60} min`
      : `${totalMinutes} min`;

    const albumType = (albumInfo.trackCount <= 2 || albumInfo.collectionName?.toLowerCase().includes('single'))
      ? 'Single'
      : (albumInfo.trackCount <= 5 || albumInfo.collectionName?.toLowerCase().includes('ep'))
        ? 'EP'
        : 'Album';

    const highResCover = (albumInfo.artworkUrl100 || '').replace('100x100bb', '600x600bb');

    const formattedAlbum = {
      id: String(albumInfo.collectionId),
      title: albumInfo.collectionName,
      artist: albumInfo.artistName,
      artworkUrl: highResCover,
      releaseDate: albumInfo.releaseDate,
      releaseYear: albumInfo.releaseDate ? new Date(albumInfo.releaseDate).getFullYear().toString() : '2024',
      trackCount: songItems.length || albumInfo.trackCount || 1,
      totalDuration: totalDurationString,
      type: albumType,
      genre: albumInfo.primaryGenreName || 'Music',
      copyright: albumInfo.copyright || ''
    };

    const formattedTracks = songItems.map((track, idx) => ({
      id: `itunes_${track.trackId}`,
      trackNumber: track.trackNumber || (idx + 1),
      title: track.trackName,
      artist: track.artistName || albumInfo.artistName,
      album: albumInfo.collectionName,
      albumId: String(albumInfo.collectionId),
      duration: formatDurationMs(track.trackTimeMillis),
      durationMs: track.trackTimeMillis,
      artworkUrl: highResCover,
      searchQuery: `${track.trackName} ${track.artistName || albumInfo.artistName}`,
    }));

    res.json({
      album: formattedAlbum,
      tracks: formattedTracks
    });

  } catch (error) {
    console.error('Album endpoint error:', error);
    res.status(502).json({ error: 'Failed to fetch album details' });
  }
});


// Synced & Plain Lyrics Endpoint (powered by LRCLIB, following iKoda architecture)
app.get('/api/lyrics', async (req, res) => {
  const { title, artist, duration } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'Query parameter "title" is required' });
  }

  // Sanitize title by stripping extraneous video tags
  const cleanTitle = title
    .replace(/\s*[\(\[](official\s*music\s*video|official\s*video|official\s*audio|lyrics|lyric\s*video|audio|video|hd|4k)[\)\]]/gi, '')
    .trim();

  console.log(`[FORENSICS] LYRICS REQUEST for "${cleanTitle}" by "${artist || 'Unknown'}"`);

  try {
    const url = new URL('https://lrclib.net/api/get');
    url.searchParams.set('track_name', cleanTitle);
    if (artist && artist !== 'Unknown') {
      url.searchParams.set('artist_name', artist);
    }
    if (duration) {
      url.searchParams.set('duration', String(duration));
    }

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'JerryTunes-Koda/1.0 (https://github.com/Ivorisnoob/iKoda)'
      }
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[FORENSICS] LYRICS FOUND (Direct match)`);
      return res.json(data);
    }

    // Fallback: search query on LRCLIB
    const searchUrl = new URL('https://lrclib.net/api/search');
    searchUrl.searchParams.set('q', `${cleanTitle} ${artist && artist !== 'Unknown' ? artist : ''}`.trim());

    const searchRes = await fetch(searchUrl.toString(), {
      headers: {
        'User-Agent': 'JerryTunes-Koda/1.0 (https://github.com/Ivorisnoob/iKoda)'
      }
    });

    if (searchRes.ok) {
      const results = await searchRes.json();
      if (Array.isArray(results) && results.length > 0) {
        console.log(`[FORENSICS] LYRICS FOUND (Search fallback: ${results[0].trackName})`);
        return res.json(results[0]);
      }
    }

    console.log(`[FORENSICS] LYRICS NOT FOUND for "${cleanTitle}"`);
    return res.status(404).json({ error: 'Lyrics not found' });
  } catch (error) {
    console.error('[FORENSICS] LYRICS ERROR:', error.message || error);
    return res.status(502).json({ error: 'Failed to fetch lyrics', details: error.message });
  }
});

// Home Recommendations & Video Feed Endpoint (inspired by Koda Home)
app.get('/api/home', async (req, res) => {
  try {
    const [trendingResults, quickPicksResults, jumpBackInResults, videoResults] = await Promise.all([
      play.search('Popular Songs Charts 2026', { limit: 12, source: { youtube: 'video' } }).catch(() => []),
      play.search('Top Trending Hits Today', { limit: 8, source: { youtube: 'video' } }).catch(() => []),
      play.search('Best Pop Hits Music', { limit: 10, source: { youtube: 'video' } }).catch(() => []),
      play.search('Official Music Video 4K', { limit: 12, source: { youtube: 'video' } }).catch(() => []),
    ]);

    const normalize = (items) => items.map(video => ({
      id: video.id,
      title: video.title,
      artist: video.channel?.name || 'Unknown',
      channelId: video.channel?.id || undefined,
      artworkUrl: video.thumbnails?.[video.thumbnails.length - 1]?.url || '',
      duration: video.durationRaw,
      views: video.views ? `${(video.views / 1000000).toFixed(1)}M views` : 'Trending',
      uploadedAt: video.uploadedAt || 'Recently'
    }));

    const sampleArtists = [
      { id: 'art-1', name: 'Justin Bieber', artworkUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=300' },
      { id: 'art-2', name: 'Harry Hudson', artworkUrl: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=300' },
      { id: 'art-3', name: 'Atlantic Records', artworkUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300' },
      { id: 'art-4', name: 'Justice', artworkUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300' },
      { id: 'art-5', name: 'Coldplay', artworkUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300' },
      { id: 'art-6', name: 'The Weeknd', artworkUrl: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=300' },
    ];

    const charts = [
      { id: 'chart-1', title: 'Daily TOP 100 Music Videos', subtitle: 'Chart • YouTube Music', artworkUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600' },
      { id: 'chart-2', title: 'Top 100 Music Videos Pakistan', subtitle: 'Chart • YouTube Music', artworkUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600' },
      { id: 'chart-3', title: 'Global Viral 50', subtitle: 'Chart • Global Trends', artworkUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600' },
    ];

    const curatedTopAlbums = [
      {
        id: '1073359412',
        title: 'Aashiqui 2 (Soundtrack)',
        artist: 'Mithoon, Ankit Tiwari & Jeet Gannguli',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/2d/11/b9/2d11b994-b4fa-19eb-953d-70b472165e95/8903431566911_cover.jpg/600x600bb.jpg',
        releaseYear: '2013',
        trackCount: 11,
        type: 'Album'
      },
      {
        id: '1499378108',
        title: 'After Hours',
        artist: 'The Weeknd',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/1b/37/a9/1b37a934-e465-b1a9-b1ff-e2a255ffcf70/20UMGIM08240.rgb.jpg/600x600bb.jpg',
        releaseYear: '2020',
        trackCount: 14,
        type: 'Album'
      },
      {
        id: '1708308989',
        title: '1989 (Taylor\'s Version)',
        artist: 'Taylor Swift',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/17/dc/5d/17dc5d73-3e74-0f2b-9366-fa3d9b4f9814/23UM1IM10839.rgb.jpg/600x600bb.jpg',
        releaseYear: '2023',
        trackCount: 21,
        type: 'Album'
      },
      {
        id: '1193069171',
        title: 'Best of Arijit Singh',
        artist: 'Arijit Singh',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/2d/11/b9/2d11b994-b4fa-19eb-953d-70b472165e95/8903431566911_cover.jpg/600x600bb.jpg',
        releaseYear: '2016',
        trackCount: 30,
        type: 'Album'
      },
      {
        id: '120954021',
        title: 'Divide (Deluxe)',
        artist: 'Ed Sheeran',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/c2/f7/a4/c2f7a424-df38-89c5-0955-f2d4e138a0c2/0190295859039.jpg/600x600bb.jpg',
        releaseYear: '2017',
        trackCount: 16,
        type: 'Album'
      },
      {
        id: '1556175419',
        title: 'Justice',
        artist: 'Justin Bieber',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/e0/75/a6/e075a611-6677-4c07-b30a-6e542c8d20ae/21UMGIM19659.rgb.jpg/600x600bb.jpg',
        releaseYear: '2021',
        trackCount: 16,
        type: 'Album'
      }
    ];

    res.json({
      trending: normalize(trendingResults),
      quickPicks: normalize(quickPicksResults),
      jumpBackIn: normalize(jumpBackInResults),
      videos: normalize(videoResults),
      topArtists: sampleArtists,
      topAlbums: curatedTopAlbums,
      charts: charts,
    });
  } catch (error) {
    console.error('Home feed error:', error);
    res.status(502).json({ error: 'Failed to load home recommendations' });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 JerryTunes Proxy Server listening on http://0.0.0.0:${PORT}`);
});