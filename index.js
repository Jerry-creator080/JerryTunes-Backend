const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Readable } = require('stream');
const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const play = require('play-dl');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const WEB_CLIENT_VERSION = '2.20260903.01.00';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const INNERTUBE_CLIENTS = [
  {
    name: 'VISIONOS',
    version: '1.02',
    id: '101',
    userAgent:
      'com.google.visionos.youtube/1.02(RealityDevice14,1; U; CPU visionOS 25_6_0 like Mac OS X; GB)',
    fields: {
      clientScreen: 'WATCH',
      platform: 'MOBILE',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice14,1',
      osName: 'visionOS',
      osVersion: '25.6.0.23O471',
    },
    sendsNonce: true,
  },
  {
    name: 'ANDROID_VR',
    version: '1.65.10',
    id: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    fields: {
      androidSdkVersion: 32,
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
    },
  },
  {
    name: 'IOS',
    version: '21.02.3',
    id: '5',
    userAgent:
      'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
    fields: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.1.0.22B83',
    },
  },
];

// VisitorData state with bounded refresh
let visitorState = {
  token: null,
  mintedAt: 0,
  vetted: null,
  mintPromise: null,
};
const VISITOR_TTL_MS = 6 * 60 * 60 * 1000;

// Bounded stream cache + single-flight deduplication
const streamCache = new Map();
const inFlightStreams = new Map();
const STREAM_CACHE_TTL = 45 * 60 * 1000;
const MAX_STREAM_CACHE = 256;

function isValidVideoId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{6,20}$/.test(id.trim());
}

function randomNonce(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function parseExpireMs(url) {
  if (!url) return Date.now() + STREAM_CACHE_TTL;
  const match = String(url).match(/[?&]expire=(\d+)/);
  if (match && match[1]) {
    const expSec = Number(match[1]);
    if (!isNaN(expSec) && expSec > 0) return expSec * 1000;
  }
  return Date.now() + STREAM_CACHE_TTL;
}

async function mintVisitorData() {
  if (visitorState.mintPromise) return visitorState.mintPromise;

  visitorState.mintPromise = (async () => {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false', {
        method: 'POST',
        signal: AbortSignal.timeout(7000),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': WEB_USER_AGENT,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: WEB_CLIENT_VERSION,
              hl: 'en',
              gl: 'US',
            },
          },
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const raw = json?.responseContext?.visitorData;
        if (raw) {
          const clean = raw.replace(/%3D/gi, '=');
          visitorState.token = clean;
          visitorState.mintedAt = Date.now();
          return clean;
        }
      }
    } catch {
      // Fallback to bootstrap page
    }

    try {
      const htmlRes = await fetch('https://www.youtube.com/', {
        signal: AbortSignal.timeout(9000),
        headers: {
          'User-Agent': WEB_USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const m = html.match(/"visitorData":"(.*?)"/);
        if (m && m[1]) {
          const clean = m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
          visitorState.token = clean;
          visitorState.mintedAt = Date.now();
          return clean;
        }
      }
    } catch {
      // Ignore
    }
    return visitorState.token;
  })();

  try {
    return await visitorState.mintPromise;
  } finally {
    visitorState.mintPromise = null;
  }
}

async function getVisitorData(forceRefresh = false) {
  if (!forceRefresh && visitorState.token && Date.now() - visitorState.mintedAt < VISITOR_TTL_MS) {
    return visitorState.token;
  }
  if (forceRefresh) {
    visitorState.token = null;
    visitorState.vetted = null;
  }
  return mintVisitorData();
}

async function probeLastByte(url, userAgent) {
  try {
    const parsed = new URL(url);
    const clen = Number(parsed.searchParams.get('clen') || 0);
    const dur = Number(parsed.searchParams.get('dur') || 0);
    if (!clen || clen <= 1 || !dur || dur < 120) return null;

    const r = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5500),
      headers: {
        'User-Agent': userAgent,
        Range: `bytes=${clen - 1}-${clen - 1}`,
      },
    });
    if (r.status === 206) return true;
    if (r.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}

