const http = require('http');

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        const pages = await getJson('http://localhost:9333/json/list');
        console.log("Raw page list from 9333:");
        console.log(JSON.stringify(pages, null, 2));
    } catch (e) {
        console.error(e);
    }
}
run();
