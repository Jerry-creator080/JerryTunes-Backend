const youtubedl = require('youtube-dl-exec');
const fs = require('fs');

async function test() {
  try {
    const output = await youtubedl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      dumpJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true
    });

    fs.writeFileSync('formats.json', JSON.stringify(output.formats, null, 2));

    const combinedFormats = output.formats.filter(f => f.acodec !== 'none' && f.vcodec !== 'none' && f.ext === 'mp4');
    console.log("Combined formats found:", combinedFormats.length);
    if (combinedFormats.length > 0) {
      console.log("Best combined:", combinedFormats.sort((a, b) => (b.height || 0) - (a.height || 0))[0].format);
    } else {
      console.log("NO COMBINED MP4 FORMATS FOUND!");
    }
  } catch(e) {
    console.error(e);
  }
}
test();
