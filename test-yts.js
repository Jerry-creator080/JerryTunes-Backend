const yts = require('yt-search');

async function testSearch() {
  try {
    const r = await yts('tame impala');
    const videos = r.videos.slice(0, 1);
    console.log(JSON.stringify(videos, null, 2));
  } catch (e) {
    console.error(e);
  }
}
testSearch();
