const youtubedl = require('youtube-dl-exec');

async function testSearch() {
  try {
    const output = await youtubedl(`ytsearch5:adele hello`, {
      dumpJson: true,
      flatPlaylist: true,
      noWarnings: true
    });
    
    // yt-dlp outputs NDJSON when doing flat-playlist, which youtube-dl-exec might parse into an array or return as a giant string.
    console.log(typeof output);
    if (typeof output === 'string') {
        const lines = output.split('\n').filter(l => l.trim().length > 0);
        console.log(JSON.parse(lines[0]));
    } else {
        console.log(output);
    }
  } catch(e) {
    console.error(e);
  }
}

testSearch();
