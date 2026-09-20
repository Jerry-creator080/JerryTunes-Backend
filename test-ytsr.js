const ytsr = require('@distube/ytsr');

async function testSearch() {
  try {
    const r = await ytsr('tame impala', { limit: 1 });
    console.log(JSON.stringify(r.items, null, 2));
  } catch (e) {
    console.error(e);
  }
}
testSearch();
