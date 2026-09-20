const play = require('play-dl');

async function testSearch() {
  try {
    const r = await play.search('tame impala', { limit: 1, source: { youtube: 'video' } });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(e);
  }
}
testSearch();
