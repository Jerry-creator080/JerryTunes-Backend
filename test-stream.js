const play = require('play-dl');

async function testStream() {
  try {
    const info = await play.video_info('xnP7qKxwzjg');
    const formats = info.format;
    const audioFormats = formats.filter(f => !f.hasVideo && f.hasAudio);
    
    // Log the first few audio format URLs
    console.log(audioFormats.slice(0, 2).map(f => f.url));
  } catch (e) {
    console.error("Error:", e);
  }
}
testStream();
