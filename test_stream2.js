const youtubedl = require('youtube-dl-exec');
const fs = require('fs');

async function test() {
  try {
    const output = await youtubedl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      dumpJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
    });

    const hlsFormats = output.formats.filter(f => f.protocol === 'm3u8_native' || f.protocol === 'm3u8' || f.ext === 'mp4' && f.acodec !== 'none' && f.vcodec !== 'none');
    console.log("HLS/Combined formats found:", hlsFormats.length);
    if (hlsFormats.length > 0) {
      console.log("Best HLS:", hlsFormats.sort((a, b) => (b.height || 0) - (a.height || 0))[0].url.substring(0, 50) + "...");
    } else {
      console.log("NO HLS FORMATS FOUND!");
    }
  } catch(e) {
    console.error(e);
  }
}
test();
