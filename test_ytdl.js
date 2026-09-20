const ytdl = require('@distube/ytdl-core');

async function test() {
  try {
    console.log("Fetching...");
    const info = await ytdl.getInfo('https://www.youtube.com/watch?v=SGB5st_pCSw');
    console.log("Formats available:", info.formats.length);
    const audio = ytdl.filterFormats(info.formats, 'audioonly');
    console.log("Audio formats:", audio.length);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
