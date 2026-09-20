const http = require('http');

http.get('http://localhost:3000/api/stream?id=dQw4w9WgXcQ', (res) => {
  let data = '';
  console.log('Status Code:', res.statusCode);
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(data);
  });
}).on('error', err => {
  console.log('Error: ', err.message);
});
