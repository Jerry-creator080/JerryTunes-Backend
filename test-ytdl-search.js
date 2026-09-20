const youtubedl = require('youtube-dl-exec');

async function testSearch() {
  try {
    const start = Date.now();
    const output = await youtubedl('ytsearch10:arijit', {
      dumpJson: true,
      noWarnings: true,
      flatPlaylist: true,
      ignoreErrors: true
    });
    console.log(`Time: ${Date.now() - start}ms`);
    
    const entries = output.entries || [output];
    console.log(JSON.stringify(entries.slice(0, 2), null, 2));
  } catch (e) {
    console.error("Error:", e);
  }
}
testSearch();
