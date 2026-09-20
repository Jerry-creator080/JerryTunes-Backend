const youtubedl = require('youtube-dl-exec');

async function test() {
  try {
    const output = await youtubedl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      dumpJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true
    });
    console.log("Success! Found URL:", output.url);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
