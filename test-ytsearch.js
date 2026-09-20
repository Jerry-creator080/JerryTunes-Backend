const yts = require('yt-search');

async function test() {
  const r = await yts('adele hello');
  const videos = r.videos.slice(0, 5);
  console.log(videos.map(v => ({
    id: v.videoId,
    title: v.title,
    artist: v.author.name,
    artworkUrl: v.thumbnail,
    duration: v.timestamp
  })));
}

test();
