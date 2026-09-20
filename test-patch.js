const fs = require('fs');
let code = fs.readFileSync('node_modules/play-dl/dist/index.js', 'utf8');
code = code.replace(/throw new Error\("Failed to Parse YouTube Video"\)/g, 'return null');
code = code.replace(/throw new Error\("Failed to Parse YouTube Playlist"\)/g, 'return null');
code = code.replace(/throw new Error\("Failed to Parse YouTube Channel"\)/g, 'return null');
fs.writeFileSync('node_modules/play-dl/dist/index.js', code);
console.log('Patched');