async function callInnerTubePlayer(videoId, client, visitorData) {
  const body = {
    videoId,
    context: {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
        ...(visitorData ? { visitorData } : {}),
        ...client.fields,
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
    ...(client.sendsNonce ? { contentPlaybackNonce: randomNonce(16), t: randomNonce(12) } : {}),
  };

  const res = await fetch(
    `https://youtubei.googleapis.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(9000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        'X-Goog-Api-Format-Version': '2',
        'X-YouTube-Client-Name': client.id,
        'X-YouTube-Client-Version': client.version,
        Origin: 'https://www.youtube.com',
        Accept: 'application/json',
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    throw new Error(`InnerTube ${client.name} HTTP ${res.status}`);
  }
  return res.json();
}

function pickAudioFromStreamingData(streamingData, quality = 'high', requireM4a = false) {
  const adaptive = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];
  let audioOnly = adaptive.filter(
    f => String(f?.mimeType || '').startsWith('audio/') && typeof f?.url === 'string' && f.url.length > 0
  );

  const defaults = audioOnly.filter(f => f?.audioTrack?.audioIsDefault === true);
  if (defaults.length > 0) {
    audioOnly = defaults;
  } else {
    const untagged = audioOnly.filter(f => !f?.audioTrack);
    if (untagged.length > 0) audioOnly = untagged;
  }

  if (requireM4a) {
    const m4aOnly = audioOnly.filter(f => String(f?.mimeType || '').startsWith('audio/mp4'));
    if (m4aOnly.length > 0) audioOnly = m4aOnly;
  }

  let bestAudio = null;
  if (audioOnly.length > 0) {
    if (quality === 'normal') {
      bestAudio = [...audioOnly].sort(
        (a, b) => Math.abs((a.bitrate || 128000) - 128000) - Math.abs((b.bitrate || 128000) - 128000)
      )[0];
    } else if (quality === 'ultra') {
      bestAudio = [...audioOnly].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    } else {
      bestAudio = [...audioOnly].sort((a, b) => {
        const aM4a = String(a?.mimeType || '').startsWith('audio/mp4');
        const bM4a = String(b?.mimeType || '').startsWith('audio/mp4');
        if (aM4a && !bM4a) return -1;
        if (!aM4a && bM4a) return 1;
        return (b.bitrate || 0) - (a.bitrate || 0);
      })[0];
    }
  }

  const muxed = (Array.isArray(streamingData?.formats) ? streamingData.formats : [])
    .filter(f => String(f?.mimeType || '').startsWith('video/') && f?.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (!bestAudio && muxed.length > 0) {
    bestAudio = muxed[muxed.length - 1];
  }

  return { bestAudio, muxed };
}

async function resolveViaInnerTube(videoId, quality = 'high', requireM4a = false) {
  let token = await getVisitorData(false);

  for (const client of INNERTUBE_CLIENTS) {
    for (let round = 0; round < (client.name === 'VISIONOS' ? 2 : 1); round++) {
      try {
        const root = await callInnerTubePlayer(videoId, client, token);
        const status = root?.playabilityStatus?.status || '';
        if (status === 'LOGIN_REQUIRED' || (status === 'OK' && !root?.streamingData)) {
          if (client.name === 'VISIONOS' && round === 0) {
            token = await getVisitorData(true);
            continue;
          }
          break;
        }
        if (status && status !== 'OK') break;

        const { bestAudio, muxed } = pickAudioFromStreamingData(root?.streamingData, quality, requireM4a);
        if (!bestAudio?.url) break;

        if (client.name === 'VISIONOS' && token && visitorState.vetted !== token) {
          const ok = await probeLastByte(bestAudio.url, client.userAgent);
          if (ok === true) {
            visitorState.vetted = token;
          } else if (ok === false && round === 0) {
            token = await getVisitorData(true);
            continue;
          }
        }

        const hlsUrl = root?.streamingData?.hlsManifestUrl || null;
        const video1080 = muxed.find(f => f.height === 1080 || f.height === 1440) || muxed[0];
        const video720 = muxed.find(f => f.height === 720) || muxed[0];
        const bestVideo = muxed[0];

        return {
          id: videoId,
          audioUrl: bestAudio.url,
          headers: { 'User-Agent': client.userAgent },
          mimeType: bestAudio.mimeType || 'audio/mp4',
          bitrate: bestAudio.bitrate || null,
          expiresAtMs: parseExpireMs(bestAudio.url),
          videoUrl: hlsUrl || bestVideo?.url || bestAudio.url,
          video720Url: video720?.url || bestVideo?.url || hlsUrl || null,
          video1080Url: video1080?.url || bestVideo?.url || hlsUrl || null,
          fallbackVideoUrl: bestVideo?.url || hlsUrl || null,
          source: `innertube_${client.name.toLowerCase()}`,
        };
      } catch {
        break;
      }
    }
  }
  return null;
}

async function searchInnerTubeVideos(query, limit = 20) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(9000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': WEB_USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: WEB_CLIENT_VERSION,
            hl: 'en',
            gl: 'US',
          },
        },
        query,
      }),
    }
  );
  if (!res.ok) throw new Error(`InnerTube search HTTP ${res.status}`);
  const root = await res.json();
  const sections =
    root?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const items = [];
  for (const sec of sections) {
    const contents = sec?.itemSectionRenderer?.contents || [];
    for (const c of contents) {
      const v = c?.videoRenderer;
      if (!v?.videoId) continue;
      const thumbs = v?.thumbnail?.thumbnails || [];
      items.push({
        id: v.videoId,
        title: v?.title?.runs?.map(r => r.text).join('') || 'Unknown Title',
        artist: v?.ownerText?.runs?.map(r => r.text).join('') || 'Unknown',
        channelId: v?.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
        artworkUrl: thumbs[thumbs.length - 1]?.url || '',
        duration: v?.lengthText?.simpleText || '',
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

async function searchVideosSafe(query, limit = 30) {
  try {
    const results = await play.search(query, { limit, source: { youtube: 'video' } });
    if (Array.isArray(results) && results.length > 0) {
      return results.map(video => ({
        id: video.id,
        title: video.title,
        artist: video.channel?.name || 'Unknown',
        channelId: video.channel?.id || undefined,
        artworkUrl: video.thumbnails?.[video.thumbnails.length - 1]?.url || '',
        duration: video.durationRaw,
        views: video.views ? `${(video.views / 1000000).toFixed(1)}M views` : 'Trending',
        uploadedAt: video.uploadedAt || 'Recently',
      }));
    }
  } catch (err) {
    console.warn(`[Search] play-dl failed for "${query}": ${err.message}`);
  }
  return searchInnerTubeVideos(query, limit);
}

// Health check
app.get('/', (req, res) => {
  res.send('JerryTunes Proxy Server is running!');
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'JerryTunes Proxy Server',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    streamCacheSize: streamCache.size,
    nodeVersion: process.version,
  });
});

// Search Endpoint
app.get('/api/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const tracks = await searchVideosSafe(query, 30);
    res.json(tracks);
  } catch (error) {
    console.error('[Search] Provider error:', error.message || error);
    res.status(502).json({
      error: 'Search Provider Error',
      details: error.message || String(error),
    });
  }
});

// Search Playlists Endpoint
app.get('/api/search/playlists', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
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
    console.error('Playlist search error:', error.message || error);
    res.status(502).json({ error: 'Failed to search YouTube playlists' });
  }
});

function setStreamCache(key, data) {
  const now = Date.now();
  for (const [k, v] of streamCache.entries()) {
    if (now - v.timestamp >= STREAM_CACHE_TTL || v.data.expiresAtMs - 300000 <= now) {
      streamCache.delete(k);
    }
  }
  if (streamCache.size >= MAX_STREAM_CACHE) {
    const oldest = streamCache.keys().next().value;
    if (oldest) streamCache.delete(oldest);
  }
  streamCache.set(key, { timestamp: now, data });
}

// Shared stream resolution helper (InnerTube-first, yt-dlp fallback)
async function resolveStreamHelper(videoId, query, quality = 'high', forceRefresh = false, requireM4a = false) {
  let targetId = typeof videoId === 'string' ? videoId.trim() : '';

  if (!targetId || targetId.startsWith('itunes_') || !isValidVideoId(targetId)) {
    if (query) {
      const searchRes = await searchVideosSafe(`${query} audio`, 1).catch(() => []);
      if (searchRes && searchRes.length > 0 && isValidVideoId(searchRes[0].id)) {
        targetId = searchRes[0].id;
      }
    }
  }

  if (!isValidVideoId(targetId)) {
    throw new Error('Unable to resolve valid YouTube video ID for track');
  }

  const normalizedQuality = ['normal', 'high', 'ultra'].includes(quality) ? quality : 'high';
  const cacheKey = `${targetId}_${normalizedQuality}_${requireM4a ? 'm4a' : 'any'}`;

  if (!forceRefresh && streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    const now = Date.now();
    if (now - cached.timestamp < STREAM_CACHE_TTL && (cached.data.expiresAtMs - 300000 > now)) {
      return cached.data;
    }
    streamCache.delete(cacheKey);
  }

  if (!forceRefresh && inFlightStreams.has(cacheKey)) {
    return inFlightStreams.get(cacheKey);
  }

  const task = (async () => {
    // 1. Primary: InnerTube (fast, no Python dependency, returns client User-Agent header)
    const innerTubeData = await resolveViaInnerTube(targetId, normalizedQuality, requireM4a);
    if (innerTubeData?.audioUrl) {
      setStreamCache(cacheKey, innerTubeData);
      return innerTubeData;
    }

    // 2. Secondary fallback: yt-dlp (youtube-dl-exec)
    let videoUrl = `https://www.youtube.com/watch?v=${targetId}`;
    let output;
    try {
      output = await youtubedl(videoUrl, {
        dumpJson: true,
        noWarnings: true,
        noCheckCertificate: true,
      });
    } catch (err) {
      if (query && (err.message?.includes('Sign in') || err.message?.includes('age'))) {
        const audioSearch = await searchVideosSafe(`${query} audio`, 1).catch(() => []);
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

    if (!output || !output.formats) {
      throw new Error('Failed to parse YouTube formats');
    }

    const audioFormats = output.formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.url);
    let bestAudio;
    if (normalizedQuality === 'normal') {
      bestAudio = [...audioFormats].sort((a, b) => Math.abs((a.abr || 128) - 128) - Math.abs((b.abr || 128) - 128))[0];
    } else if (normalizedQuality === 'ultra') {
      bestAudio = [...audioFormats].sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    } else {
      bestAudio = [...audioFormats].sort((a, b) => {
        const aM4a = a.ext === 'm4a';
        const bM4a = b.ext === 'm4a';
        if (aM4a && !bM4a) return -1;
        if (!aM4a && bM4a) return 1;
        return (b.abr || 0) - (a.abr || 0);
      })[0];
    }
    if (!bestAudio && audioFormats.length > 0) bestAudio = audioFormats[0];

    const videoFormats = output.formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const video1080 = videoFormats.find(f => f.height === 1080 || f.height === 1440) || videoFormats[0];
    const video720 = videoFormats.find(f => f.height === 720) || videoFormats[0];
    const bestVideo = videoFormats[0];
    const resolvedAudioUrl = bestAudio?.url || output.url || null;

    const responseData = {
      id: targetId,
      audioUrl: resolvedAudioUrl,
      headers: bestAudio?.http_headers || undefined,
      mimeType: bestAudio?.ext === 'm4a' ? 'audio/mp4' : 'audio/webm',
      bitrate: bestAudio?.abr ? Math.round(bestAudio.abr * 1000) : null,
      expiresAtMs: parseExpireMs(resolvedAudioUrl),
      videoUrl: bestVideo?.url || output.url || null,
      video720Url: video720?.url || bestVideo?.url || null,
      video1080Url: video1080?.url || bestVideo?.url || null,
      fallbackVideoUrl: bestVideo?.url || output.url || null,
      source: 'yt-dlp',
    };

    setStreamCache(cacheKey, responseData);
    return responseData;
  })();

  inFlightStreams.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightStreams.delete(cacheKey);
  }
}

