const http = require('http');

http.get('http://localhost:3000/api/stream?id=dQw4w9WgXcQ', res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log("HLS URL: ", json.hlsUrl);
    
    // Now request proxy
    const proxyUrl = 'http://localhost:3000/api/proxy?url=' + encodeURIComponent(json.hlsUrl);
    console.log("Proxy URL:", proxyUrl);
    
    http.get(proxyUrl, proxyRes => {
      let m3u8 = '';
      proxyRes.on('data', chunk => m3u8 += chunk);
      proxyRes.on('end', () => {
        console.log("M3U8 Length:", m3u8.length);
        console.log(m3u8.substring(0, 1000));
        
        // Find the first proxied URL
        const lines = m3u8.split('\n');
        const urlLine = lines.find(l => l.startsWith('/api/proxy'));
        if (urlLine) {
           console.log("Found chunk URL:", urlLine);
           http.get('http://localhost:3000' + urlLine, chunkRes => {
             console.log("Chunk status:", chunkRes.statusCode);
           });
        }
      });
    });
  });
});
