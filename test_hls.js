const http = require('http');

const hlsUrl = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1789675537/ei/sfOrat2oH9mXv_IPzev2qQc/ip/2400:adc3:136:c102:b5d7:b7a3:eb0b:b283/id/750c38c3d5a05dc4/itag/625/source/youtube/requiressl/yes/ratebypass/yes/pfa/1/wft/1/sgovp/clen%3D358608461%3Bdur%3D213.040%3Bgir%3Dyes%3Bitag%3D313%3Blmt%3D1766963492248817/rqh/1/hls_chunk_host/rr2---sn-jtcxg-iqqe.googlevideo.com/xpc/EgVo2aDSNQ%3D%3D/cps/1021/met/1789653937,/mh/7c/mm/18,29/mn/sn-jtcxg-iqqe,sn-ajhju5-59/ms/aub,rdu/mv/m/mvi/2/pl/51/rms/aub,aub/pcm2/yes/initcwndbps/455000/bui/AR3QkAkHySpwm0i6bQW6pXxBj62wPghGAIOra3g9OhbH-GzD89ZEHlPj91jTlz7KVkMCQLPlrbvGlkAS/spc/I-rgITe_xFovsseLTNTIO8ztjawej-pitWOd_PEXh8ugzKmBa-vBxiDj81-RrxnRNg/vprv/1/playlist_type/DVR/dover/13/txp/5532534/mt/1789653406/fvip/4/short_key/1/keepalive/yes/fexp/51565116/sparams/expire,ei,ip,id,itag,source,requiressl,ratebypass,pfa,wft,sgovp,rqh,xpc,pcm2,bui,spc,vprv,playlist_type/sig/AE0s2JYwRAIgce8Mc0ku0bblTfCGze87Hq37tm_F_re1C_LQx_XbCPQCIAnUI4ffjakD1HCNJPRmYnal3CHzDzfVwsfxH-WEVv6q/lsparams/hls_chunk_host,cps,met,mh,mm,mn,ms,mv,mvi,pl,rms,initcwndbps/lsig/APaTxxMwRgIhAPfxz73Cb-mcUqFK4otC2Yri-KBX0eHPFnxl6UtEINKkAiEAnk5VvOiXPpxmEnkTuvlh_oTIUZ_f35UKE4S0q_7qXMI%3D/playlist/index.m3u8";

const encodedHls = encodeURIComponent(hlsUrl);
const proxyUrl = `http://localhost:3000/api/proxy?url=${encodedHls}`;

http.get(proxyUrl, (res) => {
  console.log('Status Code:', res.statusCode);
  console.log('Headers:', JSON.stringify(res.headers, null, 2));
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('\n--- BODY START ---');
    console.log(data.slice(0, 500));
    console.log('\n...[truncated]...\n');
    console.log(data.slice(-500));
    console.log('--- BODY END ---');
  });
}).on('error', err => {
  console.log('Error: ', err.message);
});