// Stream URL Extraction Endpoint
app.get('/api/stream', async (req, res) => {
  const { id, query, title, artist, quality, refresh } = req.query;
  const searchQuery = query || (title ? `${title} ${artist || ''}`.trim() : null);

  if (!id && !searchQuery) {
    return res.status(400).json({ error: 'Video ID or search query is required' });
  }

  try {
    const data = await resolveStreamHelper(id, searchQuery, quality, refresh === '1');
    res.json(data);
  } catch (error) {
    console.error('Stream extraction error:', error.message);
    res.status(502).json({ error: error.message || 'Failed to extract stream URLs' });
  }
});

// Range-supporting Audio Proxy Endpoint (safe by video ID only; solves CORS and IP-bound playback fallback)
app.get('/api/proxy-stream', async (req, res) => {
  const { id, quality } = req.query;
  if (!isValidVideoId(id)) {
    return res.status(400).json({ error: 'Valid YouTube video "id" is required' });
  }

  try {
    const data = await resolveStreamHelper(id, null, quality || 'high');
    if (!data?.audioUrl) {
      return res.status(404).json({ error: 'No audio stream available' });
    }

    const upstreamHeaders = {
      ...(data.headers || {}),
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    };

    const upstream = await fetch(data.audioUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }
    if (!upstream.headers.get('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Proxy stream error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: error.message || 'Failed to proxy audio stream' });
    }
  }
});

// Dedicated Single-File Download Resolver Endpoint
app.get('/api/resolve-download', async (req, res) => {
  const { id, query, title, artist, quality } = req.query;
  const searchQuery = query || (title ? `${title} ${artist || ''}`.trim() : null);

  if (!id && !searchQuery) {
    return res.status(400).json({ error: 'Track ID or search query is required' });
  }

  try {
    const data = await resolveStreamHelper(id, searchQuery, quality || 'ultra', false, true);
    res.json(data);
  } catch (error) {
    console.error('Download resolution error:', error.message);
    res.status(502).json({ error: error.message || 'Failed to resolve download URL' });
  }
});

function formatDurationMs(ms) {
  if (!ms || isNaN(ms)) return '3:30';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Artist Discovery Endpoint
app.get('/api/artist', async (req, res) => {
  const artistName = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!artistName) {
    return res.status(400).json({ error: 'Query parameter "name" is required' });
  }

  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=album&limit=30`;
    const itunesPromise = fetch(itunesUrl, { signal: AbortSignal.timeout(9000) })
      .then(r => r.json())
      .catch(() => ({ results: [] }));

    const youtubePromise = searchVideosSafe(`${artistName} top songs`, 12).catch(() => []);

    const [itunesData, ytVideos] = await Promise.all([itunesPromise, youtubePromise]);

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
      type:
        item.trackCount <= 2 || item.collectionName.toLowerCase().includes('single')
          ? 'Single'
          : item.trackCount <= 5 || item.collectionName.toLowerCase().includes('ep')
          ? 'EP'
          : 'Album',
    }));

    const topAlbums = formattedAlbums.filter(a => a.type === 'Album').slice(0, 8);
    const allAlbums = formattedAlbums.filter(a => a.type === 'Album');
    const singlesAndEPs = formattedAlbums.filter(a => a.type === 'Single' || a.type === 'EP');

    const popularSongs = ytVideos.map(video => ({
      id: video.id,
      title: video.title,
      artist: video.artist || artistName,
      channelId: video.channelId,
      artworkUrl: video.artworkUrl || '',
      duration: video.duration || '3:45',
      album: formattedAlbums[0]?.title || 'Single',
    }));

    const artistAvatar = formattedAlbums[0]?.artworkUrl || ytVideos[0]?.artworkUrl || '';

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
      relatedArtists: sampleRelated,
    });
  } catch (error) {
    console.error('Artist endpoint error:', error.message || error);
    res.status(502).json({ error: 'Failed to fetch artist details' });
  }
});

// Album Detail Endpoint
app.get('/api/album', async (req, res) => {
  const { id, query } = req.query;
  if (!id && !query) {
    return res.status(400).json({ error: 'Either album "id" or "query" is required' });
  }

  try {
    let collectionId = id;
    if (!collectionId) {
      const itunesSearch = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=1`;
      const searchRes = await fetch(itunesSearch, { signal: AbortSignal.timeout(9000) }).then(r => r.json());
      if (searchRes.results && searchRes.results.length > 0) {
        collectionId = searchRes.results[0].collectionId;
      } else {
        return res.status(404).json({ error: 'Album not found' });
      }
    }

    const lookupUrl = `https://itunes.apple.com/lookup?id=${collectionId}&entity=song`;
    const lookupRes = await fetch(lookupUrl, { signal: AbortSignal.timeout(9000) }).then(r => r.json());

    if (!lookupRes.results || lookupRes.results.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const albumInfo = lookupRes.results[0];
    const songItems = lookupRes.results.filter(r => r.wrapperType === 'track');

    const totalMs = songItems.reduce((acc, t) => acc + (t.trackTimeMillis || 0), 0);
    const totalMinutes = Math.round(totalMs / 60000);
    const totalDurationString =
      totalMinutes > 60
        ? `${Math.floor(totalMinutes / 60)} hr ${totalMinutes % 60} min`
        : `${totalMinutes} min`;

    const albumType =
      albumInfo.trackCount <= 2 || albumInfo.collectionName?.toLowerCase().includes('single')
        ? 'Single'
        : albumInfo.trackCount <= 5 || albumInfo.collectionName?.toLowerCase().includes('ep')
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
      copyright: albumInfo.copyright || '',
    };

    const formattedTracks = songItems.map((track, idx) => ({
      id: `itunes_${track.trackId}`,
      trackNumber: track.trackNumber || idx + 1,
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
      tracks: formattedTracks,
    });
  } catch (error) {
    console.error('Album endpoint error:', error.message || error);
    res.status(502).json({ error: 'Failed to fetch album details' });
  }
});

