const youtubedl = require('youtube-dl-exec');

async function test() {
  try {
    console.log("Fetching...");
    const output = await youtubedl('https://www.youtube.com/watch?v=SGB5st_pCSw', {
      dumpJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true
    });
    
    const audioFormats = output.formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none');
    console.log("Audio formats:", audioFormats.length);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
