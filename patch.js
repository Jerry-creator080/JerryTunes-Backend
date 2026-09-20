const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, 'node_modules', 'play-dl', 'dist', 'index.js'),
  path.join(__dirname, 'node_modules', 'youtube-sr', 'dist', 'mod.js')
];

for (const file of files) {
  if (fs.existsSync(file)) {
    let code = fs.readFileSync(file, 'utf8');
    
    // Fix play-dl and youtube-sr crashes on missing browseEndpoint/browseId
    code = code.replace(/\.navigationEndpoint\.browseEndpoint\.browseId/g, '.navigationEndpoint?.browseEndpoint?.browseId');
    code = code.replace(/\.navigationEndpoint\.commandMetadata\.webCommandMetadata\.url/g, '.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url');
    code = code.replace(/\.browseEndpoint\.canonicalBaseUrl/g, '.browseEndpoint?.canonicalBaseUrl');
    
    // Prevent play-dl from destroying entire search loops when one result is a promo tile/malformed
    code = code.replace(/throw new Error\("Failed to Parse YouTube Video"\)/g, 'return null');
    code = code.replace(/throw new Error\("Failed to Parse YouTube Playlist"\)/g, 'return null');
    code = code.replace(/throw new Error\("Failed to Parse YouTube Channel"\)/g, 'return null');
    
    // Additional fix for yt-search (if used)
    // code = code.replace(/\.title\.trim\(\)/g, '.title?.trim?.()');
    
    fs.writeFileSync(file, code);
    console.log(`Patched ${file}`);
  }
}