// Synced & Plain Lyrics Endpoint
app.get('/api/lyrics', async (req, res) => {
  const { title, artist, duration } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'Query parameter "title" is required' });
  }

  const cleanTitle = String(title)
    .replace(/\s*[\(\[](official\s*music\s*video|official\s*video|official\s*audio|lyrics|lyric\s*video|audio|video|hd|4k)[\)\]]/gi, '')
    .trim();

  try {
    const url = new URL('https://lrclib.net/api/get');
    url.searchParams.set('track_name', cleanTitle);
    if (artist && artist !== 'Unknown') {
      url.searchParams.set('artist_name', String(artist));
    }
    if (duration) {
      url.searchParams.set('duration', String(duration));
    }

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(7000),
      headers: { 'User-Agent': 'JerryTunes/1.0.0' },
    });

    if (response.ok) {
      return res.json(await response.json());
    }

    const searchUrl = new URL('https://lrclib.net/api/search');
    searchUrl.searchParams.set('q', `${cleanTitle} ${artist && artist !== 'Unknown' ? artist : ''}`.trim());

    const searchRes = await fetch(searchUrl.toString(), {
      signal: AbortSignal.timeout(7000),
      headers: { 'User-Agent': 'JerryTunes/1.0.0' },
    });

    if (searchRes.ok) {
      const results = await searchRes.json();
      if (Array.isArray(results) && results.length > 0) {
        return res.json(results[0]);
      }
    }

    return res.status(404).json({ error: 'Lyrics not found' });
  } catch (error) {
    console.error('Lyrics error:', error.message || error);
    return res.status(502).json({ error: 'Failed to fetch lyrics', details: error.message });
  }
});

