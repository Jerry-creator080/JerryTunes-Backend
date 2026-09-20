const body = '#EXT-X-MAP:URI="https://example.com/segment1"\nhttps://example.com/segment2\n';

const rewritten = body.replace(/(https?:\/\/[^\s]+)/g, (match) => {
  return `/api/proxy?url=${encodeURIComponent(match)}`;
});

console.log(rewritten);