// Home Recommendations & Video Feed Endpoint
app.get('/api/home', async (req, res) => {
  try {
    const [trending, quickPicks, jumpBackIn, videos] = await Promise.all([
      searchVideosSafe('Popular Songs Charts 2026', 12).catch(() => []),
      searchVideosSafe('Top Trending Hits Today', 8).catch(() => []),
      searchVideosSafe('Best Pop Hits Music', 10).catch(() => []),
      searchVideosSafe('Official Music Video 4K', 12).catch(() => []),
    ]);

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
        type: 'Album',
      },
      {
        id: '1499378108',
        title: 'After Hours',
        artist: 'The Weeknd',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/1b/37/a9/1b37a934-e465-b1a9-b1ff-e2a255ffcf70/20UMGIM08240.rgb.jpg/600x600bb.jpg',
        releaseYear: '2020',
        trackCount: 14,
        type: 'Album',
      },
      {
        id: '1708308989',
        title: "1989 (Taylor's Version)",
        artist: 'Taylor Swift',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/17/dc/5d/17dc5d73-3e74-0f2b-9366-fa3d9b4f9814/23UM1IM10839.rgb.jpg/600x600bb.jpg',
        releaseYear: '2023',
        trackCount: 21,
        type: 'Album',
      },
      {
        id: '1193069171',
        title: 'Best of Arijit Singh',
        artist: 'Arijit Singh',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/2d/11/b9/2d11b994-b4fa-19eb-953d-70b472165e95/8903431566911_cover.jpg/600x600bb.jpg',
        releaseYear: '2016',
        trackCount: 30,
        type: 'Album',
      },
      {
        id: '120954021',
        title: 'Divide (Deluxe)',
        artist: 'Ed Sheeran',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/c2/f7/a4/c2f7a424-df38-89c5-0955-f2d4e138a0c2/0190295859039.jpg/600x600bb.jpg',
        releaseYear: '2017',
        trackCount: 16,
        type: 'Album',
      },
      {
        id: '1556175419',
        title: 'Justice',
        artist: 'Justin Bieber',
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/e0/75/a6/e075a611-6677-4c07-b30a-6e542c8d20ae/21UMGIM19659.rgb.jpg/600x600bb.jpg',
        releaseYear: '2021',
        trackCount: 16,
        type: 'Album',
      },
    ];

    res.json({
      trending,
      quickPicks,
      jumpBackIn,
      videos,
      topArtists: sampleArtists,
      topAlbums: curatedTopAlbums,
      charts,
    });
  } catch (error) {
    console.error('Home feed error:', error.message || error);
    res.status(502).json({ error: 'Failed to load home recommendations' });
  }
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`JerryTunes Proxy Server listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  app,
  resolveStreamHelper,
  resolveViaInnerTube,
  searchVideosSafe,
};
